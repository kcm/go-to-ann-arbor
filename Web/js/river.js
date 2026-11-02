import * as THREE from 'three/webgpu';
import { nearDrop } from './cascades.js';
import { riverbedHeight, riverDepth, waterLevel, bridgeDecks } from './terrain.js';

// The Huron River and its ponds sunk into their banks (terrain.js digs the bed from data/river.bin.gz): grassy banks
// sloping down through mud to the silt of the bed, the water lying flat at the river's level over it, and the bridges
// that cross it: the streets' concrete decks with sidewalks, parapets and piers, the railways' steel girders, and
// footbridges with railings, all with open water under them to paddle through.

// Every triangle split at its longest edge until `tooBig(a, b, c)` says it's small enough; positions only
function subdivide(geometry, tooBig) {
  const src = (geometry.index ? geometry.toNonIndexed() : geometry).attributes.position.array;
  const out = [];
  const split = (a, b, c, depth) => {
    if (depth > 22 || !tooBig(a, b, c)) { out.push(...a, ...b, ...c); return; }
    const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[2] - q[2]) ** 2;
    const ab = d2(a, b), bc = d2(b, c), ca = d2(c, a), m = Math.max(ab, bc, ca);
    const mid = (p, q) => [(p[0] + q[0]) / 2, 0, (p[2] + q[2]) / 2];
    if (m === ab) { const k = mid(a, b); split(a, k, c, depth + 1); split(k, b, c, depth + 1); }
    else if (m === bc) { const k = mid(b, c); split(a, b, k, depth + 1); split(a, k, c, depth + 1); }
    else { const k = mid(c, a); split(a, b, k, depth + 1); split(k, b, c, depth + 1); }
  };
  for (let i = 0; i < src.length; i += 9) {
    split([src[i], 0, src[i + 2]], [src[i + 3], 0, src[i + 5]], [src[i + 6], 0, src[i + 8]], 0);
  }
  return out;
}

const longest = (a, b, c) => Math.max((a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2, (b[0] - c[0]) ** 2 + (b[2] - c[2]) ** 2,
  (c[0] - a[0]) ** 2 + (c[2] - a[2]) ** 2);

function meshOf(pos, material, name, colors = null) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.name = name;
  m.receiveShadow = true;
  m.userData.cullDistance = 1500;
  return m;
}

