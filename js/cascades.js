import * as THREE from 'three/webgpu';

// The Argo Cascades: the old millrace beside Argo Dam, rebuilt in 2012 as a channel of nine drops of about a foot each
// between rock weirs and pools, carrying paddlers from Argo Pond down to the Huron below the dam (OpenStreetMap's
// "Argo Cascades" stream and its weirs). Here the channel's water steps down weir by weir instead of following the
// river's 10 m level grid, white water pours through each weir's chute and over its rocks, and the current runs fast
// through the chutes (terrain.js takes the levels, river.js cuts the water fine at the drops, controllers.js the kayak).

// The channel's middle, from the pond to the river, in the city's metres
const LINE = [[225.2, -1257.4], [297.0, -1228.5], [419.0, -1228.5], [506.5, -1205.2], [563.4, -1151.9],
  [622.8, -1106.3], [622.8, -1089.7], [611.2, -1064.1]];
const SEGS = [];
{
  let s = 0;
  for (let i = 0; i + 1 < LINE.length; i++) {
    const [ax, az] = LINE[i], [bx, bz] = LINE[i + 1], len = Math.hypot(bx - ax, bz - az);
    SEGS.push({ ax, az, tx: (bx - ax) / len, tz: (bz - az) / len, len, s });
    s += len;
  }
}
const LENGTH = SEGS.at(-1).s + SEGS.at(-1).len;
const hit = { s: 0, d: 0, tx: 0, tz: 0, dist: Infinity }; // what locate() found last
const POND = 7.21, OUTLET = 4.35; // the water's level at the top and the bottom
const HALF = 12.5; // half the channel's width

// Each drop: where it is along the channel, its weir's two ends and its chute (the gap in the rocks) where the map has
// them, else straight across with the chute in the middle
const MAPPED = [[361.3, -1217.4, 362.1, -1231.3, 363.8, -1245.2], [414.1, -1214.1, 417.8, -1227.4, 419.0, -1241.9],
  [461.9, -1204.1, 470.2, -1218.0, 476.0, -1233.0], [496.6, -1189.7, 505.6, -1205.2, 513.1, -1227.4],
  [513.1, -1177.4, 525.9, -1190.2, 537.0, -1197.4], [556.8, -1145.2, 563.0, -1152.4, 573.3, -1166.3],
  [607.9, -1108.6, 613.7, -1115.2, 624.4, -1128.6]];
const DROPS = [85, 115].map((s) => {
  const p = along(s), seg = segAt(s);
  return { s, gap: 0, a: [p[0] + seg.tz * HALF, p[1] - seg.tx * HALF], b: [p[0] - seg.tz * HALF, p[1] + seg.tx * HALF] };
}).concat(MAPPED.map((w) => {
  const c = locate(w[2], w[3]);
  return { s: c.s, gap: c.d, a: [w[0], w[1]], b: [w[4], w[5]] };
}));
DROPS.sort((p, q) => p.s - q.s);
const STEP = (POND - OUTLET) / DROPS.length;

function segAt(s) {
  for (const g of SEGS) if (s <= g.s + g.len) return g;
  return SEGS.at(-1);
}
function along(s) {
  const g = segAt(s), t = Math.max(-20, Math.min(g.len + 20, s - g.s));
  return [g.ax + g.tx * t, g.az + g.tz * t];
}

// Where (x, z) is by the channel: how far along it (s), how far to its right (d), and which way it runs there
function locate(x, z) {
  hit.dist = Infinity;
  for (const g of SEGS) {
    const rx = x - g.ax, rz = z - g.az, t = rx * g.tx + rz * g.tz;
    const tc = Math.max(0, Math.min(g.len, t));
    const px = rx - g.tx * tc, pz = rz - g.tz * tc, dist = Math.hypot(px, pz);
    if (dist < hit.dist) {
      hit.dist = dist;
      hit.s = g.s + (g === SEGS[0] ? Math.min(t, g.len) : g === SEGS.at(-1) ? Math.max(t, 0) : tc);
      hit.d = -g.tz * rx + g.tx * rz;
      hit.tx = g.tx; hit.tz = g.tz;
    }
  }
  return hit;
}

const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
const inBox = (x, z) => x > 90 && x < 660 && z > -1300 && z < -1030;

