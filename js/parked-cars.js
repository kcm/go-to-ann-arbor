import * as THREE from 'three/webgpu';
import { GEO } from './city-geodata.js';
import { PARKING_LOTS } from './city-config.js';
import { BODY_SPECS, buildCarGeometry, buildCarProxyGeometry, buildSteerableWheelGeo, createLoftedCarMaterial, annArborCar } from './cars.js';
import { groundHeight, groundTilt } from './terrain.js';
import { curbStalls } from './curb-parking.js';
import { vehicleContact, resolveVehicleContact } from './vehicle-physics.js';

// Parked cars: about two in three stalls of every surface parking lot (in the stalls parking-stripes.js paints: rows
// off the lot's longest edge, back to back every 18 m), and the curb lanes of the main streets downtown, around campus
// and in Kerrytown where the street is wide enough beside its traffic lanes. Each is a solid box to the player, a body
// of its own weight that a car hitting it shoves along and spins (handbrake on, so it slides to a stop: step()), drawn with the traffic's car models, in full near the camera and as the light stand-in further off,
// re-sorted a few times a second around wherever the camera is.

const STALL_W = 2.7, MODULE = 18;
const NEAR = 70, FAR = 650;
const LAWN_Y = 0.284; // Lamp: the driveways' height (city-grid.js, LAWN_Y + 0.004)

const MASS = { sedan: 1600, suv: 2100, minivan: 2000, pickup: 2400, van: 2700, sports: 1450 };
const KINDS = ['sedan', 'sedan', 'suv', 'sedan', 'suv', 'minivan', 'suv', 'pickup', 'sedan', 'suv', 'van', 'sedan', 'suv', 'pickup', 'sports'];
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

