// js/terrain.js
// The height of the ground over Ann Arbor, in metres above the street level the rest of the city was drawn at (y = 0),
// from data/elevation.bin.gz (made by Assets/Tools/build-annarbor.py from the open Terrain Tiles). Heights are 0 in the water and ease to 0
// near the shore, so whatever sits at the waterline (seawalls, waterfront highways, piers, bridge landings) stays
// where it was drawn.
//
// The city is built flat and then set on the ground (setOnTerrain): ground layers are cut finer and follow it
// vertex by vertex, and what stands on it (buildings, trees, lamps, benches) is lifted whole to the lowest ground
// under it, so nothing leans or floats. What moves asks groundHeight each frame.

import { gpuOnly } from './gpu-only.js';
import * as THREE from 'three/webgpu';
import { float, texture, uniform, vec2, positionLocal, positionWorld, cameraPosition, normalize, abs, max, min } from 'three/tsl';
import { hot, asset, log, work } from '../lamp-game.js';
import { STADIUM, radiiAt, bowlSurface } from './stadium-shape.js';
import { GEO } from './city-geodata.js';
import { carveCascades, cascadeDepth, cascadeLevel } from './cascades.js';
import { baseHeight, digAt, levelAt, onDeck, BUCKET, bucketKey, drapeLayer, CORE_SOURCE } from './ground-core.js';

let grid = null; // { x0, z0, step, cols, rows, heights: Float32Array }

