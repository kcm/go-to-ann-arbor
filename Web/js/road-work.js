import * as THREE from 'three/webgpu';
import { abs, attribute, color, dot, float, fract, mix, normalWorld, positionGeometry, positionWorld, pow, smoothstep, step, texture as tex, time, vec2, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundHeight } from './terrain.js';
import { random, log, texture as loadTexture } from '../lamp-game.js';
import { roundedBox, roundedRectShape } from './vehicles.js';

// Michigan's other season: road work. A few dozen blocks around town are shut, a Type III "ROAD CLOSED" barricade
// line across each end with its amber lamps blinking, the dug-up patch in the middle ringed by orange-and-white drums,
// a line of cones, a dump truck or an excavator and a pile of dirt, and "ROAD WORK AHEAD" diamonds on the streets
// leading in. Traffic never turns into a closed block (traffic.js, `e.closed`); the player can drive straight
// through: cones, drums and barricades go flying, the machines are solid.

const hash = (x, z, k = 0) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };

const MAX_CLOSURES = 18;
const SPACING = 350; // metres between closed blocks, at the least

// Which blocks are shut: side streets and collectors (never the main roads TheRide runs on) between junctions with
// other ways out, long enough to hold a work zone; picked the same every play, more of them toward the middle of town
function planClosures(edges) {
  let mx = 0, mz = 0;
  for (const e of edges) { mx += e.x0; mz += e.z0; }
  mx /= edges.length || 1; mz /= edges.length || 1;
  const cands = [];
  for (const e of edges) {
    if (e.closed || e.sx === undefined || e.len < 48 || e.len > 240 || (e.cls ?? 4) < 3) continue;
    if (e.from.out.length < 3 || e.to.out.length < 3) continue;
    // one of the two ways stands for the block
    if (e.opposite && (e.opposite.x0 < e.x0 || (e.opposite.x0 === e.x0 && e.opposite.z0 < e.z0))) continue;
    const cx = e.sx + e.dx * e.len / 2, cz = e.sz + e.dz * e.len / 2;
    cands.push({ e, cx, cz, score: hash(cx, cz, 7) * (1 + Math.hypot(cx - mx, cz - mz) / 1300) });
  }
  cands.sort((a, b) => a.score - b.score);
  const sites = [];
  for (const c of cands) {
    if (sites.length >= MAX_CLOSURES) break;
    if (sites.some((s) => Math.hypot(s.cx - c.cx, s.cz - c.cz) < SPACING)) continue;
    c.e.closed = true;
    if (c.e.opposite) c.e.opposite.closed = true;
    sites.push(c);
  }
  console.info(`[road work] ${sites.length} blocks closed: ${sites.slice(0, 6).map((s) => s.e.street || 'a side street').join(', ')}…`);
  return sites.map((s) => s.e);
}

// ---------------------------------------------------------------------------------------------------------------------
// Models: boxes and cylinders with a colour each, merged per kind (local frame: x across the road, z along it)
// ---------------------------------------------------------------------------------------------------------------------
const C = new THREE.Color();
function piece(geo, hex, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx) geo.rotateX(rx);
  if (rz) geo.rotateZ(rz);
  if (ry) geo.rotateY(ry);
  geo.translate(x, y, z);
  geo.deleteAttribute('uv');
  C.setHex(hex);
  const n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = C.r; a[i * 3 + 1] = C.g; a[i * 3 + 2] = C.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  geo.setAttribute('shine', new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute('soil', new THREE.BufferAttribute(new Float32Array(n), 1));
  return geo.index ? geo.toNonIndexed() : geo;
}
const box = (w, h, d, hex, x, y, z, rx, ry, rz) => piece(new THREE.BoxGeometry(w, h, d), hex, x, y, z, rx, ry, rz);
const cyl = (rt, rb, h, hex, x, y, z, seg = 8, rx, ry, rz) => piece(new THREE.CylinderGeometry(rt, rb, h, Math.min(8, seg)), hex, x, y, z, rx, ry, rz);
const merge = (parts) => { const g = mergeGeometries(parts); g.computeBoundingSphere(); return g; };
// marks a part as earth: the material draws it with the soil's photographed grain, tinted by its colour
const earthy = (geo) => { geo.getAttribute('soil').array.fill(1); return geo; };

