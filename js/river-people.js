// People out on the Huron: kayakers paddling and tubers drifting down from the top of the Argo Cascades, through its
// chutes and on down the river, each put back in at the top when they reach the end of their run.
//
// Their way down is traced once from the river's flow (terrain.js's riverFlow, the cascades' channel and chutes in
// cascades.js), kept off the banks; each keeps to a lane of its own across it. Hulls, paddles and tubes are drawn as
// one instanced mesh each, and the people in them are posed like the player's paddler (pedestrians.js) while near.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { riverFlow, riverDepth, waterLevel } from './terrain.js';
import { chuteNear, CASCADE_ENTRY } from './cascades.js';
import { PersonCrowd, PersonRig } from './pedestrians.js';

const STEP = 3; // metres between the points of the way down
const RUN = 2400; // the longest run before they're put back in at the top
const KAYAKS = 9, TUBES = 7;
const DRAWN = 320, POSED = 140; // drawn within this far of the view, their people posed within this

// The way down: from the top of the channel, along its chutes, then wherever the river runs, nudged to the middle of
// the open water. Each point has how much room there is to each side (left, right) and how much it's lined up on a
// chute (pull), where everyone squeezes into the middle.
function traceWay() {
  const pts = [];
  let x = CASCADE_ENTRY.x, z = CASCADE_ENTRY.z, tx = CASCADE_ENTRY.tx, tz = CASCADE_ENTRY.tz;
  const flow = { x: 0, z: 0 };
  const room = (nx, nz, side) => {
    let w = 0;
    for (let o = 1.5; o <= 24; o += 1.5) {
      if (riverDepth(x + nx * o * side, z + nz * o * side) < 0.6) break;
      w = o;
    }
    return w;
  };
  for (let i = 0; i < RUN / STEP; i++) {
    const ch = chuteNear(x, z);
    let dx = tx, dz = tz, pull = 0;
    if (ch) {
      pull = ch.pull;
      const k = Math.max(-1, Math.min(1, ch.across * 0.3)) * pull * 0.7;
      dx = ch.tx - ch.tz * k; dz = ch.tz + ch.tx * k;
    } else if (riverFlow(x, z, flow)) { dx = flow.x; dz = flow.z; }
    tx = tx * 0.55 + dx * 0.45; tz = tz * 0.55 + dz * 0.45;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const nx = -tz, nz = tx, left = room(nx, nz, -1), right = room(nx, nz, 1);
    if (!ch) { const shift = (right - left) * 0.5 * 0.35; x += nx * shift; z += nz * shift; }
    pts.push({ x, z, left, right, pull, s: 0, tx, tz });
    x += tx * STEP; z += tz * STEP;
    if (riverDepth(x, z) < 0.3 || waterLevel(x, z) == null) break;
    // never round in circles in a backwater
    if (i > 40 && pts.slice(0, -30).some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 4)) break;
  }
  // smoothed, then measured
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i].x = (pts[i - 1].x + pts[i].x * 2 + pts[i + 1].x) / 4;
      pts[i].z = (pts[i - 1].z + pts[i].z * 2 + pts[i + 1].z) / 4;
    }
  }
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    pts[i].tx = (b.x - a.x) / l; pts[i].tz = (b.z - a.z) / l;
    if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[i].s = s;
  }
  return pts;
}

// A kayak's hull and deck, shaped like the player's (controllers.js), and its cockpit
function kayakGeometry() {
  const L = 1.85, B = 0.36;
  const shape = (geo, height) => {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.abs(pos.getZ(i)));
      pos.setXYZ(i, pos.getX(i) * B * (1 - 0.55 * t * t), pos.getY(i) * height * (1 - 0.25 * t * t) + 0.1 + 0.09 * t ** 3, pos.getZ(i) * L);
    }
    geo.computeVertexNormals();
    return geo;
  };
  const hull = mergeGeometries([
    shape(new THREE.SphereGeometry(1, 20, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0.2),
    shape(new THREE.SphereGeometry(1, 20, 4, 0, Math.PI * 2, 0, Math.PI / 2), 0.12)
  ]);
  const cockpit = mergeGeometries([
    new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2).scale(0.23, 1, 0.37).translate(0, 0.232, -0.12),
    new THREE.TorusGeometry(1, 0.08, 5, 18).rotateX(Math.PI / 2).scale(0.24, 0.3, 0.38).translate(0, 0.236, -0.12)
  ]);
  return { hull, cockpit };
}

