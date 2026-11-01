import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { positionWorld, floor, fract, sin, dot, vec2, mix, color } from 'three/tsl';
import { drawOver } from './terrain.js';

// Ann Arbor's park playgrounds, where OpenStreetMap has them (GEO.playgrounds from build-annarbor.py): wood-chip
// ground on the real outline, a play tower with a slide in the middle, and a swing set beside it where there's room.
// Each kind of equipment is one instanced mesh in vertex colours.

const GREEN = 0x2e6e45, RED = 0xc23b2c, BLUE = 0x2c5fae, YELLOW = 0xf2b705, DECK = 0x6b4a32, SEAT = 0x232323, CHAIN = 0x8a8a8a;

function tinted(geo, hex) {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

// A post from (x0, y0, z0) to (x1, y1, z1)
function post(r, x0, y0, z0, x1, y1, z1, hex) {
  const d = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0);
  const g = new THREE.CylinderGeometry(r, r, d.length(), 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return tinted(g, hex);
}

const boxAt = (w, h, d, x, y, z, hex) => tinted(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);

// The play tower: a 1.25 m deck on four posts under a red roof, panels on two sides, a ladder up and a slide down
// (along +x, about 6 m from ladder to the slide's foot; centred)
function towerGeometry() {
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(post(0.065, sx, 0, sz, sx, 3.1, sz, GREEN));
  parts.push(boxAt(2.3, 0.1, 2.3, 0, 1.25, 0, DECK));
  parts.push(tinted(new THREE.ConeGeometry(1.75, 0.9, 4).rotateY(Math.PI / 4).translate(0, 3.55, 0), RED));
  for (const sz of [-1, 1]) {
    parts.push(boxAt(2.0, 0.75, 0.05, 0, 1.75, sz * 1.0, BLUE));
    parts.push(boxAt(2.0, 0.06, 0.08, 0, 2.15, sz * 1.0, YELLOW));
  }
  // the slide, from the deck's edge to the ground 2.9 m out
  const len = Math.hypot(2.9, 1.1), tilt = -Math.atan2(1.1, 2.9);
  parts.push(tinted(new THREE.BoxGeometry(len, 0.05, 0.7).rotateZ(tilt).translate(1.15 + 1.45, 0.75, 0), YELLOW));
  for (const sz of [-1, 1]) {
    parts.push(tinted(new THREE.BoxGeometry(len, 0.24, 0.05).rotateZ(tilt).translate(1.15 + 1.45, 0.87, sz * 0.36), YELLOW));
  }
  // the ladder
  for (const sz of [-1, 1]) parts.push(post(0.04, -1.55, 0, sz * 0.32, -1.15, 1.9, sz * 0.32, GREEN));
  for (let k = 1; k <= 4; k++) {
    const y = k * 0.27, x = -1.55 + 0.4 * (y / 1.9);
    parts.push(boxAt(0.06, 0.05, 0.64, x, y, 0, DECK));
  }
  const g = mergeGeometries(parts, false);
  g.translate(-1.1, 0, 0);
  return g;
}

// A swing set: a 4.2 m beam on A-frame legs, two seats on chains
function swingGeometry() {
  const parts = [post(0.06, -2.1, 2.4, 0, 2.1, 2.4, 0, GREEN)];
  for (const x of [-2.0, 2.0]) for (const sz of [-1, 1]) parts.push(post(0.055, x, 2.4, 0, x, 0, sz * 0.95, GREEN));
  for (const x of [-0.85, 0.85]) {
    parts.push(boxAt(0.5, 0.04, 0.22, x, 0.5, 0, SEAT));
    for (const dx of [-0.22, 0.22]) parts.push(boxAt(0.02, 1.88, 0.02, x + dx, 1.45, 0, CHAIN));
  }
  return mergeGeometries(parts, false);
}

function instanced(geo, mat, matrices) {
  const m = new THREE.InstancedMesh(geo, mat, matrices.length);
  matrices.forEach((x, i) => m.setMatrixAt(i, x));
  m.instanceMatrix.needsUpdate = true;
  m.castShadow = true;
  m.receiveShadow = true;
  m.computeBoundingSphere();
  return m;
}

// `flatGeo(rings, y)` makes the chips' ground; adds everything to `group`
function buildPlaygrounds(group, list, flatGeo, toRing, y) {
  if (!list || !list.length) return 0;
  const chips = [], towers = [], swings = [];
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const place = (cx, cz, angle, along, across) => {
    const ax = Math.cos(angle), az = Math.sin(angle);
    const p = new THREE.Vector3(cx + ax * along - az * across, y, cz + az * along + ax * across);
    return new THREE.Matrix4().compose(p, q.setFromAxisAngle(up, -angle), one);
  };
  for (const [ring, cx, cz, angle, L, W] of list) {
    chips.push(flatGeo([toRing(ring)], y));
    if (L < 6.5 || W < 4.5) continue;
    if (L >= 14 && W >= 6.5) {
      towers.push(place(cx, cz, angle, -L * 0.22, 0));
      swings.push(place(cx, cz, angle, L * 0.27, 0));
    } else {
      towers.push(place(cx, cz, angle, 0, 0));
    }
  }
  const chipGeo = mergeGeometries(chips, false);
  // drawn in front of the lawn it sits on (drawOver, terrain.js): only a centimetre above it, the grass cut to the
  // slopes its own way came up through the chips in spikes. Mottled in two sizes of patch so it reads as mulch.
  const chipMat = drawOver(new THREE.MeshStandardNodeMaterial({ roughness: 1 }));
  const cell = (s) => { const p = floor(positionWorld.xz.mul(s)); return fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453)); };
  const mottle = cell(2.5).mul(0.6).add(cell(9).mul(0.4));
  chipMat.colorNode = mix(color(0x6e4f33), color(0x9a7650), mottle);
  const chipMesh = new THREE.Mesh(chipGeo, chipMat);
  chipMesh.receiveShadow = true;
  group.add(chipMesh);
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05 });
  if (towers.length) group.add(instanced(towerGeometry(), mat, towers));
  if (swings.length) group.add(instanced(swingGeometry(), mat, swings));
  return towers.length;
}

export { buildPlaygrounds };
