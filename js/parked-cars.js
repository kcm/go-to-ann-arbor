import * as THREE from 'three/webgpu';
import { GEO } from './nyc-geodata.js';
import { PARKING_LOTS } from './city-config.js';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, buildSteerableWheelGeo, createLoftedCarMaterial, carStyleCode } from './cars.js';
import { groundHeight, groundTilt } from './terrain.js';
import { curbStalls } from './curb-parking.js';

// Parked cars: about two in three stalls of every surface parking lot (in the stalls parking-stripes.js paints: rows
// off the lot's longest edge, back to back every 18 m), and the curb lanes of the main streets downtown, around campus
// and in Kerrytown where the street is wide enough beside its traffic lanes. They never move: each is a solid box to
// the player, drawn with the traffic's car models, in full near the camera and as the light stand-in further off,
// re-sorted a few times a second around wherever the camera is.

const STALL_W = 2.7, MODULE = 18;
const NEAR = 70, FAR = 650;
const LAWN_Y = 0.239;

const KINDS = ['sedan', 'sedan', 'suv', 'sedan', 'suv', 'minivan', 'suv', 'pickup', 'sedan', 'suv', 'van', 'sedan', 'suv', 'pickup'];
const PAINT = [0xf2f4f7, 0x1c2026, 0xc8d0d8, 0x52575e, 0x9aa2ac, 0x1d3b6c, 0x741d22, 0xe6eaef, 0x363b42, 0x28382e, 0x20385c,
  0x787670, 0x8f1a1d, 0xbec6cf, 0x14171b];

const hash = (x, z, k = 0) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };

function inside(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}
const inLot = (rings, x, z) => inside(rings[0], x, z) && !rings.slice(1).some((h) => inside(h, x, z));

// The lot's frame, as parking-stripes.js draws its stalls: its longest edge's start, along it, and into the lot
function lotFrame(ring) {
  let best = 0, ox = 0, oz = 0, ax = 1, az = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    cx += p.x; cz += p.z;
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L > best) { best = L; ox = p.x; oz = p.z; ax = (q.x - p.x) / L; az = (q.z - p.z) / L; }
  }
  cx /= ring.length; cz /= ring.length;
  const s = (cx - ox) * -az + (cz - oz) * ax >= 0 ? 1 : -1;
  return { ox, oz, ax, az, nx: -az * s, nz: ax * s };
}

function lotCars(out) {
  for (const rings of PARKING_LOTS) {
    const ring = rings[0];
    if (ring.length < 3) continue;
    const f = lotFrame(ring);
    let uMax = 0, vMax = 0, uMin = 0;
    for (const p of ring) {
      const u = (p.x - f.ox) * f.ax + (p.z - f.oz) * f.az, v = (p.x - f.ox) * f.nx + (p.z - f.oz) * f.nz;
      uMin = Math.min(uMin, u); uMax = Math.max(uMax, u); vMax = Math.max(vMax, v);
    }
    for (let m = 0; m * MODULE < vMax; m++) {
      // a row facing in off each module's start, and one backed onto the next module's
      for (const [vc, facing] of [[m * MODULE + 2.9, -1], [m * MODULE + 15.25, 1]]) {
        for (let u = Math.floor(uMin / STALL_W) * STALL_W + STALL_W / 2; u < uMax; u += STALL_W) {
          const x = f.ox + f.ax * u + f.nx * vc, z = f.oz + f.az * u + f.nz * vc;
          if (hash(x, z, 1) > 0.66) continue;
          let ok = true;
          for (const [du, dv] of [[-1.05, -2.5], [1.05, -2.5], [1.05, 2.5], [-1.05, 2.5]]) {
            if (!inLot(rings, x + f.ax * du + f.nx * dv, z + f.az * du + f.nz * dv)) { ok = false; break; }
          }
          if (!ok) continue;
          // most pull in nose first, some back in
          const way = hash(x, z, 2) < 0.8 ? facing : -facing;
          out.push({ x, z, yaw: Math.atan2(f.nx * way, f.nz * way), y: LAWN_Y });
        }
      }
    }
  }
}

function streetCars(out) {
  const cuts = [];
  for (const c of GEO.curbCuts || []) cuts.push(c[0], c[1]);
  const cutGrid = new Map();
  for (let i = 0; i < cuts.length; i += 2) {
    const k = `${Math.floor(cuts[i] / 20)},${Math.floor(cuts[i + 1] / 20)}`;
    if (!cutGrid.has(k)) cutGrid.set(k, []);
    cutGrid.get(k).push(cuts[i], cuts[i + 1]);
  }
  const nearCut = (x, z) => {
    const gx = Math.floor(x / 20), gz = Math.floor(z / 20);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const c = cutGrid.get(`${gx + i},${gz + j}`);
      if (c) for (let k = 0; k < c.length; k += 2) if (Math.hypot(c[k] - x, c[k + 1] - z) < 4.5) return true;
    }
    return false;
  };
  // about seven in ten of the stalls marked along the parking lanes (curb-parking.js), facing the way traffic goes
  for (const st of curbStalls()) {
    if (hash(st.x, st.z, 3) > 0.72 || nearCut(st.x, st.z)) continue;
    const yaw = st.side > 0 ? Math.atan2(st.tx, st.tz) : Math.atan2(-st.tx, -st.tz);
    out.push({ x: st.x, z: st.z, yaw, y: 0, street: true });
  }
}

