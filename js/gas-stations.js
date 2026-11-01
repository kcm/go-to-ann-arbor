import * as THREE from 'three/webgpu';
import { color, smoothstep } from 'three/tsl';
import { cityUniforms } from './tsl-materials.js';
import { groundHeight } from './terrain.js';

// Ann Arbor's gas stations (data/gas-stations.json, Assets/Tools/build-gas-stations.py): a flat white canopy on
// columns over pump islands, a colored band round its edge (plain colors, no brand), its underside lit at night.
// Built in world space at the ground's height and merged into two meshes (the lit panels apart, for their glow).
// Where the city's survey drew the canopy as a building (`replaces`), buildings.js leaves that building out.

const BANDS = [0xc8372d, 0x2457a6, 0x2f8a4a, 0xe08a1e, 0xd0d3d6];
const WHITE = 0xeeeeea, POST = 0xdcdcd8, CONCRETE = 0xa9a8a2, PUMP = 0xd8dadb, SCREEN = 0x1d2329, HOSE = 0x202224;
const CLEAR = 4.9; // the canopy's underside, above the drive

/** The canopy rectangles whose survey building should not be drawn: [{ cx, cz, ux, uz, hl, hw }] */
export function canopyFootprints(data) {
  const list = (data && data.canopies) || [];
  const out = [];
  for (let i = 0; i < list.length; i += 6) {
    if (!list[i + 5]) continue;
    out.push({ cx: list[i], cz: list[i + 1], ux: Math.cos(list[i + 2]), uz: Math.sin(list[i + 2]),
      hl: list[i + 3] / 2 + 1, hw: list[i + 4] / 2 + 1 });
  }
  return out;
}

export function insideCanopy(footprints, x, z) {
  return footprints.some((f) => {
    const dx = x - f.cx, dz = z - f.cz;
    return Math.abs(dx * f.ux + dz * f.uz) < f.hl && Math.abs(-dx * f.uz + dz * f.ux) < f.hw;
  });
}

function parts() {
  return { pos: [], nor: [], col: [], idx: [] };
}

// A box centred at (x, z), its length along (ux, uz), from y0 to y1
function addBox(p, x, z, ux, uz, len, wid, y0, y1, hex) {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  const vx = -uz, vz = ux, hl = len / 2, hw = wid / 2;
  const corner = (a, b) => [x + ux * a * hl + vx * b * hw, z + uz * a * hl + vz * b * hw];
  const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const face = (pts, n) => {
    const o = p.pos.length / 3;
    for (const v of pts) { p.pos.push(...v); p.nor.push(...n); p.col.push(c.r, c.g, c.b); }
    p.idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  };
  face(q.map(([a, b]) => [a, y1, b]).reverse(), [0, 1, 0]);
  face(q.map(([a, b]) => [a, y0, b]), [0, -1, 0]);
  for (let i = 0; i < 4; i++) {
    const [ax, az] = q[i], [bx, bz] = q[(i + 1) % 4];
    const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez) || 1;
    face([[ax, y0, az], [ax, y1, az], [bx, y1, bz], [bx, y0, bz]], [ez / L, 0, -ex / L]);
  }
}

function mesh(p, material, name) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(p.nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(p.col, 3));
  geo.setIndex(p.idx);
  geo.computeBoundingSphere();
  const m = new THREE.Mesh(geo, material);
  m.name = name;
  m.userData.terrain = 'set';
  return m;
}

export function buildGasStations(data) {
  const group = new THREE.Group();
  group.name = 'GasStations';
  const colliders = [];
  const list = (data && data.canopies) || [];
  const solid = parts(), lit = parts();

  for (let i = 0; i < list.length; i += 6) {
    const [cx, cz, angle, L, W] = list.slice(i, i + 5);
    const ux = Math.cos(angle), uz = Math.sin(angle), vx = -uz, vz = ux;
    let g = Infinity;
    for (const a of [-1, 1]) for (const b of [-1, 1]) {
      g = Math.min(g, groundHeight(cx + ux * a * L / 2 + vx * b * W / 2, cz + uz * a * L / 2 + vz * b * W / 2));
    }
    const band = BANDS[Math.floor(Math.abs(Math.sin(cx * 12.9898 + cz * 78.233) * 43758.5453) % BANDS.length)];

    // the canopy: a white slab with a colored band round its fascia, and its lit panel beneath
    addBox(solid, cx, cz, ux, uz, L, W, g + CLEAR, g + CLEAR + 0.85, WHITE);
    addBox(solid, cx, cz, ux, uz, L + 0.08, W + 0.08, g + CLEAR + 0.22, g + CLEAR + 0.6, band);
    addBox(lit, cx, cz, ux, uz, L - 0.8, W - 0.8, g + CLEAR - 0.04, g + CLEAR, 0xffffff);

    // pump islands across the canopy, a column in each, a pump either side of it
    const n = Math.max(1, Math.round(L / 7.5));
    const islandLen = Math.min(W - 1.6, 5.4);
    for (let k = 0; k < n; k++) {
      const s = (k + 0.5) / n * L - L / 2;
      const x = cx + ux * s, z = cz + uz * s;
      addBox(solid, x, z, vx, vz, islandLen, 1.25, g - 0.3, g + 0.18, CONCRETE);
      addBox(solid, x, z, ux, uz, 0.42, 0.42, g + 0.18, g + CLEAR, POST);
      for (const side of [-1, 1]) {
        const px = x + vx * side * islandLen * 0.27, pz = z + vz * side * islandLen * 0.27;
        addBox(solid, px, pz, vx, vz, 0.95, 0.55, g + 0.18, g + 1.55, PUMP);
        addBox(solid, px, pz, vx, vz, 1.0, 0.6, g + 1.55, g + 1.85, band);
        for (const face of [-1, 1]) {
          addBox(solid, px + ux * face * 0.28, pz + uz * face * 0.28, vx, vz, 0.5, 0.02, g + 1.05, g + 1.4, SCREEN);
          addBox(solid, px + ux * face * 0.3 + vx * 0.38, pz + uz * face * 0.3 + vz * 0.38, vx, vz, 0.08, 0.05,
            g + 0.5, g + 1.3, HOSE);
        }
      }
      // the island stops cars and people at its curb, pumps included
      const hx = islandLen / 2, hz = 0.65;
      const outer = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
        ({ x: x + vx * a * hx + ux * b * hz, z: z + vz * a * hx + uz * b * hz }));
      const xs = outer.map((p) => p.x), zs = outer.map((p) => p.z);
      colliders.push({ minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs),
        minY: g, maxY: g + 1.85, polygon: { outer, holes: [] } });
    }
  }
  if (!solid.idx.length) return { group, colliders };

  const solidMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05 });
  const body = mesh(solid, solidMat, 'GasStationCanopies');
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // the underside's lights: pale by day, a bright cool white from dusk
  const litMat = new THREE.MeshStandardNodeMaterial({ color: 0xf2f4f5, roughness: 0.4 });
  litMat.emissiveNode = color(0xeef4ff).mul(smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow).mul(2.4).add(0.08));
  const panels = mesh(lit, litMat, 'GasStationLights');
  group.add(panels);
  return { group, colliders };
}
