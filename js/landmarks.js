import * as THREE from 'three/webgpu';
import { stadiumGround } from './terrain.js';
import { STADIUM, N, radiiAt, FIELD_Y, WALL_TOP, SEAT_TOP, RIM_Y, WALL_Y, AISLE_IN, CONCOURSE } from './stadium-shape.js';

// Ann Arbor's landmarks are the city's own surveyed buildings (Burton Tower, Hill Auditorium, the Union...), drawn by
// buildings.js. What the survey can't give is Michigan Stadium, "the Big House": a bowl dug into the ground, its stands
// sloping from a low rim down to the field. It's modelled here on its real outline.

let bryantParkLawn = null; // (New York's Bryant Park; Ann Arbor has none)

// Michigan Stadium on its real outline (stadium-shape.js): the field 15 m below the street, a bowl of 70-odd rows of
// aluminium benches on concrete with aisles, the blue halo with its maize stripe at the top, a brick outer wall only a
// few metres high, the press box and suite towers along the west and east sides (2010), and the video boards at
// each end. Everything stands on stadiumGround(), the ground around it, which terrain.js has dug out inside.
function buildBigHouse(group, colliders) {
  const { cx, cz } = STADIUM;
  const G = stadiumGround();
  const ROWS = 72, AISLE_EVERY = 6;
  const pos = [], col = [];
  const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();
  const bench = C(0xb9bdc2), riser = C(0x6d727a), aisle = C(0xd2cdc2), concrete = C(0xa6a39b), blue = C(0x00274c),
    maize = C(0xffcb05), brick = C(0x8a4d37), stone = C(0xcfc6b4), turfDark = C(0x2f6b2c);
  const quad = (a, b, c, d, color) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) col.push(color.r, color.g, color.b);
  };
  // point on ray k (fractional) at distance r from the middle, height y above the ground around
  const at = (k, r, y) => {
    const a = (k / N) * Math.PI * 2;
    return [cx + Math.cos(a) * r, G + y, cz + Math.sin(a) * r];
  };
  for (let k = 0; k < N; k++) {
    const k1 = k + 1;
    const [i0, o0] = radiiAt((k / N) * Math.PI * 2), [i1, o1] = radiiAt((k1 / N) * Math.PI * 2);
    const isAisle = k % AISLE_EVERY === 0;
    // the field wall: blue padding with a maize line along its top
    quad(at(k, i0, FIELD_Y), at(k1, i1, FIELD_Y), at(k1, i1, WALL_TOP - 0.25), at(k, i0, WALL_TOP - 0.25), blue);
    quad(at(k, i0, WALL_TOP - 0.25), at(k1, i1, WALL_TOP - 0.25), at(k1, i1, WALL_TOP), at(k, i0, WALL_TOP), maize);
    // the walk around the field
    quad(at(k, i0, WALL_TOP), at(k1, i1, WALL_TOP), at(k1, i1 + AISLE_IN, WALL_TOP), at(k, i0 + AISLE_IN, WALL_TOP), concrete);
    // the rows: a riser and a tread each
    const s0 = i0 + AISLE_IN, s1 = i1 + AISLE_IN, e0 = o0 - CONCOURSE, e1 = o1 - CONCOURSE;
    for (let row = 0; row < ROWS; row++) {
      const t0 = row / ROWS, t1 = (row + 1) / ROWS;
      const ya = WALL_TOP + (SEAT_TOP - WALL_TOP) * t0, yb = WALL_TOP + (SEAT_TOP - WALL_TOP) * t1;
      const ra0 = s0 + (e0 - s0) * t0, ra1 = s1 + (e1 - s1) * t0, rb0 = s0 + (e0 - s0) * t1, rb1 = s1 + (e1 - s1) * t1;
      quad(at(k, ra0, ya), at(k1, ra1, ya), at(k1, ra1, yb), at(k, ra0, yb), isAisle ? aisle : riser);
      quad(at(k, ra0, yb), at(k1, ra1, yb), at(k1, rb1, yb), at(k, rb0, yb), isAisle ? aisle : (row % 2 ? bench : C(0xaeb3b8)));
    }
    // the halo: blue fascia with a maize stripe over the top row, then the concourse to the outer wall
    quad(at(k, e0, SEAT_TOP), at(k1, e1, SEAT_TOP), at(k1, e1, RIM_Y - 0.15), at(k, e0, RIM_Y - 0.15), blue);
    quad(at(k, e0, RIM_Y - 0.15), at(k1, e1, RIM_Y - 0.15), at(k1, e1, RIM_Y), at(k, e0, RIM_Y), maize);
    quad(at(k, e0, RIM_Y), at(k1, e1, RIM_Y), at(k1, o1 - 0.6, RIM_Y), at(k, o0 - 0.6, RIM_Y), concrete);
    // the outer wall: a stone parapet over brick, down to the ground (and a little under it, on a slope)
    quad(at(k, o0 - 0.6, RIM_Y), at(k1, o1 - 0.6, RIM_Y), at(k1, o1 - 0.6, WALL_Y), at(k, o0 - 0.6, WALL_Y), brick);
    quad(at(k, o0 - 0.6, WALL_Y), at(k1, o1 - 0.6, WALL_Y), at(k1, o1, WALL_Y), at(k, o0, WALL_Y), stone);
    quad(at(k, o0, WALL_Y), at(k1, o1, WALL_Y), at(k1, o1, WALL_Y - 0.7), at(k, o0, WALL_Y - 0.7), stone);
    quad(at(k, o0, WALL_Y - 0.7), at(k1, o1, WALL_Y - 0.7), at(k1, o1, -3), at(k, o0, -3), brick);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const stands = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82, side: THREE.DoubleSide }));
  stands.name = 'BigHouseStands';
  stands.castShadow = stands.receiveShadow = true;
  group.add(stands);

  // The field: the floor inside the wall, then the turf with its maize-and-blue end zones, yard lines and the block M
  const floorShape = new THREE.Shape();
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2, r = radiiAt(a)[0];
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    k ? floorShape.lineTo(x, -z) : floorShape.moveTo(x, -z);
  }
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(floorShape).rotateX(-Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ color: turfDark, roughness: 0.92 }));
  floor.position.set(cx, G + FIELD_Y, cz);
  floor.receiveShadow = true;
  group.add(floor);
  const P = STADIUM.pitch;
  const field = new THREE.Group();
  field.position.set(P.cx, G + FIELD_Y + 0.03, P.cz);
  field.rotation.y = Math.PI / 2 - P.angle; // the field's length (local z) along the pitch's long side
  const flat = (w, d, color, y = 0, x = 0, z = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), new THREE.MeshStandardNodeMaterial({ color, roughness: 0.9 }));
    m.position.set(x, y, z);
    m.receiveShadow = true;
    field.add(m);
    return m;
  };
  const W = 48.8, L = 91.4, EZ = 9.1; // 53⅓ yards wide, 100 yards and two end zones long
  for (let i = 0; i < 20; i++) flat(W + 6, L / 20, i % 2 ? 0x3b8a35 : 0x347f30, 0.0, 0, -L / 2 + (i + 0.5) * (L / 20));
  flat(W + 6, EZ + 3, 0x00274c, 0.01, 0, -(L / 2 + (EZ + 3) / 2));
  flat(W + 6, EZ + 3, 0x00274c, 0.01, 0, L / 2 + (EZ + 3) / 2);
  for (let yd = 0; yd <= 100; yd += 5) flat(W, yd % 10 ? 0.12 : 0.22, 0xf2f2ee, 0.03, 0, -L / 2 + (yd / 100) * L);
  for (const sx of [-1, 1]) flat(0.2, L + EZ * 2, 0xf2f2ee, 0.03, sx * W / 2, 0);
  for (const sz of [-1, 1]) flat(W, 0.2, 0xf2f2ee, 0.03, 0, sz * (L / 2 + EZ));
  // hash marks
  for (let yd = 1; yd < 100; yd++) for (const hx of [-3.08, 3.08]) flat(0.6, 0.1, 0xf2f2ee, 0.03, hx, -L / 2 + (yd / 100) * L);
  // MICHIGAN across each end zone in maize outlined in white, its tops toward the end line
  {
    const cv = document.createElement('canvas');
    cv.width = 2048; cv.height = 300;
    const g = cv.getContext('2d');
    g.font = 'bold 270px "Arial Black", "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 22; g.strokeStyle = '#ffffff';
    g.strokeText('MICHIGAN', 1024, 160, 1960);
    g.fillStyle = '#ffcb05';
    g.fillText('MICHIGAN', 1024, 160, 1960);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardNodeMaterial({ map: tex, transparent: true, depthWrite: false, roughness: 0.85,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const geo = new THREE.PlaneGeometry(W - 4, (W - 4) * 300 / 2048).rotateX(-Math.PI / 2);
    for (const s of [-1, 1]) {
      const word = new THREE.Mesh(geo, mat);
      word.position.set(0, 0.035, s * (L / 2 + EZ / 2));
      word.rotation.y = s > 0 ? Math.PI : 0;
      word.renderOrder = 1;
      field.add(word);
    }
  }
  // the yard numbers, 6 ft tall with their bottoms 8 yards in from each sideline, tops toward it, and the little
  // arrows beside them pointing to the nearer goal
  const numberTex = new Map();
  const numberMat = (n) => {
    if (!numberTex.has(n)) {
      const cv = document.createElement('canvas');
      cv.width = 320; cv.height = 220;
      const g = cv.getContext('2d');
      g.fillStyle = '#fff';
      g.font = 'bold 230px "Arial Black", "Helvetica Neue", Arial, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(n), 160, 118, 300);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      numberTex.set(n, new THREE.MeshStandardNodeMaterial({ color: 0xf2f2ee, map: tex, transparent: true, depthWrite: false,
        roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    }
    return numberTex.get(n);
  };
  const numberGeo = new THREE.PlaneGeometry(2.66, 1.83).rotateX(-Math.PI / 2);
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.45); arrowShape.lineTo(-0.23, -0.45); arrowShape.lineTo(0.23, -0.45);
  const arrowGeo = new THREE.ShapeGeometry(arrowShape).rotateX(-Math.PI / 2); // points to -z
  const lineMat = new THREE.MeshStandardNodeMaterial({ color: 0xf2f2ee, roughness: 0.9 });
  const NX = W / 2 - 7.4 - 0.915;
  for (let yd = 10; yd <= 90; yd += 10) {
    const z = -L / 2 + (yd / 100) * L, n = yd <= 50 ? yd : 100 - yd;
    for (const side of [-1, 1]) {
      const num = new THREE.Mesh(numberGeo, numberMat(n));
      num.position.set(side * NX, 0.035, z);
      num.rotation.y = -side * Math.PI / 2; // the top of the numbers toward this sideline
      num.renderOrder = 1;
      field.add(num);
      if (n === 50) continue;
      const toward = yd < 50 ? -1 : 1;
      const arrow = new THREE.Mesh(arrowGeo, lineMat);
      arrow.position.set(side * (NX + 0.55), 0.035, z + toward * 1.75);
      arrow.rotation.y = toward < 0 ? 0 : Math.PI;
      field.add(arrow);
    }
  }
  // The Block M: slab serifs on its outer feet and top corners, inner legs standing on serifs of their own, and the
  // middle V coming down to a point; maize, outlined in blue
  const BLOCK_M = [[-5, -3.7], [-1.9, -3.7], [-1.9, -2.7], [-2.6, -2.7], [-2.6, 0.9], [0, -2.9], [2.6, 0.9], [2.6, -2.7],
    [1.9, -2.7], [1.9, -3.7], [5, -3.7], [5, -2.7], [4.3, -2.7], [4.3, 2.7], [5, 2.7], [5, 3.7], [2.4, 3.7], [0, 0.4],
    [-2.4, 3.7], [-5, 3.7], [-5, 2.7], [-4.3, 2.7], [-4.3, -2.7], [-5, -2.7]];
  const blockM = (grow) => {
    const shape = new THREE.Shape();
    BLOCK_M.forEach(([x, y], i) => {
      // grow the outline outward by `grow` m (each corner pushed out along the outline's bisector, near enough)
      const [px, py] = BLOCK_M[(i + BLOCK_M.length - 1) % BLOCK_M.length], [nx, ny] = BLOCK_M[(i + 1) % BLOCK_M.length];
      let ax = y - py, ay = px - x, bx = ny - y, by = x - nx;
      const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
      ax /= la; ay /= la; bx /= lb; by /= lb;
      const mx = ax + bx, my = ay + by, d = (mx * ax + my * ay) || 1;
      const ox = x + (mx / d) * grow, oy = y + (my / d) * grow;
      i ? shape.lineTo(ox, oy) : shape.moveTo(ox, oy);
    });
    return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
  };
  for (const [grow, hex, y] of [[0.35, 0x00274c, 0.045], [0, 0xffcb05, 0.05]]) {
    const mMesh = new THREE.Mesh(blockM(grow), new THREE.MeshStandardNodeMaterial({ color: hex, roughness: 0.8 }));
    mMesh.position.y = y;
    mMesh.scale.setScalar(1.4);
    mMesh.rotation.y = -Math.PI / 2; // reads from the press box on the west side
    field.add(mMesh);
  }
  // goalposts: maize uprights on a single post behind each end line
  const postMat = new THREE.MeshStandardNodeMaterial({ color: 0xffcb05, roughness: 0.5 });
  for (const s of [-1, 1]) {
    const z = s * (L / 2 + EZ + 0.6);
    const add = (geo, x, y, zz) => { const m = new THREE.Mesh(geo, postMat); m.position.set(x, y, zz); m.castShadow = true; field.add(m); };
    add(new THREE.CylinderGeometry(0.12, 0.12, 3.05, 8), 0, 1.52, z + s * 1.5);
    add(new THREE.BoxGeometry(0.15, 0.15, 1.6), 0, 3.05, z + s * 0.75);
    add(new THREE.BoxGeometry(5.64, 0.12, 0.12), 0, 3.05, z);
    for (const x of [-2.82, 2.82]) add(new THREE.CylinderGeometry(0.06, 0.06, 6.1, 6), x, 3.05 + 3.05, z);
  }
  group.add(field);

  // The press box and suites along the west side, the suites along the east: brick boxes over the top rows, glass
  // toward the field in three bands, a maize stripe along the top
  const brickMat = new THREE.MeshStandardNodeMaterial({ color: 0x7e4733, roughness: 0.85 });
  const glassMat = new THREE.MeshStandardNodeMaterial({ color: 0x1d2c3c, roughness: 0.12, metalness: 0.6 });
  const bandMat = new THREE.MeshStandardNodeMaterial({ color: 0xd9d4c8, roughness: 0.7 });
  const maizeMat = new THREE.MeshStandardNodeMaterial({ color: 0xffcb05, roughness: 0.6 });
  const towers = [{ side: -1, top: 36, half: 66, depth: 22 }, { side: 1, top: 27, half: 60, depth: 18 }];
  for (const t of towers) {
    const rOut = radiiAt(t.side < 0 ? Math.PI : 0)[1];
    const outerX = cx + t.side * rOut, innerX = outerX - t.side * t.depth, midX = (outerX + innerX) / 2;
    const y0 = RIM_Y + 1.5, h = t.top - y0;
    // solid to a car driving round the top of the stands (one passing under its overhang clears it)
    colliders.push({ minX: Math.min(innerX, outerX), maxX: Math.max(innerX, outerX), minZ: cz - t.half, maxZ: cz + t.half,
      minY: G + y0, maxY: G + t.top, solid: true });
    const box = new THREE.Mesh(new THREE.BoxGeometry(t.depth, h, t.half * 2), brickMat);
    box.position.set(midX, G + y0 + h / 2, cz);
    box.castShadow = box.receiveShadow = true;
    group.add(box);
    // the brick down to the ground on the outside
    const base = new THREE.Mesh(new THREE.BoxGeometry(3, y0 + 3, t.half * 2), brickMat);
    base.position.set(outerX - t.side * 1.5, G + (y0 - 3) / 2, cz);
    colliders.push({ minX: Math.min(outerX, outerX - t.side * 3), maxX: Math.max(outerX, outerX - t.side * 3),
      minZ: cz - t.half, maxZ: cz + t.half, minY: G - 3, maxY: G + y0, solid: true });
    group.add(base);
    for (let b = 0; b < 3; b++) {
      const gy = y0 + 3 + b * (h - 6) / 3, gh = (h - 6) / 3 - 1.4;
      const glass = new THREE.Mesh(new THREE.BoxGeometry(0.3, gh, t.half * 2 - 4), glassMat);
      glass.position.set(innerX - t.side * 0.12, G + gy + gh / 2, cz);
      group.add(glass);
      const outerGlass = new THREE.Mesh(new THREE.BoxGeometry(0.3, gh * 0.6, t.half * 2 - 20), glassMat);
      outerGlass.position.set(outerX + t.side * 0.12, G + gy + gh / 2, cz);
      group.add(outerGlass);
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(t.depth + 0.4, 1.2, t.half * 2 + 0.4), maizeMat);
    stripe.position.set(midX, G + t.top - 1.4, cz);
    group.add(stripe);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(t.depth + 0.6, 0.5, t.half * 2 + 0.6), bandMat);
    cap.position.set(midX, G + t.top + 0.25, cz);
    group.add(cap);
  }

  // The video boards behind each end zone, on the outer wall
  const boxMat = new THREE.MeshStandardNodeMaterial({ color: 0x3f474f, roughness: 0.5, metalness: 0.3 });
  // What they show: GO BLUE in maize on Michigan blue
  const cv = document.createElement('canvas');
  cv.width = 1240; cv.height = 400;
  const cx2 = cv.getContext('2d');
  const sky = cx2.createLinearGradient(0, 0, 0, 400);
  sky.addColorStop(0, '#0b3a6b'); sky.addColorStop(1, '#00274c');
  cx2.fillStyle = sky; cx2.fillRect(0, 0, 1240, 400);
  cx2.strokeStyle = '#ffcb05'; cx2.lineWidth = 14; cx2.strokeRect(22, 22, 1196, 356);
  cx2.fillStyle = '#ffcb05';
  cx2.font = '900 250px "Helvetica Neue", Helvetica, Arial, sans-serif';
  cx2.textAlign = 'center'; cx2.textBaseline = 'middle';
  cx2.fillText('GO BLUE', 620, 212, 1100);
  const screenTex = new THREE.CanvasTexture(cv);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.anisotropy = 8;
  const screenMat = new THREE.MeshBasicNodeMaterial({ map: screenTex });
  for (const s of [-1, 1]) {
    const a = s < 0 ? -Math.PI / 2 : Math.PI / 2, rOut = radiiAt(a)[1];
    const bz = cz + s * (rOut - 2);
    const board = new THREE.Mesh(new THREE.BoxGeometry(34, 14, 2), new THREE.MeshStandardNodeMaterial({ color: 0x00274c, roughness: 0.5 }));
    board.position.set(cx, G + 23, bz);
    board.castShadow = true;
    group.add(board);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(31, 10), screenMat);
    screen.position.set(cx, G + 23.5, bz - s * 1.05);
    if (s > 0) screen.rotation.y = Math.PI;
    group.add(screen);
    const band = new THREE.Mesh(new THREE.BoxGeometry(34.2, 1.2, 2.2), new THREE.MeshStandardNodeMaterial({ color: 0xffcb05, roughness: 0.6 }));
    band.position.set(cx, G + 16.6, bz);
    group.add(band);
    for (const lx of [-12, 12]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.6, 16, 1.6), boxMat);
      leg.position.set(cx + lx, G + 8, bz);
      group.add(leg);
    }
  }

  // Keep the survey's pieces of the stadium out, and people, bikes and traffic outside its wall (a car may drive in over it)
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * Math.PI * 2, r = radiiAt(a)[1];
    minX = Math.min(minX, cx + Math.cos(a) * r); maxX = Math.max(maxX, cx + Math.cos(a) * r);
    minZ = Math.min(minZ, cz + Math.sin(a) * r); maxZ = Math.max(maxZ, cz + Math.sin(a) * r);
  }
  colliders.push({ minX, maxX, minZ, maxZ, maxY: G + 45, stadium: true }); // the helicopter flies into the bowl
  // stood on the ground it was measured from: setOnTerrain leaves it be
  group.userData.terrain = 'set';
}

function buildLandmarks(scene) {
  const group = new THREE.Group();
  group.name = 'AnnArborLandmarks';
  const colliders = [];
  buildBigHouse(group, colliders);
  scene.add(group);
  return { group, colliders };
}

export { buildLandmarks, bryantParkLawn };
