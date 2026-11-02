import * as THREE from 'three/webgpu';
import { Fn, attribute, float, vec2, vec3, color, fract, floor, abs, clamp, max, min, mix, step, smoothstep, sin, fwidth, uv, texture, pow, mod } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { nearestRoads } from './city-config.js';
import { historicDistrictAt } from './districts.js';
import { groundHeight } from './terrain.js';
import { GEO } from './city-geodata.js';

// Ann Arbor's houses, from the city's surveyed footprints and heights. Each footprint is split into its main block and
// up to three wings (the largest rectangles inside it), so L-shapes, side wings and back additions keep their shape.
// The main block gets the roof its shape and age suggest (a gable to the street on a narrow lot, a hip on a square
// foursquare, a side gable with dormers on a storey-and-a-half bungalow), or the one OpenStreetMap's mappers tagged
// (data/roof-shapes.json); wings get their own lower gables or lean-tos. Roofs overhang the walls with fascia, soffits
// and rake boards. Walls are clapboard in Ann Arbor's colors, or brick, stone, stucco or shakes, with trim, sash
// windows, shutters on some, a colored front door, and a foundation above the ground; most older houses have a porch
// with posts, railings and steps, a light by the door, a chimney, a front walk to the sidewalk and shrubs.
// Walls are one mesh per square kilometer, drawn by one shader from each wall's meters along and up (`wallInfo`);
// roofs, trim, porches and chimneys are another, in vertex colours. Railings, steps, shrubs and porch lights are
// instanced and only drawn up close (scene-culling.js). Every choice is seeded from the house's position, so a house
// always looks the same.

// Ann Arbor's siding: whites and creams, yellows, sage and olive greens, grays, muted blues, barn red, tan
const SIDING = [
  0xf2efe7, 0xebe5d3, 0xe6dcc0, 0xf0ece2, 0xe4cd85, 0xd9bf72, 0xead9a0, 0xaab595, 0x8e9b74, 0x707d57, 0x5d6a4c,
  0xb9bbb7, 0x92989a, 0x6c7378, 0x9fb2c0, 0x7b91a3, 0x5a6f82, 0x8b3a2e, 0x75302a, 0xc8b391
];
// In the historic districts (Old West Side, Old Fourth Ward, Division Street…), the deeper colors of their 1850-1910
// houses: oxblood, forest and olive greens, ochre, slate, cream
const HERITAGE = [
  0x7a3b33, 0x5b2f2a, 0x46604a, 0x5e6b45, 0xb8924a, 0xc9a96b, 0x52616d, 0x6b5b4b, 0xe6dcc3, 0x8c6f4e, 0x3f4f5a,
  0xd8c8a0
];
const BRICKS = [0x8e4a38, 0x9a5240, 0x7c3b2c, 0x6b4a37, 0x7b5944, 0xa86a4c];
const STONES = [0x9a9286, 0x857d70, 0xa89f8e];
const STUCCO = [0xe6dcc4, 0xd7cbb0, 0xc9bfa8, 0xe9e2d2];
const SHAKES = [0x8a6a4a, 0x6e5a45, 0x7d7a68, 0x5f6b55];
const SHINGLES = [0x3b3b3e, 0x4e4038, 0x5b5e63, 0x3e4a40, 0x5a3e33, 0x2e2f33];
// trim (row 0 of the palette texture) and doors & shutters (row 1)
const TRIM = [0xf3f0e8, 0xe6dcc3, 0x2e3b2f, 0x202226, 0x5c2328, 0x28354a, 0xb39a70, 0x6b6f70];
const ACCENT = [0x962a22, 0x1d1e21, 0x223152, 0x264230, 0x6b4426, 0xd6a63a, 0x2d5d5f, 0x5a1e27];
const SHRUBS = [0x2f5a2c, 0x3d6b35, 0x2a4d2e, 0x4c7a3a, 0x355e3f];
const CHIMNEY = 0x7d3d2e, CONCRETE = 0xb0aca3, DECK = 0x8b8984, CEILING = 0xe9e4d6, FLAT_ROOF = 0x55575a;

// Wall kinds (wallInfo.w): a side wall, the wall with the front door (in its middle), a gable end, a blank wall
// (garages, sheds, lean-to ends), a dormer's face, a dormer's cheek, and the rest of the front
const K_WALL = 0, K_FRONT = 1, K_GABLE = 2, K_BLANK = 3, K_DORMER = 4, K_CHEEK = 5, K_FACADE = 6;
// Wall materials (houseStyle.x)
const M_CLAP = 0, M_BRICK = 1, M_STONE = 2, M_STUCCO = 3, M_SHAKE = 4;
const FASCIA = 0.2; // how deep the fascia boards are

function hash(x, z, k) {
  const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453;
  return v - Math.floor(v);
}
const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const pick = (list, r) => list[Math.min(list.length - 1, Math.floor(r * list.length))];
const luma = (hex) => (0.299 * ((hex >> 16) & 255) + 0.587 * ((hex >> 8) & 255) + 0.114 * (hex & 255)) / 255;

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

function insideRing(ring, x, z) {
  let inn = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inn = !inn;
  }
  return inn;
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

// How far along the ray from (x, z) toward (nx, nz) the nearest road's edge is, or -1
function distanceToStreet(x, z, nx, nz) {
  let best = -1;
  for (const { road } of nearestRoads(x, z, 50).slice(0, 3)) {
    const pts = road.pts;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], qx = pts[i + 1].x - a.x, qz = pts[i + 1].z - a.z;
      const den = nx * qz - nz * qx;
      if (Math.abs(den) < 1e-6) continue;
      const wx = a.x - x, wz = a.z - z;
      const s = (wx * qz - wz * qx) / den, t = (wx * nz - wz * nx) / den;
      if (s <= 0 || t < 0 || t > 1) continue;
      const edge = s - (road.w || 8) / 2;
      if (best < 0 || edge < best) best = edge;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// The footprint as rectangles: rasterised at half a meter in its box's frame, then the largest rectangle inside it (the
// main block, at least 3 m a side) and up to three more from what's left (wings, at least 2 m a side), each edge snapped
// to the footprint's own corner lines so they meet its walls exactly.
const GRID = 0.5;
function largestRect(grid, nu, nv, minU, minV) {
  const h = new Int16Array(nu);
  const st = [];
  let best = null, bestA = 0;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) h[i] = grid[j * nu + i] ? h[i] + 1 : 0;
    st.length = 0;
    for (let i = 0; i <= nu; i++) {
      const hi = i < nu ? h[i] : 0;
      let start = i;
      while (st.length && st[st.length - 1][1] >= hi) {
        const [s, hh] = st.pop();
        const w = i - s;
        if (w >= minU && hh >= minV && w * hh > bestA) { bestA = w * hh; best = { i0: s, i1: i, j0: j - hh + 1, j1: j + 1 }; }
        start = s;
      }
      st.push([start, hi]);
    }
  }
  return best;
}

function decompose(loc, L, W) {
  const nu = Math.max(1, Math.round(L / GRID)), nv = Math.max(1, Math.round(W / GRID));
  const du = L / nu, dv = W / nv;
  const grid = new Uint8Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const v = -W / 2 + (j + 0.5) * dv;
    const xs = [];
    for (let k = 0, m = loc.length - 1; k < loc.length; m = k++) {
      const a = loc[m], b = loc[k];
      if ((a.v > v) !== (b.v > v)) xs.push(a.u + ((v - a.v) / (b.v - a.v)) * (b.u - a.u));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] + L / 2) / du - 0.5));
      const i1 = Math.min(nu - 1, Math.floor((xs[k + 1] + L / 2) / du - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * nu + i] = 1;
    }
  }
  const us = loc.map((p) => p.u), vs = loc.map((p) => p.v);
  const snap = (x, list) => {
    let best = x, d = 0.6;
    for (const c of list) if (Math.abs(c - x) < d) { d = Math.abs(c - x); best = c; }
    return best;
  };
  const take = (r) => {
    for (let j = r.j0; j < r.j1; j++) for (let i = r.i0; i < r.i1; i++) grid[j * nu + i] = 0;
    return {
      u0: snap(-L / 2 + r.i0 * du, us), u1: snap(-L / 2 + r.i1 * du, us),
      v0: snap(-W / 2 + r.j0 * dv, vs), v1: snap(-W / 2 + r.j1 * dv, vs)
    };
  };
  const main = largestRect(grid, nu, nv, Math.ceil(3 / du), Math.ceil(3 / dv));
  if (!main) return [{ u0: -L / 2, u1: L / 2, v0: -W / 2, v1: W / 2 }];
  const rects = [take(main)];
  for (let k = 0; k < 3; k++) {
    const w = largestRect(grid, nu, nv, Math.ceil(2 / du), Math.ceil(2 / dv));
    if (!w || (w.i1 - w.i0) * du * (w.j1 - w.j0) * dv < 6) break;
    const r = take(w);
    if (r.u1 - r.u0 > 1.5 && r.v1 - r.v0 > 1.5) rects.push(r);
  }
  return rects;
}