function buildParkedCars(group, nearTrack = null) {
  let spots = [];
  lotCars(spots);
  streetCars(spots);
  // none parked across a railroad track (its middle and both ends of the car kept 3 m clear of the rails' middle)
  if (nearTrack) spots = spots.filter((s) => {
    const sn = Math.sin(s.yaw), cs = Math.cos(s.yaw);
    return ![0, 2.2, -2.2].some((d) => nearTrack(s.x + sn * d, s.z + cs * d, 3.2));
  });
  const colliders = [];
  const byKind = {};
  // One parked car: where it stands, how it's tilted on the ground and the box it is to the player
  const record = (s, kind, hex, style) => {
    const col = new THREE.Color(hex);
    const g = groundHeight(s.x, s.z);
    const [pitch, roll] = groundTilt(s.x, s.z, s.yaw);
    const car = { x: s.x, z: s.z, yaw: s.yaw, y: s.y || 0, street: s.street, kind, hex, paint: [col.r, col.g, col.b], style, g, pitch, roll };
    const spec = BODY_SPECS[kind];
    const hz = (spec.zFront - spec.zRear) / 2, hx = 0.95, mid = (spec.zFront + spec.zRear) / 2;
    const cs = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    const cx = s.x + sn * mid, cz = s.z + cs * mid;
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    car.collider = { minX: cx - ex, maxX: cx + ex, minZ: cz - ez, maxZ: cz + ez, minY: g + car.y, maxY: g + car.y + 1.6,
      obb: { cx, cz, hx, hz, cs, sn }, parked: car };
    Object.assign(car, { mid, halfL: hz, halfW: hx, mass: MASS[kind] ?? 1600, vx: 0, vz: 0, w: 0 });
    colliders.push(car.collider);
    return car;
  };
  for (const s of spots) {
    const kind = KINDS[Math.floor(hash(s.x, s.z, 4) * KINDS.length)];
    const look = annArborCar(kind, Math.floor(hash(s.x, s.z, 5) * 1000));
    (byKind[kind] ||= []).push(record(s, kind, look.hex, look.style));
  }

  const euler = new THREE.Euler(), quat = new THREE.Quaternion(), wpos = new THREE.Vector3(), wscale = new THREE.Vector3();
  const matrixOf = (c, m = new THREE.Matrix4()) => m.makeRotationFromEuler(euler.set(-c.pitch, c.yaw, -c.roll, 'YXZ'))
    .setPosition(c.x, c.g + c.y, c.z);
  // the full model's wheels are drawn on their own, as the traffic's are: the sedan's wheel scaled to this kind's
  const wheelsOf = (c, out = null) => {
    const spec = BODY_SPECS[c.kind];
    const r = spec.wheelRadius, sc = r / 0.35, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const fresh = !out;
    if (fresh) out = [];
    let i = 0;
    for (const side of [-1, 1]) {
      for (const wz of [spec.wheelZ, -spec.wheelZ]) {
        const x = c.x + side * spec.wheelX * cs + wz * sn, z = c.z - side * spec.wheelX * sn + wz * cs;
        // each wheel keeps the turn it was parked at (shoved sideways, it slides rather than rolls)
        c.spins ??= [];
        c.spins[i] ??= hash(x, z, 9) * 6;
        const m = fresh ? new THREE.Matrix4() : out[i];
        m.compose(wpos.set(x, groundHeight(x, z) + c.y + r, z), quat.setFromEuler(euler.set(c.spins[i], c.yaw, -c.roll, 'YXZ')),
          wscale.set(sc, sc, sc));
        if (fresh) out.push(m);
        i++;
      }
    }
    return out;
  };

  // per kind: the full model near the camera and the stand-in further off, with room for every car of the kind and a
  // few more (the cars the player leaves where they took another, made for a kind as it's first left)
  const SPARE = 12;
  const setFor = (kind, cars = []) => {
    const spec = BODY_SPECS[kind];
    const mat = createLoftedCarMaterial(spec, null, { parked: true }); // engine off, lamps dark
    const capacity = cars.length + SPARE;
    const make = (geo) => {
      geo.setAttribute('paintColor', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3));
      geo.setAttribute('carState', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
      const m = new THREE.InstancedMesh(geo, mat, capacity);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.terrain = 'set';
      group.add(m);
      return m;
    };
    return { kind, capacity, cars, matrices: cars.map((c) => matrixOf(c)), wheels: cars.map((c) => wheelsOf(c)),
      near: make(buildCarGeometry(spec, false)), far: make(buildCarProxyGeometry(spec)) };
  };
  const sets = Object.entries(byKind).map(([kind, cars]) => setFor(kind, cars));
  const wheelMat = createLoftedCarMaterial(BODY_SPECS.sedan, 0xffbe14);
  const wheelMesh = (side) => {
    const m = new THREE.InstancedMesh(buildSteerableWheelGeo(BODY_SPECS.sedan, side), wheelMat, Math.max(1, (spots.length + SPARE * 2) * 2));
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
    set.cars[k].slot = mesh; set.cars[k].n = n;
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
        c.slot = null; c.wn = -1; c.set = set; c.k = k;
        if (c.gone) continue;
        const d2 = (c.x - px) ** 2 + (c.z - pz) ** 2;
        if (d2 > far2) continue;
        put(d2 < near2 ? set.near : set.far, 0, set, k);
        if (d2 < near2 && wheelL.count + 2 <= wheelL.instanceMatrix.count) {
          const w = set.wheels[k];
          c.wn = wheelL.count;
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

  // The parked car nearest (x, z) within `reach` metres, or null
  function nearest(x, z, reach) {
    let best = null, bestD = reach * reach;
    for (const set of sets) {
      for (const c of set.cars) {
        if (c.gone) continue;
        const d = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    return best;
  }

  // Cars shoved by a crash: each slides on its locked wheels (about 0.45 g: in park, not braked) and its spin dies down, knocks the parked cars
  // it runs into the same way, and is drawn where it is now. `wake` sets one going (its vx, vz and w already set);
  // `solid(car)` pushes it out of the buildings and posts around it. Says the boxes that moved, for the player's
  // colliders.
  const rolling = new Set(), moved = [];
  const bodyA = {}, bodyB = {}, hit = {};
  const readBody = (c, b) => {
    const o = c.collider.obb;
    b.x = o.cx; b.z = o.cz; b.sin = o.sn; b.cos = o.cs;
    b.halfW = c.halfW; b.halfL = c.halfL; b.mass = c.mass;
    b.vx = c.vx; b.vz = c.vz; b.angularVel = c.w;
  };
  // move the box's centre by (dx, dz) and turn it by dYaw, keeping the car's pose, box and drawing together
  function place(c, dx, dz, dYaw) {
    const o = c.collider.obb;
    o.cx += dx; o.cz += dz;
    c.yaw += dYaw;
    o.cs = Math.cos(c.yaw); o.sn = Math.sin(c.yaw);
    c.x = o.cx - o.sn * c.mid; c.z = o.cz - o.cs * c.mid;
    const ex = Math.abs(o.cs) * o.hx + Math.abs(o.sn) * o.hz, ez = Math.abs(o.sn) * o.hx + Math.abs(o.cs) * o.hz;
    const col = c.collider;
    col.minX = o.cx - ex; col.maxX = o.cx + ex; col.minZ = o.cz - ez; col.maxZ = o.cz + ez;
    c.dirty = true;
  }
  function wake(c) {
    if (!c.gone) rolling.add(c);
  }
  function step(dt, solid) {
    moved.length = 0;
    if (!rolling.size) return moved;
    for (const c of rolling) {
      if (c.gone) { rolling.delete(c); continue; }
      const sp = Math.hypot(c.vx, c.vz);
      const slow = Math.max(0, sp - 4.5 * dt) / (sp || 1);
      c.vx *= slow; c.vz *= slow;
      c.w = Math.sign(c.w) * Math.max(0, Math.abs(c.w) - 3.2 * dt) * Math.exp(-1.5 * dt);
      place(c, c.vx * dt, c.vz * dt, c.w * dt);
      // the parked cars beside it
      readBody(c, bodyA);
      const reach = c.halfL * 2 + 1;
      for (const set of sets) {
        for (const o of set.cars) {
          if (o === c || o.gone || Math.abs(o.x - c.x) > reach || Math.abs(o.z - c.z) > reach) continue;
          readBody(o, bodyB);
          if (!vehicleContact(bodyA, bodyB, hit)) continue;
          const share = o.mass / (c.mass + o.mass);
          place(c, hit.nx * hit.depth * share, hit.nz * hit.depth * share, 0);
          place(o, -hit.nx * hit.depth * (1 - share), -hit.nz * hit.depth * (1 - share), 0);
          readBody(c, bodyA);
          readBody(o, bodyB);
          if (resolveVehicleContact(bodyA, bodyB, hit) > 0) {
            c.vx = bodyA.vx; c.vz = bodyA.vz; c.w = bodyA.angularVel;
            o.vx = bodyB.vx; o.vz = bodyB.vz; o.w = bodyB.angularVel;
            rolling.add(o);
          }
          moved.push(o.collider);
        }
      }
      if (solid) { solid(c); place(c, 0, 0, 0); }
      moved.push(c.collider);
      if (Math.abs(c.vx) < 0.03 && Math.abs(c.vz) < 0.03 && Math.abs(c.w) < 0.03) {
        c.vx = c.vz = c.w = 0;
        rolling.delete(c);
      }
    }
    // drawn where they are now, on the ground there
    for (const col of moved) {
      const c = col.parked;
      if (!c.dirty) continue;
      c.dirty = false;
      c.g = groundHeight(c.x, c.z);
      [c.pitch, c.roll] = groundTilt(c.x, c.z, c.yaw);
      col.minY = c.g + c.y; col.maxY = c.g + c.y + 1.6;
      if (!c.set) continue;
      matrixOf(c, c.set.matrices[c.k]);
      wheelsOf(c, c.set.wheels[c.k]);
      if (c.slot) {
        c.slot.setMatrixAt(c.n, c.set.matrices[c.k]);
        c.slot.instanceMatrix.needsUpdate = true;
      }
      if (c.wn >= 0) {
        const w = c.set.wheels[c.k];
        wheelL.setMatrixAt(c.wn, w[0]); wheelL.setMatrixAt(c.wn + 1, w[1]);
        wheelR.setMatrixAt(c.wn, w[2]); wheelR.setMatrixAt(c.wn + 1, w[3]);
        wheelL.instanceMatrix.needsUpdate = true;
        wheelR.instanceMatrix.needsUpdate = true;
      }
    }
    return moved;
  }

  // The player takes `car` and leaves their own (`drop`: { kind, hex, style, x, z, yaw, y }) parked where it stood. Says
  // what the taken car looks like, and the box of the one left, for the player's colliders.
  const history = [];
  // (car null: only `drop` is left, when the player took a car out of traffic instead)
  function take(car, drop) {
    if (car?.gone || (!car && !drop)) return null;
    if (car) {
      car.gone = true;
      car.collider.maxY = -Infinity;
    }
    let left = null;
    if (drop && BODY_SPECS[drop.kind]) {
      let set = sets.find((s) => s.kind === drop.kind);
      if (!set) sets.push(set = setFor(drop.kind));
      if (set.cars.length < set.capacity) {
        left = record(drop, drop.kind, drop.hex, drop.style ?? 0);
        set.cars.push(left);
        set.matrices.push(matrixOf(left));
        set.wheels.push(wheelsOf(left));
      }
    }
    lastX = Infinity;
    history.push({ take: car ? [car.x, car.z] : null, drop: drop ? { kind: drop.kind, hex: drop.hex, style: drop.style ?? 0, x: drop.x, z: drop.z, yaw: drop.yaw, y: drop.y || 0 } : null });
    if (history.length > 40) history.shift();
    return { look: car ? { kind: car.kind, hex: car.hex, style: car.style } : null, collider: left?.collider ?? null };
  }

  // The cars taken and left in an earlier play, again
  function replay(list) {
    const added = [];
    for (const step of list || []) {
      const [x, z] = step.take || [];
      const car = Number.isFinite(x) && Number.isFinite(z) ? nearest(x, z, 0.6) : null;
      if (step.take && !car) continue;
      const done = take(car, step.drop);
      if (done?.collider) added.push(done.collider);
    }
    return added;
  }

  console.info(`[parked] ${spots.length} parked cars, ${spots.filter((s) => s.street).length} on the streets`);
  return { group, colliders, update, step, wake, count: spots.length, nearest, take, replay, history };
}

export { buildParkedCars };
