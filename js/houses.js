import * as THREE from 'three/webgpu';
import { Fn, attribute, float, vec2, vec3, color, fract, floor, abs, clamp, max, min, mix, step, smoothstep, sin, fwidth } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { nearestRoads } from './city-config.js';
import { GEO } from './nyc-geodata.js';

// Ann Arbor's houses, from the city's surveyed footprints and heights: painted clapboard walls with white trim, sash
// windows and a front door facing the street, storeys counted from the surveyed height, a gabled or hipped roof, and
// on many a front porch and a brick chimney. Garages and sheds get the same walls without windows.
// Walls are one mesh per square kilometer, drawn by one shader (siding, windows, door, trim) from each wall's
// meters along and up (`wallInfo`); roofs, porches and chimneys are another, in vertex colours.

const SIDING = [
  0xeeeae0, 0xf1ecdc, 0xe7dcb5, 0xd8cf9c, 0xb7c2a3, 0x93a58a, 0x8fa3b4, 0x6f8597, 0xa9b0b3, 0x7c8a86,
  0xc9b597, 0x9a4b3e, 0x4f6b58, 0xbcc9d2, 0xe9e4d6, 0xd9c4a0
];
const BRICK = 0x8e4a38;
const SHINGLES = [[0.17, 0.17, 0.18], [0.27, 0.22, 0.19], [0.32, 0.33, 0.35], [0.21, 0.25, 0.22], [0.36, 0.28, 0.24]];
const WHITE = [0.93, 0.92, 0.88];
const DECK = [0.55, 0.53, 0.5];
const CHIMNEY = [0.48, 0.25, 0.19];

const FLAG_WALL = 0, FLAG_FRONT = 1, FLAG_GABLE = 2, FLAG_BLANK = 3;

function hash(x, z, k) {
  const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

// The footprint's oriented bounding box, along its longest wall
function orientedBox(ring) {
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c.x - a.x, dz = c.z - a.z, L = Math.hypot(dx, dz);
    if (L > best) { best = L; ux = dx / L; uz = dz / L; }
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ring) {
    const u = p.x * ux + p.z * uz, v = -p.x * uz + p.z * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let L = u1 - u0, W = v1 - v0, ax = ux, az = uz;
  if (W > L) { [L, W] = [W, L]; ax = -uz; az = ux; }
  return { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ax, az, L, W };
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

// Which way the street is: from the house's middle to the nearest point of the nearest road
function streetDirection(cx, cz) {
  const near = nearestRoads(cx, cz, 70);
  if (!near.length) return null;
  const pts = near[0].road.pts;
  let best = Infinity, bx = 0, bz = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cz - a.z) * dz) / L2));
    const x = a.x + t * dx, z = a.z + t * dz, d = (x - cx) ** 2 + (z - cz) ** 2;
    if (d < best) { best = d; bx = x; bz = z; }
  }
  const L = Math.hypot(bx - cx, bz - cz) || 1;
  return { x: (bx - cx) / L, z: (bz - cz) / L };
}

// Share of a pixel's footprint w around x that lies in [a, b] (an anti-aliased box, not repeating)
const box = (x, a, b, w) => clamp(min(x.add(w.mul(0.5)), float(b)).sub(max(x.sub(w.mul(0.5)), float(a))).div(w), 0.0, 1.0);

function createHouseWallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0 });
  const info = attribute('wallInfo', 'vec4'); // meters along, meters up, wall length, kind
  const house = attribute('houseInfo', 'vec4'); // seed, eave height above the base, a garage door's start & end along the wall
  const siding = attribute('color', 'vec3');
  const u = info.x, v = info.y, len = info.z, kind = info.w;
  const seed = house.x, eave = house.y;
  const fwU = max(fwidth(u), 0.002), fwV = max(fwidth(v), 0.002);
  // A garage door where the city's driveway meets this wall (GEO.garageDoors): white panels, 2.2 m high
  const gd0 = house.z, gd1 = house.w;
  const hasGarage = step(0.0, gd0);
  const garageDoor = box(u, gd0, gd1, fwU).mul(box(v, -0.6, 2.75, fwV)).mul(hasGarage);
  const garageTrim = box(u, gd0.sub(0.15), gd1.add(0.15), fwU).mul(box(v, -0.6, 2.9, fwV)).mul(hasGarage);
  const garageZone = box(u, gd0.sub(0.9), gd1.add(0.9), fwU).mul(step(v, 3.3)).mul(hasGarage);
  const panelLine = smoothstep(0.0, 0.06, fract(v.sub(0.5).div(0.56))).mul(0.25).add(0.75);

  const isFront = step(0.5, kind).mul(step(kind, 1.5));
  const hasWindows = step(kind, 1.5).mul(step(2.2, len));
  // windows evenly along the wall, about 3.6 m apart on the front and 5 m on the sides, where some are left out;
  // storeys 2.8 m from the top of a 0.5 m foundation
  const n = max(float(1.0), floor(len.div(mix(float(5.0), float(3.6), isFront)).add(0.5)));
  const spacing = len.div(n);
  const col = floor(u.div(spacing));
  const x = fract(u.div(spacing)).sub(0.5).mul(spacing); // meters from the window's middle
  const vs = v.sub(0.5);
  const row = floor(vs.div(2.8));
  const y = fract(vs.div(2.8)).mul(2.8); // meters up its storey
  const rowFits = step(row.mul(2.8).add(0.5).add(2.55), eave).mul(step(0.0, vs));
  const doorCol = floor(n.mul(0.5));
  const isDoor = isFront.mul(step(abs(col.sub(doorCol)), 0.1)).mul(step(row, 0.1)).mul(step(1.0, len.sub(1.0)));
  const winOpen = box(x, -0.48, 0.48, fwU).mul(box(y, 0.85, 2.3, fwV));
  const winTrim = box(x, -0.62, 0.62, fwU).mul(box(y, 0.72, 2.45, fwV));
  const doorOpen = box(x, -0.5, 0.5, fwU).mul(box(y, -0.6, 2.05, fwV));
  const doorTrim = box(x, -0.64, 0.64, fwU).mul(box(y, -0.6, 2.2, fwV));
  const colKeep = max(isFront, step(0.4, fract(sin(col.mul(12.9898).add(seed.mul(7.31)).add(len.mul(3.7))).mul(43758.5453))));
  const show = hasWindows.mul(rowFits).mul(colKeep).mul(float(1.0).sub(garageZone));
  const glass = winOpen.mul(show).mul(float(1.0).sub(isDoor));
  const door = doorOpen.mul(show).mul(isDoor);
  const trim = max(winTrim.mul(float(1.0).sub(isDoor)), doorTrim.mul(isDoor)).mul(show);
  // the sash's meeting rail and the middle muntin
  const sash = max(box(y, 1.54, 1.62, fwV), box(x, -0.03, 0.03, fwU));
  // corner boards, the foundation and the frieze under the eaves
  const corner = max(step(u, 0.14), step(len.sub(0.14), u)).mul(step(kind, 2.5));
  const foundation = step(v, 0.5);
  const frieze = step(eave.sub(0.28), v).mul(step(kind, 1.5));
  // clapboard: a shadow line under each 18 cm board
  const board = smoothstep(0.0, 0.25, fract(v.div(0.18))).mul(0.14).add(0.86);
  const lit = step(0.62, fract(sin(col.mul(12.99).add(row.mul(78.23)).add(seed.mul(3.7))).mul(43758.5)));

  const nightFactor = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  const trimColor = color(0xf2efe6);
  const glassColor = mix(color(0x1d262e), color(0x3a4650), smoothstep(1.0, 2.2, y));
  const doorColor = mix(color(0x5a2a22), color(0x22313d), step(0.5, fract(seed.mul(7.31))));
  mat.colorNode = Fn(() => {
    let c = siding.mul(board);
    c = mix(c, trimColor, max(max(corner, frieze), trim));
    c = mix(c, glassColor, glass.mul(float(1.0).sub(sash)));
    c = mix(c, trimColor, glass.mul(sash));
    c = mix(c, doorColor, door);
    c = mix(c, color(0x8d8a84), foundation);
    c = mix(c, trimColor, garageTrim);
    c = mix(c, color(0xe9e6dc).mul(panelLine), garageDoor);
    return c;
  })();
  mat.roughnessNode = mix(float(0.82), float(0.12), glass.mul(float(1.0).sub(sash)));
  mat.emissiveNode = vec3(1.0, 0.72, 0.42).mul(glass.mul(float(1.0).sub(sash)).mul(lit).mul(nightFactor).mul(0.9));
  return mat;
}

let wallMaterial = null, solidMaterial = null;