// ---------------------------------------------------------------------------------------------------------------------
// The roof shapes OpenStreetMap's mappers tagged: [x, z, shape] in 20 m cells (1 gabled, 2 hipped, 3 flat, 4 gambrel,
// 5 half-hipped, 6 skillion)
const ROOF_CELL = 20;
let roofGrid = new Map();
export function setRoofShapes(data) {
  roofGrid = new Map();
  for (let i = 0; data && i + 2 < data.length; i += 3) {
    const k = Math.floor(data[i] / ROOF_CELL) * 100000 + Math.floor(data[i + 1] / ROOF_CELL);
    if (!roofGrid.has(k)) roofGrid.set(k, []);
    roofGrid.get(k).push(data[i], data[i + 1], data[i + 2]);
  }
}
function taggedRoof(ring, cx, cz) {
  const ix = Math.floor(cx / ROOF_CELL), iz = Math.floor(cz / ROOF_CELL);
  for (let a = ix - 1; a <= ix + 1; a++) for (let b = iz - 1; b <= iz + 1; b++) {
    const list = roofGrid.get(a * 100000 + b);
    for (let i = 0; list && i < list.length; i += 3) if (insideRing(ring, list[i], list[i + 1])) return list[i + 2];
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// Wall shader

// Share of a pixel's footprint w around x that lies in [a, b] (an anti-aliased box, not repeating)
const box = (x, a, b, w) => clamp(min(x.add(w.mul(0.5)), float(b)).sub(max(x.sub(w.mul(0.5)), float(a))).div(w), 0.0, 1.0);

let paletteTex = null;
function paletteTexture() {
  if (paletteTex) return paletteTex;
  const data = new Uint8Array(16 * 2 * 4);
  [TRIM, ACCENT].forEach((list, row) => list.forEach((hex, i) => {
    const o = (row * 16 + i) * 4;
    data[o] = (hex >> 16) & 255; data[o + 1] = (hex >> 8) & 255; data[o + 2] = hex & 255; data[o + 3] = 255;
  }));
  paletteTex = new THREE.DataTexture(data, 16, 2);
  paletteTex.colorSpace = THREE.SRGBColorSpace;
  paletteTex.magFilter = paletteTex.minFilter = THREE.NearestFilter;
  paletteTex.needsUpdate = true;
  return paletteTex;
}

function createHouseWallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0.0 });
  const info = attribute('wallInfo', 'vec4'); // meters along, meters up, wall length, kind
  // seed, eaves (meters up), a garage door's start & end along the wall; on gables and dormers z is -1 and w their height
  const house = attribute('houseInfo', 'vec4');
  const style = attribute('houseStyle', 'vec4'); // wall material, trim color, door & shutter color, foundation height
  const siding = attribute('color', 'vec3');
  const u = info.x, v = info.y, len = info.z, kind = info.w;
  const seed = house.x, eave = house.y, fh = style.w, matKind = style.x;
  const fwU = max(fwidth(u), 0.002), fwV = max(fwidth(v), 0.002);
  const kindIs = (k) => step(abs(kind.sub(k)), 0.1);
  const matIs = (k) => step(abs(matKind.sub(k)), 0.1);
  const isDoorWall = kindIs(K_FRONT), isFacade = kindIs(K_FACADE), isGable = kindIs(K_GABLE);
  const isDormer = kindIs(K_DORMER), isCheek = kindIs(K_CHEEK), isBlank = kindIs(K_BLANK);
  const frontLike = max(isDoorWall, isFacade);
  const storeyWall = max(frontLike, kindIs(K_WALL));
  const onGround = float(1.0).sub(max(isDormer, isCheek));
  const pal = paletteTexture();
  const trimColor = texture(pal, vec2(style.y.add(0.5).div(16.0), 0.25)).rgb;
  const accent = texture(pal, vec2(style.z.add(0.5).div(16.0), 0.75)).rgb;
  // this house's own window sizes, spacing, sashes and shutters
  const r1 = fract(seed.mul(1.913)), r2 = fract(seed.mul(3.171)), r3 = fract(seed.mul(5.337));
  const r4 = fract(seed.mul(7.719)), r5 = fract(seed.mul(2.713));

  // A garage door where the city's driveway meets this wall (GEO.garageDoors): white panels, 2.2 m high
  const gd0 = house.z, gd1 = house.w;
  const hasGarage = step(0.0, gd0);
  const garageDoor = box(u, gd0, gd1, fwU).mul(box(v, -0.6, 2.75, fwV)).mul(hasGarage);
  const garageTrim = box(u, gd0.sub(0.15), gd1.add(0.15), fwU).mul(box(v, -0.6, 2.9, fwV)).mul(hasGarage);
  const garageZone = box(u, gd0.sub(0.9), gd1.add(0.9), fwU).mul(step(v, 3.3)).mul(hasGarage);
  const panelLine = smoothstep(0.0, 0.06, fract(v.sub(0.5).div(0.56))).mul(0.25).add(0.75);

  // Storey walls: windows evenly along, closer on the front; storeys 2.8 m from the top of the foundation. The door
  // wall has an odd number of bays, the door in the middle one.
  const sp0 = mix(mix(float(3.7), float(5.3), r1), mix(float(3.0), float(4.1), r1), frontLike);
  const nEven = max(float(1.0), floor(len.div(sp0).add(0.5)));
  const nOdd = max(float(1.0), floor(len.div(sp0).sub(1.0).mul(0.5).add(0.5)).mul(2.0).add(1.0));
  const n = mix(nEven, nOdd, isDoorWall);
  const spacing = len.div(n);
  const col = floor(u.div(spacing));
  const x = fract(u.div(spacing)).sub(0.5).mul(spacing); // meters from the bay's middle
  const vs = v.sub(fh);
  const row = floor(vs.div(2.8));
  const y = fract(vs.div(2.8)).mul(2.8); // meters up its storey
  const winTop = mix(float(2.12), float(2.42), r3), winBot = mix(float(0.95), float(0.8), r3);
  const paired = step(r5, 0.3).mul(frontLike);
  const hwBase = mix(float(0.4), float(0.56), r2);
  const hw = min(mix(hwBase, hwBase.mul(2.0).add(0.05), paired), spacing.mul(0.5).sub(0.32));
  const rowFits = step(row.mul(2.8).add(fh).add(winTop).add(0.12), eave).mul(step(0.0, vs));
  const isDoorBay = isDoorWall.mul(step(abs(col.sub(floor(n.mul(0.5)))), 0.1)).mul(step(row, 0.1));
  const colKeep = max(frontLike, step(0.35, fract(sin(col.mul(12.9898).add(seed.mul(7.31)).add(len.mul(3.7))).mul(43758.5453))));
  const wallShow = storeyWall.mul(step(2.0, len)).mul(rowFits).mul(colKeep).mul(float(1.0).sub(garageZone));

  // Gables: an attic window (a pair on a wide one) where it fits under the slope; house.w is the gable's height
  const rh = house.w;
  const gx = u.sub(len.mul(0.5)), gy = v.sub(eave);
  const gPaired = step(7.0, len).mul(step(3.2, rh));
  const ghwBase = mix(float(0.32), float(0.46), r2);
  const ghw = mix(ghwBase, ghwBase.mul(2.0).add(0.05), gPaired);
  const gyb = mix(float(0.45), float(0.65), r4);
  const gyt = min(gyb.add(1.45), rh.mul(float(1.0).sub(ghw.add(0.3).div(len.mul(0.5)))));
  const gShow = isGable.mul(step(0.8, gyt.sub(gyb)));

  // Dormers: their face filled with windows; house.w is the face's height
  const dn = max(float(1.0), floor(len.div(1.35)));
  const dsp = len.div(dn);
  const dx = fract(u.div(dsp)).sub(0.5).mul(dsp);
  const dhw = min(float(0.42), dsp.mul(0.5).sub(0.16));
  const dShow = isDormer.mul(step(0.9, rh));

  const sel = (a, b, c) => mix(mix(a, b, isGable), c, isDormer);
  const WX = sel(x, gx, dx), WY = sel(y, gy, v), WHW = sel(hw, ghw, dhw);
  const WYB = sel(winBot, gyb, float(0.28)), WYT = sel(winTop, gyt, rh.sub(0.22));
  const pairedW = sel(paired, gPaired, float(0.0));
  const show = max(max(wallShow.mul(float(1.0).sub(isDoorBay)), gShow), dShow);

  const winOpen = box(WX, WHW.negate(), WHW, fwU).mul(box(WY, WYB, WYT, fwV)).mul(show);
  const winTrim = max(
    box(WX, WHW.negate().sub(0.13), WHW.add(0.13), fwU).mul(box(WY, WYB.sub(0.1), WYT.add(0.13), fwV)),
    box(WX, WHW.negate().sub(0.2), WHW.add(0.2), fwU).mul(box(WY, WYB.sub(0.17), WYB.sub(0.08), fwV))
  ).mul(show);
  // the sash's meeting rail, the middle muntin (a mullion between a pair), divided lights up top on some
  const mid = WYB.add(WYT).mul(0.5).add(0.1);
  const lightW = WHW.mul(2.0).div(mix(float(3.0), float(6.0), pairedW));
  const lightD = abs(fract(WX.add(WHW).div(lightW).add(0.5)).sub(0.5)).mul(lightW);
  const muntin = max(max(box(WY, mid.sub(0.04), mid.add(0.04), fwV), box(WX, mix(float(-0.03), float(-0.06), pairedW), mix(float(0.03), float(0.06), pairedW), fwU)),
    step(r4, 0.5).mul(step(mid, WY)).mul(step(lightD, 0.02)));
  // shutters beside the windows of some clapboard and brick houses
  const sw = WHW.mul(0.92);
  const shutter = step(0.68, r5).mul(step(matKind, 1.5)).mul(float(1.0).sub(pairedW)).mul(storeyWall)
    .mul(box(abs(WX), WHW.add(0.15), WHW.add(0.15).add(sw), fwU)).mul(box(WY, WYB, WYT, fwV)).mul(wallShow).mul(float(1.0).sub(isDoorBay));
  const louver = smoothstep(0.0, 0.3, fract(WY.div(0.07))).mul(0.25).add(0.75);
  // the front door, glazed at the top on some
  const doorOpen = box(x, -0.48, 0.48, fwU).mul(box(y, 0.0, 2.08, fwV)).mul(isDoorBay).mul(rowFits);
  const doorTrim = box(x, -0.62, 0.62, fwU).mul(box(y, 0.0, 2.24, fwV)).mul(isDoorBay).mul(rowFits);
  const doorGlass = box(x, -0.3, 0.3, fwU).mul(box(y, 1.3, 1.85, fwV)).mul(step(r3, 0.55)).mul(doorOpen);

  // Wall surfaces: clapboard, brick in running bond, coursed stone, stucco, cedar shakes; fine joints fade out far off
  const fadeFine = float(1.0).sub(smoothstep(0.012, 0.035, max(fwU, fwV)));
  const fadeCoarse = float(1.0).sub(smoothstep(0.03, 0.09, max(fwU, fwV)));
  const mortar = color(0xb9b2a6);
  const board = smoothstep(0.0, 0.25, fract(v.div(0.18))).mul(0.14).add(0.86);
  const clap = siding.mul(board);
  const bRow = floor(v.div(0.0762));
  const bU = u.div(0.203).add(mod(bRow, 2.0).mul(0.5));
  const bVar = fract(sin(bRow.mul(12.9898).add(floor(bU).mul(78.233)).add(seed)).mul(43758.5453));
  const bMortar = max(step(fract(v.div(0.0762)), 0.14), step(fract(bU), 0.05));
  const brick = mix(mix(siding, mortar, 0.15), mix(siding.mul(bVar.mul(0.3).add(0.82)), mortar, bMortar), fadeFine);
  const sRow = floor(v.div(0.32));
  const sU = u.div(0.7).add(fract(sin(sRow.mul(17.13).add(seed)).mul(4375.85)));
  const sVar = fract(sin(sRow.mul(12.9898).add(floor(sU).mul(78.233)).add(seed.mul(1.7))).mul(43758.5453));
  const sMortar = max(step(fract(v.div(0.32)), 0.08), step(fract(sU), 0.05));
  const stoneOf = (base) => mix(mix(base, mortar, 0.12), mix(base.mul(sVar.mul(0.4).add(0.75)), mortar, sMortar), fadeCoarse);
  const stucco = siding.mul(sin(u.mul(3.1).add(sin(v.mul(2.3)).mul(2.0))).mul(0.025).add(0.97));
  const kRow = floor(v.div(0.19));
  const kU = u.div(0.24).add(fract(kRow.mul(0.37)));
  const kVar = fract(sin(kRow.mul(12.9898).add(floor(kU).mul(78.233)).add(seed)).mul(43758.5453));
  const shake = siding.mul(kVar.mul(0.25).add(0.85)).mul(smoothstep(0.0, 0.3, fract(v.div(0.19))).mul(0.18).add(0.82))
    .mul(float(1.0).sub(step(fract(kU), 0.06).mul(0.4).mul(fadeFine)));
  // clapboard houses often have shingled gables
  const shingledGable = isGable.mul(matIs(M_CLAP)).mul(step(r4, 0.55));

  const corner = max(step(u, 0.14), step(len.sub(0.14), u)).mul(max(storeyWall, isBlank)).mul(max(matIs(M_CLAP), matIs(M_SHAKE)));
  const frieze = step(eave.sub(0.26), v).mul(storeyWall);
  const foundation = step(v, fh).mul(onGround);
  const stoneFoundation = step(fract(seed.mul(9.13)), 0.45);
  const lit = step(0.6, fract(sin(col.mul(12.99).add(row.mul(78.23)).add(seed.mul(3.7)).add(kind.mul(5.1))).mul(43758.5)));

  const nightFactor = smoothstep(0.7, 1.45, cityUniforms.uInteriorGlow);
  const glassColor = mix(color(0x1d262e), color(0x3a4650), smoothstep(WYB.add(0.2), WYT, WY));
  const glass = winOpen.mul(float(1.0).sub(muntin));
  mat.colorNode = Fn(() => {
    let c = clap;
    c = mix(c, brick, matIs(M_BRICK));
    c = mix(c, stoneOf(siding), matIs(M_STONE));
    c = mix(c, stucco, matIs(M_STUCCO));
    c = mix(c, shake, max(matIs(M_SHAKE), shingledGable));
    c = mix(c, trimColor, max(corner, frieze));
    c = mix(c, accent.mul(louver), shutter);
    c = mix(c, trimColor, max(winTrim, doorTrim));
    c = mix(c, glassColor, glass);
    c = mix(c, trimColor, winOpen.mul(muntin));
    c = mix(c, accent, doorOpen);
    c = mix(c, glassColor, doorGlass);
    c = mix(c, mix(color(0x8e8a83), stoneOf(color(0x8a8278)), stoneFoundation), foundation);
    c = mix(c, trimColor, garageTrim);
    c = mix(c, color(0xe9e6dc).mul(panelLine), garageDoor);
    return c;
  })();
  mat.roughnessNode = mix(float(0.82), float(0.12), max(glass, doorGlass));
  mat.emissiveNode = vec3(1.0, 0.72, 0.42).mul(max(glass.mul(lit), doorGlass).mul(nightFactor).mul(0.9));
  return mat;
}

