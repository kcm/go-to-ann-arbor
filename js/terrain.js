// js/terrain.js
// The height of the ground over Manhattan, in metres above the street level the rest of the city was drawn at (y = 0),
// from data/elevation.bin.gz (made by Assets/Tools/build-elevation.mjs). Heights are 0 in the water and ease to 0
// near the shore, so whatever sits at the waterline (seawalls, waterfront highways, piers, bridge landings) stays
// where it was drawn.
//
// The city is built flat and then set on the ground (setOnTerrain): ground layers are cut finer and follow it
// vertex by vertex, and what stands on it (buildings, trees, lamps, benches) is lifted whole to the lowest ground
// under it, so nothing leans or floats. What moves asks groundHeight each frame.

import * as THREE from 'three/webgpu';
import { float, texture, uniform, vec2 } from 'three/tsl';
import { hot, asset } from '../lamp-game.js';
import { STADIUM, radiiAt, bowlSurface } from './stadium-shape.js';
import { GEO } from './nyc-geodata.js';

let grid = null; // { x0, z0, step, cols, rows, heights: Float32Array }

// Lamp: kept while main.js runs again for a change (lamp-game.js, "Running the game's code again"), so the heights are
// read once; the parts of the city built on them name what this returns as one of their inputs.
async function loadTerrain(url = './data/elevation.bin.gz') {
  grid = await hot(import.meta).keep('heightsAndRiver', () => readHeights(url));
  return grid;
}

// Read through Lamp's runtime (asset()), so a change to the file builds the kept heights, and the city on them, again.
async function unzipped(url) {
  const packed = await asset(url);
  if (!packed) throw new Error('not found');
  // A server that sends .gz as Content-Encoding: gzip hands over bytes the browser has already inflated
  const head = new Uint8Array(packed, 0, 2);
  return head[0] === 0x1f && head[1] === 0x8b
    ? await new Response(new Response(packed).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    : packed;
}

async function readHeights(url) {
  try {
    const bytes = await unzipped(url);
    if (new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) !== 'ELV2') throw new Error('unknown format');
    const [x0, z0, step, cols, rows] = new Float32Array(bytes, 4, 6);
    const centimetres = new Uint16Array(bytes, 28, cols * rows);
    const heights = new Float32Array(cols * rows);
    for (let i = 0; i < heights.length; i++) heights[i] = centimetres[i] / 100;
    console.log(`[terrain] ${cols} × ${rows} heights at ${step} m`);
    const g = { x0, z0, step, cols, rows, heights };
    digBowl(g);
    g.river = await readRiver(g, './data/river.bin.gz');
    return g;
  } catch (error) {
    console.warn('[terrain] no ground heights, the city stays flat:', error);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The Huron River, sunk into its banks, and the bridges over it
// ---------------------------------------------------------------------------------------------------------------------

// data/river.bin.gz (RIV1, from build-annarbor.py): how far each 2 m cell of the water is dug down towards the bed
// (0 at the shore to 1 a few metres out), and the water's level on a 10 m grid, a little under its lowest bank. The
// streets' and railways' bridges (GEO.riverBridges) carry their ground over the water on a deck from bank to bank, high
// enough over the water to pass under; footbridges' decks are drawn on their own (bridges.js).
async function readRiver(g, url) {
  try {
    const bytes = await unzipped(url);
    if (new TextDecoder().decode(new Uint8Array(bytes, 0, 4)) !== 'RIV1') throw new Error('unknown format');
    const [dx0, dz0, dstep, dcols, drows, lx0, lz0, lstep, lcols, lrows] = new Float32Array(bytes, 4, 10);
    const n = dcols * drows;
    const dig = new Uint8Array(bytes, 44, n);
    const cm = new Uint16Array(bytes, 44 + n + (n % 2), lcols * lrows);
    const level = new Float32Array(cm.length);
    for (let i = 0; i < cm.length; i++) level[i] = cm[i] / 100;
    const r = { dx0, dz0, dstep, dcols, drows, dig, lx0, lz0, lstep, lcols, lrows, level, bridges: [], buckets: new Map() };
    buildDecks(g, r);
    console.log(`[terrain] the river's bed ${dcols} × ${drows} at ${dstep} m, ${r.bridges.length} bridges`);
    return r;
  } catch (error) {
    console.warn('[terrain] no river bed:', error);
    return null;
  }
}

function baseHeight(g, x, z) {
  const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step;
  if (!(fx >= 0 && fz >= 0 && fx < g.cols - 1 && fz < g.rows - 1)) return 0;
  const c = Math.floor(fx), r = Math.floor(fz), ax = fx - c, az = fz - r;
  const h = g.heights, i = r * g.cols + c;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + g.cols] * (1 - ax) + h[i + g.cols + 1] * ax) * az;
}