// a heap of dug earth: a lumpy, uneven dome with a ragged foot that sinks into the ground, w × h × d metres
function moundGeo(seed, w, h, d, rings = 5, sectors = 14) {
  rings = Math.min(5, rings);
  sectors = Math.min(14, sectors);
  const pos = [], idx = [];
  const wob = (a) => 1 + 0.13 * Math.sin(3 * a + seed) + 0.07 * Math.sin(5 * a + seed * 2.3) + 0.04 * Math.sin(11 * a + seed * 4.1);
  const lump = (x, z) => 0.07 * Math.sin(x * 6.1 + seed) * Math.sin(z * 5.3 - seed) + 0.04 * Math.sin(x * 13.7 + z * 11.9 + seed * 3);
  pos.push(0, h * (1 + lump(0, 0)), 0);
  for (let i = 1; i <= rings; i++) {
    const t = i / rings;
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2, r = t * wob(a + t * 0.6);
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      // a slumped cone, steeper near the foot, with a second shoulder on one side
      const y = t >= 1 ? -0.06 : h * (Math.pow(1 - t * t, 1.15) * (1 + 0.18 * Math.sin(2 * a + seed) * t) + lump(x, z) * (1 - t * 0.6));
      pos.push(x * w / 2, y, z * d / 2);
    }
  }
  for (let j = 0; j < sectors; j++) idx.push(0, 1 + ((j + 1) % sectors), 1 + j);
  for (let i = 1; i < rings; i++) for (let j = 0; j < sectors; j++) {
    const a = 1 + (i - 1) * sectors + j, b = 1 + (i - 1) * sectors + ((j + 1) % sectors), c = a + sectors, e = b + sectors;
    idx.push(a, b, c, b, e, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// clods and stones strewn over a mound (the same w, h, d), so it isn't one smooth shape
function clods(parts, seed, w, h, d, n, hex, stone = 0x77736c) {
  n = Math.min(6, n);
  for (let i = 0; i < n; i++) {
    const a = hash(seed, i, 1) * Math.PI * 2, t = 0.25 + hash(seed, i, 2) * 0.8;
    const x = Math.cos(a) * t * w / 2, z = Math.sin(a) * t * d / 2;
    const y = Math.max(0, h * Math.pow(Math.max(0, 1 - t * t), 1.15)) - 0.02;
    const r = (0.05 + hash(seed, i, 3) * 0.12) * Math.min(1, w / 2);
    const rock = hash(seed, i, 4) < 0.3;
    const g = new THREE.DodecahedronGeometry(r, 0);
    g.scale(1, 0.6 + hash(seed, i, 5) * 0.4, 0.8 + hash(seed, i, 6) * 0.4);
    const p = piece(g, rock ? stone : hex, x, y, z, hash(seed, i, 7) * 3, hash(seed, i, 8) * 6, hash(seed, i, 9) * 3);
    parts.push(rock ? p : earthy(p));
  }
}

const ORANGE = 0xff5b0d, WHITE = 0xf4f2ec, BLACK = 0x1b1b1c, STEEL = 0x8a8d90, GLASS = 0x26343c, DIRT = 0x5b4733;

// a 28-inch cone: black base, two reflective collars
function coneGeo() {
  const r = (h) => 0.15 - 0.115 * (h / 0.68);
  return merge([
    box(0.38, 0.03, 0.38, BLACK, 0, 0.015, 0),
    cyl(0.035, 0.15, 0.68, ORANGE, 0, 0.37, 0),
    cyl(r(0.42) + 0.006, r(0.30) + 0.006, 0.12, WHITE, 0, 0.03 + 0.36, 0),
    cyl(r(0.56) + 0.006, r(0.49) + 0.006, 0.07, WHITE, 0, 0.03 + 0.525, 0)
  ]);
}
// MDOT's drum: orange and white bands over a black tire-ring base
function drumGeo() {
  const parts = [cyl(0.36, 0.39, 0.1, BLACK, 0, 0.05, 0, 16)];
  const bands = [ORANGE, WHITE, ORANGE, WHITE, ORANGE];
  const h = 0.19;
  for (let i = 0; i < bands.length; i++) {
    const y0 = 0.1 + i * h;
    parts.push(cyl(0.29 - (i + 1) * 0.006, 0.29 - i * 0.006, h, bands[i], 0, y0 + h / 2, 0, 16));
  }
  parts.push(cyl(0.12, 0.25, 0.08, ORANGE, 0, 0.1 + bands.length * h + 0.04, 0, 16));
  return merge(parts);
}
// Type III barricade: three striped rails on two white legs (its "ROAD CLOSED" plate is drawn on its own: textured)
function barricadeGeo() {
  const parts = [];
  for (const x of [-1.0, 1.0]) {
    parts.push(box(0.07, 1.62, 0.07, WHITE, x, 0.81, 0));
    parts.push(box(0.1, 0.06, 0.9, STEEL, x, 0.03, 0));
  }
  for (const y of [0.5, 0.92, 1.34]) {
    const n = 8, w = 2.5 / n;
    for (let i = 0; i < n; i++) parts.push(box(w, 0.2, 0.03, i % 2 ? WHITE : ORANGE, -1.25 + w * (i + 0.5), y, 0.05));
  }
  return merge(parts);
}
// the diamond's stand
function standGeo() {
  return merge([
    box(0.05, 1.9, 0.05, STEEL, 0, 0.95, 0),
    box(0.9, 0.05, 0.06, STEEL, 0, 0.03, 0),
    box(0.06, 0.05, 0.9, STEEL, 0, 0.03, 0)
  ]);
}
// ---- the machines, built to look like the real thing: rounded panels, glass, chrome, tyres with shoulders,
// tracks with grousers, hydraulic rams. `gloss` marks glass and chrome, which the material shines (shine 0..1)
function gloss(geo, v) {
  geo.getAttribute('shine').array.fill(v);
  return geo;
}
const rbox = (w, h, d, r, hex, x, y, z, rx, ry, rz) => box(w, h, d, hex, x, y, z, rx, ry, rz);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _u = new THREE.Vector3();
// a geometry whose length runs along z, laid from a to b
function lay(geo, hex, a, b) {
  _a.set(...a); _b.set(...b);
  const d = _b.clone().sub(_a);
  _u.set(0, 1, 0);
  if (Math.abs(d.clone().normalize().y) > 0.95) _u.set(0, 0, 1);
  _m.lookAt(_b, _a, _u).setPosition(_a.add(_b).multiplyScalar(0.5));
  geo.applyMatrix4(_m);
  return piece(geo, hex);
}
const beam = (a, b, w, h, hex) => lay(new THREE.BoxGeometry(w, h, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])), hex, a, b);
const rod = (a, b, r, hex, seg = 6) => lay(new THREE.CylinderGeometry(r, r, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.min(6, seg)).rotateX(Math.PI / 2), hex, a, b);
// a hydraulic ram: painted barrel, chrome rod
function ram(parts, a, b, r, hex) {
  const m = [a[0] + (b[0] - a[0]) * 0.58, a[1] + (b[1] - a[1]) * 0.58, a[2] + (b[2] - a[2]) * 0.58];
  parts.push(rod(a, m, r, hex), gloss(rod(m, b, r * 0.55, 0xd8dadc), 0.9));
  parts.push(rod([a[0] - 0.01, a[1], a[2]], [a[0] + 0.01, a[1], a[2]], r * 1.25, 0x2a2a2a));
}
// a truck tyre on the x axis: tread, rounded shoulders, a steel wheel with its hub and nuts
function tyreAt(parts, x, y, z, r, w, outward) {
  parts.push(cyl(r, r, w, 0x161617, x, y, z, 8, 0, 0, Math.PI / 2));
  const face = x + outward * (w / 2);
  parts.push(gloss(cyl(r * 0.6, r * 0.6, 0.05, 0xb9bcbf, face, y, z, 8, 0, 0, Math.PI / 2), 0.55));
  parts.push(cyl(r * 0.24, r * 0.3, 0.12, 0x5a5d60, face + outward * 0.04, y, z, 6, 0, 0, Math.PI / 2));
}
// a fender arching over a wheel (axis x), open underneath
function fender(parts, x, y, z, r, w, hex, from = 0, to = Math.PI) {
  const g = new THREE.CylinderGeometry(r, r, w, 8, 1, true, from, to - from);
  g.rotateZ(Math.PI / 2);
  parts.push(piece(g, hex, x, y, z));
}