// A paddle: a dark shaft with a coloured blade at each end, across the paddler's lap (+X along the shaft)
function paddleGeometry() {
  const coloured = (geo, hex) => {
    geo = geo.index ? geo.toNonIndexed() : geo;
    const c = new THREE.Color(hex), n = geo.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'color'].includes(k)) geo.deleteAttribute(k);
    return geo;
  };
  const blade = () => new THREE.BoxGeometry(0.44, 0.006, 0.16);
  return mergeGeometries([
    coloured(new THREE.CylinderGeometry(0.016, 0.016, 2.1, 6).rotateZ(Math.PI / 2), 0x2a2d33),
    coloured(blade().translate(0.82, 0, 0).rotateX(Math.PI / 2), 0xf2f2f2),
    coloured(blade().translate(-0.82, 0, 0).rotateX(Math.PI / 2), 0xf2f2f2)
  ]);
}

function buildRiverPeople(group) {
  const way = traceWay();
  const length = way.length ? way.at(-1).s : 0;
  if (length < 100) return { update() {}, count: 0, length };

  let seed = 7310; // the same people every time
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  const { hull, cockpit } = kayakGeometry();
  const hulls = new THREE.InstancedMesh(hull, new THREE.MeshStandardNodeMaterial({ roughness: 0.4 }), KAYAKS);
  const cockpits = new THREE.InstancedMesh(cockpit, new THREE.MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.75 }), KAYAKS);
  const paddles = new THREE.InstancedMesh(paddleGeometry(), new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.45 }), KAYAKS);
  const tubes = new THREE.InstancedMesh(new THREE.TorusGeometry(0.5, 0.19, 8, 22).rotateX(Math.PI / 2).translate(0, 0.07, 0),
    new THREE.MeshStandardNodeMaterial({ roughness: 0.55 }), TUBES);
  hulls.name = 'RiverKayaks'; tubes.name = 'RiverTubes';
  const meshes = [hulls, cockpits, paddles, tubes];
  for (const m of meshes) {
    m.frustumCulled = false;
    m.castShadow = true;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
  }
  const crowd = new PersonCrowd(KAYAKS + TUBES);
  crowd.meshes.forEach((m) => group.add(m));

  const HULL_COLORS = [0xd8452e, 0xf2a71b, 0x2f8fd8, 0x3fae5a, 0xe6d23a, 0x8a4fc9, 0xe0533a, 0x1fa3a0, 0xf07a2a];
  const TUBE_COLORS = [0x18191b, 0x18191b, 0xd23a32, 0xf0c419, 0x2c6fd1, 0x18191b, 0xe8622c];
  const color = new THREE.Color();
  const people = [];
  for (let i = 0; i < KAYAKS + TUBES; i++) {
    const kayak = i < KAYAKS;
    // two kayaks and a tube near the top of the channel, where the player's kayak starts; the rest down the run
    const s = [20, 75][i] ?? (i === KAYAKS ? 110 : 140 + rand() * (Math.min(length, RUN) - 160));
    people.push({
      kayak, slot: kayak ? i : i - KAYAKS, s, at: 0,
      lane: (rand() - 0.5) * 1.4, phase: rand() * 100,
      speed: kayak ? 1.5 + rand() * 0.7 : 0.7 + rand() * 0.35,
      stroke: rand() * 6, spin: rand() * 6, heading: null, x: 0, y: 0, z: 0,
      rig: new PersonRig({ seed: 50 + i * 7.3, scale: 0.92 + rand() * 0.14, female: rand() < 0.5, girth: 0.9 + rand() * 0.25, hair: rand() * 0.6 }),
      root: new THREE.Object3D(),
      hands: [new THREE.Vector3(), new THREE.Vector3()], twist: 0
    });
    if (kayak) hulls.setColorAt(i, color.setHex(HULL_COLORS[i % HULL_COLORS.length]));
    else tubes.setColorAt(i - KAYAKS, color.setHex(TUBE_COLORS[(i - KAYAKS) % TUBE_COLORS.length]));
  }

  const m = new THREE.Matrix4(), local = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1), none = new THREE.Matrix4().makeScale(0, 0, 0), held = new THREE.Matrix4();
  const PADDLE_AT = new THREE.Vector3(0, 0.58, 0.16), KAYAK_SEAT = new THREE.Vector3(0, 0.02, -0.14);
  const TUBE_SEAT = new THREE.Vector3(0, 0.02, -0.18);
  let time = 0;

  // where along the way `p` is, into p.x, p.z (its lane across it) and its heading
  function place(p, dt) {
    while (p.at < way.length - 2 && way[p.at + 1].s < p.s) p.at++;
    const a = way[p.at], b = way[p.at + 1], t = Math.max(0, Math.min(1, (p.s - a.s) / ((b.s - a.s) || 1)));
    const tx = a.tx + (b.tx - a.tx) * t, tz = a.tz + (b.tz - a.tz) * t, pull = a.pull + (b.pull - a.pull) * t;
    const lane = p.lane + 0.35 * Math.sin(time * 0.05 + p.phase);
    const room = Math.max(0, (lane > 0 ? Math.min(a.right, b.right) : Math.min(a.left, b.left)) - 2.5) * (1 - pull);
    const off = Math.max(-1, Math.min(1, lane)) * room;
    p.x = a.x + (b.x - a.x) * t - tz * off;
    p.z = a.z + (b.z - a.z) * t + tx * off;
    const want = Math.atan2(tx, tz);
    if (p.heading === null) p.heading = want;
    let d = want - p.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    p.heading += d * Math.min(1, dt * 1.5);
    return pull;
  }

  function update(dt, elapsed, focus) {
    if (dt <= 0) return;
    time = elapsed;
    crowd.begin();
    for (const p of people) {
      const pull = place(p, dt);
      // on through the chutes a little quicker, and back in at the top at the end of the run
      p.s += p.speed * (1 + 0.9 * pull) * dt;
      if (p.s > Math.min(length, RUN) - 4) { p.s = rand() * 12; p.at = 0; p.heading = null; }
      const fx = p.x - focus.x, fz = p.z - focus.z, far = Math.hypot(fx, fz);
      if (far > DRAWN) {
        if (p.kayak) { hulls.setMatrixAt(p.slot, none); cockpits.setMatrixAt(p.slot, none); paddles.setMatrixAt(p.slot, none); }
        else tubes.setMatrixAt(p.slot, none);
        continue;
      }
      // riding the water: bow and stern on its surface, bobbing and rolling a little
      const sh = Math.sin(p.heading), ch = Math.cos(p.heading);
      const level = waterLevel(p.x, p.z) ?? 0;
      const front = waterLevel(p.x + sh * 1.2, p.z + ch * 1.2) ?? level, back = waterLevel(p.x - sh * 1.2, p.z - ch * 1.2) ?? level;
      const bob = Math.sin(time * 1.7 + p.phase) * 0.025 + pull * Math.sin(time * 7 + p.phase) * 0.04;
      p.y = (front + back) * 0.5 + bob;
      const pitch = Math.atan2(back - front, 2.4), roll = Math.sin(time * 1.3 + p.phase * 2) * 0.04 + pull * Math.sin(time * 5.3 + p.phase) * 0.06;
      if (p.kayak) {
        e.set(pitch, p.heading, roll, 'YXZ');
      } else {
        p.spin += dt * (0.12 + 0.5 * pull) * (p.slot % 2 ? 1 : -1);
        e.set(pitch * 0.5, p.heading + p.spin, roll, 'YXZ');
      }
      q.setFromEuler(e);
      p.root.position.set(p.x, p.y, p.z);
      p.root.quaternion.copy(q);
      m.compose(p.root.position, q, one);
      if (p.kayak) {
        hulls.setMatrixAt(p.slot, m);
        cockpits.setMatrixAt(p.slot, m);
        // the stroke, as the player's (controllers.js updateKayak)
        p.stroke += dt * Math.PI * 2 * 0.62;
        const s = Math.sin(p.stroke), as = Math.abs(s);
        const deep = as < 0.7 ? (as / 0.7) ** 2 * (3 - 2 * as / 0.7) : 1;
        const pr = 0.84 * Math.sign(s) * deep, py = 0.55 * Math.cos(p.stroke);
        local.compose(PADDLE_AT, q.setFromEuler(e.set(0, py, pr, 'YZX')), one);
        paddles.setMatrixAt(p.slot, held.multiplyMatrices(m, local));
        const dx = Math.cos(pr) * Math.cos(py), dy = Math.sin(pr), dz = -Math.cos(pr) * Math.sin(py);
        p.hands[0].set(PADDLE_AT.x + dx * 0.34, PADDLE_AT.y + dy * 0.34, PADDLE_AT.z + dz * 0.34);
        p.hands[1].set(PADDLE_AT.x - dx * 0.34, PADDLE_AT.y - dy * 0.34, PADDLE_AT.z - dz * 0.34);
        p.twist = -py * 0.6;
      } else {
        tubes.setMatrixAt(p.slot, m);
        // leaning back, hands on the tube, now and then trailing one in the water
        const trail = Math.max(0, Math.sin(time * 0.3 + p.phase)) * 0.12;
        p.hands[0].set(0.48, 0.24 - trail, -0.12);
        p.hands[1].set(-0.48, 0.24, -0.12);
        p.twist = 0.15 * Math.sin(time * 0.4 + p.phase);
      }
      if (far < POSED) {
        p.root.updateMatrix();
        p.rig.paddle(p.root, p.kayak ? KAYAK_SEAT : TUBE_SEAT, p.hands, p.twist);
        crowd.add(p.rig, far);
      }
    }
    crowd.end();
    for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  console.log(`[river] ${KAYAKS} kayakers and ${TUBES} tubers on a ${Math.round(Math.min(length, RUN))} m run from the cascades`);
  return { update, count: people.length, length };
}

export { buildRiverPeople };