// How far (0-1) the ground at (x, z) is dug down to the river's bed
function digAt(r, x, z) {
  const fx = (x - r.dx0) / r.dstep, fz = (z - r.dz0) / r.dstep;
  if (!(fx >= 0 && fz >= 0 && fx < r.dcols - 1 && fz < r.drows - 1)) return 0;
  const c = Math.floor(fx), w = Math.floor(fz), ax = fx - c, az = fz - w, d = r.dig, i = w * r.dcols + c;
  if (!(d[i] | d[i + 1] | d[i + r.dcols] | d[i + r.dcols + 1])) return 0;
  return ((d[i] * (1 - ax) + d[i + 1] * ax) * (1 - az) + (d[i + r.dcols] * (1 - ax) + d[i + r.dcols + 1] * ax) * az) / 255;
}

function levelAt(r, x, z) {
  const fx = Math.min(Math.max((x - r.lx0) / r.lstep, 0), r.lcols - 1.001);
  const fz = Math.min(Math.max((z - r.lz0) / r.lstep, 0), r.lrows - 1.001);
  const c = Math.floor(fx), w = Math.floor(fz), ax = fx - c, az = fz - w, h = r.level, i = w * r.lcols + c;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + r.lcols] * (1 - ax) + h[i + r.lcols + 1] * ax) * az;
}

const BUCKET = 32;
const bucketKey = (bx, bz) => bx * 100003 + bz;

