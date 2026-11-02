import * as THREE from 'three/webgpu';
import { attribute, color, fract, mix, positionWorld, step, time } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundHeight } from './terrain.js';
import { random, log } from '../lamp-game.js';
import { roundedBox, roundedRectShape } from './vehicles.js';

// Michigan's other season: road work. A few dozen blocks around town are shut, a Type III "ROAD CLOSED" barricade
// line across each end with its amber lamps blinking, the dug-up patch in the middle ringed by orange-and-white drums,
// a line of cones, a dump truck or an excavator and a pile of dirt, and "ROAD WORK AHEAD" diamonds on the streets
// leading in. Traffic never turns into a closed block (traffic.js, `e.closed`); the player can drive straight
// through: cones, drums and barricades go flying, the machines are solid.

const hash = (x, z, k = 0) => { const v = Math.sin(x * 12.9898 + z * 78.233 + k * 37.719) * 43758.5453; return v - Math.floor(v); };

const MAX_CLOSURES = 60;
const SPACING = 170; // metres between closed blocks, at the least

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
  return geo.index ? geo.toNonIndexed() : geo;
}
const box = (w, h, d, hex, x, y, z, rx, ry, rz) => piece(new THREE.BoxGeometry(w, h, d), hex, x, y, z, rx, ry, rz);
const cyl = (rt, rb, h, hex, x, y, z, seg = 14, rx, ry, rz) => piece(new THREE.CylinderGeometry(rt, rb, h, seg), hex, x, y, z, rx, ry, rz);
const merge = (parts) => { const g = mergeGeometries(parts); g.computeBoundingSphere(); return g; };

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
const rbox = (w, h, d, r, hex, x, y, z, rx, ry, rz) => piece(roundedBox(w / 2, h / 2, d, Math.min(r, w / 2 - 0.02, h / 2 - 0.02), Math.min(0.02, r)), hex, x, y, z, rx, ry, rz);
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
const beam = (a, b, w, h, hex) => lay(roundedBox(w / 2, h / 2, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.min(0.06, w / 2 - 0.01, h / 2 - 0.01)), hex, a, b);
const rod = (a, b, r, hex, seg = 10) => lay(new THREE.CylinderGeometry(r, r, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), seg).rotateX(Math.PI / 2), hex, a, b);
// a hydraulic ram: painted barrel, chrome rod
function ram(parts, a, b, r, hex) {
  const m = [a[0] + (b[0] - a[0]) * 0.58, a[1] + (b[1] - a[1]) * 0.58, a[2] + (b[2] - a[2]) * 0.58];
  parts.push(rod(a, m, r, hex), gloss(rod(m, b, r * 0.55, 0xd8dadc), 0.9));
  parts.push(rod([a[0] - 0.01, a[1], a[2]], [a[0] + 0.01, a[1], a[2]], r * 1.25, 0x2a2a2a));
}
// a truck tyre on the x axis: tread, rounded shoulders, a steel wheel with its hub and nuts
function tyre(parts, x, y, z, r, w, outward) {
  const s = Math.min(0.09, w * 0.28);
  parts.push(cyl(r, r, w - 2 * s, 0x161617, x, y, z, 22, 0, 0, Math.PI / 2));
  for (const side of [-1, 1]) {
    const t = new THREE.TorusGeometry(r - s, s, 6, 22);
    t.rotateY(Math.PI / 2);
    parts.push(piece(t, 0x1c1c1d, x + side * (w / 2 - s), y, z));
  }
  parts.push(cyl(r - s, r - s, w - 0.02, 0x232324, x, y, z, 22, 0, 0, Math.PI / 2));
  // tread blocks across the face
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    parts.push(box(w - 2 * s, 0.035, 0.08, 0x0f0f10, x, y + Math.cos(a) * (r + 0.008), z + Math.sin(a) * (r + 0.008), a));
  }
  const face = x + outward * (w / 2);
  parts.push(gloss(cyl(r * 0.6, r * 0.6, 0.05, 0xb9bcbf, face, y, z, 18, 0, 0, Math.PI / 2), 0.55));
  parts.push(cyl(r * 0.24, r * 0.3, 0.12, 0x5a5d60, face + outward * 0.04, y, z, 12, 0, 0, Math.PI / 2));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    parts.push(gloss(cyl(0.022, 0.022, 0.06, 0xd8dadc, face + outward * 0.04, y + Math.cos(a) * r * 0.4, z + Math.sin(a) * r * 0.4, 6, 0, 0, Math.PI / 2), 0.8));
  }
}
// a fender arching over a wheel (axis x), open underneath
function fender(parts, x, y, z, r, w, hex, from = 0, to = Math.PI) {
  const g = new THREE.CylinderGeometry(r, r, w, 16, 1, true, from, to - from);
  g.rotateZ(Math.PI / 2);
  parts.push(piece(g, hex, x, y, z));
  const g2 = new THREE.CylinderGeometry(r - 0.04, r - 0.04, w, 16, 1, true, from, to - from);
  g2.rotateZ(Math.PI / 2);
  g2.scale(1, 1, 1);
  const inner = piece(g2, 0x111111, x, y, z);
  // its inside faces inward
  const idx = inner.attributes.normal.array;
  for (let i = 0; i < idx.length; i++) idx[i] = -idx[i];
  const pos = inner.attributes.position.array;
  for (let i = 0; i < pos.length; i += 9) for (let k = 0; k < 3; k++) { const t = pos[i + 3 + k]; pos[i + 3 + k] = pos[i + 6 + k]; pos[i + 6 + k] = t; }
  for (let i = 0; i < idx.length; i += 9) for (let k = 0; k < 3; k++) { const t = idx[i + 3 + k]; idx[i + 3 + k] = idx[i + 6 + k]; idx[i + 6 + k] = t; }
  parts.push(inner);
}