// The banks and bed, and the water over them. `geos` are the water's polygons, flat at y = 0
function buildRiver(group, geos, waterMat) {
  const river = new THREE.Group();
  river.name = 'HuronRiver';
  river.userData.terrain = 'set';
  // The banks: cut fine (3 m) where the ground slopes down to the bed, coarse (40 m) over the bed itself
  const bankPos = [], bankCol = [];
  // the lawn's own green on the top, a deeper, shaggier green down the bank, a narrow strip of mud at the water
  const lawn = new THREE.Color(0x4f8a2e).convertSRGBToLinear(), grass = new THREE.Color(0x3f6b27).convertSRGBToLinear();
  const mud = new THREE.Color(0x5a4c35).convertSRGBToLinear();
  const silt = new THREE.Color(0x4a4632).convertSRGBToLinear(), c = new THREE.Color();
  const sloped = (p) => { const d = riverDepth(p[0], p[2]); return d > 0.001 && d < 0.999; };
  // around the Argo Cascades (cascades.js), where the channel's levels step down beside land the map calls water
  const byCascades = (a, b, k) => Math.max(a[0], b[0], k[0]) > 140 && Math.min(a[0], b[0], k[0]) < 660
    && Math.max(a[2], b[2], k[2]) > -1300 && Math.min(a[2], b[2], k[2]) < -1030;
  const dry = (x, z) => { const lv = waterLevel(x, z); return lv === null || riverbedHeight(x, z) > lv + 0.1; };
  const waterPos = [];
  for (const geo of geos) {
    const bank = subdivide(geo, (a, b, k) => {
      const l = longest(a, b, k);
      if (l > 1600) return true;
      if (l > 9 && byCascades(a, b, k)) return true; // following the ground there, every 3 m
      if (l <= 144) return false;
      const m = [(a[0] + b[0] + k[0]) / 3, 0, (a[2] + b[2] + k[2]) / 3];
      return sloped(a) || sloped(b) || sloped(k) || sloped(m);
    });
    for (let i = 0; i < bank.length; i += 3) {
      const x = bank[i], z = bank[i + 2], y = riverbedHeight(x, z), lv = waterLevel(x, z) ?? y;
      // none on the land beside the cascades, which the ground there draws itself
      if (i % 9 === 0) {
        const a = [x, 0, z], b = [bank[i + 3], 0, bank[i + 5]], k = [bank[i + 6], 0, bank[i + 8]], high = (p) => {
          const g = riverbedHeight(p[0], p[2]), l = waterLevel(p[0], p[2]); return l === null || g > l + 0.6;
        };
        if (byCascades(a, b, k) && high(a) && high(b) && high(k)) { i += 6; continue; }
      }
      bankPos.push(x, y, z);
      const above = y - lv;
      if (above > 1.0) c.copy(grass).lerp(lawn, Math.min(1, (above - 1.0) / 0.4));
      else if (above > 0.25) c.copy(grass);
      else if (above > -0.3) c.copy(mud).lerp(grass, (above + 0.3) / 0.55);
      else c.copy(silt).lerp(mud, Math.max(0, (above + 1.2) / 0.9));
      bankCol.push(c.r, c.g, c.b);
    }
    // The water: flat at the river's level, cut every 20 m so it follows the level down the river
    // and every 60 cm over the Argo Cascades' drops, so each step shows (cascades.js)
    const water = subdivide(geo, (a, b, k) => {
      const l = longest(a, b, k);
      if (l > 400) return true;
      if (l <= 0.36) return false;
      const reach = Math.sqrt(l);
      // and every 3 m down the rest of the channel, so its pools lie at their own levels
      // (any piece reaching over it, not only those with a corner in it, so none lies across a step)
      if (l > 9 && byCascades(a, b, k)) return true;
      return [a, b, k, [(a[0] + b[0] + k[0]) / 3, 0, (a[2] + b[2] + k[2]) / 3]].some((p) => nearDrop(p[0], p[2], reach));
    });
    for (let i = 0; i < water.length; i += 9) {
      const a = [water[i], 0, water[i + 2]], b = [water[i + 3], 0, water[i + 5]], k = [water[i + 6], 0, water[i + 8]];
      // none over the land beside the cascades, where the water would show through the ground
      if (byCascades(a, b, k) && dry(a[0], a[2]) && dry(b[0], b[2]) && dry(k[0], k[2])) continue;
      for (const [x, , z] of [a, b, k]) waterPos.push(x, waterLevel(x, z) ?? riverbedHeight(x, z) + 0.05, z);
    }
  }
  if (bankPos.length) {
    // in tiles, so only what's in view is drawn
    const bankMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.97 });
    const TILE = 700, tiles = new Map();
    for (let i = 0; i < bankPos.length; i += 9) {
      const key = Math.floor((bankPos[i] + bankPos[i + 3] + bankPos[i + 6]) / 3 / TILE) * 1000
        + Math.floor((bankPos[i + 2] + bankPos[i + 5] + bankPos[i + 8]) / 3 / TILE);
      if (!tiles.has(key)) tiles.set(key, [[], []]);
      const [tp, tc] = tiles.get(key);
      for (let k = 0; k < 9; k++) { tp.push(bankPos[i + k]); tc.push(bankCol[i + k]); }
    }
    for (const [tp, tc] of tiles.values()) river.add(meshOf(tp, bankMat, 'RiverBanks', tc));
  }
  if (waterPos.length) {
    // in tiles, so only what's in view is drawn
    const TILE = 700, tiles = new Map();
    for (let i = 0; i < waterPos.length; i += 9) {
      const key = Math.floor((waterPos[i] + waterPos[i + 3] + waterPos[i + 6]) / 3 / TILE) * 1000
        + Math.floor((waterPos[i + 2] + waterPos[i + 5] + waterPos[i + 8]) / 3 / TILE);
      if (!tiles.has(key)) tiles.set(key, []);
      const t = tiles.get(key);
      for (let k = 0; k < 9; k++) t.push(waterPos[i + k]);
    }
    for (const t of tiles.values()) {
      const m = meshOf(t, waterMat, 'RiverWater');
      const n = m.geometry.attributes.normal;
      // flat, but for the cascades' drops, which keep their slope (the water's shading tilts with it)
      const ps = m.geometry.attributes.position;
      for (let i = 0; i < n.count; i++) if (!nearDrop(ps.getX(i), ps.getZ(i), 0)) n.setXYZ(i, 0, 1, 0);
      river.add(m);
    }
  }
  group.add(river);
  buildBridges(river);
}

// ---------------------------------------------------------------------------------------------------------------------
// Bridges
// ---------------------------------------------------------------------------------------------------------------------