// Each bridge's deck: from the ground at one end to the ground at the other, raised where it's over the water to clear
// it (2.4 m under a street's or a railway's, 1.3 m under a footbridge's), sampled every 4 m along it. Ways the map splits
// along a bridge are joined first, so the deck runs whole from bank to bank.
function buildDecks(g, r) {
  const list = (GEO.riverBridges || []).map((b) => {
    const pts = [];
    for (let i = 2; i + 1 < b.length; i += 2) pts.push([b[i], b[i + 1]]);
    return { kind: b[0], w: b[1], pts };
  }).filter((b) => b.pts.length >= 2);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1.5;
  for (let joined = true; joined;) {
    joined = false;
    for (let i = 0; i < list.length && !joined; i++) for (let j = 0; j < list.length && !joined; j++) {
      const a = list[i], b = list[j];
      if (i === j || a.kind !== b.kind) continue;
      const bp = near(a.pts.at(-1), b.pts[0]) ? b.pts : near(a.pts.at(-1), b.pts.at(-1)) ? [...b.pts].reverse() : null;
      if (!bp) continue;
      a.pts = a.pts.concat(bp.slice(1));
      a.w = Math.max(a.w, b.w);
      list.splice(j, 1);
      joined = true;
    }
  }
  for (const b of list) {
    const S = [];
    for (let i = 0; i + 1 < b.pts.length; i++) {
      const [x0, z0] = b.pts[i], [x1, z1] = b.pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(1, Math.ceil(len / 4));
      for (let k = 0; k < n; k++) S.push([x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n]);
    }
    S.push(b.pts.at(-1));
    let s = 0;
    const L = [0];
    for (let i = 1; i < S.length; i++) L.push(s += Math.hypot(S[i][0] - S[i - 1][0], S[i][1] - S[i - 1][1]));
    if (s < 3) continue;
    const ha = baseHeight(g, ...S[0]), hb = baseHeight(g, ...S.at(-1));
    const clear = b.kind === 2 ? 2.6 : 3.7, reach = b.kind === 2 ? 0 : b.w / 2 + 2.5;
    const wet = S.map(([x, z], i) => {
      const j = Math.min(i + 1, S.length - 1), k = Math.max(i - 1, 0);
      let tx = S[j][0] - S[k][0], tz = S[j][1] - S[k][1];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      return digAt(r, x, z) > 0.02 || [0, 1, -1, 2, -2].some((m) => digAt(r, x - tz * (reach + Math.abs(m) * 2) * Math.sign(m || 1), z + tx * (reach + Math.abs(m) * 2) * Math.sign(m || 1)) > 0.02
        || digAt(r, x + tz * (reach + Math.abs(m) * 2), z - tx * (reach + Math.abs(m) * 2)) > 0.02);
    });
    let H = S.map(([x, z], i) => {
      const h = ha + (hb - ha) * (L[i] / s);
      return wet[i] ? Math.max(h, levelAt(r, x, z) + clear) : h;
    });
    // eased into a gentle arch, its ends kept on the ground
    for (let pass = 0; pass < 6; pass++) {
      H = H.map((h, i) => (i === 0 || i === H.length - 1 ? h : Math.max(h, (H[i - 1] + h + H[i + 1]) / 3)));
    }
    const deck = { kind: b.kind, w: b.w, half: b.kind === 2 ? b.w / 2 : b.w / 2 + 1.5, length: s, points: S.map((p, i) => [p[0], p[1], L[i], H[i], wet[i]]) };
    r.bridges.push(deck);
    if (b.kind === 2) continue;
    for (let i = 0; i + 1 < S.length; i++) {
      const seg = { deck, a: deck.points[i], b: deck.points[i + 1] };
      const x0 = Math.min(S[i][0], S[i + 1][0]) - deck.half, x1 = Math.max(S[i][0], S[i + 1][0]) + deck.half;
      const z0 = Math.min(S[i][1], S[i + 1][1]) - deck.half, z1 = Math.max(S[i][1], S[i + 1][1]) + deck.half;
      for (let bx = Math.floor(x0 / BUCKET); bx <= Math.floor(x1 / BUCKET); bx++) {
        for (let bz = Math.floor(z0 / BUCKET); bz <= Math.floor(z1 / BUCKET); bz++) {
          const key = bucketKey(bx, bz);
          if (!r.buckets.has(key)) r.buckets.set(key, []);
          r.buckets.get(key).push(seg);
        }
      }
    }
  }
}

// The ground at (x, z) on a street's or railway's bridge deck, eased in from the ground over its first and last 8 m
function onDeck(r, x, z, h) {
  const list = r.buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
  if (!list) return h;
  for (const { deck, a, b } of list) {
    const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
    const t = ((x - a[0]) * ex + (z - a[1]) * ez) / l2;
    if (t < -0.2 || t > 1.2) continue;
    const u = Math.min(1, Math.max(0, t));
    if (Math.hypot(x - a[0] - ex * u, z - a[1] - ez * u) > deck.half) continue;
    const s = a[2] + (b[2] - a[2]) * u, top = a[3] + (b[3] - a[3]) * u;
    const w = Math.min(1, Math.min(s, deck.length - s) / 8);
    return h + (top - h) * w;
  }
  return h;
}

// The river's water level at (x, z), or null where there's no river
function waterLevel(x, z) {
  const r = grid?.river;
  return r ? levelAt(r, x, z) : null;
}

// The bridges' decks: { kind (0 street, 1 railway, 2 footbridge), w, half (half the deck's width), length,
// points: [x, z, distance along, deck height, over the water] }
function bridgeDecks() {
  return grid?.river?.bridges || [];
}

