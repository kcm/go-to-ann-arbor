// js/ground-core.js
// The ground's height and the cutting of flat ground layers to follow it, as plain functions of the heights' data
// (`g`, from terrain.js: { x0, z0, step, cols, rows, heights, river }). Nothing here touches three.js or the page, so
// terrain.js and the workers that cut the ground layers on other cores (drape-worker.js) run the very same code.

export function baseHeight(g, x, z) {
  const fx = (x - g.x0) / g.step, fz = (z - g.z0) / g.step;
  if (!(fx >= 0 && fz >= 0 && fx < g.cols - 1 && fz < g.rows - 1)) return 0;
  const c = Math.floor(fx), r = Math.floor(fz), ax = fx - c, az = fz - r;
  const h = g.heights, i = r * g.cols + c;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + g.cols] * (1 - ax) + h[i + g.cols + 1] * ax) * az;
}

// How far (0-1) the ground at (x, z) is dug down to the river's bed
export function digAt(r, x, z) {
  const fx = (x - r.dx0) / r.dstep, fz = (z - r.dz0) / r.dstep;
  if (!(fx >= 0 && fz >= 0 && fx < r.dcols - 1 && fz < r.drows - 1)) return 0;
  const c = Math.floor(fx), w = Math.floor(fz), ax = fx - c, az = fz - w, d = r.dig, i = w * r.dcols + c;
  if (!(d[i] | d[i + 1] | d[i + r.dcols] | d[i + r.dcols + 1])) return 0;
  return ((d[i] * (1 - ax) + d[i + 1] * ax) * (1 - az) + (d[i + r.dcols] * (1 - ax) + d[i + r.dcols + 1] * ax) * az) / 255;
}

export function levelAt(r, x, z) {
  const fx = Math.min(Math.max((x - r.lx0) / r.lstep, 0), r.lcols - 1.001);
  const fz = Math.min(Math.max((z - r.lz0) / r.lstep, 0), r.lrows - 1.001);
  const c = Math.floor(fx), w = Math.floor(fz), ax = fx - c, az = fz - w, h = r.level, i = w * r.lcols + c;
  return (h[i] * (1 - ax) + h[i + 1] * ax) * (1 - az) + (h[i + r.lcols] * (1 - ax) + h[i + r.lcols + 1] * ax) * az;
}

export const BUCKET = 32;
export const bucketKey = (bx, bz) => bx * 100003 + bz;