// a tandem-axle dump truck, the kind Ann Arbor's paving contractors run: a conventional cab behind a long hood,
// a ribbed steel box with a cab shield, its load heaped in it; facing +z, about 9 m long
function dumpTruckGeo() {
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
  const load = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  load.scale(1.12, 0.62, 2.55);
  parts.push(piece(load, 0x4e3c2b, 0, 2.62, zc));
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

// a mid-size tracked excavator in its maker's yellow: tracks with grousers on idler, sprocket and rollers, the
// turntable, the house with its counterweight and engine hood, the glass cab, and a boom, stick and bucket worked by
// rams, reaching forward (+z) into the dig
function excavatorGeo() {
  const Y = 0xf2b705, Y2 = 0xd49a00, DK = 0x252627, MID = 0x46484a, GL = 0x1f2a30, CH = 0xd8dadc;
  const parts = [];
  // undercarriage
  for (const sx of [-1, 1]) {
    const x = sx * 1.12;
    const loop = new THREE.ExtrudeGeometry(roundedRectShape(2.2, 0.42, 0.38), { depth: 0.6, bevelEnabled: false, curveSegments: 6 });
    loop.translate(0, 0, -0.3);
    loop.rotateY(Math.PI / 2);
    parts.push(piece(loop, 0x1a1a1b, x, 0.43, 0));
    for (let i = 0; i < 24; i++) {
      const z = -1.85 + i * 0.16;
      parts.push(box(0.62, 0.05, 0.07, 0x111112, x, 0.875, z));
      parts.push(box(0.62, 0.05, 0.07, 0x111112, x, -0.005, z));
    }
    parts.push(box(0.5, 0.42, 3.3, MID, x - sx * 0.04, 0.45, 0));
    for (const z of [-1.82, 1.82]) parts.push(cyl(0.34, 0.34, 0.08, MID, x + sx * 0.3, 0.43, z, 16, 0, 0, Math.PI / 2));
    parts.push(cyl(0.18, 0.18, 0.1, DK, x + sx * 0.33, 0.43, -1.82, 8, 0, 0, Math.PI / 2));
    for (let i = 0; i < 5; i++) parts.push(cyl(0.11, 0.11, 0.08, DK, x + sx * 0.3, 0.17, -1.2 + i * 0.6, 10, 0, 0, Math.PI / 2));
  }
  parts.push(box(1.7, 0.4, 2.2, MID, 0, 0.62, 0));
  parts.push(cyl(0.95, 0.95, 0.22, DK, 0, 0.95, 0, 24));
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
  parts.push(cyl(0.08, 0.1, 0.14, 0xff8a00, cx + 0.3, 3.55, cz - 0.5, 10));
  // boom (bent, in two lengths), stick, bucket, their rams
  const bx = 0.3, piv = [bx, 1.85, 1.05], knee = [bx, 4.25, 2.95], tip = [bx, 3.95, 5.05];
  parts.push(box(0.55, 0.5, 0.5, Y2, bx, 1.75, 1.05));
  parts.push(beam(piv, knee, 0.44, 0.58, Y), beam(knee, tip, 0.42, 0.5, Y));
  for (const sx of [-1, 1]) ram(parts, [bx + sx * 0.3, 1.4, 1.35], [bx + sx * 0.3, 3.35, 2.55], 0.1, Y2);
  const stTop = [bx, 4.55, 4.85], stEnd = [bx, 1.2, 5.85];
  parts.push(beam(stTop, stEnd, 0.36, 0.44, Y));
  ram(parts, [bx, 4.75, 2.95], [bx, 4.72, 4.75], 0.09, Y2);
  ram(parts, [bx, 4.4, 5.2], [bx, 1.75, 6.15], 0.075, Y2);
  parts.push(beam([bx, 1.75, 6.15], [bx, 1.2, 6.2], 0.3, 0.1, DK));
  const bk = [bx, 0.75, 6.05], br = 0.58;
  {
    const shell = new THREE.CylinderGeometry(br, br, 0.95, 14, 1, true, -Math.PI * 0.82, Math.PI * 1.32);
    shell.rotateZ(Math.PI / 2);
    parts.push(piece(shell, MID, bk[0], bk[1], bk[2]));
    for (const sx of [-1, 1]) {
      const side = new THREE.CylinderGeometry(br, br, 0.04, 14, 1, false, -Math.PI * 0.82, Math.PI * 1.32);
      side.rotateZ(Math.PI / 2);
      parts.push(piece(side, Y2, bk[0] + sx * 0.475, bk[1], bk[2]));
    }
    const la = -Math.PI * 0.82, ly = bk[1] + Math.sin(la) * br, lz = bk[2] + Math.cos(la) * br;
    for (let i = 0; i < 5; i++) parts.push(box(0.08, 0.07, 0.22, 0x9a9da0, bx - 0.36 + i * 0.18, ly - 0.03, lz - 0.08, 0.5));
    // a scoop of dirt in it
    const d = new THREE.SphereGeometry(0.42, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    d.scale(1.05, 0.5, 0.9);
    parts.push(piece(d, 0x4e3c2b, bk[0], bk[1] - 0.05, bk[2]));
  }
  return merge(parts);
}

function pileGeo() {
  const g = new THREE.SphereGeometry(1, 12, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(2.0, 1.0, 1.6);
  return merge([piece(g, 0x6a5038)]);
}
function patchGeo() {
  return merge([box(1, 0.04, 1, 0x3b3026, 0, 0.02, 0)]);
}
function plateGeo() {
  return merge([box(1, 0.03, 1, 0x5d6063, 0, 0.015, 0)]);
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
    colliders.push({ minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez, minY: g, maxY: g + top, solid: true, obb: { cx: x, cz: z, hx, hz, cs, sn } });
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
    if (k < 0.55 || Lp < 18) {
      const [x, z] = at(mid - Lp * 0.15, machineO);
      const ty = yaw + (hash(x, z, 4) < 0.5 ? 0 : Math.PI);
      fixed.truck.push({ x, z, yaw: ty });
      solid(x, z, ty, 1.3, 4.6, 3.6);
      lamps.push({ fixed: true, x, z, yaw: ty, ox: -0.95, oy: 3.45, oz: 2.75 }, { fixed: true, x, z, yaw: ty, ox: 0.95, oy: 3.45, oz: 2.75 });
    } else {
      // the excavator stands beside the dig and reaches across it
      const [x, z] = at(mid, -side * Math.max(0.5, W - Wp - 2.0));
      const ty = yaw + side * Math.PI / 2;
      fixed.excavator.push({ x, z, yaw: ty });
      solid(x, z, ty, 1.45, 2.4, 3.4);
    }
    {
      const [x, z] = at(mid + Lp / 2 - 3, po);
      fixed.pile.push({ x, z, yaw: yaw + k * 3 });
      solid(x, z, yaw, 1.4, 1.4, 1.0);
    }
  }

  // ---- drawing
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
  // paint is satin, glass and chrome shine
  const shine = attribute('shine', 'float');
  mat.roughnessNode = mix(0.62, 0.08, shine);
  mat.metalnessNode = mix(0.05, 0.85, shine);
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
  setFixed(dumpTruckGeo(), fixed.truck);
  setFixed(excavatorGeo(), fixed.excavator);
  setFixed(pileGeo(), fixed.pile);
  setFixed(patchGeo(), fixed.patch, true, false);
  setFixed(plateGeo(), fixed.plate, true, false);

  // the diamonds on their stands
  const standMesh = instanced(standGeo(), mat, aheads.length);
  const diamondMat = new THREE.MeshStandardNodeMaterial({ map: aheadTexture(), roughness: 0.5 });
  const diamond = new THREE.BoxGeometry(0.9, 0.9, 0.025);
  diamond.rotateZ(Math.PI / 4);
  diamond.translate(0, 1.55, 0.04);
  const diamondMesh = instanced(diamond, diamondMat, aheads.length);
  aheads.forEach((a, i) => {
    const y = groundHeight(a.x, a.z);
    place(standMesh, i, a.x, y, a.z, a.yaw);
    place(diamondMesh, i, a.x, y, a.z, a.yaw);
  });

  // the loose things, and the plates on the barricades
  const byKind = { cone: [], drum: [], barricade: [] };
  for (const it of items) { it.i = byKind[it.kind].length; byKind[it.kind].push(it); }
  const looseMesh = {
    cone: instanced(coneGeo(), mat, byKind.cone.length),
    drum: instanced(drumGeo(), mat, byKind.drum.length),
    barricade: instanced(barricadeGeo(), mat, byKind.barricade.length)
  };
  const plateMat = new THREE.MeshStandardNodeMaterial({ map: closedTexture(), roughness: 0.5 });
  const plate = new THREE.BoxGeometry(1.2, 0.6, 0.025);
  plate.translate(0, 1.9, 0.07);
  const plateMesh = instanced(plate, plateMat, byKind.barricade.length);

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
  // onHit(item, speed): set by the game, for the sound of it
  const api = { group, colliders, update, closures, onHit: null };
  return api;
}

export { planClosures, buildRoadWork };