// Michigan Stadium sits in a bowl dug into the ground: the ground around its outer wall (the lowest of it) is where the
// stadium is measured from (stadiumGround), and inside the wall the ground is dug out to 1.5 m under its stands and
// field (stadium-shape.js), so they show and nothing of the hill pokes through them.
function digBowl(g) {
  const at = (x, z) => {
    const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step;
    const c = Math.floor(fx), r = Math.floor(fz), ax = fx - c, az = fz - r, h = g.heights, i = r * g.cols + c;
    return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + g.cols] * (1 - ax) + h[i + g.cols + 1] * ax) * az;
  };
  let low = Infinity, reach = 0;
  for (let k = 0; k < 72; k++) {
    const a = (k / 72) * Math.PI * 2, rOut = radiiAt(a)[1];
    low = Math.min(low, at(STADIUM.cx + Math.cos(a) * (rOut + 4), STADIUM.cz + Math.sin(a) * (rOut + 4)));
    reach = Math.max(reach, rOut);
  }
  g.stadiumGround = low;
  const c0 = Math.floor((STADIUM.cx - reach - g.x0) / g.step), c1 = Math.ceil((STADIUM.cx + reach - g.x0) / g.step);
  const r0 = Math.floor((STADIUM.cz - reach - g.z0) / g.step), r1 = Math.ceil((STADIUM.cz + reach - g.z0) / g.step);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    // the lowest of the surface around the sample, so the ground between samples stays under it too
    let s = Infinity;
    for (const [u, v] of [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
      const b = bowlSurface(g.x0 + (c + u) * g.step, g.z0 + (r + v) * g.step);
      if (b !== null) s = Math.min(s, b);
    }
    if (s === Infinity) continue;
    const i = r * g.cols + c;
    g.heights[i] = Math.min(g.heights[i], low + s - 1.5);
  }
}

// The ground around Michigan Stadium, which its rim and field are measured from
function stadiumGround() {
  return grid?.stadiumGround ?? 0;
}

// The ground's height at (x, z), bilinear between samples; 0 off the map.
// In the river it's dug down from the banks to its bed, 1.8 m under the water; on a bridge it's the deck.
function groundHeight(x, z) {
  if (!grid) return 0;
  const r = grid.river;
  return r ? onDeck(r, x, z, riverbedHeight(x, z)) : baseHeight(grid, x, z);
}

// The ground at (x, z) under any bridge: the river's banks and bed where it's dug out
function riverbedHeight(x, z) {
  if (!grid) return 0;
  let h = baseHeight(grid, x, z);
  const r = grid.river;
  const f = r ? digAt(r, x, z) : 0;
  if (f > 0) {
    const bed = levelAt(r, x, z) - 1.8;
    if (bed < h) h += (bed - h) * f;
  }
  return h;
}

// How far (0-1) (x, z) is out in the river from its shore: 0 on land, 1 in open water
function riverDepth(x, z) {
  const r = grid?.river;
  return r ? digAt(r, x, z) : 0;
}

// The lowest ground under a footprint: its middle and corners, so a building is never left floating on its low side.
function groundUnder(x, z, halfW = 0, halfD = 0, rotY = 0) {
  if (!grid) return 0;
  if (halfW <= 0 && halfD <= 0) return groundHeight(x, z);
  const c = Math.cos(rotY), s = Math.sin(rotY);
  let low = groundHeight(x, z);
  for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const dx = u * halfW, dz = v * halfD;
    low = Math.min(low, groundHeight(x + dx * c + dz * s, z - dx * s + dz * c));
  }
  return low;
}

// The ground's slope at (x, z) as rise over run along x and along z.
function groundSlope(x, z, d = 2) {
  return [(groundHeight(x + d, z) - groundHeight(x - d, z)) / (2 * d), (groundHeight(x, z + d) - groundHeight(x, z - d)) / (2 * d)];
}