// The ground at (x, z) on a street's or railway's bridge deck, eased in from the ground over its first and last 8 m
export function onDeck(r, x, z, h) {
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

// The ground at (x, z) under any bridge: the river's banks and bed where it's dug out
export function riverbedOf(g, x, z) {
  let h = baseHeight(g, x, z);
  const r = g.river;
  const f = r ? digAt(r, x, z) : 0;
  if (f > 0) {
    const bed = levelAt(r, x, z) - 1.8;
    if (bed < h) h += (bed - h) * f;
  }
  return h;
}

// The ground's height at (x, z): in the river dug down to its bed, on a bridge its deck
export function groundOf(g, x, z) {
  const r = g.river;
  return r ? onDeck(r, x, z, riverbedOf(g, x, z)) : baseHeight(g, x, z);
}

// A layer is a flat triangle list in world space: { count, attrs: [{ name, array, itemSize, normalized }] }, every
// three vertices a triangle. Cut finer where the ground (`h(x, z)`) bends away from its triangles, so a polygon drawn as
// a few long slivers can follow it: a triangle is split (at the middle of its longest edge) while the ground under its
// edges' middles, quarters and centre strays more than `tolerance` metres from the plane through its corners, down to
// edges of `minEdge`. Flat ground isn't cut at all. Every attribute is interpolated, in its own number type.
export function tessellateLayer(layer, tolerance, minEdge, h) {
  const { attrs, count } = layer;
  const sizes = attrs.map((a) => a.itemSize);
  const offsets = [];
  let stride = 0;
  for (const size of sizes) { offsets.push(stride); stride += size; }
  const P = offsets[attrs.findIndex((a) => a.name === 'position')];
  const min2 = minEdge * minEdge;

  const strays = (a, b, c) => {
    const ax = a[P], az = a[P + 2], bx = b[P], bz = b[P + 2], cx = c[P], cz = c[P + 2];
    const ab = (ax - bx) ** 2 + (az - bz) ** 2, bc = (bx - cx) ** 2 + (bz - cz) ** 2, ca = (cx - ax) ** 2 + (cz - az) ** 2;
    if (Math.max(ab, bc, ca) <= min2) return false;
    const ha = h(ax, az), hb = h(bx, bz), hc = h(cx, cz);
    for (const [u, v] of [[0.5, 0.5], [0.25, 0.75], [0.75, 0.25]]) {
      if (Math.abs(h(ax * u + bx * v, az * u + bz * v) - (ha * u + hb * v)) > tolerance) return true;
      if (Math.abs(h(bx * u + cx * v, bz * u + cz * v) - (hb * u + hc * v)) > tolerance) return true;
      if (Math.abs(h(cx * u + ax * v, cz * u + az * v) - (hc * u + ha * v)) > tolerance) return true;
    }
    return Math.abs(h((ax + bx + cx) / 3, (az + bz + cz) / 3) - (ha + hb + hc) / 3) > tolerance;
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
    attrs.forEach((a, n) => { for (let k = 0; k < sizes[n]; k++) v[offsets[n] + k] = a.array[i * sizes[n] + k]; });
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
  const pos = attrs.find((a) => a.name === 'position').array;
  const small = (i) => {
    const ax = pos[i * 3], az = pos[i * 3 + 2], bx = pos[i * 3 + 3], bz = pos[i * 3 + 5], cx = pos[i * 3 + 6], cz = pos[i * 3 + 8];
    return (ax - bx) ** 2 + (az - bz) ** 2 <= min2 && (bx - cx) ** 2 + (bz - cz) ** 2 <= min2 && (cx - ax) ** 2 + (cz - az) ** 2 <= min2;
  };
  const copy = (i) => {
    if (used + stride * 3 > out.length) { const grown = new Float32Array(out.length * 2); grown.set(out); out = grown; }
    for (let v = i; v < i + 3; v++) {
      for (let n = 0; n < attrs.length; n++) {
        const a = attrs[n].array, size = sizes[n], o = used + offsets[n];
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
  if (vertices === count) return layer;
  return {
    count: vertices,
    attrs: attrs.map((a, k) => {
      const Kind = a.array.constructor;
      const whole = Kind !== Float32Array && Kind !== Float64Array;
      const data = new Kind(vertices * sizes[k]);
      for (let v = 0; v < vertices; v++) for (let j = 0; j < sizes[k]; j++) {
        const value = out[v * stride + offsets[k] + j];
        data[v * sizes[k] + j] = whole ? Math.round(value) : value;
      }
      return { name: a.name, array: data, itemSize: a.itemSize, normalized: a.normalized };
    })
  };
}

// A layer cut to follow the ground (unless `tolerance` is 0) and every vertex raised by the ground under it. The
// layer's own position array is raised in place when it isn't cut.
export function drapeLayer(g, layer, tolerance) {
  const h = (x, z) => groundOf(g, x, z);
  const out = tolerance ? tessellateLayer(layer, tolerance, 10, h) : layer;
  const pos = out.attrs.find((a) => a.name === 'position').array;
  for (let i = 0; i < pos.length; i += 3) pos[i + 1] += h(pos[i], pos[i + 2]);
  return out;
}

// What the cutting depends on, as text, so a change to any of it makes the saved ground layers again (terrain.js)
export const CORE_SOURCE = [baseHeight, digAt, levelAt, onDeck, riverbedOf, groundOf, tessellateLayer, drapeLayer]
  .map((f) => f.toString()).join('\n');