// The garage doors, in 16 m cells: [x0, z0, x1, z1]
const DOOR_CELL = 16;
let doorGrid = null;
function doorsNear(x, z) {
  if (!doorGrid) {
    doorGrid = new Map();
    const D = GEO.garageDoors || [];
    for (let i = 0; i < D.length; i += 4) {
      const k = Math.floor((D[i] + D[i + 2]) / 2 / DOOR_CELL) * 100000 + Math.floor((D[i + 1] + D[i + 3]) / 2 / DOOR_CELL);
      if (!doorGrid.has(k)) doorGrid.set(k, []);
      doorGrid.get(k).push([D[i], D[i + 1], D[i + 2], D[i + 3]]);
    }
  }
  const out = [], ix = Math.floor(x / DOOR_CELL), iz = Math.floor(z / DOOR_CELL);
  for (let a = ix - 2; a <= ix + 2; a++) for (let b = iz - 2; b <= iz + 2; b++) out.push(...(doorGrid.get(a * 100000 + b) || []));
  return out;
}
// The garage door on the wall a to b, as meters along it, or null
function doorOnWall(doors, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  if (L < 2.4) return null;
  const ux = dx / L, uz = dz / L;
  for (const [x0, z0, x1, z1] of doors) {
    const off0 = Math.abs((x0 - a.x) * uz - (z0 - a.z) * ux), off1 = Math.abs((x1 - a.x) * uz - (z1 - a.z) * ux);
    if (off0 > 1.2 || off1 > 1.2) continue;
    if (Math.abs((x1 - x0) * ux + (z1 - z0) * uz) < Math.hypot(x1 - x0, z1 - z0) * 0.9) continue;
    let t0 = (x0 - a.x) * ux + (z0 - a.z) * uz, t1 = (x1 - a.x) * ux + (z1 - a.z) * uz;
    if (t0 > t1) [t0, t1] = [t1, t0];
    t0 = Math.max(0.35, t0); t1 = Math.min(L - 0.35, t1);
    if (t1 - t0 >= 2.2) return [t0, t1];
  }
  return null;
}