// The pitch (nose up, radians) and roll (right side up) of something of the given length and width standing at (x, z)
// facing yaw, from the ground under its ends and sides.
function groundTilt(x, z, yaw, length = 4, width = 1.8) {
  if (!grid) return [0, 0];
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const front = groundHeight(x + fx * length * 0.5, z + fz * length * 0.5);
  const back = groundHeight(x - fx * length * 0.5, z - fz * length * 0.5);
  const right = groundHeight(x - fz * width * 0.5, z + fx * width * 0.5);
  const left = groundHeight(x + fz * width * 0.5, z - fx * width * 0.5);
  return [Math.atan2(front - back, length), Math.atan2(right - left, width)];
}

// The heights as a texture, for shaders that measure from the ground (a canyon's shade, a signal's lamps, grime).
let groundTexture = null;
const terrainOrigin = uniform(new THREE.Vector2());
const terrainSize = uniform(new THREE.Vector2(1, 1));
function terrainTexture() {
  if (groundTexture) return groundTexture;
  const data = grid ? grid.heights : new Float32Array(1);
  groundTexture = new THREE.DataTexture(data, grid ? grid.cols : 1, grid ? grid.rows : 1, THREE.RedFormat, THREE.FloatType);
  groundTexture.magFilter = THREE.LinearFilter;
  groundTexture.minFilter = THREE.LinearFilter;
  groundTexture.wrapS = groundTexture.wrapT = THREE.ClampToEdgeWrapping;
  groundTexture.needsUpdate = true;
  if (grid) {
    terrainOrigin.value.set(grid.x0, grid.z0);
    terrainSize.value.set(grid.step * (grid.cols - 1), grid.step * (grid.rows - 1));
  }
  return groundTexture;
}

// The ground's height under a world position, in a shader.
function groundHeightNode(worldXZ) {
  if (!grid) return float(0);
  const uv = worldXZ.sub(terrainOrigin).div(terrainSize);
  const half = vec2(0.5 / grid.cols, 0.5 / grid.rows);
  return texture(terrainTexture(), uv.mul(vec2(1).sub(half.mul(2))).add(half)).r;
}

// ---------------------------------------------------------------------------------------------------------------------
// Setting what was built flat on the ground
// ---------------------------------------------------------------------------------------------------------------------