// a tandem-axle dump truck, the kind Ann Arbor's paving contractors run: a conventional cab behind a long hood,
// a ribbed steel box with a cab shield, its load heaped in it; facing +z, about 9 m long
function dumpTruckGeo(withTyres = true) {
  const tyre = withTyres ? tyreAt : () => {};
  const P = 0xd9531e, P2 = 0xb8441a, CH = 0xd8dadc, DK = 0x2b2c2e, GL = 0x1d272d;
  const parts = [];
  // chassis
  for (const x of [-0.46, 0.46]) parts.push(box(0.18, 0.3, 8.8, DK, x, 0.98, -0.1));
  parts.push(gloss(rbox(2.5, 0.36, 0.3, 0.06, CH, 0, 0.82, 4.6), 0.7));
  parts.push(box(2.0, 0.12, 0.18, DK, 0, 0.6, 4.55));
  // the hood, sloping to the grille, and its fenders
  parts.push(rbox(1.5, 0.95, 1.85, 0.16, P, 0, 1.78, 3.62, 0.05));
  parts.push(rbox(1.3, 0.08, 1.7, 0.04, P2, 0, 2.28, 3.55, 0.05));
  parts.push(gloss(rbox(1.24, 1.08, 0.08, 0.05, CH, 0, 1.72, 4.56), 0.75));
  for (let i = 0; i < 7; i++) parts.push(box(1.08, 0.06, 0.06, 0x18191a, 0, 1.3 + i * 0.13, 4.61));
  parts.push(box(0.5, 0.1, 0.03, 0xe8e8e8, 0, 2.18, 4.62));
  for (const sx of [-1, 1]) {
    fender(parts, sx * 1.02, 0.56, 3.2, 0.66, 0.5, P, -0.15, Math.PI * 0.8);
    parts.push(rbox(0.5, 0.22, 1.1, 0.08, P, sx * 1.02, 1.13, 3.75, 0.12));
    parts.push(gloss(rbox(0.34, 0.2, 0.12, 0.05, 0xf7f3e2, sx * 0.98, 1.42, 4.32), 0.8));
    parts.push(box(0.12, 0.06, 0.04, 0xff9a1a, sx * 1.2, 1.38, 4.36));
  }
  // the cab: rounded shell, raked windshield in two panes, side glass, doors, steps, mirrors, sun visor, roof lamps
  parts.push(rbox(2.3, 2.0, 1.6, 0.18, P, 0, 2.4, 2.0));
  parts.push(rbox(2.24, 0.5, 1.5, 0.1, DK, 0, 1.38, 2.05));
  for (const sx of [-1, 1]) {
    parts.push(gloss(box(0.98, 0.78, 0.04, GL, sx * 0.53, 2.93, 2.81, -0.12), 0.95));
    parts.push(gloss(box(0.04, 0.68, 1.05, GL, sx * 1.15, 2.92, 2.12), 0.95));
    parts.push(box(0.02, 1.4, 0.02, 0x7a2a10, sx * 1.155, 2.15, 1.45));
    parts.push(gloss(box(0.03, 0.04, 0.2, CH, sx * 1.165, 2.42, 1.62), 0.8));
    parts.push(box(0.4, 0.05, 0.3, DK, sx * 1.12, 1.15, 2.0));
    parts.push(box(0.4, 0.05, 0.3, DK, sx * 1.12, 0.78, 2.0));
    parts.push(rod([sx * 1.15, 2.95, 2.75], [sx * 1.45, 2.75, 2.85], 0.02, DK));
    parts.push(rbox(0.12, 0.6, 0.2, 0.04, DK, sx * 1.48, 2.65, 2.85));
    parts.push(gloss(cyl(0.3, 0.3, 1.05, CH, sx * 0.98, 1.0, 1.75, 16, Math.PI / 2), 0.85));
  }
  parts.push(box(0.04, 0.78, 0.06, DK, 0, 2.93, 2.82, -0.12));
  parts.push(rbox(2.2, 0.06, 0.28, 0.02, DK, 0, 3.38, 2.88, 0.2));
  for (const x of [-0.6, -0.3, 0, 0.3, 0.6]) parts.push(box(0.12, 0.06, 0.06, 0xff9a1a, x, 3.42, 2.72));
  parts.push(gloss(box(1.4, 0.4, 0.04, GL, 0, 2.95, 1.19), 0.9));
  // exhaust stack and air cleaner behind the cab
  parts.push(gloss(rod([1.0, 1.3, 1.05], [1.0, 3.9, 1.05], 0.085, CH), 0.9));
  parts.push(gloss(cyl(0.11, 0.09, 0.5, 0x777a7d, 1.0, 3.25, 1.05, 12), 0.5));
  parts.push(cyl(0.26, 0.26, 0.9, DK, -1.02, 2.3, 1.05, 14));
  // the dump box: tapered sides with vertical ribs, a top rail, the shield out over the cab, the tailgate
  const z0 = -4.35, z1 = 1.0, L = z1 - z0, zc = (z0 + z1) / 2;
  parts.push(box(2.3, 0.14, L, P2, 0, 1.55, zc));
  parts.push(box(1.2, 0.22, L, DK, 0, 1.36, zc));
  for (const sx of [-1, 1]) {
    parts.push(box(0.07, 1.35, L, P, sx * 1.2, 2.22, zc, 0, 0, -sx * 0.06));
    parts.push(gloss(box(0.16, 0.14, L + 0.1, P2, sx * 1.25, 2.9, zc), 0.15));
    for (let i = 0; i < 6; i++) parts.push(box(0.1, 1.2, 0.1, P2, sx * 1.27, 2.2, z0 + 0.35 + i * (L - 0.7) / 5, 0, 0, -sx * 0.06));
    parts.push(box(0.12, 0.12, L, P2, sx * 1.24, 1.62, zc));
  }
  parts.push(rbox(2.5, 1.85, 0.12, 0.04, P, 0, 2.45, z1));
  parts.push(box(2.55, 0.08, 1.0, P, 0, 3.55, z1 + 0.42, -0.06));
  parts.push(rbox(2.5, 1.4, 0.12, 0.04, P, 0, 2.2, z0 - 0.04, 0.04));
  for (const sx of [-1, 1]) parts.push(box(0.2, 0.2, 0.12, DK, sx * 1.05, 2.86, z0 - 0.1));
  parts.push(box(2.3, 0.1, 0.1, P2, 0, 1.7, z0 - 0.1));
  // the load, heaped
  parts.push(earthy(piece(moundGeo(2.7, 2.24, 0.7, 5.1), 0x4e3c2b, 0, 2.6, zc)));
  { const c = []; clods(c, 5.1, 2.0, 0.65, 4.8, 18, 0x4a3828); for (const g of c) { g.translate(0, 2.6, zc); parts.push(g); } }
  // the hoist ram under the box's front
  ram(parts, [0, 1.0, 1.4], [0, 1.5, 0.75], 0.11, DK);
  // tandem rear: dual tyres, flat fenders, mud flaps, tail lamps
  for (const az of [-1.55, -2.95]) for (const sx of [-1, 1]) {
    tyre(parts, sx * 0.76, 0.54, az, 0.54, 0.3, -sx);
    tyre(parts, sx * 1.1, 0.54, az, 0.54, 0.3, sx);
  }
  for (const sx of [-1, 1]) {
    parts.push(box(0.72, 0.04, 2.25, DK, sx * 0.93, 1.2, -2.25));
    parts.push(box(0.6, 0.62, 0.03, 0x111111, sx * 0.93, 0.78, -3.75));
    parts.push(gloss(rbox(0.22, 0.12, 0.05, 0.03, 0xc81818, sx * 0.95, 1.14, -4.42), 0.6));
    tyre(parts, sx * 1.02, 0.54, 3.2, 0.54, 0.34, sx);
  }
  parts.push(box(2.3, 0.14, 0.14, DK, 0, 0.62, -4.38));
  return merge(parts);
}
// the truck's wheels on their own, for the one the player drives: a front tyre, and a rear pair of duals, each about
// its axle at the origin (the player's truck places them at TRUCK_WHEELS)
const TRUCK_WHEELS = [
  { x: -1.02, z: 3.2, front: true }, { x: 1.02, z: 3.2, front: true },
  { x: -0.93, z: -1.55 }, { x: 0.93, z: -1.55 }, { x: -0.93, z: -2.95 }, { x: 0.93, z: -2.95 }
];
function truckWheelGeo(front, side) {
  const parts = [];
  if (front) tyreAt(parts, 0, 0, 0, 0.54, 0.34, side);
  else { tyreAt(parts, -side * 0.17, 0, 0, 0.54, 0.3, -side); tyreAt(parts, side * 0.17, 0, 0, 0.54, 0.3, side); }
  return merge(parts);
}