function buildHouses(records) {
  wallMaterial ||= createHouseWallMaterial();
  solidMaterial ||= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide });
  const cells = new Map();
  const cellOf = (x, z) => {
    const key = Math.floor(x / 1000) + ',' + Math.floor(z / 1000);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { pos: [], nor: [], col: [], info: [], house: [], idx: [], sPos: [], sCol: [] }));
    return c;
  };
  let houses = 0, porches = 0;

  for (const r of records) {
    const ring0 = r.polygons[0] && r.polygons[0].outer;
    if (!ring0 || ring0.length < 3) continue;
    const ring = ringArea(ring0) < 0 ? [...ring0].reverse() : ring0; // counter-clockwise in x, z: walls face out
    const box = orientedBox(ring);
    const area = Math.abs(ringArea(ring));
    const fill = area / Math.max(1, box.L * box.W);
    const g = r.ground ?? 0;
    const garage = r.garage || area < 45;
    const h = Math.max(3, r.height);
    const gable = hash(r.cx, r.cz, 1) < 0.62 || garage;
    const rh = Math.max(1.2, Math.min(garage ? 2 : 4.6, box.W * (gable ? 0.42 : 0.36), h * 0.45));
    // The survey's height is the roof's average from LiDAR, which reads low (porches and eaves pull it down): count
    // storeys from it and put the eaves where those storeys end, the roof rising above
    const storeys = garage ? 0 : h < 4.5 ? 1 : h < 9.5 ? 2 : 3;
    const eave = storeys ? 3.05 + (storeys - 1) * 2.8 : Math.max(2.7, h - rh);
    const ridgeTop = g + eave + rh;
    const rand = hash(r.cx, r.cz, 2);
    const brick = !garage && rand < 0.1;
    const sidingHex = brick ? BRICK : SIDING[Math.floor(hash(r.cx, r.cz, 3) * SIDING.length)];
    const sc = new THREE.Color(sidingHex).convertSRGBToLinear();
    const seed = hash(r.cx, r.cz, 4) * 100;
    const c = cellOf(r.cx, r.cz);
    const street = garage ? null : streetDirection(r.cx, r.cz);

    // A clean rectangular house where the footprint nearly is one, else its walls follow the footprint
    const simple = fill > 0.78 && box.L < 24;
    const bx = -box.az, bz = box.ax;
    const P = (u, v) => ({ x: box.cx + box.ax * u + bx * v, z: box.cz + box.az * u + bz * v });
    const walls = simple
      ? [P(-box.L / 2, -box.W / 2), P(box.L / 2, -box.W / 2), P(box.L / 2, box.W / 2), P(-box.L / 2, box.W / 2)]
      : ring;
    const wallsCCW = ringArea(walls) < 0 ? [...walls].reverse() : walls;

    // the front wall: the longest-facing one toward the street
    let front = -1, frontScore = 0.35;
    if (street) {
      for (let i = 0; i < wallsCCW.length; i++) {
        const a = wallsCCW[i], b = wallsCCW[(i + 1) % wallsCCW.length];
        const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
        if (L < 3) continue;
        const nx = dz / L, nz = -dx / L; // outward for a counter-clockwise ring in x, z (z south)
        const s = (nx * street.x + nz * street.z) * Math.min(1, L / 6);
        if (s > frontScore) { frontScore = s; front = i; }
      }
    }
    // Walls go a little into the ground so a slope never shows under them
    const base = g - 0.6, top = g + eave;
    const doors = doorsNear(r.cx, r.cz);
    const pushWall = (a, b, y0, y1, flag, outward) => {
      // the door is measured along the wall from a; the shader counts u the same way
      const gd = doors.length ? doorOnWall(doors, a, b) : null;
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      if (L < 0.05) return;
      let nx = dz / L, nz = -dx / L;
      if (outward === false) { nx = -nx; nz = -nz; }
      const o = c.pos.length / 3;
      c.pos.push(a.x, y0, a.z, b.x, y0, b.z, a.x, y1, a.z, b.x, y1, b.z);
      for (let k = 0; k < 4; k++) {
        c.nor.push(nx, 0, nz);
        c.col.push(sc.r, sc.g, sc.b);
        c.house.push(seed, eave, gd ? gd[0] : -1, gd ? gd[1] : -1);
      }
      c.info.push(0, y0 - g, L, flag, L, y0 - g, L, flag, 0, y1 - g, L, flag, L, y1 - g, L, flag);
      c.idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
    };
    const nW = wallsCCW.length;
    for (let i = 0; i < nW; i++) {
      const a = wallsCCW[i], b = wallsCCW[(i + 1) % nW];
      pushWall(a, b, base, top, garage ? FLAG_BLANK : i === front ? FLAG_FRONT : FLAG_WALL);
    }

    // The roof, on the box with a 0.4 m overhang (shingles in vertex colour)
    const shade = SHINGLES[Math.floor(hash(r.cx, r.cz, 5) * SHINGLES.length)].map((x) => x);
    const hl = box.L / 2 + 0.4, hw = box.W / 2 + 0.4;
    const Y = (u, v, y) => { const p = P(u, v); return [p.x, y, p.z]; };
    const tri = (A, B, C, rgb) => { c.sPos.push(...A, ...B, ...C); for (let k = 0; k < 3; k++) c.sCol.push(...rgb); };
    const quad = (A, B, C, D, rgb) => { tri(A, B, C, rgb); tri(A, C, D, rgb); };
    const eaveY = top - 0.05 * 0, e = eaveY - 0.15;
    const c0 = Y(-hl, -hw, e), c1 = Y(hl, -hw, e), c2 = Y(hl, hw, e), c3 = Y(-hl, hw, e);
    if (gable) {
      const r0 = Y(-hl, 0, ridgeTop), r1 = Y(hl, 0, ridgeTop);
      quad(c0, r0, r1, c1, shade); quad(c3, c2, r1, r0, shade);
      // the gable ends: siding triangles over the end walls, with no windows
      for (const s of [-1, 1]) {
        const ga = P(s * box.L / 2, -box.W / 2 * s), gb = P(s * box.L / 2, box.W / 2 * s);
        const o = c.pos.length / 3;
        const mid = P(s * box.L / 2, 0);
        const nx = box.ax * s, nz = box.az * s;
        c.pos.push(ga.x, top, ga.z, gb.x, top, gb.z, mid.x, ridgeTop - 0.05, mid.z);
        for (let k = 0; k < 3; k++) { c.nor.push(nx, 0, nz); c.col.push(sc.r, sc.g, sc.b); c.house.push(seed, eave, -1, -1); }
        c.info.push(0, eave, box.W, FLAG_GABLE, box.W, eave, box.W, FLAG_GABLE, box.W / 2, eave + rh, box.W, FLAG_GABLE);
        c.idx.push(o, o + 2, o + 1);
      }
    } else {
      const ridge = Math.max(0, hl - hw);
      const r0 = Y(-ridge, 0, ridgeTop), r1 = Y(ridge, 0, ridgeTop);
      tri(c0, r0, c1, shade); tri(c1, r0, r1, shade);
      tri(c2, r1, c3, shade); tri(c3, r1, r0, shade);
      tri(c1, r1, c2, shade); tri(c3, r0, c0, shade);
    }

    // A brick chimney at one end of the ridge
    if (!garage && hash(r.cx, r.cz, 6) < 0.45) {
      const cu = (hash(r.cx, r.cz, 7) < 0.5 ? -1 : 1) * box.L * 0.3, cv = box.W * 0.12;
      addBox(c, P(cu, cv), box.ax, box.az, 0.7, 0.6, top - 0.5, ridgeTop + 0.9, CHIMNEY);
    }

    // A front porch on many: a deck, white posts and a low roof
    if (front >= 0 && !garage && hash(r.cx, r.cz, 8) < 0.55) {
      const a = wallsCCW[front], b = wallsCCW[(front + 1) % nW];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
      if (L >= 5) {
        const ux = dx / L, uz = dz / L, nx = uz, nz = -ux;
        const w = Math.min(L * 0.75, 9), depth = 2.2;
        const mx = (a.x + b.x) / 2 + nx * depth / 2, mz = (a.z + b.z) / 2 + nz * depth / 2;
        const ph = Math.min(2.8, eave - 0.2);
        addBox(c, { x: mx, z: mz }, ux, uz, w, depth, g - 0.4, g + 0.55, DECK);
        for (const s of [-0.48, 0.48]) {
          addBox(c, { x: mx + ux * w * s + nx * (depth / 2 - 0.15), z: mz + uz * w * s + nz * (depth / 2 - 0.15) },
            ux, uz, 0.18, 0.18, g + 0.55, g + ph, WHITE);
        }
        addBox(c, { x: mx, z: mz }, ux, uz, w + 0.3, depth + 0.3, g + ph, g + ph + 0.22, shade);
        porches++;
      }
    }
    houses++;
  }

  const group = new THREE.Group();
  group.name = 'AnnArborHouses';
  for (const c of cells.values()) {
    if (c.idx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(c.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(c.nor, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(c.col, 3));
      geo.setAttribute('wallInfo', new THREE.Float32BufferAttribute(c.info, 4));
      geo.setAttribute('houseInfo', new THREE.Float32BufferAttribute(c.house, 4));
      geo.setIndex(c.idx);
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, wallMaterial);
      m.name = 'HouseWalls';
      m.castShadow = m.receiveShadow = true;
      m.userData.shadowStandIn = true;
      group.add(m);
    }
    if (c.sPos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(c.sPos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(c.sCol, 3));
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
      const m = new THREE.Mesh(geo, solidMaterial);
      m.name = 'HouseRoofs';
      m.castShadow = m.receiveShadow = true;
      m.userData.shadowStandIn = true;
      group.add(m);
    }
  }
  console.info(`[houses] ${houses} houses, ${porches} porches`);
  return group;
}

// An upright box (centre p, its length along (ux, uz)) in vertex colour, into the cell's solid mesh
function addBox(c, p, ux, uz, len, dep, y0, y1, rgb) {
  const vx = -uz, vz = ux, hl = len / 2, hd = dep / 2;
  const C = (s, t, y) => [p.x + ux * hl * s + vx * hd * t, y, p.z + uz * hl * s + vz * hd * t];
  const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const tri = (A, B, Cc) => { c.sPos.push(...A, ...B, ...Cc); for (let k = 0; k < 3; k++) c.sCol.push(...rgb); };
  for (let i = 0; i < 4; i++) {
    const [s0, t0] = q[i], [s1, t1] = q[(i + 1) % 4];
    const a = C(s0, t0, y0), b = C(s1, t1, y0), d = C(s0, t0, y1), e = C(s1, t1, y1);
    tri(a, d, b); tri(b, d, e);
  }
  tri(C(-1, -1, y1), C(-1, 1, y1), C(1, 1, y1)); tri(C(-1, -1, y1), C(1, 1, y1), C(1, -1, y1));
}

export { buildHouses };