function buildBridges(group) {
  const decks = bridgeDecks();
  if (!decks.length) return;
  const concrete = [], steel = [], wood = [], rail = [];

  for (const d of decks) {
    const P = d.points;
    // each point's way along the bridge and across it (to the left)
    const T = P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const tx = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(tx, tz) || 1;
      return [tx / l, tz / l];
    });
    const at = (i, o, y) => [P[i][0] - T[i][1] * o, P[i][3] + y, P[i][1] + T[i][0] * o];
    // a strip along the bridge between offset o0 at height y0 and offset o1 at y1 (both sides with `both`)
    const along = (out, o0, y0, o1, y1, both = true) => {
      for (const s of both ? [1, -1] : [1]) {
        for (let i = 0; i + 1 < P.length; i++) {
          const a = at(i, o0 * s, y0), b = at(i, o1 * s, y1), c2 = at(i + 1, o1 * s, y1), d2 = at(i + 1, o0 * s, y0);
          out.push(...a, ...b, ...c2, ...a, ...c2, ...d2);
        }
      }
    };
    // a box standing across the bridge at point i: `across` wide, `thick` along it, from y0 up to y1 (world heights)
    const pier = (out, i, across, thick, y0, y1) => {
      const g = new THREE.BoxGeometry(across, y1 - y0, thick).toNonIndexed();
      g.rotateY(Math.atan2(T[i][0], T[i][1]));
      g.translate(P[i][0], (y0 + y1) / 2, P[i][1]);
      out.push(...g.attributes.position.array);
    };
    const hw = d.half;
    const under = d.kind === 2 ? -0.45 : -1.1; // the deck's underside, under its top
    if (d.kind === 0) {
      const curb = d.w / 2;
      along(concrete, curb, 0.0, curb, 0.2);              // the curbs
      along(concrete, curb, 0.2, hw - 0.3, 0.2);          // the sidewalks
      along(concrete, hw - 0.3, 0.2, hw - 0.3, 1.05);     // the parapets
      along(concrete, hw - 0.3, 1.05, hw, 1.05);
      along(concrete, hw, 1.05, hw, under);               // and the deck's face below them
      along(concrete, -hw, under, hw, under, false);      // its underside
      along(concrete, -curb, -0.06, curb, -0.06, false);  // the deck under the road
      // a steel railing on the parapets
      along(steel, hw - 0.2, 1.05, hw - 0.2, 1.12);
    } else if (d.kind === 1) {
      along(concrete, -hw, -0.15, hw, -0.15, false);      // the deck under the ballast
      along(steel, hw, -0.15, hw, under);
      along(concrete, -hw, under, hw, under, false);
      // plate girders along both sides, standing above the deck
      along(steel, hw - 0.1, -0.15, hw - 0.1, 1.5);
      along(steel, hw - 0.1, 1.5, hw + 0.25, 1.5);
      along(steel, hw + 0.25, 1.5, hw + 0.25, under);
    } else {
      along(wood, -hw, 0.0, hw, 0.0, false);              // the deck
      along(wood, hw, 0.0, hw, under);
      along(concrete, -hw, under, hw, under, false);
      // railings: a top rail and a mid rail, with posts every couple of metres
      along(rail, hw, 1.05, hw - 0.08, 1.1);
      along(rail, hw, 1.1, hw, 0.98);
      along(rail, hw, 0.55, hw, 0.5);
      for (let i = 0; i < P.length; i++) {
        for (const s of [1, -1]) {
          const [x, y, z] = at(i, (hw - 0.04) * s, 0);
          const g = new THREE.BoxGeometry(0.07, 1.1, 0.07).toNonIndexed().translate(x, y + 0.55, z);
          rail.push(...g.attributes.position.array);
        }
      }
    }
    // Piers in the water every 25 m or so, and an abutment where each end meets the bank
    const wet = P.map((p) => riverDepth(p[0], p[1]) > 0.05);
    const first = wet.indexOf(true), last = wet.lastIndexOf(true);
    if (first < 0) continue;
    const span = P[last][2] - P[first][2];
    const piers = span > 34 ? Math.floor(span / 25) : 0;
    for (let k = 1; k <= piers; k++) {
      const s = P[first][2] + (span * k) / (piers + 1);
      let i = first;
      while (i < last && P[i][2] < s) i++;
      const top = P[i][3] + under, bed = riverbedHeight(P[i][0], P[i][1]) - 0.4;
      if (top - bed > 1) pier(d.kind === 1 ? concrete : concrete, i, hw * 2 - (d.kind === 2 ? 0.4 : 1.2), d.kind === 2 ? 0.5 : 1.3, bed, top);
    }
    for (const i of [Math.max(0, first - 1), Math.min(P.length - 1, last + 1)]) {
      const top = P[i][3] + under, bed = riverbedHeight(P[i][0], P[i][1]) - 0.5;
      if (top - bed > 0.3) pier(concrete, i, hw * 2 + 0.2, 1.6, bed, top + 0.05);
    }
  }

  const mat = (color, rough, metal = 0) => new THREE.MeshStandardNodeMaterial({ color, roughness: rough, metalness: metal, side: THREE.DoubleSide });
  for (const [pos, m, name] of [[concrete, mat(0xb3ada3, 0.9), 'BridgeConcrete'], [steel, mat(0x4d5a5e, 0.6, 0.3), 'BridgeSteel'],
    [wood, mat(0x8a7356, 0.9), 'BridgeDecks'], [rail, mat(0x2f3436, 0.5, 0.4), 'BridgeRailings']]) {
    if (!pos.length) continue;
    const mesh = meshOf(pos, m, name);
    mesh.castShadow = true;
    group.add(mesh);
  }
}

export { buildRiver };
