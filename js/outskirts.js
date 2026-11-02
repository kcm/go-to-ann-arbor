import * as THREE from 'three/webgpu';
import { positionWorld, vec2, vec3, float, floor, fract, sin, dot, mix, smoothstep, abs, fwidth, min } from 'three/tsl';
import { TOWN_BOUNDS } from './city-config.js';
import { groundHeight } from './terrain.js';

// Washtenaw County around the detailed city: the real hills and the Huron valley (terrain.js) as farm fields, woodlots
// and the suburbs' tree cover, out to the fogged horizon. Nothing here is driven on; the city's edge is a lawn border.

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

function createCountryMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const wp = positionWorld;
  // fields ~180 x 240 m in a grid turned a little off true north, like the township section roads
  const p = vec2(wp.x.mul(0.99).add(wp.z.mul(0.08)), wp.z.mul(0.99).sub(wp.x.mul(0.08)));
  const cell = floor(p.div(vec2(180, 240)));
  const h = hash(cell);
  const f = fract(p.div(vec2(180, 240)));
  const edge = min(min(f.x, float(1).sub(f.x)), min(f.y, float(1).sub(f.y)));
  const fw = fwidth(p.x).div(180).add(1e-4);
  const hedge = float(1).sub(smoothstep(0.0, fw.mul(2).add(0.02), edge)); // hedgerows between the fields
  const corn = vec3(0.33, 0.36, 0.17);
  const hay = vec3(0.46, 0.43, 0.25);
  const pasture = vec3(0.22, 0.32, 0.13);
  const soil = vec3(0.30, 0.25, 0.18);
  const wood = vec3(0.11, 0.19, 0.08);
  let c = mix(mix(corn, hay, smoothstep(0.3, 0.32, h)), mix(pasture, soil, smoothstep(0.82, 0.84, h)), smoothstep(0.55, 0.57, h));
  c = mix(c, wood, smoothstep(0.9, 0.92, h)); // woodlots
  // rows across each field, faint
  const rows = abs(sin(p.x.mul(0.9).add(h.mul(40)))).mul(0.06).mul(float(1).sub(smoothstep(0.0, 0.6, fwidth(p.x).mul(0.9))));
  c = c.mul(float(0.97).add(rows));
  c = mix(c, wood.mul(1.1), hedge.mul(0.85));
  // the suburbs near the city: more tree cover the closer it is
  const cx = (TOWN_BOUNDS.minX + TOWN_BOUNDS.maxX) / 2, cz = (TOWN_BOUNDS.minZ + TOWN_BOUNDS.maxZ) / 2;
  const dx = abs(wp.x.sub(cx)).sub((TOWN_BOUNDS.maxX - TOWN_BOUNDS.minX) / 2).max(0);
  const dz = abs(wp.z.sub(cz)).sub((TOWN_BOUNDS.maxZ - TOWN_BOUNDS.minZ) / 2).max(0);
  const near = float(1).sub(smoothstep(300, 1800, dx.add(dz)));
  const canopy = hash(floor(wp.xz.div(14))).mul(0.5).add(0.5);
  c = mix(c, mix(vec3(0.14, 0.24, 0.1), vec3(0.42, 0.42, 0.4), smoothstep(0.85, 0.9, canopy)), near.mul(0.75));
  mat.colorNode = c;
  return mat;
}

