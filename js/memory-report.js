import { Vector2 } from 'three/webgpu';

// What the city holds in memory, logged once after it's built (main.js): each part's vertex data and the textures and
// render targets it draws with, counted once however many meshes share them. A phone's browser tab is ended by iOS at
// around 1-1.5 GB all told (the page's script, its copy of every buffer and the GPU's), so the phone setting keeps this
// well under PHONE_BUDGET_MB. Vertex data counts twice: three.js keeps the script's copy after uploading it.

export const PHONE_BUDGET_MB = 450;

const MB = 1 / (1024 * 1024);

function geometryBytes(geo, seen) {
  if (!geo || seen.has(geo)) return 0;
  seen.add(geo);
  let bytes = 0;
  const attrs = [...Object.values(geo.attributes), ...Object.values(geo.morphAttributes || {}).flat()];
  if (geo.index) attrs.push(geo.index);
  for (const a of attrs) {
    const array = a.isInterleavedBufferAttribute ? a.data.array : a.array;
    if (!array || seen.has(array)) continue;
    seen.add(array);
    bytes += array.byteLength;
  }
  return bytes;
}

function textureBytes(tex, seen) {
  if (!tex || seen.has(tex)) return 0;
  seen.add(tex);
  const img = tex.image;
  const w = img?.width || 0, h = img?.height || 0, d = img?.depth || 1;
  // four bytes a texel, a third more for mipmaps
  return w * h * d * 4 * (tex.generateMipmaps !== false ? 4 / 3 : 1);
}

function materialTextures(material, out) {
  for (const m of [material].flat()) {
    if (!m) continue;
    for (const v of Object.values(m)) if (v?.isTexture) out.add(v);
  }
}

// { total, parts: [[name, MB]...], textures, instances } for everything under `scene`
export function measureScene(scene, renderer) {
  const seen = new Set();
  const textures = new Set();
  const parts = new Map();
  let instances = 0;
  // each part of the city is a group of its own (main.js's cityPart): counted by what's in it
  const pieces = scene.children.flatMap((top) => (!top.name && top.isGroup ? top.children : [top]));
  for (const top of pieces) {
    let bytes = 0;
    top.traverse((o) => {
      if (o.geometry) bytes += geometryBytes(o.geometry, seen);
      if (o.isInstancedMesh) {
        for (const a of [o.instanceMatrix, o.instanceColor]) {
          if (a && !seen.has(a.array)) { seen.add(a.array); bytes += a.array.byteLength; instances += a.count ?? 0; }
        }
      }
      if (o.material) materialTextures(o.material, textures);
    });
    const name = top.name || top.children[0]?.name || top.type;
    if (!bytes) continue;
    parts.set(name, (parts.get(name) || 0) + bytes);
  }
  let texBytes = 0;
  const texSeen = new Set();
  for (const t of textures) texBytes += textureBytes(t, texSeen);
  // the frame's own targets: the drawing at its size, with depth, and the shadow maps
  const size = renderer?.getDrawingBufferSize?.(new Vector2());
  const targetBytes = size ? size.x * size.y * 4 * 4 : 0;
  const vertexMB = [...parts.values()].reduce((s, b) => s + b, 0) * MB;
  const textureMB = texBytes * MB;
  const targetMB = targetBytes * MB;
  return {
    // the script's copy and the GPU's of every buffer, the textures (on the GPU and once decoded) and the targets
    total: vertexMB * 2 + textureMB * 2 + targetMB,
    vertexMB, textureMB, targetMB,
    parts: [...parts.entries()].map(([n, b]) => [n, b * MB]).sort((a, b) => b[1] - a[1])
  };
}

export function reportMemory(scene, renderer, log, phone) {
  const m = measureScene(scene, renderer);
  const top = m.parts.filter(([, mb]) => mb >= 1).map(([n, mb]) => `${n} ${mb.toFixed(0)}`).join(', ');
  const verdict = phone ? (m.total <= PHONE_BUDGET_MB ? `within the phone's ${PHONE_BUDGET_MB} MB` : `OVER the phone's ${PHONE_BUDGET_MB} MB`) : '';
  log(`[memory] about ${m.total.toFixed(0)} MB${verdict ? ` (${verdict})` : ''}: vertex data ${m.vertexMB.toFixed(0)} MB (twice: script and GPU), textures ${m.textureMB.toFixed(0)} MB, frame targets ${m.targetMB.toFixed(0)} MB; by part MB: ${top}`);
  return m;
}
