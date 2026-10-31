import * as THREE from 'three/webgpu';
import { GEO } from './nyc-geodata.js';
import { groundHeight } from './terrain.js';

// Lamp: a sign over each named shop, restaurant, cafe and bar from OpenStreetMap (GEO.signs, placed by the generator on
// the wall of its building that faces the street): a painted board in its category's color with the name in cream
// letters, every name in one atlas, all the boards in two meshes (faces and their backing boxes).

const CELL_W = 384, CELL_H = 60, COLS = 10, ROWS = 68; // an atlas up to 3840 x 4080: 680 signs
const BOARD_H = 0.62;
const DEPTH = 0.1;
// food, coffee & sweets, bars, shops, services, culture
const BOARD_COLORS = ['#7d2320', '#5a3824', '#1f4030', '#1f2f52', '#2c3138', '#4c2650'];
const FONTS = ['Georgia, serif', 'Inter, Arial, sans-serif', 'Georgia, serif', 'Inter, Arial, sans-serif',
  'Inter, Arial, sans-serif', 'Georgia, serif'];

function buildShopSigns(group) {
  group.name = 'ShopSigns';
  const { names = [], list = [] } = GEO.signs || {};
  const count = Math.min(list.length / 7, COLS * ROWS);
  if (!count) return { count: 0 };

  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = CELL_H * Math.ceil(count / COLS);
  const ctx = canvas.getContext('2d');

  const face = { pos: [], uv: [], nrm: [] };
  const back = { pos: [], nrm: [] };
  const quad = (out, corners, n, uvs) => {
    for (const k of [0, 1, 2, 0, 2, 3]) {
      out.pos.push(...corners[k]);
      out.nrm.push(...n);
      if (uvs) out.uv.push(...uvs[k]);
    }
  };

  for (let i = 0; i < count; i++) {
    const [x, z, deg, w, y, ni, cat] = list.slice(i * 7, i * 7 + 7);
    const name = names[ni];
    // the board, painted into its cell, its letters squeezed so they read right once stretched over the board
    const cx = (i % COLS) * CELL_W, cy = Math.floor(i / COLS) * CELL_H;
    ctx.fillStyle = BOARD_COLORS[cat] || BOARD_COLORS[3];
    ctx.fillRect(cx, cy, CELL_W, CELL_H);
    ctx.strokeStyle = 'rgba(243, 231, 201, 0.55)';
    ctx.lineWidth = 3;
    ctx.strokeRect(cx + 5, cy + 5, CELL_W - 10, CELL_H - 10);
    const squeeze = (CELL_W / CELL_H) / (w / BOARD_H);
    ctx.save();
    ctx.translate(cx + CELL_W / 2, cy + CELL_H / 2 + 2);
    ctx.scale(squeeze, 1);
    let size = 36;
    ctx.font = `700 ${size}px ${FONTS[cat] || FONTS[1]}`;
    const room = (CELL_W - 30) / squeeze;
    const tw = ctx.measureText(name).width;
    if (tw > room) {
      size = Math.max(16, Math.floor(size * room / tw));
      ctx.font = `700 ${size}px ${FONTS[cat] || FONTS[1]}`;
    }
    ctx.fillStyle = '#f3e7c9';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name, 0, 0);
    ctx.restore();

    // the board on the wall: its face out along the wall's normal, centred on (x, z)
    const a = (deg * Math.PI) / 180;
    const nx = Math.sin(a), nz = Math.cos(a); // outward
    const ux = nz, uz = -nx; // along the wall, left to right as seen from the street
    const g = groundHeight(x, z);
    const y0 = g + y - BOARD_H / 2, y1 = g + y + BOARD_H / 2;
    const hw = w / 2;
    const fx = x + nx * DEPTH, fz = z + nz * DEPTH;
    const P = (px, pz, s, py) => [px + ux * s, py, pz + uz * s];
    const u0 = cx / canvas.width, u1 = (cx + CELL_W) / canvas.width;
    const v0 = 1 - (cy + CELL_H) / canvas.height, v1 = 1 - cy / canvas.height;
    quad(face, [P(fx, fz, -hw, y0), P(fx, fz, hw, y0), P(fx, fz, hw, y1), P(fx, fz, -hw, y1)], [nx, 0, nz],
      [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    // its edges: a shallow box back to the wall
    const e = 0.03;
    const top = [P(x, z, -hw - e, y1 + e), P(x, z, hw + e, y1 + e), P(fx, fz, hw + e, y1 + e), P(fx, fz, -hw - e, y1 + e)];
    quad(back, top, [0, 1, 0]);
    const bot = [P(fx, fz, -hw - e, y0 - e), P(fx, fz, hw + e, y0 - e), P(x, z, hw + e, y0 - e), P(x, z, -hw - e, y0 - e)];
    quad(back, bot, [0, -1, 0]);
    for (const s of [-1, 1]) {
      const sx = s * (hw + e);
      const side = s > 0
        ? [P(fx, fz, sx, y0 - e), P(x, z, sx, y0 - e), P(x, z, sx, y1 + e), P(fx, fz, sx, y1 + e)]
        : [P(x, z, sx, y0 - e), P(fx, fz, sx, y0 - e), P(fx, fz, sx, y1 + e), P(x, z, sx, y1 + e)];
      quad(back, side, [ux * s, 0, uz * s]);
    }
    // a frame around the face
    const fr = [P(fx + nx * -0.005, fz + nz * -0.005, -hw - e, y0 - e), P(fx, fz, hw + e, y0 - e),
      P(fx, fz, hw + e, y1 + e), P(fx, fz, -hw - e, y1 + e)];
    quad(back, fr.map((p) => [p[0] - nx * 0.004, p[1], p[2] - nz * 0.004]), [nx, 0, nz]);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(face.pos, 3));
  faceGeo.setAttribute('normal', new THREE.Float32BufferAttribute(face.nrm, 3));
  faceGeo.setAttribute('uv', new THREE.Float32BufferAttribute(face.uv, 2));
  faceGeo.computeBoundingSphere();
  const faceMat = new THREE.MeshStandardNodeMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.18, roughness: 0.6 });
  const faces = new THREE.Mesh(faceGeo, faceMat);
  faces.name = 'ShopSignFaces';
  faces.receiveShadow = true;

  const backGeo = new THREE.BufferGeometry();
  backGeo.setAttribute('position', new THREE.Float32BufferAttribute(back.pos, 3));
  backGeo.setAttribute('normal', new THREE.Float32BufferAttribute(back.nrm, 3));
  backGeo.computeBoundingSphere();
  const backs = new THREE.Mesh(backGeo, new THREE.MeshStandardNodeMaterial({ color: 0x1c1d1f, roughness: 0.5, metalness: 0.4 }));
  backs.name = 'ShopSignBoards';
  backs.castShadow = true;
  backs.receiveShadow = true;

  group.add(backs, faces);
  group.userData.terrain = 'set'; // stood on the ground as they were placed
  console.info(`[shop signs] ${count} storefront signs`);
  return { count };
}

export { buildShopSigns };