// How much (x, z) belongs to the channel, 0 to 1: its whole width, fading off its sides and past its ends
// (from its head, where it leaves the pond, at the pond's own level: on its pond side, along the dam, it reaches out to
// the pond's water, and on the other a wall keeps it from the river below the dam)
const HEAD = 0;
// The dam's wall: along the top of the dam from the pond's west shore to the channel's head, then down the channel's
// side to below the trail's bridge, between the pond's water (to its north, at the pond's level) and the river below.
const WALL_END = 54;
const DAM = [[156, -1251]];
for (let s = HEAD; s <= WALL_END; s += 3) { const g = segAt(s), [x, z] = along(s); DAM.push([x - g.tz * (HALF + 0.2), z + g.tx * (HALF + 0.2)]); }
const damHit = { side: 0, dist: Infinity };
// how far south of the wall's line (x, z) is (negative to its north), and how far from its ends' span
function damSide(x, z) {
  damHit.dist = Infinity;
  for (let i = 0; i + 1 < DAM.length; i++) {
    const [ax, az] = DAM[i], [bx, bz] = DAM[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
    const t = ((x - ax) * dx + (z - az) * dz) / (l * l), tc = Math.max(0, Math.min(1, t));
    const dist = Math.hypot(x - ax - dx * tc, z - az - dz * tc);
    if (dist < damHit.dist) { damHit.dist = dist; damHit.side = (-(x - ax) * dz + (z - az) * dx) / l; damHit.off = t < 0 || t > 1; }
  }
  return damHit;
}
const nearDam = (x, z) => x > 150 && x < 300 && z > -1310 && z < -1215;
const onWall = (x, z) => { if (!nearDam(x, z)) return false; const d = damSide(x, z); return !d.off && d.side > 0 && d.side < 2.0; };
// how much (x, z) is the pond's, north of the wall (0-1)
function pondSide(x, z) {
  if (!nearDam(x, z)) return 0;
  const d = damSide(x, z);
  if (d.off) return 0;
  return smooth(0.6, 0.2, d.side) * smooth(45, 30, -d.side);
}
function weightOf(h) {
  return smooth(HALF + 3, HALF + 0.5, h.dist) * smooth(HEAD - 10, HEAD - 3, h.s) * smooth(LENGTH + 14, LENGTH + 2, h.s);
}

// The water's level along the channel: a flat pool between weirs, falling a step over the metre and a half past each
function profile(s) {
  let lv = OUTLET;
  for (const p of DROPS) lv += STEP * (1 - smooth(p.s - 0.3, p.s + 1.5, s));
  return lv;
}

// The water's level at (x, z) given the river's own there: the channel's steps where it is
function cascadeLevel(x, z, level) {
  if (!inBox(x, z)) return level;
  const h = locate(x, z), w = weightOf(h);
  if (w > 0) level += (profile(h.s) - level) * w;
  const p = pondSide(x, z) * (1 - w); // the channel keeps its own steps
  return p > 0 ? level + (POND - level) * p : level;
}

// How deep the channel's bed lies under its water (shallower than the river's 1.8 m), or `depth` off it
function cascadeDepth(x, z, depth) {
  if (!inBox(x, z)) return depth;
  const w = weightOf(locate(x, z));
  return depth + (1.0 - depth) * w;
}

// Where people on the water line up for the next chute: how far to move across (along (-tz, tx), metres) to be in
// it, how much to (0 far from a drop, 1 at it) and which way the channel runs (tx, tz); null off the channel
const chuteOut = { across: 0, pull: 0, tx: 0, tz: 0 };
function chuteNear(x, z) {
  if (!inBox(x, z)) return null;
  const h = locate(x, z);
  if (weightOf(h) < 0.5) return null;
  chuteOut.across = 0; chuteOut.pull = 0; chuteOut.tx = h.tx; chuteOut.tz = h.tz;
  for (const p of DROPS) {
    const ds = h.s - p.s, pull = smooth(-14, -5, ds) * smooth(5, 1.5, ds);
    if (pull > chuteOut.pull) { chuteOut.pull = pull; chuteOut.across = p.gap - h.d; }
  }
  return chuteOut;
}

// Where the channel's paddlers put in: at its head, off the pond, and which way it runs there
const CASCADE_ENTRY = (() => { const g = segAt(HEAD + 2), [x, z] = along(HEAD + 2); return { x, z, tx: g.tx, tz: g.tz }; })();

// Where a paddler starts (main.js SCENIC_STARTS): in the channel a little above its first drop, facing down it
const CASCADE_START = (() => {
  const s = Math.max(HEAD + 4, Math.min(...DROPS.map((d) => d.s)) - 14), g = segAt(s), [x, z] = along(s);
  return { x, z, heading: Math.atan2(g.tx, g.tz) };
})();

// On the pond above the channel's head the water barely moves but for a slow draw into the channel: into `out`
// (m/s) and how much it takes over from the river's own current there (weight); false away from it
const HEAD_AT = along(HEAD), DRAW = 110;
function pondDraw(x, z, out) {
  const dx = HEAD_AT[0] - x, dz = HEAD_AT[1] - z, dist = Math.hypot(dx, dz);
  if (dist > DRAW || !inBox(x, z)) return false;
  const h = locate(x, z);
  if (h.s > HEAD + 2) return false;
  const speed = 0.12 + 0.45 * smooth(60, 4, dist);
  out.x = dx / (dist || 1) * speed; out.z = dz / (dist || 1) * speed;
  out.weight = smooth(DRAW, DRAW - 40, dist) * smooth(HEAD + 2, HEAD - 3, h.s);
  return true;
}

// Whether (x, z) is in the channel at all
function inCascades(x, z) {
  return inBox(x, z) && weightOf(locate(x, z)) > 0;
}

// Whether (x, z) is within `reach` metres of a drop, along the channel (where the water's cut fine)
function nearDrop(x, z, reach) {
  if (!inBox(x, z)) return false;
  const h = locate(x, z);
  if (h.dist > HALF + 6 + reach) return false;
  return DROPS.some((p) => h.s - p.s > -1.5 - reach && h.s - p.s < 11 + reach);
}

// The channel dug out of the river's bed grid (terrain.js's `r.dig`, 0-255 a cell) all along its length, so its water
// runs on under the trail's bridge at its head and on to the river at its foot where the map leaves gaps
function carveCascades(r) {
  for (let w = 0; w < r.drows; w++) {
    const z = r.dz0 + w * r.dstep;
    if (z < -1300 || z > -1030) continue;
    for (let c = 0; c < r.dcols; c++) {
      const x = r.dx0 + c * r.dstep;
      if (!inBox(x, z)) continue;
      const h = locate(x, z);
      const v = smooth(HALF + 0.5, HALF - 2.5, h.dist) * smooth(HEAD - 10, HEAD - 5, h.s) * smooth(LENGTH + 6, LENGTH + 1, h.s);
      const i = w * r.dcols + c;
      if (v > 0) r.dig[i] = Math.max(r.dig[i], Math.round(v * 255));
    }
  }
}

// The water over those gaps, as outlines like the map's water's ({x, z} rings)
function cascadeGaps() {
  return [[HEAD - 8, 74], [436, LENGTH + 4]].map(([s0, s1]) => {
    const left = [], right = [];
    for (let s = s0; s <= s1 + 0.01; s += 3) {
      const g = segAt(s), [x, z] = along(s), half = HALF + 0.5;
      left.push({ x: x + g.tz * half, z: z - g.tx * half });
      right.push({ x: x - g.tz * half, z: z + g.tx * half });
    }
    return [left.concat(right.reverse())];
  });
}

// Each drop for the water's shader (tsl-materials.js): where its chute is, which way the channel runs there, and how
// far its rocks reach either side of the chute
const CASCADE_WAVES = DROPS.map((p) => {
  const g = segAt(p.s), [x, z] = along(p.s);
  return { x: x - g.tz * p.gap, z: z + g.tx * p.gap, tx: g.tx, tz: g.tz, gap: p.gap, half: HALF };
});

// The current through the channel at (x, z), into `out` (m/s, downstream), and how rough the water is there (0-1);
// false off the channel. Steady through the pools, fast in each chute and the tongue below it.
function cascadeCurrent(x, z, out) {
  if (!inBox(x, z)) return false;
  const h = locate(x, z), w = weightOf(h);
  if (w <= 0) return false;
  let fast = 0, rough = 0;
  for (const p of DROPS) {
    const ds = h.s - p.s, lat = Math.abs(h.d - p.gap);
    if (ds < -6 || ds > 12) continue;
    const chute = smooth(5, 1.5, lat);
    fast = Math.max(fast, chute * smooth(-6, -0.5, ds) * smooth(8, 2, ds));
    rough = Math.max(rough, smooth(-0.5, 0.8, ds) * smooth(10, 3, ds) * (0.5 + 0.5 * chute));
  }
  const speed = (1.1 + 3.4 * fast) * w;
  out.x = h.tx * speed; out.z = h.tz * speed; out.rough = rough * w; out.weight = w;
  return true;
}

// Whether (x, z) is on a weir's rocks (the chute is open)
function onWeirRocks(x, z) {
  if (onWall(x, z)) return true;
  if (!inBox(x, z)) return false;
  const h = locate(x, z);
  if (h.dist > HALF + 2) return false;
  return DROPS.some((p) => Math.abs(h.s - p.s) < 0.9 && Math.abs(h.d - p.gap) > 1.9);
}

// ---------------------------------------------------------------------------------------------------------------------
// What's drawn: the weirs' rocks (the white water and its waves are the water's own, tsl-materials.js). `waterLevel` is terrain.js's, with the steps in it.
// ---------------------------------------------------------------------------------------------------------------------

function buildCascades(group, waterLevel) {
  let seed = 20120525; // the same rocks every time
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const root = new THREE.Group();
  root.name = 'ArgoCascades';

  // The rocks: rough limestone boulders across the channel at each weir, the chute left open between them
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  {
    const p = rockGeo.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 3.1 + v.y * 5.3) * Math.cos(v.z * 4.7 - v.y * 2.3));
      p.setXYZ(i, v.x * k, v.y * k * 0.7, v.z * k);
    }
    rockGeo.computeVertexNormals();
  }
  const places = [];
  for (const p of DROPS) {
    const [ax, az] = p.a, [bx, bz] = p.b, len = Math.hypot(bx - ax, bz - az);
    const n = Math.round(len / 1.05);
    const up = waterLevel(...along(p.s - 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = ax + (bx - ax) * t + (random() - 0.5) * 0.5, z = az + (bz - az) * t + (random() - 0.5) * 0.5;
      const h = locate(x, z);
      if (Math.abs(h.d - p.gap) < 1.7) continue;
      const r = 0.42 + random() * 0.32;
      places.push([x, up - 0.42 * r + random() * 0.18, z, r, random() * Math.PI * 2]);
      // a second, lower row just below, which the water pours over
      if (random() < 0.6) places.push([x + h.tx * 0.9, up - STEP - 0.5 * r, z + h.tz * 0.9, r * 0.85, random() * Math.PI * 2]);
    }
  }
  const rockMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92 });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, places.length);
  rocks.name = 'CascadeRocks';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color();
  places.forEach(([x, y, z, r, yaw], i) => {
    q.setFromEuler(e.set((random() - 0.5) * 0.4, yaw, (random() - 0.5) * 0.4));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(r * (1 + random() * 0.4), r, r));
    rocks.setMatrixAt(i, m);
    rocks.setColorAt(i, c.setHSL(0.09 + random() * 0.03, 0.08 + random() * 0.08, 0.24 + random() * 0.12));
  });
  rocks.castShadow = rocks.receiveShadow = true;
  root.add(rocks);

  // The dam's wall (DAM), its top a little over the pond, down past the river below
  const wall = [];
  for (let i = 0; i + 1 < DAM.length; i++) {
    const [ax, az] = DAM[i], [bx, bz] = DAM[i + 1], l = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / l, tz = (bz - az) / l;
    wall.push([(ax + bx) / 2 - tz, (az + bz) / 2 + tx, Math.atan2(tx, tz), l + 0.3]);
  }
  const top = POND + 0.4, bottom = OUTLET - 2;
  const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1.9, top - bottom, 1),
    new THREE.MeshStandardNodeMaterial({ color: 0x8e8a80, roughness: 0.9 }), wall.length);
  walls.name = 'CascadeHeadWall';
  wall.forEach(([x, z, yaw, len], i) => {
    q.setFromEuler(e.set(0, yaw, 0));
    m.compose(new THREE.Vector3(x, (top + bottom) / 2, z), q, new THREE.Vector3(1, 1, len));
    walls.setMatrixAt(i, m);
  });
  walls.castShadow = walls.receiveShadow = true;
  root.add(walls);

  group.add(root);
  return { rocks: places.length, wall: wall.length };
}

export { buildCascades, carveCascades, inCascades, pondDraw, chuteNear, CASCADE_ENTRY, CASCADE_START, cascadeGaps, cascadeLevel, cascadeDepth, cascadeCurrent, nearDrop, onWeirRocks, DROPS as CASCADE_DROPS, CASCADE_WAVES };