function buildOutskirts(scene) {
  const group = new THREE.Group();
  group.name = 'Outskirts';
  const B = TOWN_BOUNDS;
  // a 50 m grid of the real heights out to 6 km beyond the city, with a hole where the city is
  const STEP = 50, MARGIN = 6000;
  const x0 = Math.floor((B.minX - MARGIN) / STEP) * STEP, x1 = Math.ceil((B.maxX + MARGIN) / STEP) * STEP;
  const z0 = Math.floor((B.minZ - MARGIN) / STEP) * STEP, z1 = Math.ceil((B.maxZ + MARGIN) / STEP) * STEP;
  const nx = (x1 - x0) / STEP + 1, nz = (z1 - z0) / STEP + 1;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * STEP, z = z0 + j * STEP, k = (j * nx + i) * 3;
      pos[k] = x; pos[k + 1] = groundHeight(x, z) - 0.15; pos[k + 2] = z;
    }
  }
  const idx = [];
  for (let j = 0; j + 1 < nz; j++) {
    for (let i = 0; i + 1 < nx; i++) {
      const cx0 = x0 + i * STEP, cz0 = z0 + j * STEP;
      // leave out the cells under the city (its streets & lawns cover the ground there)
      if (cx0 >= B.minX && cx0 + STEP <= B.maxX && cz0 >= B.minZ && cz0 + STEP <= B.maxZ) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = createCountryMaterial();
  const land = new THREE.Mesh(geo, mat);
  land.name = 'CountryLand';
  land.receiveShadow = true;
  land.userData.terrain = 'set'; // already on the ground
  group.add(land);

  // under the city, a finer copy just below its streets and lawns: what shows where the city's own ground is too far
  // away to be drawn, so the hills read as hills from across town
  const FS = 20;
  const fx0 = Math.floor(B.minX / FS) * FS, fz0 = Math.floor(B.minZ / FS) * FS;
  const fnx = Math.ceil((B.maxX - fx0) / FS) + 1, fnz = Math.ceil((B.maxZ - fz0) / FS) + 1;
  const fpos = new Float32Array(fnx * fnz * 3);
  for (let j = 0; j < fnz; j++) {
    for (let i = 0; i < fnx; i++) {
      const x = fx0 + i * FS, z = fz0 + j * FS, k = (j * fnx + i) * 3;
      // by the Argo Cascades, the lowest ground around, so it stays under their narrow, deep channel between points
      let y = groundHeight(x, z);
      if (x > 100 && x < 700 && z > -1320 && z < -1000) {
        for (let u = -FS; u <= FS; u += FS / 2) for (let v = -FS; v <= FS; v += FS / 2) y = Math.min(y, groundHeight(x + u, z + v));
      }
      fpos[k] = x; fpos[k + 1] = y - 0.9; fpos[k + 2] = z;
    }
  }
  const fidx = new Uint32Array((fnx - 1) * (fnz - 1) * 6);
  let q = 0;
  for (let j = 0; j + 1 < fnz; j++) {
    for (let i = 0; i + 1 < fnx; i++) {
      const a = j * fnx + i, b = a + 1, c = a + fnx, d = c + 1;
      fidx[q++] = a; fidx[q++] = c; fidx[q++] = b; fidx[q++] = b; fidx[q++] = c; fidx[q++] = d;
    }
  }
  const fgeo = new THREE.BufferGeometry();
  fgeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
  fgeo.setIndex(new THREE.BufferAttribute(fidx, 1));
  fgeo.computeVertexNormals();
  fgeo.computeBoundingSphere();
  const under = new THREE.Mesh(fgeo, mat);
  under.name = 'CityUnderground';
  under.receiveShadow = true;
  under.userData.terrain = 'set';
  group.add(under);

  // the horizon beyond: level farmland at the heights' edge
  let edge = 0, n = 0;
  for (let i = 0; i < nx; i++) { edge += pos[i * 3 + 1] + pos[((nz - 1) * nx + i) * 3 + 1]; n += 2; }
  const far = new THREE.Mesh(new THREE.RingGeometry(Math.max(x1 - x0, z1 - z0) * 0.5 - 200, 60000, 48, 1).rotateX(-Math.PI / 2), mat);
  far.position.set((x0 + x1) / 2, edge / n - 2, (z0 + z1) / 2);
  far.name = 'CountryHorizon';
  far.userData.terrain = 'set';
  group.add(far);

  scene.add(group);
  return { group, colliders: [] };
}

export { buildOutskirts };
