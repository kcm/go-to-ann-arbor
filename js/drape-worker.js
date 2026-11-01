// js/drape-worker.js
// Cuts a share of the city's ground layers to follow the hills on a core of its own (terrain.js hands them out):
// gets the heights' data and its pieces ({ attrs, count, tolerance }), and posts back each piece draped, in order.
import { drapeLayer } from './ground-core.js';

onmessage = (e) => {
  const { ground, pieces } = e.data;
  const results = [], transfer = [];
  for (const p of pieces) {
    const out = drapeLayer(ground, p, p.tolerance);
    results.push({ count: out.count, attrs: out.attrs });
    for (const a of out.attrs) transfer.push(a.array.buffer);
  }
  postMessage({ results }, transfer);
};
