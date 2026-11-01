import * as THREE from 'three/webgpu';
import { attribute, float, vec2, vec3, fract, abs, smoothstep, fwidth, max, dot, positionWorld, mix } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { drawOver } from './terrain.js';

// Ann Arbor's golf courses (GEO.golf from build-annarbor.py: OpenStreetMap's fairways, greens, tees and cart paths,
// with fairways and bunkers filled in where a course isn't mapped): fairways mown in light and dark stripes along their
// length, close-cut greens with a pin and flag on each, tees, sand bunkers and asphalt cart paths, all lying on the
// lawn of the course.

// Each fairway's long axis, for its mowing stripes
function mowAngle(ring) {
  let cx = 0, cz = 0;
  for (const p of ring) { cx += p.x; cz += p.z; }
  cx /= ring.length; cz /= ring.length;
  let xx = 0, zz = 0, xz = 0;
  for (const p of ring) { const dx = p.x - cx, dz = p.z - cz; xx += dx * dx; zz += dz * dz; xz += dx * dz; }
  return 0.5 * Math.atan2(2 * xz, xx - zz);
}

function tagged(geo, angle) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n).fill(angle);
  geo.setAttribute('mow', new THREE.BufferAttribute(arr, 1));
  return geo;
}

// Turf in stripes `width` metres wide across the attribute `mow`'s direction, light and dark
function mownMaterial(dark, light, width) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const a = attribute('mow', 'float');
  const across = vec2(a.sin().negate(), a.cos());
  const v = dot(positionWorld.xz, across).div(width);
  const fw = max(fwidth(v), 0.001);
  // a soft edge between stripes, fading to their average where they get thinner than a few pixels
  const band = smoothstep(fw.negate(), fw, abs(fract(v).sub(0.5)).sub(0.25));
  const t = mix(band, float(0.5), smoothstep(0.08, 0.3, fw));
  const c0 = new THREE.Color(dark).convertSRGBToLinear(), c1 = new THREE.Color(light).convertSRGBToLinear();
  mat.colorNode = mix(vec3(c0.r, c0.g, c0.b), vec3(c1.r, c1.g, c1.b), t);
  return mat;
}

// A strip `w` wide along a line of flat x, z pairs, at height y: mitred at each bend (capped where it turns sharply)
// and cut every couple of metres along its length, so it follows the ground it's laid on
function ribbon(flat, w, y) {
  const h = w / 2;
  const P = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i], z = flat[i + 1];
    if (P.length && Math.hypot(x - P[P.length - 1][0], z - P[P.length - 1][1]) < 0.05) continue;
    P.push([x, z]);
  }
  const pos = [];
  if (P.length < 2) return emptyGeo();
  // each point's offset to the left: the average of its two segments' normals, lengthened to keep the width
  const L = [];
  const dir = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); return [dx / l, dz / l]; };
  for (let i = 0; i < P.length; i++) {
    const d0 = dir(P[Math.max(0, i - 1)], P[Math.max(1, i)]);
    const d1 = dir(P[Math.min(P.length - 2, i)], P[Math.min(P.length - 1, i + 1)]);
    let nx = -(d0[1] + d1[1]), nz = d0[0] + d1[0];
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    const cos = Math.max(0.5, nx * -d1[1] + nz * d1[0]);
    L.push([nx * h / cos, nz * h / cos]);
  }
  for (let i = 0; i + 1 < P.length; i++) {
    const [x0, z0] = P[i], [x1, z1] = P[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const ax = x0 + (x1 - x0) * t0, az = z0 + (z1 - z0) * t0, bx = x0 + (x1 - x0) * t1, bz = z0 + (z1 - z0) * t1;
      const lx0 = L[i][0] + (L[i + 1][0] - L[i][0]) * t0, lz0 = L[i][1] + (L[i + 1][1] - L[i][1]) * t0;
      const lx1 = L[i][0] + (L[i + 1][0] - L[i][0]) * t1, lz1 = L[i][1] + (L[i + 1][1] - L[i][1]) * t1;
      const A = [ax + lx0, y, az + lz0], B = [ax - lx0, y, az - lz0], C = [bx - lx1, y, bz - lz1], D = [bx + lx1, y, bz + lz1];
      pos.push(...A, ...C, ...B, ...A, ...D, ...C);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  return geo;
}

function emptyGeo() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
  return geo;
}

// A ground overlay's material, drawn in front of the lawn it lies on wherever the two meet
function overlay(color) {
  const mat = new THREE.MeshStandardNodeMaterial({ color, roughness: 0.95 });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  return mat;
}

function addMerged(group, geos, mat, name) {
  if (!geos.length) return;
  for (const g of geos) { g.deleteAttribute('uv'); }
  const m = new THREE.Mesh(mergeGeometries(geos, false), mat);
  m.name = name;
  m.receiveShadow = true;
  group.add(m);
}