function buildParkedCars(group) {
  const spots = [];
  lotCars(spots);
  streetCars(spots);
  const colliders = [];
  const byKind = {};
  for (const s of spots) {
    const kind = KINDS[Math.floor(hash(s.x, s.z, 4) * KINDS.length)];
    const col = new THREE.Color(PAINT[Math.floor(hash(s.x, s.z, 5) * PAINT.length)]);
    const style = carStyleCode({ livery: 0, metallic: hash(s.x, s.z, 6) < 0.6 ? 1 : 0, trim: Math.floor(hash(s.x, s.z, 7) * 3), wheel: Math.floor(hash(s.x, s.z, 8) * 4) });
    const g = groundHeight(s.x, s.z);
    const [pitch, roll] = groundTilt(s.x, s.z, s.yaw);
    const car = { ...s, kind, paint: [col.r, col.g, col.b], style, g, pitch, roll };
    (byKind[kind] ||= []).push(car);
    const spec = BODY_SPECS[kind];
    const hz = (spec.zFront - spec.zRear) / 2, hx = 0.95, mid = (spec.zFront + spec.zRear) / 2;
    const cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    const cx = s.x + sn * mid, cz = s.z + cs * mid;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    colliders.push({ minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: g + s.y, maxY: g + s.y + 1.6,
      obb: { cx, cz, hx, hz, cs, sn } });
  }

  // per kind: the full model near the camera and the stand-in further off, with room for every car of the kind
  const meshes = [];
  const sets = Object.entries(byKind).map(([kind, cars]) => {
    const spec = BODY_SPECS[kind];
    const mat = createLoftedCarMaterial(spec);
    const make = (geo) => {
      const n = cars.length;
      geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4));
      const m = new THREE.InstancedMesh(geo, mat, n);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.terrain = 'set';
      group.add(m);
      meshes.push(m);
      return m;
    };
    const matrices = cars.map((c) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-c.pitch, c.yaw, -c.roll, 'YXZ'))
      .setPosition(c.x, c.g + c.y, c.z));
    // the full model's wheels are drawn on their own, as the traffic's are: the sedan's wheel scaled to this kind's
    const wheels = cars.map((c) => {
      const r = spec.wheelRadius, sc = r / 0.35, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const out = [];
      for (const side of [-1, 1]) {
        for (const wz of [spec.wheelZ, -spec.wheelZ]) {
          const x = c.x + side * spec.wheelX * cs + wz * sn, z = c.z - side * spec.wheelX * sn + wz * cs;
          out.push(new THREE.Matrix4().compose(new THREE.Vector3(x, groundHeight(x, z) + c.y + r, z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(hash(x, z, 9) * 6, c.yaw, -c.roll, 'YXZ')), new THREE.Vector3(sc, sc, sc)));
        }
      }
      return out;
    });
    return { cars, matrices, wheels, near: make(buildCarGeometry(spec, false)), far: make(buildCarProxyGeometry(spec)) };
  });
  const wheelMat = createLoftedCarMaterial(BODY_SPECS.sedan, 0xffbe14);
  const wheelMesh = (side) => {
    const m = new THREE.InstancedMesh(buildSteerableWheelGeo(BODY_SPECS.sedan, side), wheelMat, Math.max(1, spots.length * 2));
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    group.add(m);
    return m;
  };
  const wheelL = wheelMesh(-1), wheelR = wheelMesh(1);
  group.name = 'ParkedCars';
  group.userData.terrain = 'set';

  const put = (mesh, i, set, k) => {
    const n = mesh.count++;
    mesh.setMatrixAt(n, set.matrices[k]);
    const c = set.cars[k];
    mesh.geometry.attributes.paintColor.array.set(c.paint, n * 3);
    mesh.geometry.attributes.carState.array.set([0, 0, 0, c.style], n * 4);
  };
  let lastX = Infinity, lastZ = Infinity;
  function update(camera) {
    const px = camera.position.x, pz = camera.position.z;
    if (Math.hypot(px - lastX, pz - lastZ) < 12) return;
    lastX = px; lastZ = pz;
    const far2 = FAR * FAR, near2 = NEAR * NEAR;
    wheelL.count = 0; wheelR.count = 0;
    for (const set of sets) {
      set.near.count = 0; set.far.count = 0;
      for (let k = 0; k < set.cars.length; k++) {
        const c = set.cars[k];
        const d2 = (c.x - px) ** 2 + (c.z - pz) ** 2;
        if (d2 > far2) continue;
        put(d2 < near2 ? set.near : set.far, 0, set, k);
        if (d2 < near2) {
          const w = set.wheels[k];
          wheelL.setMatrixAt(wheelL.count++, w[0]); wheelL.setMatrixAt(wheelL.count++, w[1]);
          wheelR.setMatrixAt(wheelR.count++, w[2]); wheelR.setMatrixAt(wheelR.count++, w[3]);
        }
      }
      for (const m of [set.near, set.far]) {
        m.instanceMatrix.needsUpdate = true;
        m.geometry.attributes.paintColor.needsUpdate = true;
        m.geometry.attributes.carState.needsUpdate = true;
      }
    }
    wheelL.instanceMatrix.needsUpdate = true;
    wheelR.instanceMatrix.needsUpdate = true;
  }
  console.info(`[parked] ${spots.length} parked cars, ${spots.filter((s) => s.street).length} on the streets`);
  return { group, colliders, update, count: spots.length };
}

export { buildParkedCars };
