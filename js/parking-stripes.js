import * as THREE from 'three/webgpu';
import { attribute, float, vec2, fract, abs, clamp, max, min, step, smoothstep, fwidth, dot, positionWorld } from 'three/tsl';

// Painted stalls on every parking lot: a second copy of each lot's surface just above it, clear but for white stall
// lines. Each lot's stalls run off its longest edge (`lotFrame`: that edge's start, its direction, and which side is
// inside), in the usual American layout: a row of 2.7 m by 5.5 m stalls on the edge, a 7 m aisle, then back-to-back rows
// and aisles every 18 m.

const STALL_W = 2.7;
const MODULE = 18;

// The lot's frame from its outer ring: origin at the longest edge's start, `a` along it, `n` into the lot
function lotFrame(ring) {
  let best = 0, ox = 0, oz = 0, ax = 1, az = 0;
  let cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    cx += p.x; cz += p.z;
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    if (L > best) { best = L; ox = p.x; oz = p.z; ax = (q.x - p.x) / L; az = (q.z - p.z) / L; }
  }
  cx /= ring.length; cz /= ring.length;
  const inward = (cx - ox) * -az + (cz - oz) * ax >= 0 ? 1 : -1;
  return [ox, oz, Math.atan2(az, ax), inward];
}

// Tags a lot's flat geometry with its frame, for the stripes' shader
function tagLot(geo, ring) {
  const f = lotFrame(ring);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) arr.set(f, i * 4);
  geo.setAttribute('lotFrame', new THREE.BufferAttribute(arr, 4));
  return geo;
}

function createStripeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xeceae2, roughness: 0.7, transparent: true, depthWrite: false });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -2;
  const frame = attribute('lotFrame', 'vec4');
  const a = vec2(frame.z.cos(), frame.z.sin());
  const nrm = vec2(a.y.negate(), a.x).mul(frame.w);
  const d = positionWorld.xz.sub(frame.xy);
  const u = dot(d, a), v = dot(d, nrm);
  const fw = max(fwidth(u), 0.002);
  // distance to the nearest stall line, and how much of the pixel a 12 cm line covers
  const du = float(0.5).sub(abs(fract(u.div(STALL_W)).sub(0.5))).mul(STALL_W);
  const line = clamp(float(0.06).add(fw.mul(0.5)).sub(du).div(fw), 0.0, 1.0);
  const vm = fract(v.div(MODULE)).mul(MODULE);
  const fv = max(fwidth(v), 0.002);
  const rowA = clamp(min(vm, float(5.5)).sub(max(vm.sub(fv), float(0.3))).div(fv), 0.0, 1.0);
  const rowB = clamp(min(vm.add(fv), float(MODULE)).sub(max(vm, float(12.5))).div(fv), 0.0, 1.0);
  const inStall = max(rowA, rowB).mul(step(0.3, v));
  // worn paint, faded out where the lines get thinner than a pixel
  const wear = fract(u.mul(0.37).add(v.mul(1.71))).mul(0.25).add(0.7);
  mat.opacityNode = line.mul(inStall).mul(wear).mul(smoothstep(0.35, 0.08, fw));
  return mat;
}

export { tagLot, createStripeMaterial };