function buildGolf(group, golf, flatGeo, toRing, y) {
  if (!golf) return;
  const fairways = [], greens = [], tees = [], bunkers = [];
  for (const rings of golf.fairways) {
    const r = rings.map(toRing);
    fairways.push(tagged(flatGeo(r, y), mowAngle(r[0])));
  }
  for (const rings of golf.tees) {
    const r = rings.map(toRing);
    tees.push(tagged(flatGeo(r, y + 0.004), mowAngle(r[0])));
  }
  for (const rings of golf.greens) {
    const r = rings.map(toRing);
    greens.push(tagged(flatGeo(r, y + 0.008), mowAngle(r[0]) + Math.PI / 4));
  }
  for (const rings of golf.bunkers) bunkers.push(flatGeo(rings.map(toRing), y + 0.006));
  addMerged(group, fairways, mownMaterial(0x4e8d38, 0x5d9b42, 8), 'GolfFairways');
  addMerged(group, tees, mownMaterial(0x4f9238, 0x67a94a, 2), 'GolfTees');
  addMerged(group, greens, mownMaterial(0x5aa043, 0x6db552, 1.5), 'GolfGreens');
  addMerged(group, bunkers, new THREE.MeshStandardNodeMaterial({ color: 0xe0cfa0, roughness: 1 }), 'GolfBunkers');
  addMerged(group, golf.paths.filter((p) => p.length >= 4).map((p) => ribbon(p, 2.4, y + 0.012)),
    new THREE.MeshStandardNodeMaterial({ color: 0x55575a, roughness: 0.9 }), 'GolfCartPaths');

  // The pins: a white flagstick with a flag, red on the front nine's greens and yellow on the back's
  const P = golf.pins;
  if (!P.length) return;
  const stick = new THREE.CylinderGeometry(0.02, 0.02, 2.3, 5).translate(0, 1.15, 0);
  const flag = new THREE.BufferGeometry();
  flag.setAttribute('position', new THREE.Float32BufferAttribute([0, 2.3, 0, 0, 1.85, 0, 0.55, 2.08, 0, 0, 2.3, 0, 0.55, 2.08, 0, 0, 1.85, 0], 3));
  flag.computeVertexNormals();
  const cup = new THREE.CircleGeometry(0.11, 10).rotateX(-Math.PI / 2).translate(0, 0.003, 0);
  const sticks = new THREE.InstancedMesh(stick, new THREE.MeshStandardNodeMaterial({ color: 0xf4f4f0, roughness: 0.5 }), P.length / 2);
  const flags = new THREE.InstancedMesh(flag, new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.8, side: THREE.DoubleSide }), P.length / 2);
  const cups = new THREE.InstancedMesh(cup, new THREE.MeshBasicNodeMaterial({ color: 0x151515 }), P.length / 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  const red = new THREE.Color(0xd8282b), yellow = new THREE.Color(0xf3c518);
  for (let i = 0; i < P.length / 2; i++) {
    const x = P[i * 2], z = P[i * 2 + 1];
    // every flag blows the same way, with the wind
    q.setFromAxisAngle(up, 0.6 + Math.sin(x * 0.13 + z * 0.07) * 0.25);
    m.compose(new THREE.Vector3(x, y + 0.01, z), q, one);
    sticks.setMatrixAt(i, m); flags.setMatrixAt(i, m); cups.setMatrixAt(i, m);
    flags.setColorAt(i, i % 2 ? red : yellow);
  }
  for (const im of [sticks, flags, cups]) { im.castShadow = im !== cups; group.add(im); }
  sticks.name = 'GolfPins';
}

// Trails through the parks, woods and campus lawns (GEO.trails from build-annarbor.py, OpenStreetMap's paths and
// footways): packed dirt or gravel on the woodland paths, pale gray paving on the park walks and bike paths
function buildTrails(group, trails, y) {
  if (!trails) return;
  const dirt = [], paved = [];
  for (const t of trails) {
    if (t.length < 6) continue;
    (t[0] ? dirt : paved).push(ribbon(t.slice(2), t[1], t[0] ? y : y + 0.004));
  }
  // Lamp: in front of the lawn but behind the city's own paving (driveways and the campus's walks, drawn over the lawn
  // as if 6 cm up): the map's footpaths run a little off the surveyed walks, so where the two overlap the walk wins,
  // and a paved path is the walks' own concrete, so it carries on from them seamlessly where the survey has none
  addMerged(group, dirt, drawOver(overlay(0x8f7c5e), 0.03), 'TrailsDirt');
  addMerged(group, paved, drawOver(overlay(0xa29e96), 0.03), 'TrailsPaved');
}

export { buildGolf, buildTrails };
