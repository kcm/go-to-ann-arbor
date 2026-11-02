import * as THREE from 'three/webgpu';
import { CROSSWALK } from './road-network.js';
import { GEO } from './city-geodata.js';
import { createRoadPaintMaterial } from './tsl-materials.js';
import { curbStalls } from './curb-parking.js';

// Road markings generated from the drivable road network (js/road-network.js), so the paint matches where traffic
// actually drives and stops: dashed lane lines, double yellow centre lines on two-way roads (Lamp: not on residential
// streets, as in Ann Arbor), a centre turn lane's yellow lines, a one-way's yellow left edge, stop bars at the stop
// lines, continental crosswalks where OpenStreetMap maps a painted crossing (and at traffic lights where it says nothing),
// and the city's painted bike lanes (OpenStreetMap).

const WHITE = new THREE.Color(0xe6e2d6);
const YELLOW = new THREE.Color(0xe8ad22);
const GREEN = new THREE.Color(0x2a8a4e);
const STEP = 6; // Lamp: metres between a strip's vertices along it, so it follows the ground
const HEIGHT = 0.10; // above the asphalt (Lamp: clear of it where the two follow the ground by different cuts, terrain.js)
const PAINT_CELL_SIZE = 900;
const PAINT_CULL_DISTANCE = 1150;
const WIDEN_SPHERE_PAD = 16; // createRoadPaintMaterial widens thin distant strips up to 16x in screen space