// a mid-size tracked excavator in its maker's yellow: tracks with grousers on idler, sprocket and rollers, the
// turntable, the house with its counterweight and engine hood, the glass cab, and a boom, stick and bucket worked by
// rams, reaching forward (+z) into the dig
function excavatorGeo() {
  const Y = 0xdfa012, Y2 = 0xb98410, DK = 0x252627, MID = 0x46484a, GL = 0x1f2a30, CH = 0xd8dadc;
  const parts = [];
  // undercarriage
  for (const sx of [-1, 1]) {
    const x = sx * 1.12;
    const loop = new THREE.ExtrudeGeometry(roundedRectShape(2.2, 0.42, 0.38), { depth: 0.6, bevelEnabled: false, curveSegments: 3 });
    loop.translate(0, 0, -0.3);
    loop.rotateY(Math.PI / 2);
    parts.push(piece(loop, 0x1a1a1b, x, 0.43, 0));
    for (let i = 0; i < 10; i++) {
      const z = -1.8 + i * 0.4;
      parts.push(box(0.62, 0.05, 0.09, 0x111112, x, 0.875, z));
      parts.push(box(0.62, 0.05, 0.09, 0x111112, x, -0.005, z));
    }
    parts.push(box(0.5, 0.42, 3.3, MID, x - sx * 0.04, 0.45, 0));
    for (const z of [-1.82, 1.82]) parts.push(cyl(0.34, 0.34, 0.08, MID, x + sx * 0.3, 0.43, z, 8, 0, 0, Math.PI / 2));
    parts.push(cyl(0.18, 0.18, 0.1, DK, x + sx * 0.33, 0.43, -1.82, 6, 0, 0, Math.PI / 2));
    for (let i = 0; i < 4; i++) parts.push(cyl(0.11, 0.11, 0.08, DK, x + sx * 0.3, 0.17, -1.2 + i * 0.8, 6, 0, 0, Math.PI / 2));
  }
  parts.push(box(1.7, 0.4, 2.2, MID, 0, 0.62, 0));
  parts.push(cyl(0.95, 0.95, 0.22, DK, 0, 0.95, 0, 10));
  // the house: deck, counterweight, engine hood with vents, handrails, exhaust
  parts.push(rbox(2.6, 0.75, 3.1, 0.12, Y, 0, 1.45, -0.3));
  parts.push(rbox(2.6, 0.9, 0.9, 0.4, Y2, 0, 1.6, -2.15));
  parts.push(box(2.4, 0.1, 0.06, DK, 0, 1.25, -2.62));
  parts.push(rbox(1.5, 0.48, 1.6, 0.1, Y, 0.5, 2.05, -1.05));
  for (let i = 0; i < 6; i++) parts.push(box(0.03, 0.26, 0.08, DK, 1.26, 2.05, -1.6 + i * 0.2));
  for (let i = 0; i < 5; i++) parts.push(box(0.9, 0.03, 0.1, DK, 0.5, 2.3, -1.5 + i * 0.22));
  parts.push(gloss(rod([0.95, 2.2, -0.55], [0.95, 2.85, -0.55], 0.06, 0x2e2e2e), 0.3));
  parts.push(rod([1.25, 2.3, -1.9], [1.25, 2.3, 0.6], 0.025, Y));
  for (const z of [-1.9, -0.6, 0.6]) parts.push(rod([1.25, 1.85, z], [1.25, 2.32, z], 0.025, Y));
  parts.push(box(0.9, 0.5, 0.6, Y, 0.7, 1.95, 0.4));
  // the cab: tall glass on a dark frame, a yellow roof, a wiper, the lamp on top
  const cx = -0.72, cz = 0.5;
  parts.push(gloss(rbox(1.0, 1.55, 1.5, 0.08, GL, cx, 2.6, cz), 0.95));
  for (const [dx, dz] of [[-0.49, -0.74], [0.49, -0.74], [-0.49, 0.74], [0.49, 0.74]]) parts.push(box(0.06, 1.58, 0.06, DK, cx + dx, 2.6, cz + dz));
  parts.push(box(0.06, 0.06, 1.48, DK, cx - 0.49, 2.0, cz));
  parts.push(box(0.98, 0.06, 0.06, DK, cx, 2.0, cz + 0.74));
  parts.push(rbox(1.08, 0.12, 1.6, 0.05, Y, cx, 3.42, cz));
  parts.push(box(0.03, 0.55, 0.03, 0x111111, cx + 0.15, 2.7, cz + 0.77, 0, 0, 0.5));
  parts.push(cyl(0.08, 0.1, 0.14, 0xff8a00, cx + 0.3, 3.55, cz - 0.5, 8));
  // boom (bent, in two lengths), stick, bucket, their rams
  const bx = 0.3, piv = [bx, 1.85, 1.05], knee = [bx, 4.25, 2.95], tip = [bx, 3.95, 5.05];
  parts.push(box(0.55, 0.5, 0.5, Y2, bx, 1.75, 1.05));
  parts.push(beam(piv, knee, 0.6, 0.72, Y), beam(knee, tip, 0.56, 0.62, Y));
  for (const sx of [-1, 1]) {
    const o = (p) => [p[0] + sx * 0.31, p[1], p[2]];
    parts.push(beam(o(piv), o(knee), 0.03, 0.5, Y2), beam(o(knee), o(tip), 0.03, 0.44, Y2));
    parts.push(cyl(0.16, 0.16, 0.06, DK, bx + sx * 0.33, knee[1], knee[2], 8, 0, 0, Math.PI / 2));
  }
  // the hydraulic hoses that run up the boom and down to the bucket, in black rubber
  for (const hx of [-0.1, 0.1]) {
    const o = (p, dy, dz = 0) => [p[0] + hx, p[1] + dy, p[2] + dz];
    parts.push(rod(o(piv, 0.36, -0.2), o(knee, 0.36), 0.03, 0x141414, 6), rod(o(knee, 0.36), o(tip, 0.32), 0.03, 0x141414, 6));
    parts.push(rod(o(tip, 0.32), o(tip, 0.5, 0.35), 0.03, 0x141414, 6));
  }
  // black-and-yellow warning stripes on the counterweight's back
  for (let i = 0; i < 7; i++) parts.push(box(0.16, 0.62, 0.03, 0x1a1a1a, -1.05 + i * 0.35, 1.58, -2.61, 0, 0, 0.6));
  for (const sx of [-1, 1]) ram(parts, [bx + sx * 0.3, 1.4, 1.35], [bx + sx * 0.3, 3.35, 2.55], 0.1, Y2);
  const stTop = [bx, 4.55, 4.85], stEnd = [bx, 1.2, 5.85];
  parts.push(beam(stTop, stEnd, 0.46, 0.56, Y));
  // the bucket's linkage at the stick's end
  for (const sx of [-1, 1]) parts.push(beam([bx + sx * 0.2, 1.75, 6.15], [bx + sx * 0.2, 1.05, 6.45], 0.06, 0.16, Y2));
  ram(parts, [bx, 4.75, 2.95], [bx, 4.72, 4.75], 0.09, Y2);
  ram(parts, [bx, 4.4, 5.2], [bx, 1.75, 6.15], 0.075, Y2);
  parts.push(beam([bx, 1.75, 6.15], [bx, 1.2, 6.2], 0.3, 0.1, DK));
  const bk = [bx, 0.75, 6.05], br = 0.58;
  {
    const shell = new THREE.CylinderGeometry(br, br, 0.95, 8, 1, true, -Math.PI * 0.82, Math.PI * 1.32);
    shell.rotateZ(Math.PI / 2);
    parts.push(piece(shell, MID, bk[0], bk[1], bk[2]));
    for (const sx of [-1, 1]) {
      const side = new THREE.CylinderGeometry(br, br, 0.04, 8, 1, false, -Math.PI * 0.82, Math.PI * 1.32);
      side.rotateZ(Math.PI / 2);
      parts.push(piece(side, Y2, bk[0] + sx * 0.475, bk[1], bk[2]));
    }
    const la = -Math.PI * 0.82, ly = bk[1] + Math.sin(la) * br, lz = bk[2] + Math.cos(la) * br;
    for (let i = 0; i < 5; i++) parts.push(box(0.08, 0.07, 0.22, 0x9a9da0, bx - 0.36 + i * 0.18, ly - 0.03, lz - 0.08, 0.5));
    // a scoop of dirt in it
    parts.push(earthy(piece(moundGeo(8.3, 0.88, 0.24, 0.76, 4, 10), 0x4e3c2b, bk[0], bk[1] - 0.05, bk[2])));
  }
  return merge(parts);
}