// A triangle mesh cut finer where the ground bends away from its triangles, so a polygon drawn as a few long slivers
// can follow it: a triangle is split (at the middle of its longest edge) while the ground under its edges' middles,
// quarters and centre strays more than `tolerance` metres from the plane through its corners, down to edges of
// `minEdge`. Flat ground (the water's edge, level streets) isn't cut at all. Every attribute is interpolated.
function tessellate(geometry, tolerance = 0.02, minEdge = 2) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const names = Object.keys(g.attributes).filter((n) => !g.attributes[n].isInterleavedBufferAttribute);
  const sources = names.map((n) => g.attributes[n]);
  const sizes = sources.map((a) => a.itemSize);
  const offsets = [];
  let stride = 0;
  for (const size of sizes) { offsets.push(stride); stride += size; }
  const P = offsets[names.indexOf('position')];
  const min2 = minEdge * minEdge;
  const count = g.attributes.position.count;

  // How far the ground strays from the triangle's plane (by its corners' ground heights) along it.
  const strays = (a, b, c) => {
    const ax = a[P], az = a[P + 2], bx = b[P], bz = b[P + 2], cx = c[P], cz = c[P + 2];
    const ab = (ax - bx) ** 2 + (az - bz) ** 2, bc = (bx - cx) ** 2 + (bz - cz) ** 2, ca = (cx - ax) ** 2 + (cz - az) ** 2;
    if (Math.max(ab, bc, ca) <= min2) return false;
    const ha = groundHeight(ax, az), hb = groundHeight(bx, bz), hc = groundHeight(cx, cz);
    for (const [u, v] of [[0.5, 0.5], [0.25, 0.75], [0.75, 0.25]]) {
      if (Math.abs(groundHeight(ax * u + bx * v, az * u + bz * v) - (ha * u + hb * v)) > tolerance) return true;
      if (Math.abs(groundHeight(bx * u + cx * v, bz * u + cz * v) - (hb * u + hc * v)) > tolerance) return true;
      if (Math.abs(groundHeight(cx * u + ax * v, cz * u + az * v) - (hc * u + ha * v)) > tolerance) return true;
    }
    return Math.abs(groundHeight((ax + bx + cx) / 3, (az + bz + cz) / 3) - (ha + hb + hc) / 3) > tolerance;
  };

  let out = new Float32Array(count * stride + stride * 3);
  let used = 0;
  const write = (v) => {
    if (used + stride > out.length) { const grown = new Float32Array(out.length * 2); grown.set(out); out = grown; }
    out.set(v, used);
    used += stride;
  };
  const vertex = (i) => {
    const v = new Float32Array(stride);
    sources.forEach((a, n) => { for (let k = 0; k < sizes[n]; k++) v[offsets[n] + k] = a.array[i * sizes[n] + k]; });
    return v;
  };
  const d2 = (a, b) => (a[P] - b[P]) ** 2 + (a[P + 2] - b[P + 2]) ** 2;
  const mid = (a, b) => { const m = new Float32Array(stride); for (let k = 0; k < stride; k++) m[k] = (a[k] + b[k]) / 2; return m; };
  const split = (a, b, c, depth) => {
    if (depth > 24 || !strays(a, b, c)) { write(a); write(b); write(c); return; }
    const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a), longest = Math.max(ab, bc, ca);
    // The longest edge split at its middle, keeping the winding.
    if (longest === ab) { const m = mid(a, b); split(a, m, c, depth + 1); split(m, b, c, depth + 1); }
    else if (longest === bc) { const m = mid(b, c); split(a, b, m, depth + 1); split(a, m, c, depth + 1); }
    else { const m = mid(c, a); split(a, b, m, depth + 1); split(m, b, c, depth + 1); }
  };
  // Most triangles are small: those are copied straight across without being looked at further.
  const pos = sources[names.indexOf('position')].array;
  const small = (i) => {
    const ax = pos[i * 3], az = pos[i * 3 + 2], bx = pos[i * 3 + 3], bz = pos[i * 3 + 5], cx = pos[i * 3 + 6], cz = pos[i * 3 + 8];
    return (ax - bx) ** 2 + (az - bz) ** 2 <= min2 && (bx - cx) ** 2 + (bz - cz) ** 2 <= min2 && (cx - ax) ** 2 + (cz - az) ** 2 <= min2;
  };
  const copy = (i) => {
    if (used + stride * 3 > out.length) { const grown = new Float32Array(out.length * 2); grown.set(out); out = grown; }
    for (let v = i; v < i + 3; v++) {
      for (let n = 0; n < sources.length; n++) {
        const a = sources[n].array, size = sizes[n], o = used + offsets[n];
        for (let k = 0; k < size; k++) out[o + k] = a[v * size + k];
      }
      used += stride;
    }
  };
  for (let i = 0; i < count; i += 3) {
    if (small(i)) copy(i);
    else split(vertex(i), vertex(i + 1), vertex(i + 2), 0);
  }
  const vertices = used / stride;
  if (vertices === count) return g;
  const result = new THREE.BufferGeometry();
  names.forEach((n, k) => {
    // In the attribute's own number type: a colour kept as bytes stays bytes (0-255, read as 0-1), never 255 as a float
    const Kind = sources[k].array.constructor;
    const whole = Kind !== Float32Array && Kind !== Float64Array;
    const data = new Kind(vertices * sizes[k]);
    for (let v = 0; v < vertices; v++) for (let j = 0; j < sizes[k]; j++) {
      const value = out[v * stride + offsets[k] + j];
      data[v * sizes[k] + j] = whole ? Math.round(value) : value;
    }
    result.setAttribute(n, new THREE.BufferAttribute(data, sizes[k], sources[k].normalized));
  });
  return result;
}