// Spatial chunk builder shared by the town's street markings and perimeter highway markings (js/city-grid.js), so
// off-screen and distant (> 1.65 km) road paint is culled instead of transforming all 12.5 km of vertices every frame.
function createRoadPaintChunkBuilder(name, { cellSize = PAINT_CELL_SIZE, cullDistance = PAINT_CULL_DISTANCE } = {}) {
  const cells = new Map();

  function cellAt(mx, mz) {
    const key = (Math.floor(mx / cellSize) << 16) ^ (Math.floor(mz / cellSize) & 0xffff);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { position: [], side: [], paint: [], colors: [], index: [] }));
    return cell;
  }

  function strip3D(ax, ay, az, bx, by, bz, w, col, period = 1, duty = 1, phase = 0, flow = 1) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) return;
    const sx = ((az - bz) / len) * w * 0.5;
    const sz = ((bx - ax) / len) * w * 0.5;
    const end = phase + len * flow;
    // Lamp: in lengths of at most STEP, so the strip can follow the ground (terrain.js lays each vertex on it and
    // doesn't cut the strip itself: a cut would average its two sides' `side` vectors to nothing)
    const pieces = Math.max(1, Math.ceil(len / STEP));
    const cell = cellAt((ax + bx) * 0.5, (az + bz) * 0.5);
    const { position, side, paint, colors, index } = cell;
    const first = position.length / 3;
    for (let k = 0; k <= pieces; k++) {
      const t = k / pieces;
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, u = phase + (end - phase) * t;
      for (const s of [-1, 1]) {
        position.push(x + sx * s, y, z + sz * s);
        side.push(sx * s, sz * s);
        paint.push(u, period, duty);
        colors.push(col.r, col.g, col.b);
      }
    }
    for (let k = 0; k < pieces; k++) {
      const i = first + k * 2;
      index.push(i, i + 1, i + 3, i, i + 3, i + 2);
    }
  }

  function build() {
    const group = new THREE.Group();
    group.name = name;
    const material = createRoadPaintMaterial();
    let first = null;

    for (const cell of cells.values()) {
      if (!cell.index.length) continue;
      const vertCount = cell.position.length / 3;
      const normal = new Float32Array(cell.position.length);
      for (let i = 1; i < normal.length; i += 3) normal[i] = 1;

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.position, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(cell.colors, 3));
      geometry.setAttribute('side', new THREE.Float32BufferAttribute(cell.side, 2));
      geometry.setAttribute('paint', new THREE.Float32BufferAttribute(cell.paint, 3));
      geometry.setIndex(
        vertCount <= 65535
          ? new THREE.Uint16BufferAttribute(cell.index, 1)
          : new THREE.Uint32BufferAttribute(cell.index, 1)
      );
      geometry.computeBoundingSphere();
      if (geometry.boundingSphere) geometry.boundingSphere.radius += WIDEN_SPHERE_PAD;

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${name}Chunk`;
      mesh.receiveShadow = true;
      mesh.renderOrder = -1; // under the other see-through ground effects (contact shadows, headlight beams)
      mesh.userData.cullDistance = cullDistance;
      if (first) mesh.userData.sharesPipelineWith = first;
      else first = mesh;
      group.add(mesh);
    }
    return group;
  }

  return { strip3D, build };
}

function buildRoadPaint(scene, network, sharedBuilder = null) {
  const builder = sharedBuilder || createRoadPaintChunkBuilder('RoadMarkings');
  const lines = [];
  const bends = new Map();

  // Flat strip w wide from a to b, with a dash pattern (period, duty cycle) running along it
  function strip(ax, az, bx, bz, w, col, period = 1, duty = 1, phase = 0, flow = 1) {
    builder.strip3D(ax, HEIGHT, az, bx, HEIGHT, bz, w, col, period, duty, phase, flow);
  }

  // Edges run between stop lines; s is measured from the start one and o to the right of the centre line
  const at = (e, s, o) => [e.sx + e.dx * s + e.rx * o, e.sz + e.dz * s + e.rz * o];
  const along = (e, o, w, col, period = 1, duty = 1, kind = null) => {
    const start = (e.sx - e.x0) * e.dx + (e.sz - e.z0) * e.dz;
    const ends = [at(e, e.from.shape ? -start : 0.9, o), at(e, e.to.shape ? e.span - start : e.len - 0.9, o)];
    lines.push({ e, o, w, col, period, duty, ends, joins: [], kind });
  };
  const across = (e, s, o0, o1, w, col, period, duty) => strip(...at(e, s, o0), ...at(e, s, o1), w, col, period, duty);
  const clearCentre = (e, o) => {
    if (!network.isRoadClear) return false;
    const steps = Math.max(1, Math.ceil((e.len - 1.8) / 2.5));
    for (let i = 0; i <= steps; i++) {
      const s = 0.9 + (e.len - 1.8) * i / steps;
      for (const offset of [o - 0.12, o + 0.12]) if (!network.isRoadClear(...at(e, s, offset), 0.15)) return false;
    }
    return true;
  };

  // Lamp: OpenStreetMap's crossings ([x, z, marked: 0 no, 1 yes, 2 not said]) in 20 m cells
  const CELL = 20;
  const crossingCells = new Map();
  {
    const list = (GEO.controls && GEO.controls.crossings) || [];
    for (let i = 0; i + 2 < list.length; i += 3) {
      const key = Math.floor(list[i] / CELL) + ',' + Math.floor(list[i + 1] / CELL);
      if (!crossingCells.has(key)) crossingCells.set(key, []);
      crossingCells.get(key).push({ x: list[i], z: list[i + 1], marked: list[i + 2], used: false });
    }
  }
  const crossingsNear = (x, z, r) => {
    const out = [];
    for (let i = Math.floor((x - r) / CELL); i <= Math.floor((x + r) / CELL); i++) {
      for (let j = Math.floor((z - r) / CELL); j <= Math.floor((z + r) / CELL); j++) {
        for (const c of crossingCells.get(i + ',' + j) || []) if (Math.hypot(c.x - x, c.z - z) < r) out.push(c);
      }
    }
    return out;
  };
  // A crosswalk at the end of e by node: where a painted crossing is mapped there, not where an unpainted one is,
  // and where nothing is said, only at traffic lights
  const paintedEnd = (e, s, node) => {
    const [x, z] = at(e, s, 0);
    const near = crossingsNear(x, z, e.half + 5);
    for (const c of near) c.used = true;
    if (near.some((c) => c.marked === 1)) return true;
    if (near.some((c) => c.marked === 0)) return false;
    return !!node.signal;
  };

  // The one or two directed edges of each road between a pair of intersections
  const roads = new Map();
  for (const e of network.paintEdges || network.edges) {
    const key = Math.min(e.from.id, e.to.id) * 65536 + Math.max(e.from.id, e.to.id);
    if (roads.has(key)) roads.get(key).push(e);
    else roads.set(key, [e]);
  }
  for (const [e, back] of roads.values()) {
    const firstLine = lines.length;
    // Lanes of both directions, measured to the right of e, left to right
    const lanes = e.lanes.map((o) => ({ o, dir: 1 }));
    if (back) for (const o of back.lanes) lanes.push({ o: -o, dir: -1 });
    lanes.sort((p, q) => p.o - q.o);

    // Dashed white between lanes going the same way, double yellow between opposing ones
    // (nothing across a median or a lane closed off by an obstacle). Lamp: a residential street (class 4) or one marked
    // without lines (6) has no centre line, a street with a centre turn lane its solid and dashed yellow either side
    const lined = (e.cls ?? 4) <= 3 || e.cls === 5 || lanes.length > 2;
    for (let k = 0; k + 1 < lanes.length; k++) {
      const p = lanes[k];
      const q = lanes[k + 1];
      const mid = (p.o + q.o) / 2;
      if (p.dir !== q.dir && e.turn && q.o - p.o > 4.5 && q.o - p.o < 9 && clearCentre(e, mid)) {
        for (const sgn of [-1, 1]) {
          along(e, mid + sgn * 1.65, 0.12, YELLOW, 1, 1, { turn: sgn });
          along(e, mid + sgn * 1.4, 0.12, YELLOW, 6, 0.5, { turn: sgn, dashed: true });
        }
        continue;
      }
      if (q.o - p.o > 4.5 && (p.dir === q.dir || !clearCentre(e, mid))) continue;
      if (p.dir === q.dir) {
        if (e.cls !== 6) along(e, mid, 0.13, WHITE, 12, 0.25);
      } else if (lined) {
        along(e, mid - 0.12, 0.11, YELLOW, 1, 1, { centre: -1 });
        along(e, mid + 0.12, 0.11, YELLOW, 1, 1, { centre: 1 });
      }
    }

    // Lamp: a one-way main street's left edge, solid yellow
    if (!back && lanes.length >= 2 && (e.cls ?? 4) <= 3 && !e.divided) along(e, lanes[0].o - 1.75, 0.12, YELLOW);

    // Lamp: painted bike lanes along the curb (offsets in e's frame): a solid white line on the traffic side (a second
    // one where it's buffered) and the lane itself in green
    const bikeLane = (curb, width) => {
      const sgn = Math.sign(curb);
      const inner = curb - sgn * width;
      along(e, inner, 0.15, WHITE);
      if (width > 2) along(e, inner + sgn * 0.6, 0.15, WHITE);
      along(e, curb - sgn * Math.min(1.7, width) / 2 - sgn * 0.1, Math.min(1.7, width) - 0.45, GREEN);
    };
    // (not on a divided road's two halves, whose half-width spans both: their curbs aren't known here)
    // Lamp: a parking lane along each curb (curb-parking.js) ends in a solid white line, any bike lane beside it
    const pR = e.divided ? 0 : e.parkR || 0, pL = e.divided ? 0 : e.parkL || 0;
    if (pR) along(e, e.half - pR, 0.12, WHITE);
    if (pL) along(e, -e.half + pL, 0.12, WHITE);
    if (e.bikeR && !e.divided) bikeLane(e.half - pR, e.bikeR);
    if (!back && e.bikeL && !e.divided) bikeLane(-e.half + pL, e.bikeL);
    if (back && back.bikeR && !back.divided) bikeLane(-e.half + pL, back.bikeR);

    // Stop bars across the lanes arriving at each stop line, from the centre line (or median) to the curb (none where a
    // street merely bends: a shape node of the centreline streets)
    for (const f of back ? [e, back] : [e]) {
      if (f.to.shape) continue;
      const left = back ? Math.max(0, f.lanes[0] - 1.8) : -f.half;
      across(f, f.len - 0.35, left + 0.1, f.half - 0.1, 0.45, WHITE);
    }

    // Continental crosswalks curb to curb, between the stop lines and the intersections at both ends
    if (!e.from.shape && paintedEnd(e, -CROSSWALK / 2, e.from)) {
      across(e, -CROSSWALK / 2, -e.half, e.half, CROSSWALK - 0.3, WHITE, 1.2, 0.5);
    }
    if (!e.to.shape && paintedEnd(e, e.len + CROSSWALK / 2, e.to)) {
      across(e, e.len + CROSSWALK / 2, -e.half, e.half, CROSSWALK - 0.3, WHITE, 1.2, 0.5);
    }

    for (const [end, node] of [[0, e.from], [1, e.to]]) {
      if (!node.shape) continue;
      if (!bends.has(node.id)) bends.set(node.id, []);
      bends.get(node.id).push({ e, end, lines: lines.slice(firstLine) });
    }
  }

  // Lamp: painted crossings mid-block (by a school, a park path, a campus walk), wherever one wasn't an intersection's
  for (const [e] of roads.values()) {
    if (e.len < CROSSWALK * 2 + 4) continue;
    const [mx, mz] = at(e, e.len / 2, 0);
    for (const c of crossingsNear(mx, mz, e.len / 2 + e.half)) {
      if (c.used || c.marked !== 1) continue;
      const s = (c.x - e.sx) * e.dx + (c.z - e.sz) * e.dz;
      const o = (c.x - e.sx) * e.rx + (c.z - e.sz) * e.rz;
      if (s < CROSSWALK + 2 || s > e.len - CROSSWALK - 2 || Math.abs(o) > e.half + 1) continue;
      c.used = true;
      across(e, s, -e.half, e.half, CROSSWALK - 0.3, WHITE, 1.2, 0.5);
    }
  }

  // At a simple bend, corresponding offset lines meet at a bounded miter, without an intersection-sized gap.
  for (const roadsAtBend of bends.values()) {
    if (roadsAtBend.length !== 2) continue;
    const [a, b] = roadsAtBend;
    const sign = a.end === b.end ? -1 : 1;
    if ((a.e.dx * b.e.dx + a.e.dz * b.e.dz) * sign < 0.5) continue;
    for (const p of a.lines) {
      let q = null;
      let distance = 0.5;
      for (const line of b.lines) {
        const d = Math.abs(p.o - line.o * sign);
        if (!line.joins[b.end] && line.col === p.col && line.w === p.w && line.period === p.period &&
          line.duty === p.duty && d < distance) {
          q = line;
          distance = d;
        }
      }
      if (!q) continue;
      const A = p.ends[a.end];
      const B = q.ends[b.end];
      const dx = B[0] - A[0];
      const dz = B[1] - A[1];
      const cross = a.e.dx * b.e.dz - a.e.dz * b.e.dx;
      let join;
      if (Math.abs(cross) < 0.001) {
        if (Math.hypot(dx, dz) > 0.5) continue;
        join = [(A[0] + B[0]) * 0.5, (A[1] + B[1]) * 0.5];
      } else {
        const t = (dx * b.e.dz - dz * b.e.dx) / cross;
        const u = (dx * a.e.dz - dz * a.e.dx) / cross;
        const limit = Math.min(6, a.e.span * 0.25, b.e.span * 0.25);
        if (Math.abs(t) > limit || Math.abs(u) > limit) continue;
        join = [A[0] + a.e.dx * t, A[1] + a.e.dz * t];
      }
      p.ends[a.end] = q.ends[b.end] = join;
      p.joins[a.end] = [q, b.end];
      q.joins[b.end] = [p, a.end];
    }
  }

  // Continue the same dash phase around bends, even when adjacent road edges point in opposite directions.
  for (const line of lines) {
    // An unmatched marking keeps its original gap instead of extending towards a curb at a sharp bend.
    for (const end of [0, 1]) {
      if (!line.joins[end]) line.ends[end] = at(line.e, end ? line.e.len - 0.9 : 0.9, line.o);
    }
  }
  // Lamp: where a centre turn lane ends at a bend and the street goes on with a plain double yellow, the turn lane's
  // solid edges taper in to meet the double yellow (its dashed ones stop where the taper starts), rather than both
  // stopping short with a gap and the double yellow starting between them
  for (const roadsAtBend of bends.values()) {
    if (roadsAtBend.length !== 2) continue;
    for (const [A, B] of [roadsAtBend, [...roadsAtBend].reverse()]) {
      const sign = A.end === B.end ? -1 : 1;
      if ((A.e.dx * B.e.dx + A.e.dz * B.e.dz) * sign < 0.5) continue;
      const turnLines = A.lines.filter((l) => l.kind?.turn && !l.joins[A.end]);
      const centre = B.lines.filter((l) => l.kind?.centre && !l.joins[B.end]);
      if (!turnLines.length || centre.length !== 2) continue;
      const T = Math.min(18, A.e.len * 0.4);
      const sT = A.end ? A.e.len - 0.9 - T : 0.9 + T;
      for (const l of turnLines) {
        l.ends[A.end] = at(l.e, sT, l.o);
        if (l.kind.dashed) continue;
        // the double yellow line on the same side, in A's frame
        const q = centre.reduce((m, c) => ((c.o - m.o) * sign * l.kind.turn > 0 ? c : m));
        strip(...l.ends[A.end], ...q.ends[B.end], l.w, l.col);
      }
    }
  }
  for (const line of lines) {
    line.len = Math.hypot(line.ends[1][0] - line.ends[0][0], line.ends[1][1] - line.ends[0][1]);
  }
  for (const root of lines) {
    if (root.phase !== undefined) continue;
    root.phase = 0;
    root.flow = 1;
    const stack = [root];
    while (stack.length) {
      const line = stack.pop();
      for (let end = 0; end < 2; end++) {
        if (!line.joins[end]) continue;
        const [next, nextEnd] = line.joins[end];
        if (next.phase !== undefined) continue;
        next.flow = line.flow * (end === nextEnd ? -1 : 1);
        next.phase = line.phase + end * line.len * line.flow - nextEnd * next.len * next.flow;
        next.phase = ((next.phase % next.period) + next.period) % next.period;
        stack.push(next);
      }
      strip(...line.ends[0], ...line.ends[1], line.w, line.col, line.period, line.duty, line.phase, line.flow);
    }
  }

  // Lamp: each parallel-parking stall's marks (curb-parking.js), from the parking lane's line to near the curb
  for (const st of curbStalls()) {
    for (const end of [-0.5, 0.5]) {
      const cx = st.x + st.tx * st.length * end, cz = st.z + st.tz * st.length * end;
      const h = st.lane / 2;
      strip(cx - st.nx * h, cz - st.nz * h, cx + st.nx * (h - 0.35), cz + st.nz * (h - 0.35), 0.12, WHITE);
    }
  }

  const group = builder.build();
  scene.add(group);
  return group;
}

export { buildRoadPaint, createRoadPaintChunkBuilder };
