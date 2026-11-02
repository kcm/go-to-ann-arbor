// Meshes that never change once built (the ground, roads, river, buildings, roofs, walls) keep their vertex data on the
// GPU only: three.js keeps the script's copy of every buffer after uploading it, which doubled the city's vertex data.
// A part is handed over as it's built (main.js `still`, terrain.js's streamed tiles, houses.js's streamed cells), its
// bounds worked out while the data is still there, and each buffer let go a few frames after the renderer uploads it
// (releaseUploaded, from the frame step). What the game reads later (ground height, collisions) is its own data, not
// these meshes. Instanced attributes, which streaming rewrites, and anything a part marks `userData.keepArrays` stay.

// each buffer waiting, with how many rounds it has waited and whether it's an index
const pending = new Map();
// bytes of each buffer let go, still held on the GPU (memory-report.js counts them there)
const freed = new WeakMap();
let freedTotal = 0;

export function gpuOnly(root) {
  root.traverse((o) => {
    if (!(o.isMesh || o.isLine || o.isPoints) || o.userData.keepArrays) return;
    const g = o.geometry;
    if (!g || g.userData.keepArrays) return;
    if (!g.boundingSphere) g.computeBoundingSphere();
    if (!g.boundingBox) g.computeBoundingBox();
    for (const a of [...Object.values(g.attributes), g.index]) {
      if (!a || a.isInstancedBufferAttribute || a.isInterleavedBufferAttribute || a.isStorageBufferAttribute) continue;
      if (a.array?.length && !pending.has(a)) pending.set(a, { rounds: 0, index: a === g.index });
    }
  });
}

// Lets go of the script's copy of every handed-over buffer the renderer has uploaded; answers the bytes let go
export function releaseUploaded(renderer) {
  if (!pending.size) return 0;
  const backend = renderer.backend;
  let bytes = 0, sent = 0;
  for (const [a, wait] of pending) {
    let data = backend.data?.get(a);
    if (!data || (data.buffer === undefined && data.bufferGPU === undefined)) {
      // not drawn yet (out of sight since it was built): after a while it goes up to the GPU anyway, a few MB a round
      if (++wait.rounds < 4 || sent > 8388608 || !renderer._attributes) continue;
      renderer._attributes.update(a, wait.index ? 2 : 1);
      sent += a.array.byteLength;
      data = backend.data.get(a);
      if (!data || (data.buffer === undefined && data.bufferGPU === undefined)) continue;
    }
    pending.delete(a);
    const n = a.array.byteLength;
    freed.set(a, n);
    // an empty array of the same kind, so the renderer still reads its type; the count stays as it was
    a.array = new a.array.constructor(0);
    bytes += n;
  }
  freedTotal += bytes;
  return bytes;
}

export function freedBytes(a) { return freed.get(a) || 0; }
export function gpuOnlyStats() { return { freedMB: freedTotal / 1048576, waiting: pending.size }; }

// A streamed part's own buffers given back to the GPU when it's let go, leaving what it shares with others (trees.js)
let renderer = null;
export function useRenderer(r) { renderer = r; }
export function dropBuffers(list) {
  for (const a of list) {
    if (!a) continue;
    pending.delete(a);
    renderer?._attributes?.delete(a);
  }
}
