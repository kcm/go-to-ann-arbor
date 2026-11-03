import * as THREE from 'three/webgpu';

// Ann Arbor's churches: the survey's buildings on the city's religious parcels, drawn as churches rather than as
// windowed blocks. Stone or brick walls up to the eaves, a steep slate gable along the long side, a square bell tower
// with a spire and a cross at one end, tall pointed stained-glass windows down the sides, a rose window over the
// front and an arched door. Every church goes into two meshes (masonry and glass) for the whole city.

const WALLS = [[0.70, 0.66, 0.58], [0.62, 0.60, 0.56], [0.50, 0.27, 0.21], [0.58, 0.33, 0.24], [0.55, 0.52, 0.47]];
const SLATE = [0.21, 0.22, 0.25];
const COPPER = [0.33, 0.52, 0.45];
const DOOR = [0.24, 0.13, 0.08];
const LOUVER = [0.08, 0.08, 0.09];
const CROSS = [0.72, 0.60, 0.30];
const GLASS = [[0.12, 0.16, 0.42], [0.42, 0.10, 0.12], [0.14, 0.30, 0.20], [0.40, 0.30, 0.10]];

/** A church's plan: its oriented box (along its longest wall) and how well the footprint fills it, or null */
export function churchPlan(b) {
  const ring = b.polygons[0] && b.polygons[0].outer;
  if (!ring || ring.length < 3) return null;
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], c = ring[(i + 1) % ring.length];
    const dx = c.x - a.x, dz = c.z - a.z, L = Math.hypot(dx, dz);
    if (L > best) { best = L; ux = dx / L; uz = dz / L; }
  }
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, area = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const u = p.x * ux + p.z * uz, v = -p.x * uz + p.z * ux;
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    area += p.x * q.z - q.x * p.z;
  }
  let L = u1 - u0, W = v1 - v0;
  if (L < 9 || W < 7 || L * W > 5000) return null;
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  let ax = ux, az = uz;
  if (W > L) { [L, W] = [W, L]; ax = -uz; az = ux; }
  return { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ax, az, L, W, fill: Math.abs(area / 2) / (L * W) };
}