// Lamp: kept while main.js runs again for a change (lamp-game.js, "Running the game's code again"), so the heights are
// read once; the parts of the city built on them name what this returns as one of their inputs.
async function loadTerrain(url = './data/elevation.bin.gz') {
  grid = await hot(import.meta).keep('heightsAndRiver', () => readHeights(url),
    { from: [url.replace(/^\.\//, ''), 'js/cascades.js'] });
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
    carveCascades(r); // the Argo Cascades' channel, unbroken (cascades.js)
    buildDecks(g, r);
    console.log(`[terrain] the river's bed ${dcols} × ${drows} at ${dstep} m, ${r.bridges.length} bridges`);
    return r;
  } catch (error) {
    console.warn('[terrain] no river bed:', error);
    return null;
  }
}

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

// The river's water level at (x, z), or null where there's no river
function waterLevel(x, z) {
  const r = grid?.river;
  return r ? cascadeLevel(x, z, levelAt(r, x, z)) : null; // stepping down the Argo Cascades (cascades.js)
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
    const bed = cascadeLevel(x, z, levelAt(r, x, z)) - cascadeDepth(x, z, 1.8);
    if (bed < h) h += (bed - h) * f;
  }
  return h;
}

// How far (0-1) (x, z) is out in the river from its shore: 0 on land, 1 in open water
function riverDepth(x, z) {
  const r = grid?.river;
  return r ? digAt(r, x, z) : 0;
}

// Which way the river runs: the distance along the water (on a 6 m grid of its open water) from the lowest point of its
// largest stretch, measured once when it's first asked for. Downstream is where that distance falls.
const FLOW_STEP = 6;
function flowField() {
  const r = grid?.river;
  if (!r) return null;
  if (r.flow !== undefined) return r.flow;
  const cols = Math.floor((r.dcols - 1) * r.dstep / FLOW_STEP), rows = Math.floor((r.drows - 1) * r.dstep / FLOW_STEP);
  const n = cols * rows, x0 = r.dx0 + FLOW_STEP / 2, z0 = r.dz0 + FLOW_STEP / 2;
  const wet = new Uint8Array(n);
  for (let w = 0; w < rows; w++) for (let c = 0; c < cols; c++) {
    if (digAt(r, x0 + c * FLOW_STEP, z0 + w * FLOW_STEP) > 0.35) wet[w * cols + c] = 1;
  }
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  // the stretches of water that join up, and the biggest of them
  const part = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let best = -1, bestSize = 0;
  for (let i = 0; i < n; i++) {
    if (!wet[i] || part[i] >= 0) continue;
    let head = 0, tail = 0;
    queue[tail++] = i; part[i] = i;
    while (head < tail) {
      const k = queue[head++], c = k % cols, w = (k - c) / cols;
      for (const [dc, dw] of NB) {
        const cc = c + dc, ww = w + dw;
        if (cc < 0 || ww < 0 || cc >= cols || ww >= rows) continue;
        const j = ww * cols + cc;
        if (wet[j] && part[j] < 0) { part[j] = i; queue[tail++] = j; }
      }
    }
    if (tail > bestSize) { bestSize = tail; best = i; }
  }
  if (best < 0) return (r.flow = null);
  // each stretch runs to its own lowest point (a pond above a dam to the dam, the river on to Gallup)
  const lows = new Map();
  for (let i = 0; i < n; i++) {
    if (part[i] < 0) continue;
    const c = i % cols, w = (i - c) / cols, lv = levelAt(r, x0 + c * FLOW_STEP, z0 + w * FLOW_STEP);
    const was = lows.get(part[i]);
    if (!was || lv < was.level) lows.set(part[i], { level: lv, at: i });
  }
  // the distance along the water from there, relaxed until it settles
  const dist = new Float32Array(n).fill(Infinity);
  const inQueue = new Uint8Array(n);
  let head = 0, size = 0;
  for (const { at } of lows.values()) { dist[at] = 0; queue[size++] = at; inQueue[at] = 1; }
  while (size > 0) {
    const k = queue[head]; head = (head + 1) % n; size--; inQueue[k] = 0;
    const c = k % cols, w = (k - c) / cols, d = dist[k];
    for (const [dc, dw, cost] of NB) {
      const cc = c + dc, ww = w + dw;
      if (cc < 0 || ww < 0 || cc >= cols || ww >= rows) continue;
      const j = ww * cols + cc;
      if (part[j] !== part[k] || dist[j] <= d + cost) continue;
      dist[j] = d + cost;
      if (!inQueue[j]) { inQueue[j] = 1; queue[(head + size) % n] = j; size++; }
    }
  }
  let far = 0;
  for (let i = 0; i < n; i++) if (part[i] === best && dist[i] > far) far = dist[i];
  console.log(`[terrain] the river runs ${Math.round(far * FLOW_STEP / 1000 * 10) / 10} km to its lowest point here, in ${lows.size} stretches`);
  return (r.flow = { cols, rows, x0, z0, wet, dist });
}

// The way the river runs at (x, z), into `out` as a unit { x, z } downstream; false where there's no current there
function riverFlow(x, z, out) {
  const f = flowField();
  if (!f) return false;
  const fx = (x - f.x0) / FLOW_STEP, fz = (z - f.z0) / FLOW_STEP;
  const c0 = Math.floor(fx), w0 = Math.floor(fz);
  if (c0 < 1 || w0 < 1 || c0 >= f.cols - 2 || w0 >= f.rows - 2) return false;
  const { cols, dist } = f;
  let gx = 0, gz = 0;
  for (let dw = 0; dw <= 1; dw++) for (let dc = 0; dc <= 1; dc++) {
    const c = c0 + dc, w = w0 + dw, i = w * cols + c, d = dist[i];
    if (!Number.isFinite(d)) continue;
    const wgt = (dc ? fx - c0 : 1 - (fx - c0)) * (dw ? fz - w0 : 1 - (fz - w0));
    const e = dist[i + 1], we = dist[i - 1], s = dist[i + cols], nn = dist[i - cols];
    gx += wgt * ((Number.isFinite(e) ? e : d) - (Number.isFinite(we) ? we : d));
    gz += wgt * ((Number.isFinite(s) ? s : d) - (Number.isFinite(nn) ? nn : d));
  }
  const l = Math.hypot(gx, gz);
  if (l < 1e-4) return false;
  out.x = -gx / l;
  out.z = -gz / l;
  return true;
}

// The nearest open water to (x, z) within `reach` metres, as { x, z }, or null
function nearestWater(x, z, reach = 600) {
  const f = flowField();
  if (!f) return null;
  const fc = Math.round((x - f.x0) / FLOW_STEP), fw = Math.round((z - f.z0) / FLOW_STEP);
  const span = Math.ceil(reach / FLOW_STEP);
  let best = null, bestD = Infinity;
  for (let w = Math.max(0, fw - span); w <= Math.min(f.rows - 1, fw + span); w++) {
    for (let c = Math.max(0, fc - span); c <= Math.min(f.cols - 1, fc + span); c++) {
      const i = w * f.cols + c;
      if (!f.wet[i] || !Number.isFinite(f.dist[i])) continue;
      const px = f.x0 + c * FLOW_STEP, pz = f.z0 + w * FLOW_STEP;
      if (riverDepth(px, pz) < 0.9) continue;
      const d = (px - x) ** 2 + (pz - z) ** 2;
      if (d < bestD) { bestD = d; best = { x: px, z: pz }; }
    }
  }
  return best;
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
function tessellate(geometry, tolerance = 0.12, minEdge = 5) {
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
function drapeGeometry(geometry, tolerance = 0.12) {
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

// A world-space geometry split into square tiles by where each triangle's middle falls, so a ground layer that spans
// the island is drawn (and shadowed) only where the camera sees it, rather than whole on every pass.
const TILE = 800; // larger tiles: each ground layer is a few dozen pieces, not hundreds
function splitIntoTiles(geometry) {
  const names = Object.keys(geometry.attributes);
  const layer = { count: geometry.attributes.position.count, attrs: names.map((n) => {
    const a = geometry.attributes[n];
    return { name: n, array: a.array, itemSize: a.itemSize, normalized: a.normalized };
  }) };
  const tiles = tilesOfLayer(layer);
  if (tiles.length < 2) return [geometry];
  return tiles.map(geometryOfLayer);
}

// A mesh in world space laid on the ground (`draped`, its geometry cut and raised), as one mesh or (when it's big) a
// group of tiles to put in its place
function meshOnGround(mesh, draped) {
  draped.computeBoundingBox();
  draped.computeBoundingSphere();
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
    tile.name = mesh.name;
    group.add(tile);
  }
  return group;
}

// ---- Ground layers as plain data, cut on other cores and saved for the next start ----------------------------------

// What a layer is made from, as the arrays its key is the fingerprint of: a geometry's attributes and index, and an
// instanced mesh's matrices as well, so a saved layer is found without making the layer first
function geometryInputs(geometry) {
  const names = Object.keys(geometry.attributes).filter((n) => !geometry.attributes[n].isInterleavedBufferAttribute).sort();
  return [textBytes(names.join(',')), ...names.map((n) => geometry.attributes[n].array), ...(geometry.index ? [geometry.index.array] : [])];
}
function instanceInputs(mesh) {
  mesh.updateMatrixWorld();
  return [...geometryInputs(mesh.geometry), mesh.instanceMatrix.array.subarray(0, mesh.count * 16), new Float32Array(mesh.matrixWorld.elements)];
}

// A mesh's geometry as a layer (ground-core.js): its triangles, every attribute but interleaved ones, in copies of its
// own arrays (they go to a worker)
function layerOfGeometry(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const attrs = Object.keys(g.attributes).filter((n) => !g.attributes[n].isInterleavedBufferAttribute).map((n) => {
    const a = g.attributes[n];
    return { name: n, array: a.array.slice(0, a.count * a.itemSize), itemSize: a.itemSize, normalized: a.normalized };
  });
  return { count: g.attributes.position.count, attrs };
}

// Big flat instances (a block's sidewalk slab) as one layer in world space: position, normal and uv of every instance
function layerOfInstances(mesh) {
  mesh.updateMatrixWorld();
  const base = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const names = ['position', 'normal', 'uv'].filter((n) => base.attributes[n]);
  const n = base.attributes.position.count, count = n * mesh.count;
  const arrays = names.map((name) => new Float32Array(count * base.attributes[name].itemSize));
  const m = new THREE.Matrix4(), normalMatrix = new THREE.Matrix3(), v = new THREE.Vector3();
  for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, m);
    m.premultiply(mesh.matrixWorld);
    normalMatrix.getNormalMatrix(m);
    names.forEach((name, k) => {
      const src = base.attributes[name], out = arrays[k], o = i * n * src.itemSize;
      for (let j = 0; j < n; j++) {
        if (name === 'uv') { out[o + j * 2] = src.getX(j); out[o + j * 2 + 1] = src.getY(j); continue; }
        v.fromBufferAttribute(src, j);
        if (name === 'position') v.applyMatrix4(m); else v.applyMatrix3(normalMatrix).normalize();
        out[o + j * 3] = v.x; out[o + j * 3 + 1] = v.y; out[o + j * 3 + 2] = v.z;
      }
    });
  }
  return { count, attrs: names.map((name, k) => ({ name, array: arrays[k], itemSize: base.attributes[name].itemSize, normalized: false })) };
}

function geometryOfLayer(layer) {
  const g = new THREE.BufferGeometry();
  for (const a of layer.attrs) g.setAttribute(a.name, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Triangles longer than this are halved (at their longest edge's middle, as the cut itself does) before the layer is
// shared out, so one polygon over the whole town (the road surface) is cut on every core rather than one
const SHARE_EDGE = 200;
function splitLong(layer) {
  const { attrs, count } = layer;
  const pos = attrs.find((a) => a.name === 'position').array, max2 = SHARE_EDGE * SHARE_EDGE;
  const long = (i) => (pos[i * 3] - pos[i * 3 + 3]) ** 2 + (pos[i * 3 + 2] - pos[i * 3 + 5]) ** 2 > max2
    || (pos[i * 3 + 3] - pos[i * 3 + 6]) ** 2 + (pos[i * 3 + 5] - pos[i * 3 + 8]) ** 2 > max2
    || (pos[i * 3 + 6] - pos[i * 3]) ** 2 + (pos[i * 3 + 8] - pos[i * 3 + 2]) ** 2 > max2;
  let any = false;
  for (let i = 0; i < count && !any; i += 3) any = long(i);
  if (!any) return layer;
  // Each long triangle as a list of smaller ones, in vertices of every attribute side by side (`stride` numbers)
  const sizes = attrs.map((a) => a.itemSize), stride = sizes.reduce((n, k) => n + k, 0);
  const P = sizes.slice(0, attrs.findIndex((a) => a.name === 'position')).reduce((n, k) => n + k, 0);
  const extra = [];
  const vertex = (i) => { const v = []; attrs.forEach((a, n) => { for (let k = 0; k < sizes[n]; k++) v.push(a.array[i * sizes[n] + k]); }); return v; };
  const d2 = (p, q) => (p[P] - q[P]) ** 2 + (p[P + 2] - q[P + 2]) ** 2;
  const mid = (p, q) => p.map((x, k) => (x + q[k]) / 2);
  const split = (a, b, c, into) => {
    const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a), longest = Math.max(ab, bc, ca);
    if (longest <= max2) { into.push(a, b, c); return; }
    if (longest === ab) { const m = mid(a, b); split(a, m, c, into); split(m, b, c, into); }
    else if (longest === bc) { const m = mid(b, c); split(a, b, m, into); split(a, m, c, into); }
    else { const m = mid(c, a); split(a, b, m, into); split(m, b, c, into); }
  };
  let total = 0;
  const plan = [];
  for (let i = 0; i < count; i += 3) {
    if (!long(i)) { plan.push(i); total += 3; continue; }
    const into = [];
    split(vertex(i), vertex(i + 1), vertex(i + 2), into);
    plan.push(into); total += into.length;
  }
  const out = attrs.map((a) => new a.array.constructor(total * a.itemSize));
  let at = 0;
  for (const item of plan) {
    if (typeof item === 'number') {
      attrs.forEach((a, n) => out[n].set(a.array.subarray(item * sizes[n], (item + 3) * sizes[n]), at * sizes[n]));
      at += 3;
    } else {
      for (const v of item) {
        let o = 0;
        attrs.forEach((a, n) => { for (let k = 0; k < sizes[n]; k++) out[n][at * sizes[n] + k] = v[o++]; });
        at++;
      }
    }
  }
  return { count: total, attrs: attrs.map((a, n) => ({ ...a, array: out[n] })) };
}

// A layer in square tiles by where each triangle's middle falls (as splitIntoTiles), as layers (`keyed`: a Map of them
// by each tile's key, x * 100000 + z in tiles, every one kept however few there are)
function tilesOfLayer(layer, size = TILE, keyed = false) {
  const pos = layer.attrs.find((a) => a.name === 'position').array, triangles = layer.count / 3;
  const tileOf = new Int32Array(triangles), counts = new Map();
  for (let t = 0; t < triangles; t++) {
    const o = t * 9;
    const key = Math.floor((pos[o] + pos[o + 3] + pos[o + 6]) / 3 / size) * 100000
      + Math.floor((pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3 / size);
    tileOf[t] = key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (counts.size < 2 && !keyed) return [layer];
  const tiles = new Map();
  for (const [key, n] of counts) tiles.set(key, { count: n * 3, used: 0, attrs: layer.attrs.map((a) => ({ ...a, array: new a.array.constructor(n * 3 * a.itemSize) })) });
  for (let t = 0; t < triangles; t++) {
    const tile = tiles.get(tileOf[t]);
    for (let n = 0; n < layer.attrs.length; n++) {
      const src = layer.attrs[n].array, dst = tile.attrs[n].array, size = layer.attrs[n].itemSize * 3;
      const from = t * size, to = tile.used * size;
      for (let k = 0; k < size; k++) dst[to + k] = src[from + k];
    }
    tile.used++;
  }
  if (keyed) return new Map([...tiles].map(([key, { count, attrs }]) => [key, { count, attrs }]));
  return [...tiles.values()].map(({ count, attrs }) => ({ count, attrs }));
}

// A quick fingerprint of numbers, for the saved layers' keys: two 32-bit lanes over the bytes, 4 at a time
function fingerprint(arrays, seed = 0) {
  let h1 = 0x9e3779b9 ^ seed, h2 = 0x85ebca6b ^ seed;
  for (const a of arrays) {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul(h2 + w, 0x5bd1e995) ^ (h2 >>> 15);
    }
    for (let i = words.length * 4; i < bytes.length; i++) h1 = Math.imul(h1 ^ bytes[i], 0x01000193);
    h1 = Math.imul(h1 ^ a.length, 0x01000193);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
const textBytes = (text) => new TextEncoder().encode(text);

// The heights' data a worker needs (ground-core.js) and its fingerprint, with the cutting's own code in it, so a change
// to the ground or to how it's cut makes every saved layer again
const groundData = new WeakMap();
function groundOfGrid(g) {
  if (!groundData.has(g)) {
    const r = g.river;
    const ground = { x0: g.x0, z0: g.z0, step: g.step, cols: g.cols, rows: g.rows, heights: g.heights, river: r && {
      dx0: r.dx0, dz0: r.dz0, dstep: r.dstep, dcols: r.dcols, drows: r.drows, dig: r.dig.slice(),
      lx0: r.lx0, lz0: r.lz0, lstep: r.lstep, lcols: r.lcols, lrows: r.lrows, level: r.level, buckets: r.buckets
    } };
    const decks = r ? JSON.stringify(r.bridges) : '';
    const key = fingerprint([g.heights, ...(r ? [ground.river.dig, r.level] : []),
      textBytes(`${g.x0} ${g.z0} ${g.step} ${g.cols} ${g.rows} ${r ? [r.dx0, r.dz0, r.dstep, r.dcols, r.lx0, r.lz0, r.lstep, r.lcols].join(' ') : ''}`),
      textBytes(decks), textBytes(CORE_SOURCE)]);
    groundData.set(g, { ground, key });
  }
  return groundData.get(g);
}

// The saved layers, in the page's own database (IndexedDB), one for each part of the city, so saving one part's layers
// doesn't hold up reading the next part's: each layer by its key, and the keys the part used last, so the ones a change
// left behind are let go. Without a database every start cuts them again.
const opening = new Map();
try { indexedDB.deleteDatabase('ground-layers'); } catch {} // the one database all parts shared at first
function savedLayers(part) {
  if (!opening.has(part)) opening.set(part, new Promise((done) => {
    try {
      const request = indexedDB.open(`ground-layers-${part}`, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('layers'); request.result.createObjectStore('parts'); };
      request.onsuccess = () => done(request.result);
      request.onerror = request.onblocked = () => done(null);
    } catch { done(null); }
  }));
  return opening.get(part);
}
const asked = (request) => new Promise((done) => { request.onsuccess = () => done(request.result); request.onerror = () => done(undefined); });
async function readSaved(part, keys) {
  const db = await savedLayers(part);
  if (!db) return keys.map(() => undefined);
  try {
    const store = db.transaction('layers').objectStore('layers');
    return await Promise.all(keys.map((k) => asked(store.get(k))));
  } catch { return keys.map(() => undefined); }
}
async function writeSaved(part, keys, made) {
  const db = await savedLayers(part);
  if (!db) return;
  try {
    const t = db.transaction(['layers', 'parts'], 'readwrite');
    const layers = t.objectStore('layers'), parts = t.objectStore('parts');
    const before = (await asked(parts.get(part))) || [];
    for (const [k, layer] of made) layers.put(layer, k);
    for (const k of before) if (!keys.includes(k)) layers.delete(k);
    parts.put(keys, part);
  } catch (error) { log(`[drape] not saved: ${error?.message || error}`); }
}

// Cuts the layers (`jobs`: { layer, tolerance }) on several cores: each long triangle halved first (splitLong), then the
// triangles shared out in many small pieces by how much ground they cover, round and round the workers, so the hills
// fall to all of them. Answers each job's draped layer, in order.
async function cutOnCores(ground, jobs) {
  const cores = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const pieces = [];
  let total = 0;
  const weights = jobs.map((job) => {
    const pos = job.layer.attrs.find((a) => a.name === 'position').array, w = new Float32Array(job.layer.count / 3);
    for (let t = 0; t < w.length; t++) {
      const o = t * 9;
      const area = Math.abs((pos[o + 3] - pos[o]) * (pos[o + 8] - pos[o + 2]) - (pos[o + 6] - pos[o]) * (pos[o + 5] - pos[o + 2])) / 2;
      w[t] = 1 + area / 50;
      total += w[t];
    }
    return w;
  });
  const share = total / (cores * 12);
  jobs.forEach((job, j) => {
    const w = weights[j];
    let from = 0, sum = 0;
    for (let t = 0; t < w.length; t++) {
      sum += w[t];
      if (sum >= share || t === w.length - 1) {
        const a = from * 3, b = (t + 1) * 3;
        pieces.push({ job: j, tolerance: job.tolerance, count: b - a,
          attrs: job.layer.attrs.map((x) => ({ ...x, array: x.array.slice(a * x.itemSize, b * x.itemSize) })) });
        from = t + 1; sum = 0;
      }
    }
  });
  const batches = Array.from({ length: Math.min(cores, pieces.length) }, () => []);
  pieces.forEach((p, i) => batches[i % batches.length].push(p));
  const answers = await Promise.all(batches.map((batch) => work('js/drape-worker.js', { ground, pieces: batch },
    batch.flatMap((p) => p.attrs.map((a) => a.array.buffer)))));
  // Each job's pieces, back in their order
  const parts = jobs.map(() => []);
  batches.forEach((batch, b) => batch.forEach((p, i) => parts[p.job].push([pieces.indexOf(p), answers[b].results[i]])));
  return parts.map((list, j) => {
    list.sort((x, y) => x[0] - y[0]);
    const count = list.reduce((n, [, r]) => n + r.count, 0);
    return { count, attrs: jobs[j].layer.attrs.map((a, k) => {
      const array = new a.array.constructor(count * a.itemSize);
      let at = 0;
      for (const [, r] of list) { array.set(r.attrs[k].array, at); at += r.attrs[k].array.length; }
      return { name: a.name, array, itemSize: a.itemSize, normalized: a.normalized };
    }) };
  });
}

// The layers draped, each as its tiles (tilesOfLayer; one for a small mesh): those saved by an earlier start with the
// same ground, code and layer read back, the rest cut on several cores and saved
async function drapeLayers(part, jobs) {
  const { ground, key: groundKey } = groundOfGrid(grid);
  for (const job of jobs) job.key = `${groundKey}.${job.instances ? 'i' : 'm'}${job.tolerance}.${fingerprint(job.inputs)}`;
  const saved = await readSaved(part, jobs.map((j) => j.key));
  const missing = jobs.filter((j, i) => !(j.tiles = saved[i]));
  if (missing.length) {
    for (const job of missing) job.layer = splitLong(job.make());
    const cut = await cutOnCores(ground, missing);
    missing.forEach((j, i) => {
      j.tiles = j.instances || cut[i].count > 30000 ? tilesOfLayer(cut[i]) : [cut[i]];
      j.layer = null;
    });
    writeSaved(part, jobs.map((j) => j.key), missing.map((j) => [j.key, j.tiles]));
  }
  return missing.length;
}


// ---- Ground streamed around the player (a phone, or a Mac without much memory: device-tier.js) ----------------------
// The whole city's ground cut to follow the hills is far more than a phone's browser holds. Streamed, each big layer is
// kept flat (a tenth of its cut size) in STREAM_TILE squares, and only the squares within `radius` of the player are
// cut and drawn, read back from the page's database when an earlier play cut them; those left far behind are let go.
const STREAM_TILE = 500;
const stream = hot(import.meta).keep('groundStream', () => ({ radius: 0, x: 0, z: 0, layers: [], busy: false, cut: 0 }));
// Streams the big ground layers set on the ground from here on, around (x, z) to begin with
function streamGround(radius, x = 0, z = 0) {
  Object.assign(stream, { radius, x, z });
}
const tileKeyOf = (x, z) => Math.floor(x / STREAM_TILE) * 100000 + Math.floor(z / STREAM_TILE);
// How far (x, z) is from a tile's square
function tileDistance(key, x, z) {
  const tx = Math.round(key / 100000), tz = key - tx * 100000;
  const dx = Math.max(tx * STREAM_TILE - x, 0, x - (tx + 1) * STREAM_TILE);
  const dz = Math.max(tz * STREAM_TILE - z, 0, z - (tz + 1) * STREAM_TILE);
  return Math.hypot(dx, dz);
}

// The page's database of cut tiles, one record per layer's tile; the layers each part last streamed, so the tiles of
// one a change left behind are let go
let tileBase = null;
function tileDatabase() {
  return tileBase ??= new Promise((done) => {
    try {
      const request = indexedDB.open('ground-tiles', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('tiles'); request.result.createObjectStore('parts'); };
      request.onsuccess = () => done(request.result);
      request.onerror = request.onblocked = () => done(null);
    } catch { done(null); }
  });
}
async function forgetOldTiles(part, keys) {
  const db = await tileDatabase();
  if (!db) return;
  try {
    const t = db.transaction(['tiles', 'parts'], 'readwrite');
    const tiles = t.objectStore('tiles'), parts = t.objectStore('parts');
    const before = (await asked(parts.get(part))) || [];
    for (const k of before) if (!keys.includes(k)) tiles.delete(IDBKeyRange.bound(`${k}/`, `${k}/￿`));
    parts.put(keys, part);
  } catch {}
}
async function readTiles(names) {
  const db = await tileDatabase();
  if (!db) return names.map(() => undefined);
  try {
    const store = db.transaction('tiles').objectStore('tiles');
    return await Promise.all(names.map((k) => asked(store.get(k))));
  } catch { return names.map(() => undefined); }
}
async function writeTiles(made) {
  const db = await tileDatabase();
  if (!db) return;
  try {
    const store = db.transaction('tiles', 'readwrite').objectStore('tiles');
    for (const [k, layer] of made) store.put(layer, k);
  } catch (error) { log(`[stream] not saved: ${error?.message || error}`); }
}

// Takes a ground layer's job (setOnTerrain) to stream: a group in the mesh's place, filled with its tiles near (x, z)
function streamLayer(part, job, groundKey) {
  const obj = job.obj;
  const key = `${groundKey}.${job.instances ? 'i' : 'm'}${job.tolerance}.${fingerprint(job.inputs)}`;
  const flat = tilesOfLayer(splitLong(job.make()), STREAM_TILE, true);
  const group = new THREE.Group();
  group.name = obj.name;
  const look = { material: obj.material, castShadow: obj.castShadow, receiveShadow: obj.receiveShadow, renderOrder: obj.renderOrder,
    frustumCulled: job.instances ? true : obj.frustumCulled, mask: job.instances ? 1 : obj.layers.mask };
  const layer = { part, key, tolerance: job.tolerance, group, look, flat, built: new Map(), away: 0 };
  stream.layers.push(layer);
  return layer;
}

// The tiles wanted near (x, z) and not drawn, nearest first, as [layer, tile key]
function wantedTiles(x, z, layers = stream.layers) {
  const want = [];
  for (const layer of layers) {
    for (const k of layer.flat.keys()) {
      if (layer.built.has(k)) continue;
      const d = tileDistance(k, x, z);
      if (d < stream.radius) want.push([d, layer, k]);
    }
  }
  return want.sort((a, b) => a[0] - b[0]).map(([, layer, k]) => [layer, k]);
}

// Draws these tiles: read back or cut on several cores, then saved
async function buildTiles(list) {
  const { ground } = groundOfGrid(grid);
  const names = list.map(([layer, k]) => `${layer.key}/${k}`);
  const saved = await readTiles(names);
  const missing = list.map((item, i) => [item, i]).filter(([, i]) => !saved[i]);
  if (missing.length) {
    const cut = await cutOnCores(ground, missing.map(([[layer, k]]) => ({ layer: layer.flat.get(k), tolerance: layer.tolerance })));
    missing.forEach(([, i], n) => { saved[i] = cut[n]; });
    writeTiles(missing.map(([, i]) => [names[i], saved[i]]));
    stream.cut += missing.length;
  }
  list.forEach(([layer, k], i) => {
    if (layer.built.has(k)) return;
    const { look } = layer;
    const mesh = new THREE.Mesh(geometryOfLayer(saved[i]), look.material);
    mesh.castShadow = look.castShadow;
    mesh.receiveShadow = look.receiveShadow;
    mesh.renderOrder = look.renderOrder;
    mesh.frustumCulled = look.frustumCulled;
    mesh.layers.mask = look.mask;
    mesh.name = layer.group.name;
    mesh.userData.streamed = true;
    gpuOnly(mesh);
    layer.group.add(mesh);
    mesh.updateMatrixWorld(true);
    layer.built.set(k, mesh);
  });
  return missing.length;
}

// Every frame: the tiles the player has come near are drawn (a few at a time, one batch in hand), and those left more
// than 400 m beyond the radius let go. Answers whether any were drawn or let go.
const AWAY = 300, BATCH = 6;
function updateGroundStreaming(x, z) {
  if (!stream.radius || !stream.layers.length) return false;
  stream.x = x; stream.z = z;
  let changed = false;
  for (const layer of stream.layers) {
    // a part a change built again leaves its old layers out of the scene
    let top = layer.group;
    while (top.parent) top = top.parent;
    layer.away = top.isScene ? 0 : layer.away + 1;
    for (const [k, mesh] of layer.built) {
      if (tileDistance(k, x, z) < stream.radius + AWAY) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      layer.built.delete(k);
      changed = true;
    }
  }
  const before = stream.layers.length;
  stream.layers = stream.layers.filter((layer) => layer.away < 600);
  if (stream.layers.length < before) log(`[stream] let go of ${before - stream.layers.length} layers no longer drawn`);
  if (!stream.busy) {
    const want = wantedTiles(x, z, stream.layers.filter((layer) => !layer.away)).slice(0, BATCH);
    if (want.length) {
      stream.busy = true;
      buildTiles(want).catch((error) => log(`[stream] ${error?.message || error}`)).finally(() => { stream.busy = false; });
    }
  }
  return changed;
}

// Where the streaming is centred now: the player's last place, or where they start
function groundStreamCenter() {
  return { x: stream.x, z: stream.z };
}

// What's streamed now: tiles drawn, and their vertices
function groundStreamStats() {
  let tiles = 0, layers = 0;
  for (const layer of stream.layers) { tiles += layer.built.size; layers++; }
  return { layers, tiles, radius: stream.radius };
}

const IDENTITY = new THREE.Matrix4();
const isIdentity = (m) => m.elements.every((v, i) => Math.abs(v - IDENTITY.elements[i]) < 1e-6);

// Sets a part of the city built flat on the ground. What's drawn in world space (merged batches, a single polygon of
// the whole island) follows the ground vertex by vertex, cut finer where it bends (ground-core.js); an object placed by
// its own transform is lifted whole by the ground at its position; instances are lifted each by its own, and those
// marked userData.terrain = 'drape' (big flat slabs) are made into one geometry that follows the ground. Anything
// marked userData.terrain = 'set' was put on the ground where it was built and is left alone, children included.
// The cutting is the slow part of a start: it's done on several cores and saved, so a later start with the same city
// reads it back (drapeLayers). Answers a promise when there's cutting to wait for, else nothing.
function setOnTerrain(root, tolerance = 0.16) {
  if (!grid || !root) return null;
  root.updateMatrixWorld(true);
  const replace = [], jobs = [];
  const visit = (obj) => {
    if (obj.userData.terrain === 'set') return;
    if (obj.isInstancedMesh) {
      if (obj.userData.terrain === 'drape') jobs.push({ obj, instances: true, inputs: instanceInputs(obj), make: () => layerOfInstances(obj), tolerance });
      else liftInstances(obj);
    } else if ((obj.isMesh || obj.isLine || obj.isPoints) && obj.geometry?.attributes.position) {
      if (isIdentity(obj.matrixWorld)) {
        // Road markings carry each vertex's offset to its strip's edge (`side`), which a cut would average away:
        // they're built in short lengths instead and only laid on the ground; lines and points can't be cut
        const cut = obj.isMesh && !obj.geometry.attributes.side ? obj.userData.terrainTolerance ?? tolerance : 0;
        if (cut) jobs.push({ obj, inputs: geometryInputs(obj.geometry), make: () => layerOfGeometry(obj.geometry), tolerance: cut });
        else if (obj.isMesh) {
          const tiles = meshOnGround(obj, drapeGeometry(obj.geometry, 0));
          if (tiles) replace.push([obj, tiles]);
        } else obj.geometry = drapeGeometry(obj.geometry, 0);
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
  const finish = () => {
    for (const job of jobs) {
      const obj = job.obj, geometries = job.tiles.map(geometryOfLayer);
      job.tiles = null;
      if (!job.instances && geometries.length === 1) {
        obj.geometry.dispose();
        obj.geometry = geometries[0];
        continue;
      }
      const group = new THREE.Group();
      group.name = obj.name;
      for (const g of geometries) {
        const tile = new THREE.Mesh(g, obj.material);
        tile.castShadow = obj.castShadow;
        tile.receiveShadow = obj.receiveShadow;
        tile.renderOrder = obj.renderOrder;
        if (!job.instances) {
          tile.frustumCulled = obj.frustumCulled;
          tile.layers.mask = obj.layers.mask;
        }
        tile.name = obj.name;
        group.add(tile);
      }
      replace.push([obj, group]);
    }
    for (const [old, draped] of replace) {
      old.parent.add(draped);
      old.removeFromParent();
    }
  };
  if (!jobs.length) { finish(); return null; }
  const began = performance.now();
  // Streamed, the big layers are drawn only near the player (streamGround): the tiles near them now are waited for
  if (stream.radius) {
    const { key: groundKey } = groundOfGrid(grid);
    // (a layer of a few big triangles, a lawn, comes to millions of vertices once cut: only what's small on the map, or
    // has few vertices over a small area, is drawn whole)
    const big = jobs.filter((job) => {
      if (job.instances) return true;
      const geo = job.obj.geometry;
      if (!geo.boundingBox) geo.computeBoundingBox();
      const { min, max } = geo.boundingBox;
      return Math.max(max.x - min.x, max.z - min.z) > STREAM_TILE || geo.attributes.position.count > 2000;
    });
    const layers = big.map((job) => {
      const layer = streamLayer(root.name, job, groundKey);
      replace.push([job.obj, layer.group]);
      return layer;
    });
    forgetOldTiles(root.name, layers.map((layer) => layer.key));
    const rest = jobs.filter((job) => !big.includes(job));
    jobs.length = 0;
    jobs.push(...rest);
    const near = wantedTiles(stream.x, stream.z, layers);
    return Promise.all([rest.length ? drapeLayers(root.name, rest) : 0, buildTiles(near)]).then(([cut, cutTiles]) => {
      finish();
      log(`[drape] ${root.name}: ${rest.length} layers (${cut} cut), ${layers.length} streamed: ${near.length} tiles within ${stream.radius} m (${cutTiles} cut), in ${Math.round(performance.now() - began)} ms`);
    });
  }
  return drapeLayers(root.name, jobs).then((cut) => {
    finish();
    log(`[drape] ${root.name}: ${jobs.length} layers, ${jobs.length - cut} read back, ${cut} cut, in ${Math.round(performance.now() - began)} ms`);
  });
}

// A flat layer laid on another (a driveway on the lawn, a fairway on the grass) drawn in front of it as if `lift`
// metres higher: each vertex is moved along its own line of sight toward the camera, so it covers the same pixels and
// only its depth changes, by what a lift of `lift` comes to at the angle it's seen from (capped far off at a glance).
// Both layers are cut to follow the slopes their own way and can stray a few cm apart, so a few mm of real height
// between them isn't enough: the one under would show through in wedges.
function drawOver(mat, lift = 0.06) {
  const toCamera = cameraPosition.sub(positionWorld);
  const dir = normalize(toCamera);
  const pull = min(float(lift).div(max(abs(dir.y), 0.02)), toCamera.length().mul(0.5));
  mat.positionNode = positionLocal.add(dir.mul(pull));
  mat.polygonOffset = false;
  return mat;
}

export {
  drawOver,
  loadTerrain, groundHeight, riverbedHeight, riverDepth, riverFlow, nearestWater, waterLevel, bridgeDecks, groundUnder, stadiumGround, groundSlope, groundTilt, groundHeightNode,
  tessellate, drapeGeometry, liftGeometry, liftInstances, setOnTerrain,
  streamGround, updateGroundStreaming, groundStreamStats, groundStreamCenter
};