// Every vertex of a world-space geometry raised by the ground under it, cut finer first (tessellate) unless
// `tolerance` is 0 (lines and points, which can't be cut).
function drapeGeometry(geometry, tolerance = 0.02) {
  if (!grid) return geometry;
  const g = tolerance ? tessellate(geometry, tolerance) : geometry;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + groundHeight(pos.getX(i), pos.getZ(i)));
  pos.needsUpdate = true;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// A world-space geometry lifted whole by the lowest ground under it.
function liftGeometry(geometry) {
  if (!grid) return 0;
  geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  const lift = groundUnder((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2, (b.max.x - b.min.x) / 2, (b.max.z - b.min.z) / 2);
  if (lift) {
    geometry.translate(0, lift, 0);
    geometry.computeBoundingSphere();
  }
  return lift;
}

// Each instance of an InstancedMesh raised by the ground at its own position. Big flat instances (a sidewalk slab)
// aren't for this: they need draping.
function liftInstances(mesh) {
  if (!grid) return;
  const m = new THREE.Matrix4(), e = m.elements;
  mesh.updateMatrixWorld();
  const world = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    world.set(e[12], e[13], e[14]).applyMatrix4(mesh.matrixWorld);
    e[13] += groundHeight(world.x, world.z);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox?.();
  mesh.computeBoundingSphere?.();
}

// Big flat instances (a block's sidewalk slab) made into one geometry that follows the ground.
function drapeInstances(mesh, tolerance) {
  mesh.updateMatrixWorld();
  const m = new THREE.Matrix4();
  const parts = [];
  const base = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) if (base.attributes[name]) g.setAttribute(name, base.attributes[name].clone());
    g.applyMatrix4(m.premultiply(mesh.matrixWorld));
    parts.push(drapeGeometry(g, tolerance));
  }
  const merged = new THREE.Mesh(mergeAll(parts), mesh.material);
  merged.castShadow = mesh.castShadow;
  merged.receiveShadow = mesh.receiveShadow;
  merged.renderOrder = mesh.renderOrder;
  merged.name = mesh.name;
  const group = new THREE.Group();
  group.name = mesh.name;
  for (const g of splitIntoTiles(merged.geometry)) {
    const tile = merged.clone();
    tile.geometry = g;
    group.add(tile);
  }
  return group;
}