// Porch railings: a top and bottom rail with balusters between, cut out of one quad (attribute railLen, meters)
function createRailMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, side: THREE.DoubleSide });
  const len = attribute('railLen', 'float');
  const p = uv();
  const m = p.x.mul(len), h = p.y.mul(0.92);
  const balusters = step(h, 0.84).mul(step(0.08, h)).mul(step(abs(fract(m.div(0.15)).sub(0.5)), 0.17));
  const rails = max(step(0.82, h), step(abs(h.sub(0.1)), 0.04));
  const ends = max(step(m, 0.08), step(len.sub(0.08), m));
  mat.colorNode = color(0xffffff);
  mat.opacityNode = max(max(balusters, rails), ends);
  mat.alphaTest = 0.5;
  return mat;
}

let wallMaterial = null, solidMaterial = null, railMaterial = null, stepMaterial = null, shrubMaterial = null, lampMaterial = null;

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

// House numbers: a dark plate beside each front door with its brass digits, all one instanced mesh whose shader
// picks each digit from a 0-9 atlas by the plate's number and digit count (attribute `plate`)
let plateMaterial = null;
function createPlateMaterial() {
  const W = 64, H = 96;
  const canvas = document.createElement('canvas');
  canvas.width = W * 10; canvas.height = H;
  const g = canvas.getContext('2d');
  g.fillStyle = '#1d2024';
  g.fillRect(0, 0, canvas.width, H);
  g.fillStyle = '#e6d39a';
  g.font = `600 ${Math.round(H * 0.74)}px Georgia, "Times New Roman", serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let d = 0; d < 10; d++) g.fillText(String(d), d * W + W / 2, H * 0.54);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.2 });
  const plate = attribute('plate', 'vec2'); // the number, its digit count
  const p = uv();
  const k = plate.y;
  // a 6% margin of plate at each end, the digits between
  const ux = p.x.sub(0.06).div(0.88);
  const inside = step(0.0, ux).mul(step(ux, 1.0));
  const i = floor(clamp(ux, 0.0, 0.9999).mul(k));
  const digit = mod(floor(plate.x.div(pow(float(10.0), k.sub(1.0).sub(i))).add(0.001)), 10.0);
  const cell = fract(clamp(ux, 0.0, 0.9999).mul(k));
  const vy = p.y.sub(0.1).div(0.8);
  const glyph = texture(tex, vec2(digit.add(clamp(cell, 0.04, 0.96)).div(10.0), clamp(vy, 0.0, 1.0)));
  mat.colorNode = mix(color(0x1d2024), glyph.rgb, inside.mul(step(0.0, vy)).mul(step(vy, 1.0)));
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry helpers. `hc` is the house being built: its cell, ground, seed, colors and style.

function pushWall(hc, a, b, y0, y1, kind, eaveRel) {
  const { c, g } = hc;
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  if (L < 0.05 || y1 <= y0) return;
  // the garage door is measured along the wall from a; the shader counts u the same way
  const gd = kind !== K_FRONT && hc.doors.length ? doorOnWall(hc.doors, a, b) : null;
  const nx = dz / L, nz = -dx / L;
  const o = c.pos.length / 3;
  c.pos.push(a.x, y0, a.z, b.x, y0, b.z, a.x, y1, a.z, b.x, y1, b.z);
  for (let k = 0; k < 4; k++) {
    c.nor.push(nx, 0, nz);
    c.col.push(...hc.sc);
    c.house.push(hc.seed, eaveRel, gd ? gd[0] : -1, gd ? gd[1] : -1);
    c.style.push(...hc.style);
  }
  c.info.push(0, y0 - g, L, kind, L, y0 - g, L, kind, 0, y1 - g, L, kind, L, y1 - g, L, kind);
  c.idx.push(o, o + 2, o + 1, o + 1, o + 2, o + 3);
}

// A flat convex wall face (a gable, a dormer's face or cheek) facing (nx, nz): its points [x, y, z], v measured up
// from vBase, w the gable's or dormer's height for the shader
function wallPoly(hc, pts, nx, nz, kind, eaveRel, w, vBase) {
  const { c } = hc;
  const us = pts.map((p) => -p[0] * nz + p[2] * nx);
  const u0 = Math.min(...us), len = Math.max(...us) - u0;
  if (len < 0.05) return;
  const o = c.pos.length / 3;
  pts.forEach((p, k) => {
    c.pos.push(p[0], p[1], p[2]);
    c.nor.push(nx, 0, nz);
    c.col.push(...hc.sc);
    c.house.push(hc.seed, eaveRel, -1, w);
    c.style.push(...hc.style);
    c.info.push(us[k] - u0, p[1] - vBase, len, kind);
  });
  const P0 = pts[0];
  for (let k = 1; k + 1 < pts.length; k++) {
    const P1 = pts[k], P2 = pts[k + 1];
    const e1x = P1[0] - P0[0], e1y = P1[1] - P0[1], e1z = P1[2] - P0[2];
    const e2x = P2[0] - P0[0], e2y = P2[1] - P0[1], e2z = P2[2] - P0[2];
    const cx = e1y * e2z - e1z * e2y, cz = e1x * e2y - e1y * e2x;
    if (cx * nx + cz * nz >= 0) c.idx.push(o, o + k, o + k + 1);
    else c.idx.push(o, o + k + 1, o + k);
  }
}

function sTri(c, A, B, C, rgb) {
  c.sPos.push(...A, ...B, ...C);
  for (let k = 0; k < 3; k++) c.sCol.push(...rgb);
}
function sQuad(c, A, B, C, D, rgb) {
  sTri(c, A, B, C, rgb);
  sTri(c, A, C, D, rgb);
}

// An upright box (centre p, its length along (ux, uz)) in vertex colour, into the cell's solid mesh
function addBox(c, p, ux, uz, len, dep, y0, y1, rgb) {
  const vx = -uz, vz = ux, hl = len / 2, hd = dep / 2;
  const C = (s, t, y) => [p.x + ux * hl * s + vx * hd * t, y, p.z + uz * hl * s + vz * hd * t];
  const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [s0, t0] = q[i], [s1, t1] = q[(i + 1) % 4];
    sQuad(c, C(s0, t0, y0), C(s1, t1, y0), C(s1, t1, y1), C(s0, t0, y1), rgb);
  }
  sQuad(c, C(-1, -1, y1), C(1, -1, y1), C(1, 1, y1), C(-1, 1, y1), rgb);
}

// A roof over the rectangle R (in the house's frame), its ridge along `along` ('u' or 'v'). Returns its frame (for
// dormers and chimneys), the soffit's height and the gable ends' profile.
function roofOf(hc, R, spec) {
  const { c, P } = hc;
  const alongU = spec.along === 'u';
  const cu = (R.u0 + R.u1) / 2, cv = (R.v0 + R.v1) / 2;
  const ha = (alongU ? R.u1 - R.u0 : R.v1 - R.v0) / 2, hb = (alongU ? R.v1 - R.v0 : R.u1 - R.u0) / 2;
  const W = (a, b, y) => { const p = alongU ? P(cu + a, cv + b) : P(cu + b, cv + a); return [p.x, y, p.z]; };
  const aDir = alongU ? hc.uDir : hc.vDir, bDir = alongU ? hc.vDir : hc.uDir;
  const { top, rh, shade } = spec;
  const ov = spec.ov ?? 0.45, ovr = 0.3, F = FASCIA;
  const trim = hc.trimRGB, soff = hc.soffitRGB;
  const frame = { W, aDir, bDir, ha, hb, top, rh, type: spec.type };

  if (spec.type === 'flat') {
    const A = ha + 0.3, B = hb + 0.3, y = top + 0.35;
    const k = [W(-A, -B, y), W(A, -B, y), W(A, B, y), W(-A, B, y)];
    sQuad(c, k[0], k[1], k[2], k[3], lin(FLAT_ROOF));
    for (let i = 0; i < 4; i++) {
      const p = k[i], q = k[(i + 1) % 4];
      sQuad(c, p, q, [q[0], top, q[2]], [p[0], top, p[2]], trim);
    }
    return { ...frame, soffit: top, ends: null };
  }

  if (spec.type === 'hip') {
    const s = rh / hb, eY = top - ov * s, A = ha + ov, B = hb + ov, rl = Math.max(0, ha - hb), ry = top + rh;
    const k = [W(-A, -B, eY), W(A, -B, eY), W(A, B, eY), W(-A, B, eY)];
    const r0 = W(-rl, 0, ry), r1 = W(rl, 0, ry);
    sQuad(c, k[0], k[1], r1, r0, shade);
    sQuad(c, k[2], k[3], r0, r1, shade);
    sTri(c, k[1], k[2], r1, shade);
    sTri(c, k[3], k[0], r0, shade);
    const w = [W(-ha, -hb, eY - F), W(ha, -hb, eY - F), W(ha, hb, eY - F), W(-ha, hb, eY - F)];
    for (let i = 0; i < 4; i++) {
      const p = k[i], q = k[(i + 1) % 4];
      sQuad(c, p, q, [q[0], eY - F, q[2]], [p[0], eY - F, p[2]], trim);
      sQuad(c, [p[0], eY - F, p[2]], [q[0], eY - F, q[2]], w[(i + 1) % 4], w[i], soff);
    }
    return { ...frame, soffit: eY - F, ends: null };
  }

  // Gable, gambrel and lean-to: a profile across the ridge, swept along it
  let prof, ends;
  if (spec.type === 'shed') {
    const hi = spec.high; // the side (+1 or -1 along b) that's high, against the main house
    const s = rh / (2 * hb), eY = top - ov * s;
    prof = [[-hi * (hb + ov), eY], [hi * hb, top + rh]];
    ends = [[-hi * hb, top], [hi * hb, top + rh], [hi * hb, top]];
  } else if (spec.type === 'gambrel') {
    const s1 = (0.7 * rh) / (0.5 * hb), eY = top - ov * s1, ky = top + 0.7 * rh;
    prof = [[-hb - ov, eY], [-0.5 * hb, ky], [0, top + rh], [0.5 * hb, ky], [hb + ov, eY]];
    ends = [[-hb, top], [-0.5 * hb, ky], [0, top + rh], [0.5 * hb, ky], [hb, top]];
  } else {
    const s = rh / hb, eY = top - ov * s;
    prof = [[-hb - ov, eY], [0, top + rh], [hb + ov, eY]];
    ends = [[-hb, top], [0, top + rh], [hb, top]];
  }
  const A0 = -ha - ovr, A1 = ha + ovr;
  for (let i = 0; i + 1 < prof.length; i++) {
    const [pb, py] = prof[i], [qb, qy] = prof[i + 1];
    sQuad(c, W(A0, pb, py), W(A1, pb, py), W(A1, qb, qy), W(A0, qb, qy), shade);
    // rake boards along the ends, and the rake's underside
    for (const sa of [-1, 1]) {
      sQuad(c, W(sa * A1, pb, py), W(sa * A1, qb, qy), W(sa * A1, qb, qy - F), W(sa * A1, pb, py - F), trim);
      sQuad(c, W(sa * ha, pb, py - F), W(sa * A1, pb, py - F), W(sa * A1, qb, qy - F), W(sa * ha, qb, qy - F), soff);
    }
  }
  // fascia and soffit along the eaves (a lean-to's low side only)
  let soffitY = Infinity;
  for (const [eb, ey] of [prof[0], prof[prof.length - 1]]) {
    if (spec.type === 'shed' && Math.sign(eb) === spec.high) continue;
    const wb = Math.sign(eb) * hb;
    sQuad(c, W(A0, eb, ey), W(A1, eb, ey), W(A1, eb, ey - F), W(A0, eb, ey - F), trim);
    sQuad(c, W(A0, wb, ey - F), W(A1, wb, ey - F), W(A1, eb, ey - F), W(A0, eb, ey - F), soff);
    soffitY = Math.min(soffitY, ey - F);
  }
  return { ...frame, soffit: soffitY, ends };
}

// A dormer on the roof `F` (gable or hip), on the slope toward sb (+1 or -1 along b), centered at ac along the ridge
function addDormer(hc, F, sb, ac, w, shed) {
  const { c } = hc;
  const yAt = (b) => F.top + F.rh * (1 - Math.abs(b) / F.hb);
  const nx = F.bDir.x * sb, nz = F.bDir.z * sb;
  const a0 = ac - w / 2, a1 = ac + w / 2;
  const cheeks = (bf, yb, yTop, bBack, yBack) => {
    for (const [a, s] of [[a0, -1], [a1, 1]]) {
      wallPoly(hc, [F.W(a, sb * bf, yb), F.W(a, sb * bf, yTop), F.W(a, sb * bBack, yBack)], F.aDir.x * s, F.aDir.z * s, K_CHEEK, 99, 0, yb);
    }
  };
  if (shed) {
    const yT = F.top + F.rh * 0.72;
    const bf = F.hb * (1 - (yT - 1.45 - F.top) / F.rh);
    const yBack = yT + 0.35, bBack = F.hb * (1 - (yBack - F.top) / F.rh);
    if (bf > F.hb - 0.5 || bf < 0.8 || bBack < 0 || bf - bBack < 0.5) return false;
    const yb = yAt(bf);
    wallPoly(hc, [F.W(a0, sb * bf, yb - 0.05), F.W(a1, sb * bf, yb - 0.05), F.W(a1, sb * bf, yT), F.W(a0, sb * bf, yT)],
      nx, nz, K_DORMER, 99, yT - yb, yb);
    cheeks(bf, yb, yT, bBack, yBack);
    const k = 0.35 / (bf - bBack), yF = yT + 0.02 - 0.25 * k;
    sQuad(c, F.W(a0 - 0.15, sb * (bf + 0.25), yF), F.W(a1 + 0.15, sb * (bf + 0.25), yF),
      F.W(a1 + 0.15, sb * bBack, yBack + 0.02), F.W(a0 - 0.15, sb * bBack, yBack + 0.02), hc.shade);
    sQuad(c, F.W(a0 - 0.15, sb * (bf + 0.25), yF), F.W(a1 + 0.15, sb * (bf + 0.25), yF),
      F.W(a1 + 0.15, sb * (bf + 0.25), yF - 0.16), F.W(a0 - 0.15, sb * (bf + 0.25), yF - 0.16), hc.trimRGB);
    return true;
  }
  const bf = F.hb * 0.62, yb = yAt(bf), yE = yb + 1.45;
  const ridgeD = yE + (w / 2) * 0.9;
  if (ridgeD > F.top + F.rh - 0.25) return false;
  const bE = F.hb * (1 - (yE - F.top) / F.rh), bR = F.hb * (1 - (ridgeD - F.top) / F.rh);
  if (bR < 0.1) return false;
  wallPoly(hc, [F.W(a0, sb * bf, yb - 0.05), F.W(a1, sb * bf, yb - 0.05), F.W(a1, sb * bf, yE), F.W(a0, sb * bf, yE)],
    nx, nz, K_DORMER, 99, yE - yb, yb);
  wallPoly(hc, [F.W(a0, sb * bf, yE), F.W(a1, sb * bf, yE), F.W(ac, sb * bf, ridgeD)], nx, nz, K_CHEEK, 99, 0, yb);
  cheeks(bf, yb, yE, bE, yE);
  const sd = (ridgeD - yE) / (w / 2), yEave = yE - 0.15 * sd;
  const bEave = F.hb * (1 - (yEave - F.top) / F.rh), bFront = sb * (bf + 0.2);
  for (const sa of [-1, 1]) {
    const aE = ac + sa * (w / 2 + 0.15);
    sQuad(c, F.W(aE, bFront, yEave), F.W(ac, bFront, ridgeD), F.W(ac, sb * bR, ridgeD), F.W(aE, sb * bEave, yEave), hc.shade);
    sQuad(c, F.W(aE, bFront, yEave), F.W(ac, bFront, ridgeD), F.W(ac, bFront, ridgeD - 0.16), F.W(aE, bFront, yEave - 0.16), hc.trimRGB);
  }
  return true;
}

// The stretches of rectangle R's side i that another rectangle covers from outside: [[t0, t1], ...]
function sideOf(R, i) {
  const cs = [[R.u0, R.v0], [R.u1, R.v0], [R.u1, R.v1], [R.u0, R.v1]];
  const [au, av] = cs[i], [bu, bv] = cs[(i + 1) % 4];
  const L = Math.hypot(bu - au, bv - av) || 1e-6;
  const du = (bu - au) / L, dv = (bv - av) / L;
  return { au, av, bu, bv, L, du, dv, nu: dv, nv: -du };
}
function coveredBy(S, O) {
  const pts = [[O.u0, O.v0], [O.u1, O.v0], [O.u1, O.v1], [O.u0, O.v1]];
  let nMin = Infinity, t0 = Infinity, t1 = -Infinity;
  for (const [u, v] of pts) {
    nMin = Math.min(nMin, (u - S.au) * S.nu + (v - S.av) * S.nv);
    const t = (u - S.au) * S.du + (v - S.av) * S.dv;
    t0 = Math.min(t0, t); t1 = Math.max(t1, t);
  }
  if (Math.abs(nMin) > 0.35) return null;
  t0 = Math.max(0, t0); t1 = Math.min(S.L, t1);
  return t1 - t0 > 0.3 ? [t0, t1] : null;
}

// ---------------------------------------------------------------------------------------------------------------------

// the city's address points in 20 m cells, made once for all the houses built from them (streamHouses builds a few
// streets' worth at a time)
const ADDR_CELL = 20;
const addressGrids = new WeakMap();
function addressGrid(addresses) {
  if (!addresses) return new Map();
  if (addressGrids.has(addresses)) return addressGrids.get(addresses);
  const addrGrid = new Map();
  for (let i = 0; i < addresses.length; i += 3) {
    const key = Math.floor(addresses[i] / ADDR_CELL) * 100000 + Math.floor(addresses[i + 1] / ADDR_CELL);
    if (!addrGrid.has(key)) addrGrid.set(key, []);
    addrGrid.get(key).push(i);
  }
  addressGrids.set(addresses, addrGrid);
  return addrGrid;
}

function buildHouses(records, addresses = null, { quiet = false } = {}) {
  const addrGrid = addressGrid(addresses);
  // the house's number: an address point inside its footprint, else the nearest within a few metres of it
  const numberFor = (ring, cx, cz, reach) => {
    let best = -1, bestD = reach * reach, inBest = -1, inD = Infinity;
    const ix = Math.floor(cx / ADDR_CELL), iz = Math.floor(cz / ADDR_CELL), span = Math.ceil(reach / ADDR_CELL);
    for (let a = ix - span; a <= ix + span; a++) for (let b = iz - span; b <= iz + span; b++) {
      for (const i of addrGrid.get(a * 100000 + b) || []) {
        const d = (addresses[i] - cx) ** 2 + (addresses[i + 1] - cz) ** 2;
        if (insideRing(ring, addresses[i], addresses[i + 1])) { if (d < inD) { inD = d; inBest = i; } }
        else if (d < bestD) { bestD = d; best = i; }
      }
    }
    const i = inBest >= 0 ? inBest : best;
    return i >= 0 ? addresses[i + 2] : 0;
  };
  const plates = []; // x, y, z, yaw, number, digits
  const rails = [];  // x, y, z, yaw, length, r, g, b
  const steps = [];  // x, y0, z, yaw, width, height, depth, r, g, b
  const shrubs = []; // x, y, z, radius, r, g, b
  const lamps = [];  // x, y, z, yaw

  wallMaterial ||= createHouseWallMaterial();
  solidMaterial ||= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, side: THREE.DoubleSide });
  const cells = new Map();
  const cellOf = (x, z) => {
    const key = Math.floor(x / 1000) + ',' + Math.floor(z / 1000);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { pos: [], nor: [], col: [], info: [], house: [], style: [], idx: [], sPos: [], sCol: [] }));
    return c;
  };
  let houses = 0, porches = 0, wings = 0, dormers = 0, tagged = 0;

  for (const r of records) {
    const ring0 = r.polygons[0] && r.polygons[0].outer;
    if (!ring0 || ring0.length < 3) continue;
    const ring = ringArea(ring0) < 0 ? [...ring0].reverse() : ring0; // counter-clockwise in x, z: walls face out
    const fb = orientedBox(ring);
    const area = Math.abs(ringArea(ring));
    const g = r.ground ?? 0;
    const garage = r.garage || area < 45;
    const id = (k) => hash(r.cx, r.cz, k);
    const historic = !garage && historicDistrictAt(r.cx, r.cz) !== null;

    // the house's frame: u along its box, v across
    const vx = -fb.az, vz = fb.ax;
    const P = (u, v) => ({ x: fb.cx + fb.ax * u + vx * v, z: fb.cz + fb.az * u + vz * v });
    const loc = ring.map((p) => {
      const dx = p.x - fb.cx, dz = p.z - fb.cz;
      return { u: dx * fb.ax + dz * fb.az, v: dx * vx + dz * vz };
    });
    const rects = garage ? [{ u0: -fb.L / 2, u1: fb.L / 2, v0: -fb.W / 2, v1: fb.W / 2 }] : decompose(loc, fb.L, fb.W);
    const M = rects[0], wingRects = rects.slice(1);
    wings += wingRects.length;

    // Storeys from the surveyed height (the LiDAR roof average, which reads low), a storey and a half where the
    // second floor lives under the roof
    const h = Math.max(3, r.height);
    const storeys = garage ? 0 : h < 4.6 ? 1 : h < 6.6 ? 1.5 : h < 10 ? 2 : 3;
    const ranch = storeys === 1 && !historic;
    const fh = garage ? 0.12 : historic ? 0.75 + 0.3 * id(21) : ranch ? 0.3 + 0.2 * id(21) : 0.5 + 0.35 * id(21);

    // Walls: clapboard in Ann Arbor's colors, about one in five brick, a few stone, stucco or cedar shakes
    const m = id(2);
    const brickP = historic ? 0.22 : ranch ? 0.25 : 0.18;
    let matKind = M_CLAP;
    if (!garage) {
      if (m < brickP) matKind = M_BRICK;
      else if (m < brickP + 0.03) matKind = M_STONE;
      else if (m < brickP + 0.07) matKind = M_STUCCO;
      else if (m < brickP + 0.07 + (storeys === 1.5 ? 0.15 : 0.05)) matKind = M_SHAKE;
    }
    const sidingHex = matKind === M_BRICK ? pick(BRICKS, id(3)) : matKind === M_STONE ? pick(STONES, id(3))
      : matKind === M_STUCCO ? pick(STUCCO, id(3)) : matKind === M_SHAKE ? pick(SHAKES, id(3))
      : pick(historic && id(12) < 0.5 ? HERITAGE : SIDING, id(3));
    // trim: white on most; dark on some light houses, contrasting colors on historic ones
    const tr = id(9);
    const light = luma(sidingHex) > 0.7;
    let trim = 0;
    if (historic && matKind === M_CLAP) trim = tr < 0.4 ? 0 : tr < 0.6 ? 1 : pick([2, 4, 6, 3], (tr - 0.6) / 0.4);
    else if (light && matKind === M_CLAP) trim = tr < 0.6 ? 0 : pick([2, 3, 5, 7], (tr - 0.6) / 0.4);
    else trim = tr < 0.72 ? 0 : tr < 0.92 ? 1 : 6;
    const accent = Math.floor(id(10) * ACCENT.length);
    const trimRGB = lin(TRIM[trim]);
    const hc = {
      c: cellOf(r.cx, r.cz), g, P, seed: id(4) * 100, sc: lin(sidingHex), style: [matKind, trim, accent, fh],
      doors: doorsNear(r.cx, r.cz), uDir: { x: fb.ax, z: fb.az }, vDir: { x: vx, z: vz },
      trimRGB, soffitRGB: trimRGB.map((x) => x * 0.8), shade: lin(pick(SHINGLES, id(5)))
    };
    const c = hc.c;
    const wn = (S) => ({ x: fb.ax * S.nu + vx * S.nv, z: fb.az * S.nu + vz * S.nv });

    // The front: the main block's side that faces the street
    const street = garage ? null : streetDirection(r.cx, r.cz);
    let frontSide = -1, frontScore = 0.3;
    if (street) {
      for (let i = 0; i < 4; i++) {
        const n = wn(sideOf(M, i));
        const s = n.x * street.x + n.z * street.z;
        if (s > frontScore) { frontScore = s; frontSide = i; }
      }
    }
    // the door: in the longest stretch of that side no wing covers, else on the wing in front
    let door = null; // { rect, side, t0, t1 }
    if (frontSide >= 0) {
      const S = sideOf(M, frontSide);
      const cov = wingRects.map((w) => coveredBy(S, w)).filter(Boolean).sort((a, b) => a[0] - b[0]);
      let t = 0, best = null;
      for (const [a, b] of [...cov, [S.L, S.L]]) {
        if (a - t > (best ? best[1] - best[0] : 0)) best = [t, a];
        t = Math.max(t, b);
      }
      if (best && best[1] - best[0] >= 3.4) door = { rect: M, side: frontSide, t0: best[0], t1: best[1], cov };
      else {
        const w = wingRects.find((w) => coveredBy(S, w));
        if (w && sideOf(w, frontSide).L >= 2.4) door = { rect: w, side: frontSide, t0: 0, t1: sideOf(w, frontSide).L, cov: [] };
        else door = { rect: M, side: frontSide, t0: 0, t1: S.L, cov: [] };
      }
    }

    // The main roof: as mapped, else from the house's shape and age
    const tag = garage ? 0 : taggedRoof(ring, r.cx, r.cz);
    if (tag) tagged++;
    const mL = M.u1 - M.u0, mW = M.v1 - M.v0;
    const frontAlong = frontSide < 0 ? (mL >= mW ? 'u' : 'v') : frontSide % 2 === 0 ? 'u' : 'v';
    const deepAlong = frontAlong === 'u' ? 'v' : 'u';
    const fw = frontAlong === 'u' ? mL : mW, depth = frontAlong === 'u' ? mW : mL;
    const longer = mL >= mW ? 'u' : 'v';
    const ratio = Math.max(mL, mW) / Math.max(1, Math.min(mL, mW));
    const rr = id(11);
    let type = 'gable', along = longer;
    if (garage) { type = 'gable'; along = longer; }
    else if (tag === 3) type = 'flat';
    else if (tag === 2) { type = 'hip'; along = longer; }
    else if (tag === 4) { type = 'gambrel'; along = frontAlong; }
    else if (tag === 1 || tag === 5 || tag === 6) along = fw <= depth * 1.05 ? deepAlong : frontAlong;
    else if (storeys >= 2 && ratio < 1.3 && rr < 0.7) { type = 'hip'; along = longer; }
    else if (fw <= depth * 1.05) { if (rr < 0.85 || frontSide < 0) along = deepAlong; else { type = 'hip'; along = longer; } }
    else if (storeys === 1.5) along = rr < 0.8 ? frontAlong : deepAlong;
    else if (storeys === 1) { if (rr < 0.45) { type = 'hip'; along = longer; } else along = frontAlong; }
    else if (rr < 0.55) along = frontAlong;
    else if (rr < 0.8) { type = 'hip'; along = longer; }
    else if (rr < 0.86) { type = 'gambrel'; along = frontAlong; }
    else along = deepAlong;
    const pitch = garage ? 0.45 : type === 'hip' ? (ranch ? 0.4 : 0.55) : storeys === 1.5 ? 0.95 : ranch ? 0.42 : historic ? 0.85 : 0.7;
    const mainTop = garage ? g + Math.max(2.4, Math.min(3, h - 1)) : g + fh + (storeys === 1.5 ? 3.25 : Math.floor(storeys) * 2.8 + 0.2);
    const hbM = (along === 'u' ? mW : mL) / 2;
    const rhM = type === 'flat' ? 0 : Math.max(0.9, Math.min(garage ? 2 : 6.5, hbM * pitch));
    const roofSpecs = [{ type, along, top: mainTop, rh: rhM, shade: hc.shade }];

    // Wings: lower, with their own cross gable, or a lean-to against the house
    const mainSoffitGuess = mainTop - 0.45 * pitch - FASCIA;
    for (const w of wingRects) {
      let touch = -1;
      for (let i = 0; i < 4 && touch < 0; i++) if (coveredBy(sideOf(M, i), w)) touch = i;
      const wl = w.u1 - w.u0, ww = w.v1 - w.v0;
      const projAxis = touch < 0 ? (wl >= ww ? 'u' : 'v') : touch % 2 === 0 ? 'v' : 'u';
      const proj = projAxis === 'u' ? wl : ww, wid = projAxis === 'u' ? ww : wl;
      const wArea = wl * ww;
      if (touch >= 0 && (proj < 2.8 || wArea < 14)) {
        const top = Math.min(g + fh + 3.0, mainSoffitGuess - 0.75);
        const rh = Math.max(0.25, Math.min(proj * 0.3, 1.2, mainSoffitGuess - 0.05 - top));
        const S = sideOf(M, touch);
        const nAlongB = projAxis === 'u' ? S.nu : S.nv; // the side's outward normal, along the lean-to's b axis
        roofSpecs.push({ type: 'shed', along: projAxis === 'u' ? 'v' : 'u', high: -Math.sign(nAlongB), top, rh, shade: hc.shade });
        continue;
      }
      const tall = storeys >= 2 && wArea >= 30 && Math.min(wl, ww) >= 4.5 && id(30 + roofSpecs.length) < 0.5;
      let top = tall ? mainTop : Math.min(g + fh + 3.0, mainTop);
      const wAlong = wid <= proj * 1.6 ? projAxis : projAxis === 'u' ? 'v' : 'u';
      const hb = (wAlong === 'u' ? ww : wl) / 2;
      let rh = Math.min(hb * Math.max(pitch, 0.6), mainTop + rhM - top - 0.4);
      if (rh < 0.8 && tall) { top = Math.min(g + fh + 3.0, mainTop); rh = Math.min(hb * Math.max(pitch, 0.6), mainTop + rhM - top - 0.4); }
      if (rh < 0.6) roofSpecs.push({ type: 'flat', along: wAlong, top, rh: 0, shade: hc.shade });
      else roofSpecs.push({ type: 'gable', along: wAlong, top, rh: Math.min(rh, 5), shade: hc.shade });
    }

    // Roofs first (they say where the soffits are), then the walls under them
    const frames = rects.map((R, k) => roofOf(hc, R, roofSpecs[k]));
    const base = g - 0.6;
    rects.forEach((R, k) => {
      const spec = roofSpecs[k], F = frames[k];
      const endSides = spec.type === 'hip' || spec.type === 'flat' ? [] : spec.along === 'u' ? [1, 3] : [0, 2];
      for (let i = 0; i < 4; i++) {
        const S = sideOf(R, i);
        // a wing's wall against the main house is inside it
        if (k > 0) {
          const cv = coveredBy(S, M);
          if (cv && cv[1] - cv[0] > S.L * 0.7) continue;
        }
        const A = P(S.au, S.av);
        const at = (t) => P(S.au + S.du * t, S.av + S.dv * t);
        const isEnd = endSides.includes(i);
        const eaveRel = (isEnd ? spec.top - 0.02 : F.soffit) - g;
        const kindOf = garage ? K_BLANK : K_WALL;
        if (door && door.rect === R && door.side === i) {
          // the front: the door's stretch, the rest of the front beside it, wings' stretches behind them
          const cuts = [...new Set([0, S.L, door.t0, door.t1, ...door.cov.flat()].map((t) => Math.max(0, Math.min(S.L, t))))].sort((a, b) => a - b);
          for (let j = 0; j + 1 < cuts.length; j++) {
            const t0 = cuts[j], t1 = cuts[j + 1];
            if (t1 - t0 < 0.05) continue;
            const midT = (t0 + t1) / 2;
            const kind = midT > door.t0 && midT < door.t1 ? K_FRONT : door.cov.some(([a, b]) => midT > a && midT < b) ? K_WALL : K_FACADE;
            pushWall(hc, at(t0), at(t1), base, spec.top, kind, eaveRel);
          }
        } else pushWall(hc, A, at(S.L), base, spec.top, kindOf, eaveRel);
        // the gable over an end wall
        if (isEnd && F.ends) {
          const sa = i === 1 || i === 2 ? 1 : -1;
          const n = wn(S);
          const pts = F.ends.map(([b, y]) => F.W(sa * F.ha, b, y));
          wallPoly(hc, pts, n.x, n.z, spec.type === 'shed' ? K_BLANK : garage ? K_BLANK : K_GABLE, spec.top - g, spec.rh, g);
        }
      }
    });

    // The roofs' shapes on the house's collider, so the helicopter can set down on them (controllers.js)
    if (r.collider) {
      r.collider.roofs = rects.map((R, k) => {
        const F = frames[k], s = roofSpecs[k], C = P((R.u0 + R.u1) / 2, (R.v0 + R.v1) / 2);
        return { cx: C.x, cz: C.z, ax: F.aDir.x, az: F.aDir.z, bx: F.bDir.x, bz: F.bDir.z, ha: F.ha, hb: F.hb,
          top: s.top, rh: s.rh, type: s.type, high: s.high || 0 };
      });
    }
    const MF = frames[0];
    // Dormers on a storey-and-a-half house, and on many foursquares' hipped roofs
    if (!garage && (type === 'gable' || type === 'hip') && (storeys === 1.5 || (type === 'hip' && storeys >= 2 && id(13) < 0.7))) {
      const fN = frontSide >= 0 ? wn(sideOf(M, frontSide)) : null;
      const dotB = fN ? fN.x * MF.bDir.x + fN.z * MF.bDir.z : 0;
      if (Math.abs(dotB) > 0.7) {
        // the front slope: one wide shed dormer, or one or two gabled ones
        const sb = Math.sign(dotB);
        const ridgeLen = 2 * MF.ha;
        if (type === 'gable' && id(14) < 0.45 && ridgeLen > 6) { if (addDormer(hc, MF, sb, 0, ridgeLen * 0.5, true)) dormers++; }
        else if (type === 'gable' && ridgeLen > 9 && id(14) < 0.75) {
          for (const s of [-1, 1]) if (addDormer(hc, MF, sb, s * ridgeLen * 0.22, 1.9, false)) dormers++;
        } else if (addDormer(hc, MF, sb, 0, Math.min(2.4, ridgeLen * 0.35), false)) dormers++;
      } else if (type === 'gable' && storeys === 1.5 && MF.ha > 3.5) {
        // a front-gabled house: a shed dormer on one side slope
        if (addDormer(hc, MF, id(15) < 0.5 ? -1 : 1, -MF.ha * 0.15, MF.ha * 0.9, true)) dormers++;
      }
    }

    // A chimney: up the outside of a side gable, else through the roof near the ridge
    if (!garage && type !== 'flat' && id(6) < (historic ? 0.7 : 0.45)) {
      const chim = matKind === M_BRICK ? hc.sc : lin(CHIMNEY);
      const capRGB = chim.map((x) => x * 0.6);
      const ridgeY = MF.top + MF.rh;
      const fN = frontSide >= 0 ? wn(sideOf(M, frontSide)) : { x: 0, z: 0 };
      const endFacesFront = Math.abs(fN.x * MF.aDir.x + fN.z * MF.aDir.z) > 0.7;
      const sgn = id(7) < 0.5 ? -1 : 1;
      if ((type === 'gable' || type === 'gambrel') && !endFacesFront) {
        const b = MF.hb * 0.3 * (id(16) < 0.5 ? -1 : 1);
        const p3 = MF.W(sgn * (MF.ha + 0.32), b, 0), p = { x: p3[0], z: p3[2] };
        addBox(c, p, MF.bDir.x, MF.bDir.z, 1.1, 0.62, g - 0.3, MF.top - 0.4, chim);
        addBox(c, p, MF.bDir.x, MF.bDir.z, 0.72, 0.6, MF.top - 0.4, ridgeY + 0.7, chim);
        addBox(c, p, MF.bDir.x, MF.bDir.z, 0.84, 0.72, ridgeY + 0.7, ridgeY + 0.82, capRGB);
      } else {
        const b = MF.hb * 0.3 * sgn, a = (MF.ha - MF.hb > 1 ? (MF.ha - MF.hb) * 0.6 : MF.ha * 0.3) * (id(16) < 0.5 ? -1 : 1);
        const p3 = MF.W(a, b, 0), p = { x: p3[0], z: p3[2] };
        const yTop = Math.max(MF.top + MF.rh * (1 - Math.abs(b) / MF.hb) + 1.0, ridgeY + 0.4);
        addBox(c, p, MF.aDir.x, MF.aDir.z, 0.72, 0.6, MF.top, yTop, chim);
        addBox(c, p, MF.aDir.x, MF.aDir.z, 0.84, 0.72, yTop, yTop + 0.12, capRGB);
      }
    }

    // The front door's wall: its porch or stoop and steps, its light and number, a walk to the street, shrubs
    if (door && !garage) {
      const R = door.rect, S = sideOf(R, door.side);
      const A0 = P(S.au, S.av), B0 = P(S.bu, S.bv);
      const dir = { x: (B0.x - A0.x) / S.L, z: (B0.z - A0.z) / S.L }, N = { x: dir.z, z: -dir.x };
      const Q = (t, d) => ({ x: A0.x + dir.x * t + N.x * d, z: A0.z + dir.z * t + N.z * d });
      const doorT = (door.t0 + door.t1) / 2, segLen = door.t1 - door.t0;
      const deckY = g + fh;
      const blockTop = roofSpecs[rects.indexOf(R)].top, blockSoffit = frames[rects.indexOf(R)].soffit;
      const yaw = Math.atan2(-dir.z, dir.x);
      const craftsman = storeys === 1.5 || (!historic && storeys === 1 && id(17) < 0.3);
      const hasPorch = segLen >= 3.4 && id(8) < (historic ? 0.85 : ranch ? 0.3 : 0.65);
      const nSteps = Math.max(1, Math.round(fh / 0.18)), riser = fh / nSteps;
      const sw = craftsman ? 1.8 : 1.5;
      let outD;
      if (hasPorch) {
        porches++;
        const full = (historic && id(18) < 0.6) || (craftsman && id(18) < 0.7);
        const pw = full ? segLen - 0.2 : Math.min(segLen - 0.4, 3.6 + id(19) * 1.8);
        const t0 = doorT - pw / 2, t1 = doorT + pw / 2;
        const pd = historic ? 2.5 + id(20) * 0.5 : 2.1 + id(20) * 0.6;
        const ph = Math.min(deckY + 2.65, blockSoffit - 0.45);
        outD = pd;
        // the deck on its skirt, the ceiling, posts (on brick piers on a craftsman porch), beams
        addBox(c, Q(doorT, pd / 2), dir.x, dir.z, pw, pd, g - 0.4, deckY - 0.1, matKind === M_BRICK ? hc.sc : lin(0x6d6a64));
        addBox(c, Q(doorT, pd / 2 + 0.03), dir.x, dir.z, pw + 0.08, pd + 0.06, deckY - 0.1, deckY, lin(DECK));
        const nPosts = pw > 6.2 ? 4 : 2;
        for (let k = 0; k < nPosts; k++) {
          const p = Q(t0 + 0.2 + (k * (pw - 0.4)) / (nPosts - 1), pd - 0.2);
          if (craftsman) {
            addBox(c, p, dir.x, dir.z, 0.5, 0.5, deckY, deckY + 0.95, matKind === M_SHAKE || matKind === M_CLAP ? lin(pick(BRICKS, id(22))) : hc.sc);
            addBox(c, p, dir.x, dir.z, 0.3, 0.3, deckY + 0.95, ph - 0.28, trimRGB);
          } else addBox(c, p, dir.x, dir.z, 0.17, 0.17, deckY, ph - 0.28, trimRGB);
        }
        addBox(c, Q(doorT, pd - 0.2), dir.x, dir.z, pw, 0.24, ph - 0.3, ph, trimRGB);
        for (const t of [t0 + 0.2, t1 - 0.2]) addBox(c, Q(t, pd / 2), N.x, N.z, pd, 0.2, ph - 0.3, ph, trimRGB);
        sQuad(c, [Q(t0, 0).x, ph, Q(t0, 0).z], [Q(t1, 0).x, ph, Q(t1, 0).z], [Q(t1, pd).x, ph, Q(t1, pd).z], [Q(t0, pd).x, ph, Q(t0, pd).z], lin(CEILING));
        // its roof: a lean-to off the house, with fascia
        const yb = Math.min(ph + 0.05 + (pd + 0.3) * 0.28, blockSoffit - 0.05, blockTop - 0.1);
        const yf = ph + 0.05;
        const e0 = Q(t0 - 0.3, 0), e1 = Q(t1 + 0.3, 0), f0 = Q(t0 - 0.3, pd + 0.3), f1 = Q(t1 + 0.3, pd + 0.3);
        sQuad(c, [e0.x, yb, e0.z], [e1.x, yb, e1.z], [f1.x, yf, f1.z], [f0.x, yf, f0.z], hc.shade);
        sQuad(c, [f0.x, yf, f0.z], [f1.x, yf, f1.z], [f1.x, yf - 0.2, f1.z], [f0.x, yf - 0.2, f0.z], trimRGB);
        for (const [e, f] of [[e0, f0], [e1, f1]]) sQuad(c, [e.x, yb, e.z], [f.x, yf, f.z], [f.x, yf - 0.2, f.z], [e.x, yb - 0.2, e.z], trimRGB);
        // railings round the deck, open at the steps
        if (fh >= 0.4 && id(23) < 0.85) {
          const rail = (p, q) => {
            const L = Math.hypot(q.x - p.x, q.z - p.z);
            if (L < 0.4) return;
            rails.push((p.x + q.x) / 2, deckY, (p.z + q.z) / 2, Math.atan2(-(q.z - p.z), q.x - p.x), L, ...trimRGB);
          };
          rail(Q(t0 + 0.2, pd - 0.2), Q(doorT - sw / 2, pd - 0.2));
          rail(Q(doorT + sw / 2, pd - 0.2), Q(t1 - 0.2, pd - 0.2));
          rail(Q(t0 + 0.2, 0.15), Q(t0 + 0.2, pd - 0.2));
          rail(Q(t1 - 0.2, 0.15), Q(t1 - 0.2, pd - 0.2));
        }
        // shrubs either side of the steps, and at the porch's ends
        for (const s of [-1, 1]) {
          const p = Q(doorT + s * (sw / 2 + 0.75), pd + 0.6);
          shrubs.push(p.x, groundHeight(p.x, p.z), p.z, 0.5 + id(24 + s) * 0.3, ...lin(pick(SHRUBS, id(26 + s))));
          const t = s < 0 ? t0 - 0.9 : t1 + 0.9;
          if (t > 0.6 && t < S.L - 0.6) {
            const q = Q(t, 0.8);
            shrubs.push(q.x, groundHeight(q.x, q.z), q.z, 0.6 + id(28 + s) * 0.35, ...lin(pick(SHRUBS, id(29 + s))));
          }
        }
      } else {
        // a stoop: a landing at the door
        outD = 1.3;
        addBox(c, Q(doorT, 0.65), dir.x, dir.z, 1.9, 1.3, g - 0.3, deckY, lin(CONCRETE));
        for (const s of [-1, 1]) for (const t of [doorT + s * 1.9, doorT + s * 3.4]) {
          if (t < 0.6 || t > S.L - 0.6) continue;
          const p = Q(t, 0.75);
          shrubs.push(p.x, groundHeight(p.x, p.z), p.z, 0.45 + id(31 + t) * 0.3, ...lin(pick(SHRUBS, id(33 + t))));
        }
      }
      // steps down from the porch or stoop
      const stepRGB = hasPorch ? lin(DECK) : lin(CONCRETE);
      for (let k = 1; k <= nSteps; k++) {
        const top = deckY - k * riser;
        if (top <= g + 0.02) break;
        const p = Q(doorT, outD + (k - 0.5) * 0.3);
        steps.push(p.x, g - 0.3, p.z, yaw, sw, top - (g - 0.3), 0.3, ...stepRGB);
      }
      // the porch light by the door and the house number on the other side
      const lp = Q(doorT - 0.9, 0.08);
      lamps.push(lp.x, deckY + 1.8, lp.z, yaw);
      if (addresses) {
        const num = numberFor(ring, r.cx, r.cz, Math.max(fb.L, fb.W) / 2 + 8);
        if (num > 0) {
          const pp = Q(doorT + 0.95, 0.03);
          plates.push(pp.x, deckY + 1.6, pp.z, Math.atan2(N.x, N.z), num, String(num).length);
        }
      }
      // a front walk from the steps to the sidewalk, following the ground
      const startD = outD + nSteps * 0.3;
      const s0 = Q(doorT, startD);
      const toStreet = distanceToStreet(s0.x, s0.z, N.x, N.z);
      const walkLen = toStreet - 2.0;
      if (walkLen > 0.8 && walkLen < 30) {
        const n = Math.ceil(walkLen / 2.5), walkRGB = lin(CONCRETE);
        for (let k = 0; k < n; k++) {
          const d0 = startD + (walkLen * k) / n, d1 = startD + (walkLen * (k + 1)) / n;
          const p = [Q(doorT - 0.6, d0), Q(doorT + 0.6, d0), Q(doorT + 0.6, d1), Q(doorT - 0.6, d1)]
            .map((q) => [q.x, groundHeight(q.x, q.z) + 0.05, q.z]);
          sQuad(c, p[0], p[1], p[2], p[3], walkRGB);
        }
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
      geo.setAttribute('houseStyle', new THREE.Float32BufferAttribute(c.style, 4));
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

  // The details only seen up close, instanced so the scene's culling draws them only near the camera
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const at = new THREE.Vector3(), size = new THREE.Vector3(), col = new THREE.Color();
  const instanced = (geo, mat, count, name, cull, fill) => {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) fill(i);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.name = name;
    mesh.userData.terrain = 'set';
    mesh.userData.cullDistance = cull;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  if (rails.length) {
    railMaterial ||= createRailMaterial();
    const count = rails.length / 8, geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const lens = new Float32Array(count);
    instanced(geo, railMaterial, count, 'PorchRailings', 220, (i) => {
      const o = i * 8;
      lens[i] = rails[o + 4];
      mtx.compose(at.set(rails[o], rails[o + 1], rails[o + 2]), q.setFromAxisAngle(up, rails[o + 3]), size.set(rails[o + 4], 0.92, 1));
      return null;
    });
    const mesh = group.children[group.children.length - 1];
    for (let i = 0; i < count; i++) {
      const o = i * 8;
      mtx.compose(at.set(rails[o], rails[o + 1], rails[o + 2]), q.setFromAxisAngle(up, rails[o + 3]), size.set(rails[o + 4], 0.92, 1));
      mesh.setMatrixAt(i, mtx);
      mesh.setColorAt(i, col.setRGB(rails[o + 5], rails[o + 6], rails[o + 7]));
    }
    geo.setAttribute('railLen', new THREE.InstancedBufferAttribute(lens, 1));
  }
  if (steps.length) {
    stepMaterial ||= new THREE.MeshStandardNodeMaterial({ roughness: 0.9 });
    const count = steps.length / 10, geo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const mesh = instanced(geo, stepMaterial, count, 'PorchSteps', 280, () => {});
    for (let i = 0; i < count; i++) {
      const o = i * 10;
      mtx.compose(at.set(steps[o], steps[o + 1], steps[o + 2]), q.setFromAxisAngle(up, steps[o + 3]), size.set(steps[o + 4], steps[o + 5], steps[o + 6]));
      mesh.setMatrixAt(i, mtx);
      mesh.setColorAt(i, col.setRGB(steps[o + 7], steps[o + 8], steps[o + 9]));
    }
  }
  if (shrubs.length) {
    shrubMaterial ||= new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
    const count = shrubs.length / 7, geo = new THREE.IcosahedronGeometry(1, 1);
    const mesh = instanced(geo, shrubMaterial, count, 'HouseShrubs', 320, () => {});
    for (let i = 0; i < count; i++) {
      const o = i * 7, rad = shrubs[o + 3];
      mtx.compose(at.set(shrubs[o], shrubs[o + 1] + rad * 0.5, shrubs[o + 2]), q.setFromAxisAngle(up, i * 1.7), size.set(rad, rad * 0.8, rad));
      mesh.setMatrixAt(i, mtx);
      mesh.setColorAt(i, col.setRGB(shrubs[o + 4], shrubs[o + 5], shrubs[o + 6]));
    }
  }
  if (lamps.length) {
    if (!lampMaterial) {
      lampMaterial = new THREE.MeshStandardNodeMaterial({ color: 0xf1e6c8, roughness: 0.4 });
      lampMaterial.emissiveNode = color(0xffc477).mul(smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow).mul(3.0).add(0.02));
    }
    const count = lamps.length / 4, geo = new THREE.BoxGeometry(0.16, 0.26, 0.14);
    const mesh = instanced(geo, lampMaterial, count, 'PorchLights', 450, () => {});
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      mtx.compose(at.set(lamps[o], lamps[o + 1], lamps[o + 2]), q.setFromAxisAngle(up, lamps[o + 3]), size.set(1, 1, 1));
      mesh.setMatrixAt(i, mtx);
    }
  }

  if (plates.length) {
    plateMaterial ||= createPlateMaterial();
    const count = plates.length / 6;
    const geo = new THREE.PlaneGeometry(1, 1);
    const info = new Float32Array(count * 2);
    const mesh = new THREE.InstancedMesh(geo, plateMaterial, count);
    for (let i = 0; i < count; i++) {
      const o = i * 6, digits = plates[o + 5];
      info[i * 2] = plates[o + 4];
      info[i * 2 + 1] = digits;
      at.set(plates[o], plates[o + 1], plates[o + 2]);
      size.set(0.15 * digits + 0.06, 0.24, 1);
      mesh.setMatrixAt(i, mtx.compose(at, q.setFromAxisAngle(up, plates[o + 3]), size));
    }
    geo.setAttribute('plate', new THREE.InstancedBufferAttribute(info, 2));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'HouseNumbers';
    mesh.userData.terrain = 'set'; // on the house's own ground already
    mesh.userData.cullDistance = 160;
    group.add(mesh);
  }
  if (!quiet) console.info(`[houses] ${houses} houses, ${wings} wings, ${dormers} dormers, ${porches} porches, ${tagged} mapped roofs, ` +
    `${rails.length / 8} railings, ${shrubs.length / 7} shrubs, ${plates.length / 6} house numbers`);
  return group;
}

// The houses built only near the player (a phone, or a Mac without much memory: device-tier.js), in STREAM_CELL
// squares: those within `radius` of (x, z) now, the rest a square a frame as the player comes near (update, each
// frame), and those left 300 m beyond it let go. Every house's collider stays, built or not. The porch details in a
// square are hidden beyond their own distances (`cullDistance`, scaled by `farCut`), as the scene's culling would.
const STREAM_CELL = 250;
function streamHouses(records, addresses, { radius, x, z, farCut = 1 }) {
  const cells = new Map();
  for (const r of records) {
    const key = Math.floor(r.cx / STREAM_CELL) * 100000 + Math.floor(r.cz / STREAM_CELL);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(r);
  }
  const group = new THREE.Group();
  group.name = 'AnnArborHouses';
  const built = new Map();
  const distance = (key, px, pz) => {
    const cx = Math.round(key / 100000), cz = key - cx * 100000;
    const dx = Math.max(cx * STREAM_CELL - px, 0, px - (cx + 1) * STREAM_CELL);
    const dz = Math.max(cz * STREAM_CELL - pz, 0, pz - (cz + 1) * STREAM_CELL);
    return Math.hypot(dx, dz);
  };
  const build = (key) => {
    const made = buildHouses(cells.get(key), addresses, { quiet: true });
    for (const m of made.children) {
      // ground that comes and goes casts its own shadow, not a stand-in's that would stay (scene-culling.js)
      delete m.userData.shadowStandIn;
      m.userData.streamed = true;
    }
    group.add(made);
    made.updateMatrixWorld(true);
    built.set(key, made);
  };
  const near = (px, pz) => [...cells.keys()].filter((k) => !built.has(k) && distance(k, px, pz) < radius)
    .sort((a, b) => distance(a, px, pz) - distance(b, px, pz));
  for (const k of near(x, z)) build(k);
  const update = (px, pz) => {
    for (const [k, made] of built) {
      const d = distance(k, px, pz);
      if (d > radius + 300) {
        made.removeFromParent();
        made.traverse((o) => o.geometry?.dispose());
        built.delete(k);
        continue;
      }
      for (const m of made.children) if (m.userData.cullDistance) m.visible = d < m.userData.cullDistance * farCut;
    }
    const next = near(px, pz)[0];
    if (next !== undefined) build(next);
  };
  group.userData.stream = { update, built };
  console.info(`[houses] ${records.length} houses in ${cells.size} squares, ${built.size} built near the start`);
  return group;
}

export { buildHouses, streamHouses };