function pileGeo() {
  const parts = [earthy(piece(moundGeo(1.7, 4.4, 1.15, 3.5), 0x5e4632))];
  // a second, smaller heap slumped against it, and the clods and stones on both
  parts.push(earthy(piece(moundGeo(4.2, 2.2, 0.55, 1.9, 4, 12), 0x56402d, 1.5, 0, 0.9)));
  clods(parts, 3.3, 4.2, 1.1, 3.3, 6, 0x4f3b29);
  return merge(parts);
}
// the dug-up patch (a unit square, scaled to the dig): loose backfill heaped a little above the cut asphalt, its edge
// ragged where the pavement broke off
function patchGeo() {
  const n = 8, pos = [], idx = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    let x = i / n - 0.5, z = j / n - 0.5;
    const edge = i === 0 || j === 0 || i === n || j === n;
    if (edge) { const k = 0.035 * hash(i, j, 5); x -= Math.sign(x) * (i === 0 || i === n ? k : 0); z -= Math.sign(z) * (j === 0 || j === n ? k : 0); }
    const y = edge ? 0.012 : 0.03 + 0.035 * hash(i, j, 6) + 0.025 * Math.sin(i * 0.9) * Math.sin(j * 0.7);
    pos.push(x, y, z);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j, b = a + n + 1;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return merge([earthy(piece(g, 0x3e3022))]);
}
function plateGeo() {
  return merge([gloss(box(1, 0.03, 1, 0x4f5153, 0, 0.015, 0), 0.25)]);
}