function mergeAll(geometries) {
  let total = 0;
  for (const g of geometries) total += g.attributes.position.count;
  const merged = new THREE.BufferGeometry();
  for (const name of Object.keys(geometries[0].attributes)) {
    const size = geometries[0].attributes[name].itemSize;
    const data = new Float32Array(total * size);
    let at = 0;
    for (const g of geometries) { data.set(g.attributes[name].array, at); at += g.attributes[name].array.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

// A world-space geometry split into square tiles by where each triangle's middle falls, so a ground layer that spans
// the island is drawn (and shadowed) only where the camera sees it, rather than whole on every pass.
const TILE = 800; // larger tiles: each ground layer is a few dozen pieces, not hundreds
function splitIntoTiles(geometry) {
  const pos = geometry.attributes.position.array;
  const triangles = pos.length / 9;
  const tileOf = new Int32Array(triangles);
  const counts = new Map();
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const key = Math.floor((pos[o] + pos[o + 3] + pos[o + 6]) / 3 / TILE) * 100000
      + Math.floor((pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3 / TILE);
    tileOf[t] = key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size < 2) return [geometry];
  const names = Object.keys(geometry.attributes);
  const tiles = new Map();
  for (const [key, count] of counts) {
    tiles.set(key, { used: 0, arrays: names.map((n) => new geometry.attributes[n].array.constructor(count * 3 * geometry.attributes[n].itemSize)) });
  }
  for (let t = 0; t < triangles; t++) {
    const tile = tiles.get(tileOf[t]);
    names.forEach((n, k) => {
      const a = geometry.attributes[n], size = a.itemSize * 3;
      tile.arrays[k].set(a.array.subarray(t * size, t * size + size), tile.used * size);
    });
    tile.used++;
  }
  return [...tiles.values()].map(({ arrays }) => {
    const g = new THREE.BufferGeometry();
    names.forEach((n, k) => g.setAttribute(n, new THREE.BufferAttribute(arrays[k], geometry.attributes[n].itemSize, geometry.attributes[n].normalized)));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
}

// A mesh in world space, its geometry laid on the ground, as one mesh or (when it's big) a group of tiles
function drapedMesh(mesh, tolerance) {
  // Road markings carry each vertex's offset to its strip's edge (`side`), which a cut would average away: they're
  // built in short lengths instead and only laid on the ground
  const draped = drapeGeometry(mesh.geometry, mesh.geometry.attributes.side ? 0 : tolerance);
  const big = draped.attributes.position.count > 30000 && !draped.index;
  if (!big) {
    mesh.geometry = draped;
    return null;
  }
  const group = new THREE.Group();
  group.name = mesh.name;
  for (const g of splitIntoTiles(draped)) {
    const tile = new THREE.Mesh(g, mesh.material);
    tile.castShadow = mesh.castShadow;
    tile.receiveShadow = mesh.receiveShadow;
    tile.renderOrder = mesh.renderOrder;
    tile.frustumCulled = mesh.frustumCulled;
    tile.layers.mask = mesh.layers.mask;
    group.add(tile);
  }
  return group;
}

const IDENTITY = new THREE.Matrix4();
const isIdentity = (m) => m.elements.every((v, i) => Math.abs(v - IDENTITY.elements[i]) < 1e-6);

// Sets a part of the city built flat on the ground. What's drawn in world space (merged batches, a single polygon of
// the whole island) follows the ground vertex by vertex, cut finer where it bends (tessellate); an object placed by
// its own transform is lifted whole by the ground at its position; instances are lifted each by its own, and those
// marked userData.terrain = 'drape' (big flat slabs) are made into one geometry that follows the ground. Anything
// marked userData.terrain = 'set' was put on the ground where it was built and is left alone, children included.
function setOnTerrain(root, tolerance = 0.05) {
  if (!grid || !root) return;
  root.updateMatrixWorld(true);
  const replace = [];
  const visit = (obj) => {
    if (obj.userData.terrain === 'set') return;
    if (obj.isInstancedMesh) {
      if (obj.userData.terrain === 'drape') replace.push([obj, drapeInstances(obj, tolerance)]);
      else liftInstances(obj);
    } else if ((obj.isMesh || obj.isLine || obj.isPoints) && obj.geometry?.attributes.position) {
      if (isIdentity(obj.matrixWorld)) {
        if (obj.isMesh) {
          const tiles = drapedMesh(obj, obj.userData.terrainTolerance ?? tolerance);
          if (tiles) replace.push([obj, tiles]);
        } else {
          obj.geometry = drapeGeometry(obj.geometry, 0);
        }
      } else {
        const at = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
        const lift = groundHeight(at.x, at.z);
        if (lift && obj.parent) {
          const world = at.clone().setY(at.y + lift);
          obj.position.copy(obj.parent.worldToLocal(world));
          obj.updateMatrixWorld(true);
        }
      }
      return; // a mesh's children (rare) move with it
    }
    for (const child of [...obj.children]) visit(child);
  };
  visit(root);
  for (const [old, draped] of replace) {
    old.parent.add(draped);
    old.removeFromParent();
  }
}

export {
  loadTerrain, groundHeight, riverbedHeight, riverDepth, waterLevel, bridgeDecks, groundUnder, stadiumGround, groundSlope, groundTilt, groundHeightNode,
  tessellate, drapeGeometry, liftGeometry, liftInstances, setOnTerrain
};