export function buildChurches(items) {
  const stone = { pos: [], col: [] }, glass = { pos: [], col: [] };
  // colors are written as seen (sRGB); the vertex colors want them linear
  const lin = new Map();
  const linear = (col) => { if (!lin.has(col)) lin.set(col, col.map((c) => c ** 2.2)); return lin.get(col); };
  const tri = (m, a, b, c, col) => { m.pos.push(...a, ...b, ...c); const l = linear(col); for (let k = 0; k < 3; k++) m.col.push(...l); };
  const quad = (m, a, b, c, d, col) => { tri(m, a, b, c, col); tri(m, a, c, d, col); };

  for (const ch of items) {
    const { plan, ground, minGround = ground, height, tone } = ch;
    const base = Math.min(minGround, ground) - 0.5;
    const r = (k) => { const s = Math.sin((ch.cx * 12.9898 + ch.cz * 78.233 + k * 37.719)) * 43758.5453; return s - Math.floor(s); };
    const wall = WALLS[Math.floor(tone * WALLS.length) % WALLS.length];
    const pane = GLASS[Math.floor(r(1) * GLASS.length)];
    const { ax, az } = plan, bx = -az, bz = ax;
    const rect = plan.fill > 0.78 && ch.polygons.length === 1;
    const hl = plan.L / 2, hw = plan.W / 2;
    const P = (u, v, y) => [plan.cx + ax * u + bx * v, y, plan.cz + az * u + bz * v];

    // the roof: a steep gable (about 50°) whose ridge is the surveyed height; irregular plans keep a flat top
    const roofH = rect ? Math.min(plan.W * 0.6, height * 0.5, 14) : 0;
    const eave = ground + Math.max(4.5, height - roofH);
    const ridge = ground + height + 0.22;

    // the walls: the box for a plain nave, the surveyed outline otherwise
    const rings = rect
      ? [[P(-hl, -hw, 0), P(hl, -hw, 0), P(hl, hw, 0), P(-hl, hw, 0)].map(([x, , z]) => ({ x, z }))]
      : ch.polygons.map((p) => p.outer);
    const towerEnd = r(2) < 0.5 ? -1 : 1;
    const tw = Math.max(3.6, Math.min(plan.W * 0.38, 7));
    const towerU = towerEnd * (hl - tw / 2 + 0.8);
    const hasTower = plan.L > 12 && height > 6;
    for (const ring of rings) {
      let area = 0;
      for (let i = 0; i < ring.length; i++) { const p = ring[i], q = ring[(i + 1) % ring.length]; area += p.x * q.z - q.x * p.z; }
      const out = area > 0 ? -1 : 1; // which side of each edge is outside
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        quad(stone, [p.x, base, p.z], [q.x, base, q.z], [q.x, eave, q.z], [p.x, eave, p.z], wall);
        // tall pointed windows down each wall long enough, clear of the tower
        const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot(dx, dz);
        if (len < 5 || eave - ground < 4) continue;
        if (rect && Math.abs(dx * ax + dz * az) < len * 0.5) continue; // the gable ends have the rose and the door
        const tx = dx / len, tz = dz / len, nx = -tz * out, nz = tx * out;
        const n = Math.floor((len - 2) / 3.6), w = Math.min(1.5, (eave - ground) * 0.22);
        const sill = ground + Math.min(2, (eave - ground) * 0.3), top = eave - 0.7;
        for (let k = 0; k < n; k++) {
          const s = (len - (n - 1) * 3.6) / 2 + k * 3.6;
          const x = p.x + tx * s + nx * 0.07, z = p.z + tz * s + nz * 0.07;
          if (hasTower) {
            const du = (x - plan.cx) * ax + (z - plan.cz) * az;
            if (Math.abs(du - towerU) < tw / 2 + 1) continue;
          }
          const E = (o, y) => [x + tx * o, y, z + tz * o];
          const spring = top - w * 0.85;
          quad(glass, E(-w / 2, sill), E(w / 2, sill), E(w / 2, spring), E(-w / 2, spring), pane);
          tri(glass, E(-w / 2, spring), E(w / 2, spring), E(0, top), pane);
          // a stone sill under it
          quad(stone, [x + tx * (-w / 2 - 0.15) + nx * 0.08, sill - 0.18, z + tz * (-w / 2 - 0.15) + nz * 0.08],
            [x + tx * (w / 2 + 0.15) + nx * 0.08, sill - 0.18, z + tz * (w / 2 + 0.15) + nz * 0.08],
            [x + tx * (w / 2 + 0.15) + nx * 0.08, sill, z + tz * (w / 2 + 0.15) + nz * 0.08],
            [x + tx * (-w / 2 - 0.15) + nx * 0.08, sill, z + tz * (-w / 2 - 0.15) + nz * 0.08], SLATE);
        }
      }
      // a flat top over an irregular plan
      if (!rect) {
        const shape = ring.map((p) => new THREE.Vector2(p.x, p.z));
        for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(shape, [])) {
          tri(stone, [ring[a].x, eave, ring[a].z], [ring[b].x, eave, ring[b].z], [ring[c].x, eave, ring[c].z], SLATE);
        }
      }
    }

    if (rect) {
      // the gable: slate slopes with a little overhang, and the masonry triangles at its ends
      const o = 0.4;
      quad(stone, P(-hl - o, -hw - o, eave - 0.3), P(hl + o, -hw - o, eave - 0.3), P(hl + o, 0, ridge), P(-hl - o, 0, ridge), SLATE);
      quad(stone, P(hl + o, hw + o, eave - 0.3), P(-hl - o, hw + o, eave - 0.3), P(-hl - o, 0, ridge), P(hl + o, 0, ridge), SLATE);
      for (const end of [-1, 1]) tri(stone, P(end * hl, -hw, eave), P(end * hl, hw, eave), P(end * hl, 0, ridge), wall);

      // the front, away from the tower: a rose window in the gable and an arched door below it
      const front = hasTower ? -towerEnd : (r(3) < 0.5 ? -1 : 1);
      const fu = front * (hl + 0.07);
      const rr = Math.min(plan.W * 0.17, 2.4, (ridge - eave) * 0.4);
      if (rr > 0.6) {
        const cy = eave + rr * 0.2;
        for (let k = 0; k < 12; k++) {
          const a0 = k / 12 * Math.PI * 2, a1 = (k + 1) / 12 * Math.PI * 2;
          tri(glass, P(fu, 0, cy), P(fu, Math.cos(a0) * rr, cy + Math.sin(a0) * rr), P(fu, Math.cos(a1) * rr, cy + Math.sin(a1) * rr),
            k % 2 ? pane : GLASS[(GLASS.indexOf(pane) + 1) % GLASS.length]);
        }
      }
      if (!hasTower) door(front * (hl + 0.08), 0, front);
    }

    // the bell tower: a square shaft a little out from the end wall, open belfry arches, a spire and a cross
    if (hasTower) {
      const towerTop = ridge + Math.max(3, tw * 0.9);
      const h2 = tw / 2;
      const C = [P(towerU - h2, -h2, 0), P(towerU + h2, -h2, 0), P(towerU + h2, h2, 0), P(towerU - h2, h2, 0)];
      for (let i = 0; i < 4; i++) {
        const a = C[i], b = C[(i + 1) % 4];
        quad(stone, [a[0], base, a[2]], [b[0], base, b[2]], [b[0], towerTop, b[2]], [a[0], towerTop, a[2]], wall);
        // the belfry: an arched louvered opening on each face
        const mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2;
        const ex = (b[0] - a[0]) / tw, ez = (b[2] - a[2]) / tw;
        const cxT = plan.cx + ax * towerU, czT = plan.cz + az * towerU;
        let nx = mx - cxT, nz = mz - czT; const nl = Math.hypot(nx, nz); nx /= nl; nz /= nl;
        const bw = tw * 0.36, b0 = towerTop - tw * 1.1, b1 = towerTop - 0.6;
        const B = (o, y) => [mx + ex * o + nx * 0.07, y, mz + ez * o + nz * 0.07];
        quad(stone, B(-bw / 2, b0), B(bw / 2, b0), B(bw / 2, b1 - bw * 0.5), B(-bw / 2, b1 - bw * 0.5), LOUVER);
        tri(stone, B(-bw / 2, b1 - bw * 0.5), B(bw / 2, b1 - bw * 0.5), B(0, b1), LOUVER);
        // a cornice band at the top of the shaft
        const K = (o, y, d) => [mx + ex * o + nx * d, y, mz + ez * o + nz * d];
        quad(stone, K(-h2 - 0.25, towerTop - 0.05, 0.25), K(h2 + 0.25, towerTop - 0.05, 0.25), K(h2 + 0.25, towerTop + 0.35, 0.25), K(-h2 - 0.25, towerTop + 0.35, 0.25), wall);
      }
      // the spire: eight-sided, slate or green copper
      const spireH = Math.min(26, Math.max(7, tw * 2.8));
      const spire = r(4) < 0.3 ? COPPER : SLATE;
      const apex = P(towerU, 0, towerTop + 0.35 + spireH);
      const sr = h2 * 0.92;
      for (let k = 0; k < 8; k++) {
        const a0 = (k + 0.5) / 8 * Math.PI * 2, a1 = (k + 1.5) / 8 * Math.PI * 2;
        tri(stone, P(towerU + Math.cos(a0) * sr, Math.sin(a0) * sr, towerTop + 0.35), P(towerU + Math.cos(a1) * sr, Math.sin(a1) * sr, towerTop + 0.35), apex, spire);
      }
      // the cross on top
      const cy = apex[1];
      const bar = (u0, u1, y0, y1) => {
        quad(stone, P(towerU + u0, -0.06, y0), P(towerU + u1, -0.06, y0), P(towerU + u1, -0.06, y1), P(towerU + u0, -0.06, y1), CROSS);
        quad(stone, P(towerU + u0, 0.06, y0), P(towerU + u1, 0.06, y0), P(towerU + u1, 0.06, y1), P(towerU + u0, 0.06, y1), CROSS);
      };
      bar(-0.07, 0.07, cy, cy + 1.6);
      bar(-0.45, 0.45, cy + 0.95, cy + 1.12);
      door(towerEnd * (hl + 0.8 + 0.08), 0, towerEnd);
    }

    // an arched wooden door in the end wall at u, facing along `dir`
    function door(u, v, dir) {
      const w = 1.9, h = 3.2;
      const D = (o, y) => P(u, v + o * dir, y);
      quad(stone, D(-w / 2 - 0.3, ground), D(w / 2 + 0.3, ground), D(w / 2 + 0.3, ground + h - w / 2), D(-w / 2 - 0.3, ground + h - w / 2), wall);
      quad(stone, D(-w / 2, ground), D(w / 2, ground), D(w / 2, ground + h - w * 0.5), D(-w / 2, ground + h - w * 0.5), DOOR);
      tri(stone, D(-w / 2, ground + h - w * 0.5), D(w / 2, ground + h - w * 0.5), D(0, ground + h + 0.3), DOOR);
    }
  }

  const group = new THREE.Group();
  group.name = 'Churches';
  const add = (m, material) => {
    if (!m.pos.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  };
  add(stone, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, side: THREE.DoubleSide }));
  add(glass, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.2, metalness: 0.15, side: THREE.DoubleSide,
    emissive: 0x1a1208 }));
  return group;
}