function signTexture(draw, w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const closedTexture = () => signTexture((ctx, w, h) => {
  ctx.fillStyle = '#f6f5f0'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 10; ctx.strokeRect(14, 14, w - 28, h - 28);
  ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 92px Helvetica, Arial, sans-serif';
  ctx.fillText('ROAD', w / 2, h * 0.31, w - 60);
  ctx.fillText('CLOSED', w / 2, h * 0.71, w - 60);
});
// drawn turned a quarter-turn's half, as the diamond is turned the other way
const aheadTexture = () => signTexture((ctx, w) => {
  ctx.fillStyle = '#f7891f'; ctx.fillRect(0, 0, w, w);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 14; ctx.strokeRect(18, 18, w - 36, w - 36);
  ctx.translate(w / 2, w / 2); ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 74px Helvetica, Arial, sans-serif';
  ctx.fillText('ROAD', 0, -82, 300);
  ctx.fillText('WORK', 0, 0, 330);
  ctx.fillText('AHEAD', 0, 82, 300);
}, 512, 512);

// ---------------------------------------------------------------------------------------------------------------------
// The work zones
// ---------------------------------------------------------------------------------------------------------------------
// what a hit sends flying: [radius, how far it flies for the car's speed, how high, how much it slows the car]
const LOOSE = {
  cone: { r: 0.2, fling: 1.25, lift: 0.3, drag: 0.004, lie: 0.15 },
  drum: { r: 0.36, fling: 0.95, lift: 0.18, drag: 0.03, lie: 0.29 },
  barricade: { r: 1.1, fling: 0.8, lift: 0.14, drag: 0.05, lie: 0.05 }
};

function buildRoadWork(group, closures) {
  group.name = 'RoadWork';
  const items = []; // the loose things: { kind, x, z, yaw, ... }
  const fixed = { truck: [], excavator: [], pile: [], patch: [], plate: [], stand: [] };
  const colliders = [];
  const lamps = []; // { item, ox, oy, oz } blinking amber lamps on the barricades and machines
  const aheads = []; // the diamonds: { x, z, yaw }

  const add = (kind, x, z, yaw) => {
    const it = { kind, x, z, yaw, g: groundHeight(x, z), h: 0, vx: 0, vz: 0, vy: 0, tilt: 0, tiltVel: 0, tipYaw: 0, moving: false, ...LOOSE[kind] };
    items.push(it);
    return it;
  };
  const solid = (x, z, yaw, hx, hz, top) => {
    const cs = Math.cos(yaw), sn = Math.sin(yaw), g = groundHeight(x, z);
    const ex = Math.abs(cs) * hx + Math.abs(sn) * hz, ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
    const col = { minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez, minY: g, maxY: g + top, solid: true, obb: { cx: x, cz: z, hx, hz, cs, sn } };
    colliders.push(col);
    return col;
  };
  // a machine's box moved to where it stands now
  const reboxed = (m) => {
    const cs = Math.cos(m.yaw), sn = Math.sin(m.yaw), g = groundHeight(m.x, m.z), c = m.col;
    const ex = Math.abs(cs) * m.hx + Math.abs(sn) * m.hz, ez = Math.abs(sn) * m.hx + Math.abs(cs) * m.hz;
    Object.assign(c, { minX: m.x - ex, maxX: m.x + ex, minZ: m.z - ez, maxZ: m.z + ez, minY: g, maxY: g + m.top });
    Object.assign(c.obb, { cx: m.x, cz: m.z, cs, sn });
  };

  for (const e of closures) {
    const yaw = Math.atan2(e.dx, e.dz);
    const W = Math.max(3, (e.half || 5) - 0.7);
    const at = (s, o) => [e.sx + e.dx * s + e.rx * o, e.sz + e.dz * s + e.rz * o];
    const k = hash(e.sx, e.sz, 3);
    // a barricade line across each end, a lamp on every other one
    for (const [s, face] of [[2.5, 0], [e.len - 2.5, Math.PI]]) {
      const n = Math.max(2, Math.round((2 * W) / 2.7));
      for (let i = 0; i < n; i++) {
        const o = -W + 1.25 + (i * (2 * W - 2.5)) / Math.max(1, n - 1);
        const [x, z] = at(s, o);
        const b = add('barricade', x, z, yaw + face);
        if (i % 2 === 0) lamps.push({ item: b, ox: 1.0, oy: 1.72, oz: 0 });
      }
    }
    // "ROAD WORK AHEAD" on the right of each street leading in, 30 m before the junction
    for (const node of [e.from, e.to]) {
      for (const f of node.in) {
        if (f.closed || f.len < 45 || f.sx === undefined) continue;
        const side = Math.sign(f.lanes.reduce((a, b) => a + b, 0)) || 1;
        const s = f.len - 30, o = side * ((f.half || 5) + 0.6);
        aheads.push({ x: f.sx + f.dx * s + f.rx * o, z: f.sz + f.dz * s + f.rz * o, yaw: Math.atan2(-f.dx, -f.dz) });
      }
    }
    // the dig: a patch of dirt to one side of the middle, drums around it, a steel plate and a pile
    const side = k < 0.5 ? 1 : -1;
    const Lp = Math.min(26, e.len - 26), Wp = Math.min(W * 1.1, 5.5);
    const mid = e.len / 2, po = side * (W - Wp / 2 - 0.2);
    {
      const [x, z] = at(mid, po);
      fixed.patch.push({ x, z, yaw, sx: Wp, sz: Lp });
      const [px, pz] = at(mid + Lp * 0.18, po);
      fixed.plate.push({ x: px, z: pz, yaw, sx: Wp * 0.5, sz: 2.4 });
    }
    for (let s = mid - Lp / 2; s <= mid + Lp / 2 + 0.01; s += 3.2) {
      const [x, z] = at(s, po - side * (Wp / 2 + 0.5));
      add('drum', x, z, yaw + hash(x, z, 1) * 6);
    }
    for (const s of [mid - Lp / 2 - 0.6, mid + Lp / 2 + 0.6]) {
      for (const f of [-0.3, 0.3]) {
        const [x, z] = at(s, po + f * Wp);
        add('drum', x, z, yaw + hash(x, z, 1) * 6);
      }
    }
    // the cones down the open side, from each barricade line to the dig
    for (let s = 6; s < e.len - 6; s += 4.5) {
      if (Math.abs(s - mid) < Lp / 2 + 2) continue;
      const [x, z] = at(s, -side * (W * 0.45));
      add('cone', x, z, yaw + hash(x, z, 2) * 6);
    }
    // the machine on the open side of the dig, and the dirt it dug
    const machineO = -side * Math.max(0.5, W - Wp - 1.6);
    let pileAt; // the dirt heaped in line before the machine, long way down the street: a ramp to jump it from
    if (k < 0.55 || Lp < 18) {
      pileAt = at(mid - Lp * 0.15 - 4.6 - 9, machineO);
      const [x, z] = at(mid - Lp * 0.15, machineO);
      const ty = yaw + (hash(x, z, 4) < 0.5 ? 0 : Math.PI);
      const t = { kind: 'dumptruck', x, z, yaw: ty, home: [x, z, ty], hx: 1.3, hz: 4.6, top: 3.6 };
      fixed.truck.push(t);
      t.col = solid(x, z, ty, 1.3, 4.6, 3.6);
      t.lamps = [{ fixed: true, x, z, yaw: ty, ox: -0.95, oy: 3.45, oz: 2.75 }, { fixed: true, x, z, yaw: ty, ox: 0.95, oy: 3.45, oz: 2.75 }];
      lamps.push(...t.lamps);
    } else {
      // the excavator stands beside the dig and reaches across it
      const [x, z] = at(mid, -side * Math.max(0.5, W - Wp - 2.0));
      pileAt = at(mid - 1.45 - 9, -side * Math.max(0.5, W - Wp - 2.0));
      const ty = yaw + side * Math.PI / 2;
      const t = { kind: 'excavator', x, z, yaw: ty, home: [x, z, ty], hx: 1.45, hz: 2.4, top: 3.4, lamps: [] };
      fixed.excavator.push(t);
      t.col = solid(x, z, ty, 1.45, 2.4, 3.4);
    }
    {
      const [x, z] = pileAt;
      // no box round it: it's earth, driven up and over like a ramp (pileTop)
      fixed.pile.push({ x, z, yaw: yaw + Math.PI / 2 + (k - 0.5) * 0.3, g: groundHeight(x, z) });
    }
  }

  // ---- drawing
  // its colour is worked out below from the vertex colours, so the material doesn't multiply them in again
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.05 });
  // the photographed soil (ambientCG's Ground 054), filled in once it's loaded
  const soilMap = new THREE.Texture();
  soilMap.wrapS = soilMap.wrapT = THREE.RepeatWrapping;
  soilMap.colorSpace = THREE.SRGBColorSpace;
  loadTexture('assets/ambientcg/Ground054_1K-JPG_Color.jpg').then((t) => { soilMap.image = t.image; soilMap.needsUpdate = true; }).catch(() => {});
  // paint is satin, glass and chrome shine; earth is the soil's grain in its own colour; and everything that works the
  // dig wears it: mud thrown up its lower half, dust on what faces up, the undersides in shade
  const shine = attribute('shine', 'float'), soil = attribute('soil', 'float'), vc = attribute('color', 'vec3');
  const wN = pow(abs(normalWorld), vec3(4)), wSum = wN.x.add(wN.y).add(wN.z);
  const grainAt = (scale) => tex(soilMap, positionWorld.zy.mul(scale)).rgb.mul(wN.x)
    .add(tex(soilMap, positionWorld.xz.mul(scale)).rgb.mul(wN.y))
    .add(tex(soilMap, positionWorld.xy.mul(scale)).rgb.mul(wN.z)).div(wSum);
  const grain = grainAt(0.55), lum = dot(grain, vec3(0.3, 0.59, 0.11)).div(0.42);
  const patchy = smoothstep(0.75, 1.15, dot(grainAt(0.13), vec3(0.3, 0.59, 0.11)).div(0.42));
  const earth = vc.mul(mix(vec3(lum), grain.div(0.42), 0.25)).mul(1.35);
  const clean = float(1).sub(shine.mul(0.85));
  const mud = smoothstep(1.9, 0.25, positionGeometry.y).mul(patchy.mul(0.7).add(0.3)).mul(clean);
  // rain-streaked grime down the sides: the grain stretched tall, only on what faces sideways
  const streak = smoothstep(0.85, 1.25, dot(tex(soilMap, vec2(positionWorld.x.add(positionWorld.z).mul(0.9), positionWorld.y.mul(0.04))).rgb, vec3(0.3, 0.59, 0.11)).div(0.42))
    .mul(smoothstep(0.6, 0.2, abs(normalWorld.y))).mul(clean);
  const scuff = smoothstep(0.7, 1.3, lum).mul(clean);
  const dusty = smoothstep(0.55, 0.95, normalWorld.y).mul(0.22).mul(clean);
  const muck = vec3(0.075, 0.055, 0.035);
  let paint = mix(vc, vec3(dot(vc, vec3(0.3, 0.59, 0.11))), 0.12);
  paint = paint.mul(mix(1, 0.72, patchy.mul(0.6).add(streak.mul(0.5)).min(1))).mul(mix(1, 0.88, scuff));
  paint = mix(paint, muck.mul(lum), mud.mul(0.85));
  paint = mix(paint, vec3(0.2, 0.17, 0.13).mul(lum), dusty);
  paint = paint.mul(mix(1, 0.55, smoothstep(-0.05, -0.8, normalWorld.y)));
  mat.colorNode = mix(paint, earth, soil);
  mat.roughnessNode = mix(mix(0.62, 0.08, shine).add(mud.mul(0.3)).min(1), 0.97, soil);
  mat.metalnessNode = mix(0.05, 0.85, shine).mul(float(1).sub(soil));
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const p3 = new THREE.Vector3(), s3 = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0), xAxis = new THREE.Vector3(1, 0, 0);
  const instanced = (geo, material, count, shadow = true) => {
    const m = new THREE.InstancedMesh(geo, material, Math.max(1, count));
    m.count = count;
    m.castShadow = shadow;
    m.receiveShadow = true;
    m.frustumCulled = false;
    m.userData.terrain = 'set';
    group.add(m);
    return m;
  };
  const place = (mesh, i, x, y, z, yaw, sx = 1, sy = 1, sz = 1) => {
    q.setFromAxisAngle(up, yaw);
    mesh.setMatrixAt(i, m4.compose(p3.set(x, y, z), q, s3.set(sx, sy, sz)));
  };
  const setFixed = (geo, list, scaled = false, shadow = true) => {
    const mesh = instanced(geo, mat, list.length, shadow);
    list.forEach((f, i) => place(mesh, i, f.x, groundHeight(f.x, f.z) + (scaled ? 0.01 : 0), f.z, f.yaw, scaled ? f.sx : 1, 1, scaled ? f.sz : 1));
    return mesh;
  };
  const machineMesh = { dumptruck: setFixed(dumpTruckGeo(), fixed.truck), excavator: setFixed(excavatorGeo(), fixed.excavator) };
  fixed.truck.forEach((m, i) => { m.i = i; });
  fixed.excavator.forEach((m, i) => { m.i = i; });
  setFixed(pileGeo(), fixed.pile, false, false);
  setFixed(patchGeo(), fixed.patch, true, false);
  setFixed(plateGeo(), fixed.plate, true, false);

  // the diamonds on their stands
  const standMesh = instanced(standGeo(), mat, aheads.length, false);
  const diamondMat = new THREE.MeshStandardNodeMaterial({ map: aheadTexture(), roughness: 0.5 });
  const diamond = new THREE.BoxGeometry(0.9, 0.9, 0.025);
  diamond.rotateZ(Math.PI / 4);
  diamond.translate(0, 1.55, 0.04);
  const diamondMesh = instanced(diamond, diamondMat, aheads.length, false);
  aheads.forEach((a, i) => {
    const y = groundHeight(a.x, a.z);
    place(standMesh, i, a.x, y, a.z, a.yaw);
    place(diamondMesh, i, a.x, y, a.z, a.yaw);
  });

  // the loose things, and the plates on the barricades
  const byKind = { cone: [], drum: [], barricade: [] };
  for (const it of items) { it.i = byKind[it.kind].length; byKind[it.kind].push(it); }
  const looseMesh = {
    cone: instanced(coneGeo(), mat, byKind.cone.length, false),
    drum: instanced(drumGeo(), mat, byKind.drum.length, false),
    barricade: instanced(barricadeGeo(), mat, byKind.barricade.length, false)
  };
  const plateMat = new THREE.MeshStandardNodeMaterial({ map: closedTexture(), roughness: 0.5 });
  const plate = new THREE.BoxGeometry(1.2, 0.6, 0.025);
  plate.translate(0, 1.9, 0.07);
  const plateMesh = instanced(plate, plateMat, byKind.barricade.length, false);

  // the amber lamps, blinking out of step with each other
  const lampMat = new THREE.MeshStandardNodeMaterial({ color: 0x5a3a08, roughness: 0.4 });
  const blink = step(0.55, fract(time.mul(1.1).add(positionWorld.x.mul(0.37)).add(positionWorld.z.mul(0.23))));
  lampMat.emissiveNode = color(0xffa21a).mul(blink.mul(4.0).add(0.05));
  const lampGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.07, 12);
  lampGeo.rotateX(Math.PI / 2);
  const lampMesh = instanced(lampGeo, lampMat, lamps.length, false);

  const matrixOf = (it, out) => {
    // turned to its heading, tipped over toward where it was knocked, and lifted by what it lies on
    qa.setFromAxisAngle(up, it.tipYaw);
    qb.setFromAxisAngle(xAxis, it.tilt);
    q.copy(qa).multiply(qb);
    qa.setFromAxisAngle(up, it.yaw - it.tipYaw);
    q.multiply(qa);
    return out.compose(p3.set(it.x, it.g + it.h + Math.sin(it.tilt) * it.lie, it.z), q, s3.set(1, 1, 1));
  };
  const lampAt = (l, i) => {
    if (l.fixed) {
      const cs = Math.cos(l.yaw), sn = Math.sin(l.yaw);
      place(lampMesh, i, l.x + cs * l.ox + sn * l.oz, groundHeight(l.x, l.z) + l.oy, l.z - sn * l.ox + cs * l.oz, l.yaw);
      return;
    }
    matrixOf(l.item, m4);
    p3.set(l.ox, l.oy, l.oz).applyMatrix4(m4);
    q.setFromRotationMatrix(m4);
    lampMesh.setMatrixAt(i, m4.compose(p3, q, s3.set(1, 1, 1)));
  };
  const draw = (it) => {
    matrixOf(it, m4);
    looseMesh[it.kind].setMatrixAt(it.i, m4);
    looseMesh[it.kind].instanceMatrix.needsUpdate = true;
    if (it.kind === 'barricade') { plateMesh.setMatrixAt(it.i, m4); plateMesh.instanceMatrix.needsUpdate = true; }
  };
  for (const it of items) draw(it);
  lamps.forEach((l, i) => { l.n = i; lampAt(l, i); if (!l.fixed) l.item.lamp = l; });

  // ---- knocking them over
  const CELL = 12;
  const cells = new Map();
  const key = (cx, cz) => cx * 73856093 ^ cz * 19349663;
  for (const it of items) {
    const kk = key(Math.floor(it.x / CELL), Math.floor(it.z / CELL));
    if (!cells.has(kk)) cells.set(kk, []);
    cells.get(kk).push(it);
    it.cell = kk;
  }
  const moving = new Set();
  // the body that hits them: [half width, half length] of the player's car, bike, bicycle or self
  const bodyOf = (ent, mode) => mode === 'car' ? (ent.bike ? [0.45, 1.15] : [1.0, 2.35]) : mode === 'cyclist' ? [0.35, 0.9] : mode === 'person' ? [0.3, 0.3] : null;
  // a body moving through the work zone sends what it runs into flying; returns how much of its speed is left
  function strike(px, py, pz, heading, sp, hw, hl, who) {
    const sn = Math.sin(heading), cs = Math.cos(heading);
    const reach = hl + 1.2;
    const c0x = Math.floor((px - reach) / CELL), c1x = Math.floor((px + reach) / CELL);
    const c0z = Math.floor((pz - reach) / CELL), c1z = Math.floor((pz + reach) / CELL);
    let keep = 1;
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const list = cells.get(key(cx, cz));
      if (!list) continue;
      for (const it of list) {
        const dx = it.x - px, dz = it.z - pz;
        if (py !== null && Math.abs(py - it.g - it.h) > 2.2) continue;
        const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs; // across, along the body
        if (Math.abs(lx) > hw + it.r || Math.abs(lz) > hl + it.r) continue;
        // only what it's running into, and not again while it's still flying off
        const rel = Math.hypot(it.vx - sn * sp, it.vz - cs * sp);
        if (rel < 1.2) continue;
        const side = Math.sign(lx) || 1, across = (0.25 + random() * 0.35) * Math.abs(sp) * side;
        it.vx = sn * sp * it.fling + cs * across;
        it.vz = cs * sp * it.fling - sn * across;
        it.vy = Math.min(7, 1 + Math.abs(sp) * it.lift);
        if (!it.moving) { it.tipYaw = Math.atan2(it.vx, it.vz); it.tiltVel = 3 + Math.abs(sp) * 0.25; }
        it.moving = true;
        moving.add(it);
        keep *= 1 - it.drag;
        api.onHit?.(it, Math.abs(sp), who);
      }
    }
    return keep;
  }
  // knocked things settle where they land: file them under the cell they're in now, so the next car finds them
  function refile(it) {
    const was = it.cell, now = key(Math.floor(it.x / CELL), Math.floor(it.z / CELL));
    if (was === now) return;
    const old = cells.get(was);
    if (old) { const n = old.indexOf(it); if (n >= 0) old.splice(n, 1); }
    if (!cells.has(now)) cells.set(now, []);
    cells.get(now).push(it);
    it.cell = now;
  }
  function trafficStrikes(list) {
    if (list) for (const v of list) {
      if (!v || Math.abs(v.speed || 0) < 0.6 || v.x === undefined) continue;
      const k = strike(v.x, null, v.z, v.yaw + (v.yawOffset || 0), v.speed, v.halfWidth ?? 0.86, v.halfL ?? 2.18, 'traffic');
      if (k < 1) v.speed *= 0.5 + 0.5 * k;
    }
  }
  function update(dt, ent, mode, cars, buses) {
    const body = ent && bodyOf(ent, mode);
    if (body && Math.abs(ent.speed || 0) > 0.6) {
      ent.speed *= strike(ent.position.x, ent.position.y, ent.position.z, ent.heading, ent.speed, body[0], body[1], 'player');
    }
    // traffic, and the buses, run into them too
    trafficStrikes(cars);
    trafficStrikes(buses);
    for (const it of moving) {
      it.vy -= 9.8 * dt;
      it.h += it.vy * dt;
      it.x += it.vx * dt;
      it.z += it.vz * dt;
      const g = groundHeight(it.x, it.z);
      it.h += it.g - g;
      it.g = g;
      if (it.h <= 0) {
        it.h = 0;
        it.vy = it.vy < -2 ? -it.vy * 0.3 : 0;
        const slow = Math.exp(-dt * 4);
        it.vx *= slow; it.vz *= slow;
      }
      it.tilt = Math.min(Math.PI / 2, it.tilt + it.tiltVel * dt);
      if (it.h === 0 && it.tilt >= Math.PI / 2 && Math.hypot(it.vx, it.vz) < 0.1) {
        it.vx = it.vz = 0;
        moving.delete(it);
        refile(it);
      }
      draw(it);
      if (it.lamp) { lampAt(it.lamp, it.lamp.n); lampMesh.instanceMatrix.needsUpdate = true; }
    }
  }

  log(`[road work] ${closures.length} blocks closed, ${items.filter((i) => i.kind === 'cone').length} cones, ${byKind.drum.length} drums, ${byKind.barricade.length} barricades, ${fixed.truck.length + fixed.excavator.length} machines`);
  // ---- the machines the player can climb into and drive (controllers.js drives them as a car): `nearestMachine` finds
  // one within reach of where they stand, `take` lifts it out of the work zone (hidden, its box gone) and `leave` sets it
  // down again where the player left it; `home` puts it back at its own dig
  const machines = [...fixed.truck, ...fixed.excavator];
  let held = null;
  const show = (m, on) => {
    const mesh = machineMesh[m.kind];
    if (on) place(mesh, m.i, m.x, groundHeight(m.x, m.z), m.z, m.yaw);
    else mesh.setMatrixAt(m.i, m4.makeScale(0, 0, 0));
    mesh.instanceMatrix.needsUpdate = true;
    for (const l of m.lamps) {
      if (on) { l.x = m.x; l.z = m.z; l.yaw = m.yaw; lampAt(l, l.n); } else lampMesh.setMatrixAt(l.n, m4.makeScale(0, 0, 0));
    }
    lampMesh.instanceMatrix.needsUpdate = true;
    if (on) reboxed(m); else m.col.maxY = -Infinity;
  };
  function nearestMachine(x, z, reach) {
    let best = null, bestD = reach;
    for (const m of machines) {
      if (m === held) continue;
      // how far from its sides, not its middle: a truck is long
      const cs = Math.cos(m.yaw), sn = Math.sin(m.yaw), dx = x - m.x, dz = z - m.z;
      const lx = Math.abs(dx * cs - dz * sn) - m.hx, lz = Math.abs(dx * sn + dz * cs) - m.hz;
      const d = Math.hypot(Math.max(0, lx), Math.max(0, lz));
      if (d < bestD) { bestD = d; best = m; }
    }
    return best ? { machine: best, d: bestD, x: best.x, z: best.z, yaw: best.yaw } : null;
  }
  function take(m) {
    if (held && held !== m) leave(held.x, held.z, held.yaw);
    held = m;
    show(m, false);
    return { kind: m.kind, hex: 0, style: 0 };
  }
  function leave(x, z, yaw) {
    const m = held;
    if (!m) return null;
    held = null;
    Object.assign(m, { x, z, yaw });
    show(m, true);
    return m.col;
  }
  // a reloaded game whose player was in one: the one of that kind nearest them is the one they're in
  function claim(kind, x, z) {
    let best = null, bestD = Infinity;
    for (const m of machines) if (m.kind === kind && (m.x - x) ** 2 + (m.z - z) ** 2 < bestD) { bestD = (m.x - x) ** 2 + (m.z - z) ** 2; best = m; }
    if (best) take(best);
  }
  function home() {
    if (held) leave(...held.home);
    for (const m of machines) if (m.x !== m.home[0] || m.z !== m.home[1]) { [m.x, m.z, m.yaw] = m.home; show(m, true); }
  }

  // onHit(item, speed): set by the game, for the sound of it
  // The dirt piles' height above the ground at (x, z), or -Infinity off them: the two heaps of pileGeo as straight cones
  // just inside their domes (the wheels sink a little in the loose earth), so a car runs up an even slope and leaves
  // the top with all the lift it climbed with, enough at speed to clear the machine beyond or land on it
  // (controllers.js getGroundHeight, carVertical)
  const heap = (lx, lz, w, h, d) => { const t = Math.hypot(lx / (w / 2), lz / (d / 2)); return t < 1 ? h * (1 - t) : -Infinity; };
  const pileTop = (x, z) => {
    let top = -Infinity;
    for (const p of fixed.pile) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz > 9) continue;
      const cs = Math.cos(p.yaw), sn = Math.sin(p.yaw), lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const y = Math.max(heap(lx, lz, 4.4, 1.15, 3.5), heap(lx - 1.5, lz - 0.9, 2.2, 0.55, 1.9));
      if (y > -Infinity) top = Math.max(top, p.g + y);
    }
    return top;
  };
  const api = { group, colliders, pileTop, update, closures, onHit: null, material: mat, nearestMachine, take, leave, claim, home, get held() { return held; } };
  return api;
}

export { planClosures, buildRoadWork, dumpTruckGeo, excavatorGeo, truckWheelGeo, TRUCK_WHEELS };
