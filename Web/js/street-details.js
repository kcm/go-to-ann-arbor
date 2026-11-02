import * as THREE from 'three/webgpu';
import { Fn, float, color, positionWorld, uniform, mod, fract, step, smoothstep, mix } from 'three/tsl';
import { groundHeight, groundHeightNode, groundStreamCenter } from './terrain.js';
import { TIER } from './device-tier.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  AVENUES,
  STREETS,
  ALL_AVENUES,
  ALL_STREETS,
  streetZ,
  SIGNAL_TIMING,
  blockAt,
  fromOldFrame,
  BIG_PARK_BOUNDS as CPB,
  BLOCKS,
  LANDMARK_SITES
} from './city-config.js';
import { cityUniforms, createSteamMaterial, createTreeGrateMaterial, createGodRayMaterial } from './tsl-materials.js';
import { createTreeField } from './trees.js';
import { REAL_TREES, REAL_TREE_KINDS, REAL_TREE_HEIGHTS } from './tree-geodata.js';
import { placeStreetTrees } from './tree-placements.js';
import { createFoodCartParts } from './street-props.js';
import { pavedPlazaRects, bigParkClearings, parkTreeSites, parkLampSites, parkLampMeshes } from './city-grid.js';
import { bryantParkLawn } from './landmarks.js';
import { GEO } from './city-geodata.js';
import { createParkLampPoolMaterial } from './tsl-materials.js';

// Instanced street furniture, traffic signals, trees and nearby light pools.

function createStreetSignBladeTexture(label) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0d6b3f';
  ctx.fillRect(0, 0, 256, 64);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(4, 4, 248, 56);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 30px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 128, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * TSL 3-Aspect Traffic Signal Lens Material (Red y=5.78, Amber y=5.42, Green y=5.06)
 * Driven by the shared signal clock and SIGNAL_TIMING (city-config.js), which js/traffic.js obeys.
 */
function createTrafficSignalLensMaterial(isAvenueHead, clock) {
  const { cycle, avenueAmber, avenueRed, streetAmber } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const wy = positionWorld.y.sub(groundHeightNode(positionWorld.xz)); // Lamp: the head's height above the ground
    const isTopRed = step(5.60, wy);
    const isBottomGreen = float(1.0).sub(step(5.24, wy));
    const isMidAmber = float(1.0).sub(isTopRed).mul(float(1.0).sub(isBottomGreen));

    // Avenue phase: Green, then Amber from avenueAmber, Red from avenueRed
    // Street phase: Red until avenueRed, then Green, Amber from streetAmber
    const greenActive = isAvenueHead
      ? float(1.0).sub(step(avenueAmber, t))
      : step(avenueRed, t).mul(float(1.0).sub(step(streetAmber, t)));
    const amberActive = isAvenueHead
      ? step(avenueAmber, t).mul(float(1.0).sub(step(avenueRed, t)))
      : step(streetAmber, t);
    const redActive = isAvenueHead
      ? step(avenueRed, t)
      : float(1.0).sub(step(avenueRed, t));

    const activeMask = isTopRed.mul(redActive)
      .add(isMidAmber.mul(amberActive))
      .add(isBottomGreen.mul(greenActive));

    const lensHue = mix(
      mix(color(0x18ff68), color(0xffaa10), isMidAmber),
      color(0xff2424),
      isTopRed
    );
    return mix(color(0x14181e), lensHue.mul(1.35), activeMask);
  })();
  return mat;
}

// Pedestrian signal for crossing alongside the avenue: WALK, then a flashing hand until the avenue's amber, then a
// steady hand
function createWalkSignalMaterial(clock) {
  const { cycle, avenueAmber, walk } = SIGNAL_TIMING;
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = Fn(() => {
    const t = mod(clock, cycle);
    const isWalk = float(1.0).sub(step(walk, t));
    const isFlashing = step(walk, t).mul(float(1.0).sub(step(avenueAmber, t)));
    const handLit = float(1.0).sub(isFlashing.mul(step(0.5, fract(t))));
    const hand = mix(color(0x14181e), color(0xff5518), handLit);
    return mix(hand, color(0xf4f9ff), isWalk);
  })();
  return mat;
}

function buildStreetDetails(scene, colliders = [], streetFurniture = null) {
  const group = new THREE.Group();
  group.name = 'StreetDetails';

  const dummy = new THREE.Object3D();
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Ground footprints of street furniture that traffic and pedestrians must keep clear of
  const footprints = [];
  const addFootprint = (x, z, w, d, pedestrianOnly = false) => footprints.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, pedestrianOnly });

  // Signal clock (seconds), set every frame by main.js
  const signalClock = uniform(0);

  // Shared materials
  const poleMetalMat = new THREE.MeshStandardNodeMaterial({
    color: 0x3b4046,
    roughness: 0.45,
    metalness: 0.78
  });
  const signalHousingMat = new THREE.MeshStandardNodeMaterial({
    color: 0xe6a817, // Authentic NYC DOT school-bus/marigold yellow housing
    roughness: 0.38,
    metalness: 0.35,
    side: THREE.DoubleSide // the tunnel visors are open half-tubes
  });
  const aveSignalLensMat = createTrafficSignalLensMaterial(true, signalClock);
  const streetSignalLensMat = createTrafficSignalLensMaterial(false, signalClock);
  const walkSignalGlow = createWalkSignalMaterial(signalClock);
  // Cobra-head LED streetlight lens & pedestrian post-top globe: pale diffuser by day, warm white after dusk
  const lampBulbGlow = new THREE.MeshBasicNodeMaterial();
  lampBulbGlow.colorNode = mix(color(0x8f918c), color(0xfff1d6).mul(2.1), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const pedGlobeGlow = new THREE.MeshBasicNodeMaterial();
  pedGlobeGlow.colorNode = mix(color(0xd4d2c8), color(0xffe4b0).mul(1.95), smoothstep(0.4, 1.1, cityUniforms.uInteriorGlow));
  const streetBladeMat = new THREE.MeshStandardNodeMaterial({
    map: createStreetSignBladeTexture('5TH AVE · 42 ST'),
    roughness: 0.32
  });

  // 12-inch three-section signal head (origin at its centre, y = 5.42): yellow housing, a tunnel visor over each lens
  // and a hanger to the mast arm, lenses on both faces (+-z) so it reads from both approaches; the lens material
  // picks red / amber / green from each lens's world height (5.78 / 5.42 / 5.06)
  const HEAD_W = 0.4;
  const HEAD_H = 1.12;
  const HEAD_D = 0.28;
  const LENS_R = 0.145;
  const LENS_Y = [0.36, 0, -0.36];
  const bothFaces = (geo) => [geo, geo.clone().rotateY(Math.PI)];
  const signalHousingGeo = mergeGeometries([
    new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D),
    new THREE.BoxGeometry(0.07, 0.2, 0.07).translate(0, HEAD_H / 2 + 0.1, 0),
    ...LENS_Y.flatMap((ly) => bothFaces(
      new THREE.CylinderGeometry(LENS_R + 0.03, LENS_R + 0.03, 0.24, 14, 1, true, Math.PI / 2, Math.PI)
        .rotateX(Math.PI / 2).translate(0, ly, HEAD_D / 2 + 0.12)
    ))
  ]);
  const signalLensGeo = mergeGeometries(LENS_Y.flatMap((ly) => bothFaces(new THREE.CircleGeometry(LENS_R, 18).translate(0, ly, HEAD_D / 2 + 0.004))));
  // Pedestrian signal: housing with the WALK / hand face lit on both sides (+-z, toward the crosswalk's far end)
  const walkHousingGeo = new THREE.BoxGeometry(0.34, 0.4, 0.24);
  const walkPanelGeo = mergeGeometries(bothFaces(new THREE.PlaneGeometry(0.27, 0.31).translate(0, 0, 0.125)));
  // Cobra-head luminaire on the end of the arm: flattened grey housing, flat lens underneath
  const lampHousingGeo = new THREE.SphereGeometry(1, 14, 4, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.7, 0.2, 0.3);
  const lampLensGeo = new THREE.CircleGeometry(1, 16).rotateX(Math.PI / 2).scale(0.6, 1, 0.24).translate(0, -0.005, 0);
  // Classic NYC cast-iron pedestrian post-top globe lightpole (fluted base + shaft + decorative capital + opal globe)
  const pedLampPostGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.11, 0.16, 0.85, 10).translate(0, 0.425, 0),
    new THREE.CylinderGeometry(0.065, 0.085, 2.75, 10).translate(0, 2.22, 0),
    new THREE.CylinderGeometry(0.14, 0.07, 0.16, 10).translate(0, 3.62, 0)
  ]);
  const pedGlobeGeo = new THREE.SphereGeometry(0.23, 8, 6).translate(0, 3.84, 0);

  // =========================================================================
  // 1. NYC CANTILEVERED TRAFFIC SIGNALS, STREET BLADES & WALK SIGNALS
  // =========================================================================
  const poleMatrices = [];
  const armMatrices = [];
  const yellowBoxMatrices = [];
  const aveLensMatrices = [];
  const streetLensMatrices = [];
  const streetBladeMatrices = [];
  const walkBoxMatrices = [];
  const audioSignals = [];
  const signalIntersections = [];
  const lampHeadMatrices = [];
  const pedPostMatrices = [];
  const cobraLampSites = [];
  const streetPointSites = [];
  // Only nearby poles can conflict, even with street furniture across the whole island.
  const POLE_CELL = 8;
  const poleCells = new Map();
  // Lamp: the pole being put up, so each piece of it is noted (own()) and it can be knocked over as one
  let pole = null;
  function addPole(x, z, width) {
    const key = Math.floor(x / POLE_CELL) + ',' + Math.floor(z / POLE_CELL);
    let cell = poleCells.get(key);
    if (!cell) poleCells.set(key, cell = []);
    cell.push(pole = { x, z, width, parts: [] });
    // Poles stand on curbs: pedestrians avoid them, but they must not narrow the inferred road gaps.
    addFootprint(x, z, width, width, true);
  }

  // A piece of the pole being put up: its matrix (dummy's) into `list`, noted on the pole
  const own = (list) => {
    pole?.parts.push(list, list.length);
    list.push(dummy.matrix.clone());
  };

  const plazaRects = pavedPlazaRects || [];
  const inPlaza = (x, z, m = 1.0) =>
    plazaRects.some((r) => x > r.minX - m && x < r.maxX + m && z > r.minZ - m && z < r.maxZ + m);

  // True only when (x, z) and its surrounding pad-meter footprint sit on a real curb island (never in a road or median)
  const isOnCurbIsland = (x, z, pad = 0.55) => {
    const b = blockAt(x, z);
    if (!b || b.median) return false;
    if (pad <= 0) return true;
    const b1 = blockAt(x - pad, z);
    const b2 = blockAt(x + pad, z);
    const b3 = blockAt(x, z - pad);
    const b4 = blockAt(x, z + pad);
    return !!(b1 && !b1.median && b2 && !b2.median && b3 && !b3.median && b4 && !b4.median);
  };

  // True only when (x, z) is on a non-park, non-median, non-plaza sidewalk with `pad` clearance from all curbs
  const isOnSidewalk = (x, z, pad = 0.55) => {
    if (!isOnCurbIsland(x, z, pad)) return false;
    const b = blockAt(x, z);
    return !(b.park > 0.6) && !inPlaza(x, z, 1.0);
  };

  const isClearOfPoles = (x, z, minDist = 6.0) => {
    const md2 = minDist * minDist;
    for (let ix = Math.floor((x - minDist) / POLE_CELL); ix <= Math.floor((x + minDist) / POLE_CELL); ix++) {
      for (let iz = Math.floor((z - minDist) / POLE_CELL); iz <= Math.floor((z + minDist) / POLE_CELL); iz++) {
        for (const p of poleCells.get(ix + ',' + iz) || []) {
          if ((p.x - x) ** 2 + (p.z - z) ** 2 < md2) return false;
        }
      }
    }
    return true;
  };

  // Use each avenue's local width and the street's real runs, including gaps at Central Park and road ends.
  for (const ave of ALL_AVENUES) {
    if (ave.isHighway) continue;
    for (const st of ALL_STREETS) {
      const avenueRun = ave.segs?.find((s) => st.z >= s.z0 && st.z <= s.z1);
      const streetRun = st.runs?.find((s) => ave.x >= s[0] && ave.x <= s[1]);
      if (!avenueRun || !streetRun) continue;
      // A median avenue spans both carriageways and the planted mall between them.
      const cornerOffsetX = (ave.hasMedian ? 33 : avenueRun.w) * 0.5 + 1.25;
      const cornerOffsetZ = streetRun[3] * 0.5 + 1.25;
      let placedSignal = false;

      // Place diagonal pair of traffic signal masts at NE and SW corners of every intersection
      const corners = [
        { sx: 1, sz: -1, armDir: -1 },
        { sx: -1, sz: 1, armDir: 1 }
      ];

      for (const c of corners) {
        let px = ave.x + c.sx * cornerOffsetX;
        let pz = st.z + c.sz * cornerOffsetZ;
        if (!isOnCurbIsland(px, pz, 0.55) || inPlaza(px, pz, 1.0)) {
          // Try nudging slightly deeper into the block corner if clipped near the curb
          const altX = ave.x + c.sx * (cornerOffsetX + 0.85);
          const altZ = st.z + c.sz * (cornerOffsetZ + 0.85);
          if (isOnCurbIsland(altX, altZ, 0.55) && !inPlaza(altX, altZ, 1.0)) {
            px = altX;
            pz = altZ;
          } else {
            continue;
          }
        }
        // Ensure the cantilevered mast arm actually overhangs the avenue roadway
        if (blockAt(px + c.armDir * 3.1, pz) || !isClearOfPoles(px, pz, 6.0)) continue;
        addPole(px, pz, 0.5);
        if (!placedSignal) {
          signalIntersections.push({ x: ave.x, z: st.z });
          placedSignal = true;
        }

        // Vertical pole (6.4m tall)
        dummy.position.set(px, 3.3, pz);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(0.14, 6.4, 0.14);
        dummy.updateMatrix();
        own(poleMatrices);

        // NYC DOT Green Street Name Sign Blade mounted on pole (y = 4.65m)
        dummy.position.set(px + c.armDir * 0.68, 4.65, pz);
        dummy.scale.set(1.38, 0.34, 0.08);
        dummy.updateMatrix();
        own(streetBladeMatrices);

        // Pedestrian "WALK / DON'T WALK" signal on the pole at crosswalk level (y = 3.15m), facing across the street
        dummy.position.set(px + c.armDir * 0.24, 3.15, pz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        own(walkBoxMatrices);
        // These panels share the avenue WALK phase; rejected/unplaced poles never become sound sources.
        audioSignals.push({ x: dummy.position.x, y: dummy.position.y, z: dummy.position.z, isAvenue: true });

        // Cantilever horizontal mast arm reaching 6.5m over the avenue
        const armX = px + c.armDir * 3.25;
        dummy.position.set(armX, 6.1, pz);
        dummy.scale.set(6.5, 0.11, 0.11);
        dummy.updateMatrix();
        own(armMatrices);

        // Intersection corner cobra-head luminaire overhanging the crosswalk & corner sidewalk
        const cornerLampX = px + c.armDir * 1.85;
        dummy.position.set(cornerLampX, 6.22, pz);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        own(lampHeadMatrices);
        cobraLampSites.push({
          x: cornerLampX,
          y: 6.18,
          z: pz,
          tx: px + c.armDir * 2.8,
          tz: pz - c.sz * 1.4
        });

        // Two NYC yellow signal heads hanging from the mast arm: the avenue's (3.1 m out, facing up & down the avenue)
        // and the cross street's (5.5 m out, turned to face along the street)
        for (const armDist of [3.1, 5.5]) {
          dummy.position.set(px + c.armDir * armDist, 5.42, pz);
          dummy.rotation.set(0, armDist < 4.0 ? 0 : Math.PI / 2, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          own(yellowBoxMatrices);
          own(armDist < 4.0 ? aveLensMatrices : streetLensMatrices);
        }
        dummy.rotation.set(0, 0, 0);
      }
    }
  }

  // =========================================================================
  // 2. MID-BLOCK AVENUE & STREET ORNAMENTAL ACORN & COBRA STREETLIGHTS
  //    Placed directly along the true curb edges of every city block (BLOCKS)
  //    and verified with blockAt(x, z) so no pole ever stands in any roadway.
  // =========================================================================
  const allBlocks = BLOCKS || [];

  // Lamp: Ann Arbor's own streetlights, where the city's map has them (GEO.streetlights from build-annarbor.py): a
  // cobra head on a pole with its arm out over the street, or a post-top lantern on campus, in lots and on paths,
  // each with a warm pool of light under it after dusk. The made-up ones along every block stand in without the map.
  const realLights = GEO.streetlights || [];
  const lightPools = [];
  for (let i = 0; i < realLights.length; i += 4) {
    const lx = realLights[i], lz = realLights[i + 1], post = realLights[i + 2] === 1;
    const a = realLights[i + 3] * Math.PI / 180, outX = Math.cos(a), outZ = Math.sin(a);
    if (!isClearOfPoles(lx, lz, 1.2)) continue;
    addPole(lx, lz, 0.4);
    if (post) {
      dummy.position.set(lx, 0.18, lz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      own(pedPostMatrices);
      streetPointSites.push({ x: lx, y: 4.02, z: lz, color: 0xffe0aa, intensity: 28, dist: 14.0 });
      lightPools.push(lx, lz, 9);
      continue;
    }
    const armYaw = Math.atan2(-outZ, outX);
    const headX = lx + outX * 2.6, headZ = lz + outZ * 2.6;
    dummy.position.set(lx, 4.3, lz);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(0.12, 8.4, 0.12);
    dummy.updateMatrix();
    own(poleMatrices);
    dummy.position.set(lx + outX * 1.15, 8.2, lz + outZ * 1.15);
    dummy.rotation.set(0, armYaw, 0);
    dummy.scale.set(2.3, 0.09, 0.09);
    dummy.updateMatrix();
    own(armMatrices);
    dummy.position.set(headX, 8.08, headZ);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    own(lampHeadMatrices);
    dummy.rotation.set(0, 0, 0);
    cobraLampSites.push({ x: headX, y: 8.02, z: headZ, tx: lx + outX * 3.4, tz: lz + outZ * 3.4 });
    lightPools.push(headX + outX * 0.8, headZ + outZ * 0.8, 17);
  }
  let poolMesh = null;
  if (lightPools.length) {
    const n = lightPools.length / 3;
    const pools = poolMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createParkLampPoolMaterial(), n);
    const pm = new THREE.Matrix4();
    for (let k = 0; k < n; k++) {
      const w = lightPools[k * 3 + 2];
      pools.setMatrixAt(k, pm.makeScale(w, 1, w).setPosition(lightPools[k * 3], 0.26, lightPools[k * 3 + 1]));
    }
    pools.instanceMatrix.needsUpdate = true;
    pools.computeBoundingSphere();
    pools.name = 'StreetlightPools';
    pools.renderOrder = 2;
    group.add(pools);
  }

  for (const b of (realLights.length ? [] : allBlocks)) {
    if (!b || !b.poly || b.poly.length < 3 || b.median || b.park > 0.6) continue;

    const poly = b.poly;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 24) continue;

      const ux = dx / len;
      const uz = dz / len;
      const mx = (p0.x + p1.x) * 0.5;
      const mz = (p0.z + p1.z) * 0.5;

      // Determine inward normal (into the sidewalk block) and outward normal (into the street roadway)
      let inx = -uz;
      let inz = ux;
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) {
        inx = uz;
        inz = -ux;
      }
      if (blockAt(mx + inx * 1.6, mz + inz * 1.6) !== b) continue;
      const outX = -inx;
      const outZ = -inz;
      // Confirm this curb edge fronts an open roadway
      if (blockAt(mx + outX * 2.5, mz + outZ * 2.5)) continue;

      const isAvenueEdge = Math.abs(uz) > 0.65;
      if (isAvenueEdge) {
        const armYaw = Math.atan2(-outZ, outX);
        const cobraFracs = inx > 0 ? [0.26, 0.72] : [0.32, 0.78];
        for (const f of cobraFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const lx = cx + inx * 1.08;
          const lz = cz + inz * 1.08;
          const headX = lx + outX * 2.6;
          const headZ = lz + outZ * 2.6;
          if (
            !isOnSidewalk(lx, lz, 0.55) ||
            blockAt(cx + outX * 2.5, cz + outZ * 2.5) ||
            blockAt(headX, headZ) ||
            !isClearOfPoles(lx, lz, 6.5)
          ) {
            continue;
          }
          addPole(lx, lz, 0.45);

          // Tall ornamental streetlight pole
          dummy.position.set(lx, 4.3, lz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(0.12, 8.4, 0.12);
          dummy.updateMatrix();
          own(poleMatrices);

          // Upper luminaire bracket arm overhanging the street
          dummy.position.set(lx + outX * 1.15, 8.2, lz + outZ * 1.15);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(2.3, 0.09, 0.09);
          dummy.updateMatrix();
          own(armMatrices);

          // NYC DOT cobra-head LED luminaire on the end of the arm, lens facing the street
          dummy.position.set(headX, 8.08, headZ);
          dummy.rotation.set(0, armYaw, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          own(lampHeadMatrices);
          dummy.rotation.set(0, 0, 0);

          cobraLampSites.push({
            x: headX,
            y: 8.02,
            z: headZ,
            tx: lx + outX * 3.4,
            tz: lz + outZ * 3.4
          });
        }

        // Historic NYC cast-iron pedestrian post-top globe lightpoles along avenue sidewalks (with PointLights)
        const pedFracs = len >= 48 ? [0.16, 0.50, 0.84] : [0.24, 0.76];
        for (const f of pedFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.42;
          const pz = cz + inz * 1.42;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.2)
          ) {
            continue;
          }
          addPole(px, pz, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          own(pedPostMatrices);
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 30,
            dist: 14.5
          });
        }
      } else if (len >= 36) {
        // Cross-street cast-iron pedestrian post-top globe lightpoles along north and south block curbs
        const crossFracs = len >= 115 ? [0.20, 0.40, 0.60, 0.80] : [0.24, 0.50, 0.76];
        for (const f of crossFracs) {
          const cx = p0.x + dx * f;
          const cz = p0.z + dz * f;
          const px = cx + inx * 1.22;
          const pz = cz + inz * 1.22;
          if (
            !isOnSidewalk(px, pz, 0.55) ||
            blockAt(cx + outX * 2.2, cz + outZ * 2.2) ||
            !isClearOfPoles(px, pz, 5.5)
          ) {
            continue;
          }
          addPole(px, pz, 0.4);

          dummy.position.set(px, 0.18, pz);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(1, 1, 1);
          dummy.updateMatrix();
          own(pedPostMatrices);
          streetPointSites.push({
            x: px,
            y: 4.02,
            z: pz,
            color: 0xffe0aa,
            intensity: 28,
            dist: 14.0
          });
        }
      }
    }
  }

  const meshesOf = new Map(); // matrix list -> the instanced meshes drawn from it
  function addMatrixArrayInstanced(geo, mat, matrices, castShadow = true) {
    if (matrices.length === 0) return;
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    if (!meshesOf.has(matrices)) meshesOf.set(matrices, []);
    meshesOf.get(matrices).push(inst);
    if (castShadow && !mat.isMeshBasicNodeMaterial && mat.type !== 'MeshBasicNodeMaterial' && !mat.transparent) {
      inst.castShadow = true;
      inst.receiveShadow = true;
    }
    for (let i = 0; i < matrices.length; i++) {
      inst.setMatrixAt(i, matrices[i]);
    }
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    return inst;
  }

  addMatrixArrayInstanced(unitCyl, poleMetalMat, poleMatrices);
  addMatrixArrayInstanced(unitBox, poleMetalMat, armMatrices, false);
  addMatrixArrayInstanced(signalHousingGeo, signalHousingMat, yellowBoxMatrices, false);
  addMatrixArrayInstanced(signalLensGeo, aveSignalLensMat, aveLensMatrices, false);
  addMatrixArrayInstanced(signalLensGeo, streetSignalLensMat, streetLensMatrices, false);
  addMatrixArrayInstanced(unitBox, streetBladeMat, streetBladeMatrices, false);
  addMatrixArrayInstanced(walkHousingGeo, signalHousingMat, walkBoxMatrices, false);
  addMatrixArrayInstanced(walkPanelGeo, walkSignalGlow, walkBoxMatrices, false);
  addMatrixArrayInstanced(lampHousingGeo, poleMetalMat, lampHeadMatrices, false);
  addMatrixArrayInstanced(lampLensGeo, lampBulbGlow, lampHeadMatrices, false);
  const pedPosts = addMatrixArrayInstanced(pedLampPostGeo, poleMetalMat, pedPostMatrices);
  // ~28k posts: they cast as 4-sided base + shaft (16 triangles instead of 120; scene-culling.js shadow stand-ins)
  if (pedPosts) {
    pedPosts.userData.shadowStandIn = mergeGeometries([
      new THREE.CylinderGeometry(0.12, 0.18, 0.85, 4, 1, true).translate(0, 0.425, 0),
      new THREE.CylinderGeometry(0.072, 0.094, 2.85, 4, 1, true).translate(0, 2.275, 0)
    ]);
  }
  addMatrixArrayInstanced(pedGlobeGeo, pedGlobeGlow, pedPostMatrices, false);

  // =========================================================================
  // 2B. VOLUMETRIC GOLDEN-HOUR CANYON SUN SHAFTS (GOD RAYS)
  // =========================================================================
  const godRayMat = createGodRayMaterial();
  const godRayGeo = new THREE.PlaneGeometry(54, 92);
  const canyonShafts = [
    { x: 0,    y: 42, z: 180,  rotY: 0.32,  rotZ: -0.46 }, // 34th St & 5th Ave (Empire State Canyon)
    { x: 0,    y: 44, z: 0,    rotY: 0.28,  rotZ: -0.44 }, // 42nd St & 5th Ave (NYPL / Bryant Park)
    { x: 165,  y: 46, z: 0,    rotY: 0.25,  rotZ: -0.45 }, // 42nd St & Park/Lexington (Grand Central & Chrysler)
    { x: -110, y: 42, z: -90,  rotY: 0.30,  rotZ: -0.44 }, // 47th St & 6th Ave (Rockefeller Center)
    { x: -215, y: 40, z: -45,  rotY: 0.35,  rotZ: -0.42 }, // Times Square / Broadway Canyon
    { x: -55,  y: 48, z: -360, rotY: 0.28,  rotZ: -0.46 }  // 59th St / Central Park South Canyon
  ];
  for (const cs of canyonShafts) {
    const shaft = new THREE.Mesh(godRayGeo, godRayMat);
    shaft.name = 'CanyonSunShaft';
    const at = fromOldFrame(cs.x, cs.z); // (authored on the former compressed grid)
    shaft.position.set(at.x, cs.y, at.z);
    shaft.rotation.set(0.12, cs.rotY, cs.rotZ);
    group.add(shaft);
  }

  // =========================================================================
  // 3. STEAM STACKS & BARRICADES (New York's; none in Ann Arbor, see steamLocations)
  // =========================================================================
  // Ann Arbor has no Con Edison steam: no striped stacks or steam clouds in the streets
  const steamLocations = [];
  // (authored on the former compressed grid: carried onto the real streets; the Financial District one by One WTC)
  for (const st of steamLocations) {
    const wtc = LANDMARK_SITES['One World Trade Center'];
    const at = st.z > 1000 && wtc ? { x: wtc.x + 48, z: wtc.z - 40 } : fromOldFrame(st.x, st.z);
    st.x = at.x;
    st.z = at.z;
  }

  const steamOrangeMat = new THREE.MeshStandardNodeMaterial({
    color: 0xff5518, // High-visibility ConEd safety orange
    roughness: 0.42
  });
  const steamWhiteMat = new THREE.MeshStandardNodeMaterial({
    color: 0xf4f6f8,
    roughness: 0.45
  });
  const steamMat = createSteamMaterial();
  const puffsPerStack = 36;
  const totalSteamSprites = steamLocations.length * puffsPerStack;
  const smokeOriginArr = new Float32Array(totalSteamSprites * 3);
  const smokeWindArr = new Float32Array(totalSteamSprites * 3);
  const smokeParamsArr = new Float32Array(totalSteamSprites * 4);
  let spriteCursor = 0;

  const orangeMatrices = [];
  const whiteMatrices = [];
  const barricadeOrangeMatrices = [];
  const barricadeWhiteMatrices = [];

  for (let sIdx = 0; sIdx < steamLocations.length; sIdx++) {
    const { x: sx, z: sz, windX, windZ } = steamLocations[sIdx];
    addFootprint(sx, sz, 2, 2); // stack + sawhorse barricades

    // 5-Band Alternating Orange & White Candy-Cane ConEd Steam Stack (height = 2.85m)
    for (let b = 0; b < 5; b++) {
      const bandH = 0.56;
      const by = 0.28 + b * bandH;
      const rScale = 0.36 - b * 0.025;
      dummy.position.set(sx, by, sz);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(rScale, bandH, rScale);
      dummy.updateMatrix();
      if (b % 2 === 0) {
        orangeMatrices.push(dummy.matrix.clone());
      } else {
        whiteMatrices.push(dummy.matrix.clone());
      }
    }

    // 4-Sided NYCDOT Orange-and-White Striped Wooden Sawhorse Barricades around base of stack
    const bHalf = 0.92;
    const sides = [
      { ox: 0, oz: bHalf, rotY: 0 },
      { ox: 0, oz: -bHalf, rotY: 0 },
      { ox: bHalf, oz: 0, rotY: Math.PI * 0.5 },
      { ox: -bHalf, oz: 0, rotY: Math.PI * 0.5 }
    ];
    for (const side of sides) {
      // Barricade vertical legs
      for (const legOff of [-0.72, 0.72]) {
        const lx = sx + side.ox + (side.rotY === 0 ? legOff : 0);
        const lz = sz + side.oz + (side.rotY !== 0 ? legOff : 0);
        dummy.position.set(lx, 0.48, lz);
        dummy.rotation.set(0, side.rotY, 0);
        dummy.scale.set(0.08, 0.96, 0.08);
        dummy.updateMatrix();
        barricadeWhiteMatrices.push(dummy.matrix.clone());
      }
      // Top & middle striped horizontal rails
      for (const railY of [0.82, 0.46]) {
        for (let seg = -2; seg <= 2; seg++) {
          const segOff = seg * 0.34;
          const rx = sx + side.ox + (side.rotY === 0 ? segOff : 0);
          const rz = sz + side.oz + (side.rotY !== 0 ? segOff : 0);
          dummy.position.set(rx, railY, rz);
          dummy.rotation.set(0, side.rotY, 0);
          dummy.scale.set(0.34, 0.16, 0.06);
          dummy.updateMatrix();
          if (Math.abs(seg) % 2 === 0) {
            barricadeOrangeMatrices.push(dummy.matrix.clone());
          } else {
            barricadeWhiteMatrices.push(dummy.matrix.clone());
          }
        }
      }
    }

    // 36 Camera-Facing Volumetric Smoke Sprites per ConEd Steam Stack (SpriteNodeMaterial)
    for (let p = 0; p < puffsPerStack; p++) {
      const idx3 = spriteCursor * 3;
      const idx4 = spriteCursor * 4;
      const phaseOffset = (p + ((sIdx * 0.37) % 1.0)) / puffsPerStack;
      const spinDir = p % 2 === 0 ? 1.0 : -1.0;
      const spinSpeed = spinDir * (0.28 + ((p * 0.19 + sIdx * 0.13) % 0.45));
      const curlSeed = (p * 1.73 + sIdx * 2.41) % (Math.PI * 2);
      const scaleMul = 0.86 + ((p * 0.31 + sIdx * 0.17) % 0.36);

      smokeOriginArr[idx3] = sx;
      smokeOriginArr[idx3 + 1] = 2.75;
      smokeOriginArr[idx3 + 2] = sz;

      smokeWindArr[idx3] = windX;
      smokeWindArr[idx3 + 1] = 7.4;
      smokeWindArr[idx3 + 2] = windZ;

      smokeParamsArr[idx4] = phaseOffset;
      smokeParamsArr[idx4 + 1] = spinSpeed;
      smokeParamsArr[idx4 + 2] = curlSeed;
      smokeParamsArr[idx4 + 3] = scaleMul;
      spriteCursor++;
    }
  }

  addMatrixArrayInstanced(unitCyl, steamOrangeMat, orangeMatrices);
  addMatrixArrayInstanced(unitCyl, steamWhiteMat, whiteMatrices);
  addMatrixArrayInstanced(unitBox, steamOrangeMat, barricadeOrangeMatrices);
  addMatrixArrayInstanced(unitBox, steamWhiteMat, barricadeWhiteMatrices);

  const steamSpriteGeo = new THREE.PlaneGeometry(1, 1);
  steamSpriteGeo.setAttribute('aSmokeOrigin', new THREE.InstancedBufferAttribute(smokeOriginArr, 3));
  steamSpriteGeo.setAttribute('aSmokeWind', new THREE.InstancedBufferAttribute(smokeWindArr, 3));
  steamSpriteGeo.setAttribute('aSmokeParams', new THREE.InstancedBufferAttribute(smokeParamsArr, 4));
  const steamInstancedSprites = new THREE.Mesh(steamSpriteGeo, steamMat);
  steamInstancedSprites.count = totalSteamSprites;
  steamInstancedSprites.frustumCulled = false;
  steamInstancedSprites.renderOrder = 2;
  if (totalSteamSprites > 0) group.add(steamInstancedSprites);

  // =========================================================================
  // 5. STREET FOOD CARTS (none in Ann Arbor)
  // =========================================================================
  // Keep the whole prop on the sidewalk, outside building lots.
  const findPropSite = (x, z, width, depth) => {
    const hw = width * 0.5 + 0.15;
    const hd = depth * 0.5 + 0.15;
    const fits = (px, pz) => {
      const block = blockAt(px, pz);
      if (!block || block.median) return false;
      for (const dx of [-hw, 0, hw]) {
        for (const dz of [-hd, 0, hd]) {
          if (blockAt(px + dx, pz + dz) !== block) return false;
        }
      }
      return !block.rects.some(([x0, x1, z0, z1]) =>
        px + hw > x0 && px - hw < x1 && pz + hd > z0 && pz - hd < z1);
    };
    if (fits(x, z)) return { x, z };
    for (let r = 2; r <= 40; r += 2) {
      for (let k = 0; k < 16; k++) {
        const angle = k / 16 * Math.PI * 2;
        const px = x + Math.cos(angle) * r;
        const pz = z + Math.sin(angle) * r;
        if (fits(px, pz)) return { x: px, z: pz };
      }
    }
    return null;
  };

  // (New York's hot dog and halal carts: none in Ann Arbor)
  const cartLocations = [];

  const cartMatrices = [];
  for (const [ox, oz] of cartLocations) {
    const raw = fromOldFrame(ox, oz);
    const site = findPropSite(raw.x, raw.z, 3.5, 3.5);
    if (!site) continue;
    const { x, z } = site;
    cartMatrices.push(new THREE.Matrix4().makeTranslation(x, 0, z));
    addFootprint(x, z, 1.5, 2.2);
    streetPointSites.push({ x, y: 2.15, z, color: 0xffdf9e, intensity: 28, dist: 9.5 });
  }
  for (const part of createFoodCartParts()) {
    addMatrixArrayInstanced(part.geometry, part.material, cartMatrices, part.castShadow);
  }

  // =========================================================================
  // 6. FIRE HYDRANTS, PARK BENCHES, TABLES, SHELTERS & COURTS (the city's own maps; build-street-furniture.py)
  // =========================================================================
  const FURN_LAWN = 0.22; // between the sidewalk's top and the park lawn's: what stands on either sits on both
  // one solid of several colored parts (y from its foot, +x along it), merged into one geometry for one instanced draw
  const furnPart = (geo, hex, x = 0, y = 0, z = 0, ry = 0, rz = 0) => {
    if (rz) geo.rotateZ(rz);
    if (ry) geo.rotateY(ry);
    geo.translate(x, y, z);
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  };
  const fBox = (w, h, d, hex, x, y, z, ry) => furnPart(new THREE.BoxGeometry(w, h, d), hex, x, y + h / 2, z, ry);
  const fCyl = (r0, r1, h, hex, x, y, z, seg = 10) => furnPart(new THREE.CylinderGeometry(r0, r1, h, seg), hex, x, y + h / 2, z);
  const fNozzle = (r, len, hex, x, y, z, ry) => furnPart(new THREE.CylinderGeometry(r, r, len, 8), hex, x, y, z, ry, Math.PI / 2);
  const furnMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.1 });

  const RED = 0xb3261e, SILVER = 0xc9ccd0, WOOD = 0x8a5a36, IRON = 0x2b2e32, GREEN = 0x2f4a38, STONE = 0x8d9095;
  const FURN_SHAPES = {
    hydrant: mergeGeometries([
      fCyl(0.17, 0.19, 0.08, RED, 0, 0, 0), fCyl(0.12, 0.13, 0.56, RED, 0, 0.08, 0), fCyl(0.16, 0.16, 0.05, RED, 0, 0.62, 0),
      fCyl(0.06, 0.13, 0.1, SILVER, 0, 0.67, 0), fCyl(0.03, 0.03, 0.05, SILVER, 0, 0.77, 0, 5),
      fNozzle(0.045, 0.34, SILVER, 0, 0.45, 0, 0), fNozzle(0.07, 0.2, SILVER, 0, 0.42, 0.1, Math.PI / 2)
    ]),
    bench: mergeGeometries([
      fBox(1.8, 0.05, 0.42, WOOD, 0, 0.42, 0), fBox(1.8, 0.32, 0.04, WOOD, 0, 0.55, -0.22),
      fBox(0.06, 0.45, 0.46, IRON, -0.78, 0, -0.02), fBox(0.06, 0.45, 0.46, IRON, 0.78, 0, -0.02),
      fBox(0.06, 0.5, 0.04, IRON, -0.78, 0.42, -0.24), fBox(0.06, 0.5, 0.04, IRON, 0.78, 0.42, -0.24)
    ]),
    trash: mergeGeometries([fCyl(0.28, 0.26, 0.88, GREEN, 0, 0, 0, 12), fCyl(0.3, 0.3, 0.06, IRON, 0, 0.88, 0, 12)]),
    table: mergeGeometries([
      fBox(1.8, 0.05, 0.76, WOOD, 0, 0.72, 0), fBox(1.8, 0.04, 0.26, WOOD, 0, 0.42, 0.62), fBox(1.8, 0.04, 0.26, WOOD, 0, 0.42, -0.62),
      fBox(0.08, 0.72, 0.08, IRON, -0.7, 0, 0), fBox(0.08, 0.72, 0.08, IRON, 0.7, 0, 0),
      fBox(0.08, 0.06, 1.5, IRON, -0.7, 0.36, 0), fBox(0.08, 0.06, 1.5, IRON, 0.7, 0.36, 0)
    ]),
    grill: mergeGeometries([fBox(0.09, 0.82, 0.09, IRON, 0, 0, 0), fBox(0.6, 0.24, 0.42, 0x1d1e20, 0, 0.82, 0), fBox(0.64, 0.03, 0.46, 0x4a4c50, 0, 1.06, 0)]),
    fountain: mergeGeometries([fCyl(0.17, 0.22, 0.82, STONE, 0, 0, 0, 10), fCyl(0.3, 0.2, 0.14, SILVER, 0, 0.82, 0, 12)]),
    rack: mergeGeometries([-0.6, 0, 0.6].flatMap((x) => [
      fBox(0.05, 0.8, 0.05, SILVER, x, 0, -0.3), fBox(0.05, 0.8, 0.05, SILVER, x, 0, 0.3), fBox(0.05, 0.05, 0.65, SILVER, x, 0.78, 0)
    ])),
    shelter: mergeGeometries([
      ...[[-3, -2.4], [3, -2.4], [-3, 2.4], [3, 2.4]].map(([x, z]) => fBox(0.18, 2.6, 0.18, 0x6b4a32, x, 0, z)),
      fBox(7.4, 0.22, 6.0, 0x6b4a32, 0, 2.6, 0),
      furnPart(new THREE.ConeGeometry(Math.SQRT1_2, 1, 4).rotateY(Math.PI / 4).scale(7.8, 1.3, 6.4), 0x4f3a30, 0, 3.47, 0),
      fBox(1.8, 0.05, 0.76, WOOD, 0, 0.72, 0), fBox(1.8, 0.04, 0.26, WOOD, 0, 0.42, 0.62), fBox(1.8, 0.04, 0.26, WOOD, 0, 0.42, -0.62),
      fBox(0.08, 0.72, 0.08, IRON, -0.7, 0, 0), fBox(0.08, 0.72, 0.08, IRON, 0.7, 0, 0)
    ])
  };
  // kinds as build-street-furniture.py numbers them, with their footprints (w along x, d along z)
  const FURN_KINDS = [['bench', 1.9, 0.6], ['trash', 0.6, 0.6], ['table', 1.9, 1.6], ['grill', 0.7, 0.5],
    ['fountain', 0.6, 0.6], ['rack', 1.4, 0.8], ['shelter', 7.6, 6.2]];
  const furnMatrices = Object.fromEntries(Object.keys(FURN_SHAPES).map((k) => [k, []]));
  const putFurniture = (kind, x, z, yaw, w, d) => {
    dummy.position.set(x, FURN_LAWN, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    furnMatrices[kind].push(dummy.matrix.clone());
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    addFootprint(x, z, w * c + d * s, w * s + d * c, true);
  };

  // Hydrants: each where the city mapped it, moved out of the street onto the curb's edge when the map's point is a
  // little off it, and turned with its pumper nozzle toward the nearest street
  const HY = streetFurniture?.hydrants || [];
  const hydrantSites = []; // where each stands, in the order of its instance
  const curbSearch = [];
  for (let r = 0.75; r <= 8; r += 0.75) for (let k = 0; k < 12; k++) curbSearch.push([r, (k / 12) * Math.PI * 2]);
  const towardStreet = (x, z) => {
    for (const [r, a] of curbSearch) if (r >= 1.5 && !isOnCurbIsland(x + Math.cos(a) * r, z + Math.sin(a) * r, 0)) return a;
    return 0;
  };
  for (let i = 0; i < HY.length; i += 2) {
    let x = HY[i], z = HY[i + 1];
    if (!isOnCurbIsland(x, z, 0.35)) {
      const hit = curbSearch.find(([r, a]) => isOnCurbIsland(x + Math.cos(a) * r, z + Math.sin(a) * r, 0.35));
      if (!hit) continue;
      x += Math.cos(hit[1]) * hit[0];
      z += Math.sin(hit[1]) * hit[0];
    }
    // the pumper nozzle points along local +z: turn it to face the street
    const a = towardStreet(x, z);
    dummy.position.set(x, 0.2, z);
    dummy.rotation.set(0, Math.PI / 2 - a, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    furnMatrices.hydrant.push(dummy.matrix.clone());
    hydrantSites.push({ x, z });
    addFootprint(x, z, 0.4, 0.4, true);
  }

  // Park amenities: benches, trash cans, picnic tables, grills, drinking fountains, bike racks and picnic shelters
  const AM = streetFurniture?.amenities || [];
  for (let i = 0; i < AM.length; i += 4) {
    const x = AM[i], z = AM[i + 1], kind = FURN_KINDS[AM[i + 2]];
    if (!kind || !blockAt(x, z)) continue; // a point in a street is a slip of the map
    putFurniture(kind[0], x, z, AM[i + 3], kind[1], kind[2]);
  }
  // only the shelters cast shadows: a bench's or a hydrant's is too small to be worth its draws in every cascade
  let hydrantMesh = null;
  for (const k of Object.keys(FURN_SHAPES)) {
    const inst = addMatrixArrayInstanced(FURN_SHAPES[k], furnMat, furnMatrices[k], k === 'shelter');
    if (k === 'hydrant') hydrantMesh = inst;
    if (inst) {
      inst.userData.cullDistance = k === 'shelter' ? 500 : 280;
      if (k !== 'shelter') inst.receiveShadow = true;
    }
  }

  // Courts and fields: tennis, basketball, pickleball and volleyball courts and soccer fields, each painted on its
  // own surface (OpenStreetMap's pitches), with nets, hoops and goals; laid on the ground's slope as one mesh
  const CT = streetFurniture?.courts || [];
  if (CT.length) {
    const pos = [], col = [];
    let cx = 0, cz = 0, ux = 1, uz = 0;
    const tmpC = new THREE.Color();
    // a flat quad in the court's own frame: a along its length, b across, at height y
    const quad = (a0, a1, b0, b1, y, hex) => {
      tmpC.set(hex);
      const P = (a, b) => [cx + ux * a - uz * b, y, cz + uz * a + ux * b];
      const p = [P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1)];
      for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...p[k]); col.push(tmpC.r, tmpC.g, tmpC.b); }
    };
    const LW = 0.09, LY = FURN_LAWN + 0.045;
    const line = (a0, b0, a1, b1, hex = 0xf2f2ee) => {
      // a thin quad from one point to the other
      const da = a1 - a0, db = b1 - b0, len = Math.hypot(da, db) || 1;
      const na = (-db / len) * LW / 2, nb = (da / len) * LW / 2;
      tmpC.set(hex);
      const P = (a, b) => [cx + ux * a - uz * b, LY, cz + uz * a + ux * b];
      const p = [P(a0 - na, b0 - nb), P(a1 - na, b1 - nb), P(a1 + na, b1 + nb), P(a0 + na, b0 + nb)];
      for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...p[k]); col.push(tmpC.r, tmpC.g, tmpC.b); }
    };
    const rect = (a0, a1, b0, b1, hex) => { line(a0, b0, a1, b0, hex); line(a1, b0, a1, b1, hex); line(a1, b1, a0, b1, hex); line(a0, b1, a0, b0, hex); };
    const arc = (a, b, r, t0, t1, hex, seg = 16) => {
      for (let k = 0; k < seg; k++) {
        const s0 = t0 + (t1 - t0) * k / seg, s1 = t0 + (t1 - t0) * (k + 1) / seg;
        line(a + Math.cos(s0) * r, b + Math.sin(s0) * r, a + Math.cos(s1) * r, b + Math.sin(s1) * r, hex);
      }
    };
    // an upright box (net, post, backboard) in the court's frame
    const solid = (a, b, h0, la, lb, h, hex) => {
      tmpC.set(hex);
      const P = (da, db, y) => [cx + ux * (a + da) - uz * (b + db), y, cz + uz * (a + da) + ux * (b + db)];
      const A2 = la / 2, B2 = lb / 2, y0 = FURN_LAWN + h0, y1 = y0 + h;
      const v = [P(-A2, -B2, y0), P(A2, -B2, y0), P(A2, B2, y0), P(-A2, B2, y0), P(-A2, -B2, y1), P(A2, -B2, y1), P(A2, B2, y1), P(-A2, B2, y1)];
      for (const f of [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]]) {
        for (const k of [0, 2, 1, 0, 3, 2]) { pos.push(...v[f[k]]); col.push(tmpC.r, tmpC.g, tmpC.b); }
      }
    };
    const net = (half, h = 0.95) => { solid(0, 0, 0, 0.03, half * 2, h, 0x1c1d1f); solid(0, -half, 0, 0.08, 0.08, h + 0.12, 0x3a3d42); solid(0, half, 0, 0.08, 0.08, h + 0.12, 0x3a3d42); };
    for (let i = 0; i < CT.length; i += 6) {
      const sport = CT[i];
      cx = CT[i + 1]; cz = CT[i + 2]; ux = Math.cos(CT[i + 3]); uz = Math.sin(CT[i + 3]);
      const L = CT[i + 4], W = CT[i + 5], hl = L / 2, hw = W / 2;
      if (sport === 0) { // tennis: green apron, blue court
        const s = Math.min(1, (L - 2) / 23.77, (W - 1) / 10.97), a = 11.885 * s, b = 5.485 * s, bs = 4.115 * s, sv = 6.4 * s;
        quad(-hl, hl, -hw, hw, FURN_LAWN + 0.02, 0x3f6e4c);
        quad(-a - 0.6, a + 0.6, -b - 0.6, b + 0.6, FURN_LAWN + 0.03, 0x2f5c86);
        rect(-a, a, -b, b); line(-a, -bs, a, -bs); line(-a, bs, a, bs);
        line(-sv, -bs, -sv, bs); line(sv, -bs, sv, bs); line(-sv, 0, sv, 0);
        line(-a, 0, -a + 0.3, 0); line(a, 0, a - 0.3, 0);
        net(b + 0.9);
      } else if (sport === 1) { // basketball: blacktop, white lines, a hoop at each end (one on a half court)
        const full = L >= 20, s = Math.min(1, (L - 1) / (full ? 28 : 14), (W - 1) / 15);
        const a = (full ? 14 : 7) * s, b = 7.5 * s, kw = 2.45 * s, kl = 5.8 * s, tp = 6.75 * s;
        quad(-hl, hl, -hw, hw, FURN_LAWN + 0.02, 0x4b4d52);
        rect(-a, a, -b, b);
        const ends = full ? [-1, 1] : [1];
        if (full) { line(0, -b, 0, b); arc(0, 0, 1.8 * s, 0, Math.PI * 2, 0xf2f2ee, 20); }
        for (const e of ends) {
          const base = e * a, k = base - e * kl;
          rect(Math.min(base, k), Math.max(base, k), -kw, kw);
          arc(k, 0, 1.8 * s, e > 0 ? Math.PI / 2 : -Math.PI / 2, e > 0 ? Math.PI * 1.5 : Math.PI / 2, 0xf2f2ee, 10);
          const rim = base - e * 1.6 * s;
          arc(rim, 0, tp, e > 0 ? Math.PI / 2 + 0.25 : -Math.PI / 2 + 0.25, e > 0 ? Math.PI * 1.5 - 0.25 : Math.PI / 2 - 0.25, 0xf2f2ee, 18);
          solid(base + e * 0.4, 0, 0, 0.14, 0.14, 3.2, 0x3a3d42); // post
          solid(base - e * 0.9, 0, 2.9, 0.06, 1.8, 1.05, 0xe9e9e6); // backboard
          solid(base - e * 1.15, 0, 3.05, 0.5, 0.5, 0.03, 0xe06a22); // rim
          solid(base - e * 0.15, 0, 3.05, 1.1, 0.12, 0.08, 0x3a3d42); // arm
        }
      } else if (sport === 2) { // pickleball
        const s = Math.min(1, (L - 1) / 13.41, (W - 1) / 6.1), a = 6.705 * s, b = 3.05 * s, kz = 2.13 * s;
        quad(-hl, hl, -hw, hw, FURN_LAWN + 0.02, 0x3d6b52);
        quad(-a - 0.4, a + 0.4, -b - 0.4, b + 0.4, FURN_LAWN + 0.03, 0x2e5f8c);
        rect(-a, a, -b, b); line(-kz, -b, -kz, b); line(kz, -b, kz, b);
        line(-a, 0, -kz, 0); line(kz, 0, a, 0);
        net(b + 0.3, 0.88);
      } else if (sport === 3) { // sand volleyball
        const s = Math.min(1, (L - 1) / 16, (W - 1) / 8), a = 8 * s, b = 4 * s;
        quad(-hl, hl, -hw, hw, FURN_LAWN + 0.02, 0xd8c28e);
        rect(-a, a, -b, b, 0x2f6fb0);
        solid(0, 0, 1.4, 0.03, b * 2 + 0.6, 1.0, 0x1c1d1f);
        solid(0, -b - 0.5, 0, 0.1, 0.1, 2.5, 0x8d9095); solid(0, b + 0.5, 0, 0.1, 0.1, 2.5, 0x8d9095);
      } else if (sport === 4 && L > 30) { // soccer: the field's lines on its grass, a goal at each end
        const a = hl - 1.5, b = hw - 1.5, pd = Math.min(16.5, L * 0.15), pw = Math.min(20.15, b * 0.6), gw = Math.min(3.66, b * 0.18);
        quad(-hl, hl, -hw, hw, FURN_LAWN + 0.015, 0x5a8a40);
        rect(-a, a, -b, b); line(0, -b, 0, b); arc(0, 0, Math.min(9.15, b * 0.27), 0, Math.PI * 2, 0xf2f2ee, 24);
        for (const e of [-1, 1]) {
          const g = e * a, p = g - e * pd;
          rect(Math.min(g, p), Math.max(g, p), -pw, pw);
          solid(g + e * 0.6, -gw, 0, 0.1, 0.1, 2.44 * Math.min(1, b / 30), 0xf4f4f2);
          solid(g + e * 0.6, gw, 0, 0.1, 0.1, 2.44 * Math.min(1, b / 30), 0xf4f4f2);
          solid(g + e * 0.6, 0, 2.44 * Math.min(1, b / 30), 0.1, gw * 2 + 0.1, 0.1, 0xf4f4f2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    g.computeVertexNormals();
    const courtMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85 });
    courtMat.polygonOffset = true;
    courtMat.polygonOffsetFactor = -2;
    courtMat.polygonOffsetUnits = -4;
    const courts = new THREE.Mesh(g, courtMat);
    courts.name = 'ParkCourts';
    courts.receiveShadow = true;
    group.add(courts);
  }

  // USPS blue mailboxes along the curbs
  const mailboxPositions = [];
  for (const ave of AVENUES) {
    for (let row = 0; row < STREETS.length - 1; row++) {
      const zMid = (STREETS[row].z + STREETS[row + 1].z) * 0.5;
      const mb = [ave.x + ave.width * 0.5 + 1.2, zMid - 22];
      if (isOnSidewalk(mb[0], mb[1], 0.45)) mailboxPositions.push(mb);
    }
  }

  const uspsMat = new THREE.MeshStandardNodeMaterial({ color: 0x183c7a, roughness: 0.45, metalness: 0.35 });
  const mailboxInst = new THREE.InstancedMesh(new THREE.BoxGeometry(0.65, 1.25, 0.65), uspsMat, mailboxPositions.length);
  mailboxPositions.forEach(([mx, mz], i) => {
    dummy.position.set(mx, 0.84, mz);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    mailboxInst.setMatrixAt(i, dummy.matrix);
  });
  mailboxInst.instanceMatrix.needsUpdate = true;
  group.add(mailboxInst);

  // =========================================================================
  // 7. LUSH TREES: PARKS & PLAZAS, CENTRAL PARK WOODLANDS, AVENUE & CROSS-STREET TREES
  //    London planes, honey locusts & American elms (one unified trunk + crown instanced mesh per species & band)
  // =========================================================================
  const treePositions = []; // { x, y, z, scale, species (0 plane, 1 honey locust, 2 elm / oak) }
  const CP_LAWN_Y = 1.19;
  const mixSpecies = (r, plane, locust) => (r < plane ? 0 : (r < plane + locust ? 1 : 2));


  // A. Bryant Park: double allées of London planes on the raised terraces along the Great Lawn's north & south sides
  //    and its west end, framing the lawn the library's terrace looks out over (the lawn as fitted by landmarks.js)
  const bpl = bryantParkLawn;
  if (bpl) {
    const ty = bpl.top - 0.2; // Lamp: the lawn's top is in world space already (it stands on the ground), so these sites are `world`
    for (let tx = bpl.minX - 6; tx <= bpl.maxX + 6; tx += 6.5) {
      for (const tz of [bpl.minZ - 5, bpl.minZ - 11.5, bpl.maxZ + 5, bpl.maxZ + 11.5]) {
        treePositions.push({ x: tx, y: ty, z: tz, scale: 0.8, species: 0, world: true });
      }
    }
    for (let tz = bpl.minZ; tz <= bpl.maxZ; tz += 6.5) {
      treePositions.push({ x: bpl.minX - 6, y: ty, z: tz, scale: 0.82, species: 0, world: true });
      treePositions.push({ x: bpl.minX - 12.5, y: ty, z: tz, scale: 0.76, species: 0, world: true });
    }
  }

  // B. Central Park (59th to 110th St, 5th Ave to Central Park West; city-config.js BIG_PARK_BOUNDS), on the lawn
  const cp = CPB;
  // B1. Central Park South (59th St) dense woodland border
  for (let tx = cp.minX + 8; tx <= cp.maxX - 8; tx += 9.5) {
    treePositions.push({ x: tx, y: CP_LAWN_Y, z: cp.maxZ - 5, scale: 0.95, species: 0 });
    treePositions.push({ x: tx + 3.5, y: CP_LAWN_Y, z: cp.maxZ - 16, scale: 1.0, species: mixSpecies(hashPos(tx, 1, 2), 0.5, 0.1) });
    if (hashPos(tx, 7, 3) > 0.35) {
      treePositions.push({ x: tx - 2.5, y: CP_LAWN_Y, z: cp.maxZ - 31, scale: 1.05, species: mixSpecies(hashPos(tx, 3, 4), 0.4, 0.15) });
    }
  }

  // B2. 5th Avenue & Central Park West perimeter rows inside the park wall
  for (let tz = cp.maxZ - 10; tz >= cp.minZ + 10; tz -= 14) {
    treePositions.push({ x: cp.maxX - 5, y: CP_LAWN_Y, z: tz, scale: 0.92, species: mixSpecies(hashPos(tz, 1, 1), 0.55, 0.1) });
    treePositions.push({ x: cp.maxX - 15, y: CP_LAWN_Y, z: tz - 6, scale: 0.98, species: mixSpecies(hashPos(tz, 2, 1), 0.3, 0.1) });
    treePositions.push({ x: cp.minX + 5, y: CP_LAWN_Y, z: tz, scale: 0.92, species: mixSpecies(hashPos(tz, 3, 1), 0.55, 0.1) });
    treePositions.push({ x: cp.minX + 15, y: CP_LAWN_Y, z: tz - 6, scale: 0.98, species: mixSpecies(hashPos(tz, 4, 1), 0.3, 0.1) });
  }

  // B3. The Mall & Literary Walk quadruple row of towering American Elms (66th to 72nd St)
  const cpClear = bigParkClearings;
  const mall = cpClear && cpClear.mall;
  if (mall) {
    for (let tz = mall.z0 + 4; tz <= mall.z1 - 4; tz += 9.5) {
      for (const [dx, sc] of [[-16, 1.08], [-9, 1.0], [9, 1.0], [16, 1.08]]) treePositions.push({ x: mall.x + dx, y: CP_LAWN_Y, z: tz, scale: sc, species: 2 });
    }
  }

  // B4. Woodlands: a jittered grid over the park kept clear of the meadows, water, drives, transverses, rock outcrops
  //     & terraces (laid out by city-grid.js), densest in the Ramble (between the Lake & the 79th St transverse) & the
  //     North Woods (north of 102nd St), with glades
  if (cpClear) {
    const withBox = (pts) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      return { pts, x0: x0 - 4, x1: x1 + 4, z0: z0 - 4, z1: z1 + 4 };
    };
    const polys = cpClear.polygons.map(withBox);
    const drives = cpClear.drives.map((wp) => {
      const b = withBox(wp.map(([x, z]) => ({ x, z })));
      return { wp, x0: b.x0 - 4, x1: b.x1 + 4, z0: b.z0 - 4, z1: b.z1 + 4 };
    });
    const inPoly = (x, z, pts) => {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i];
        const b = pts[j];
        if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
      }
      return inside;
    };
    const segDist = (px, pz, [ax, az], [bx, bz]) => {
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
      return Math.hypot(px - ax - dx * t, pz - az - dz * t);
    };
    const blocked = (x, z) => {
      for (const P of polys) {
        if (x < P.x0 || x > P.x1 || z < P.z0 || z > P.z1) continue;
        for (const [ox, oz] of [[0, 0], [3.5, 0], [-3.5, 0], [0, 3.5], [0, -3.5]]) if (inPoly(x + ox, z + oz, P.pts)) return true;
      }
      for (const D of drives) {
        if (x < D.x0 || x > D.x1 || z < D.z0 || z > D.z1) continue;
        for (let i = 0; i < D.wp.length - 1; i++) if (segDist(x, z, D.wp[i], D.wp[i + 1]) < 7.5) return true;
      }
      for (const r of cpClear.rects) if (x > r.minX - 2.5 && x < r.maxX + 2.5 && z > r.minZ - 2.5 && z < r.maxZ + 2.5) return true;
      for (const c of cpClear.circles) if (Math.hypot(x - c.x, z - c.z) < c.r) return true;
      return false;
    };
    const SP = 13;
    const z79 = streetZ(79);
    const z102 = streetZ(102);
    for (let gz = cp.maxZ - 24; gz >= cp.minZ + 12; gz -= SP) {
      for (let gx = cp.minX + 22; gx <= cp.maxX - 22; gx += SP) {
        const tx = gx + (hashPos(gx, 2.1, gz) - 0.5) * SP * 0.95;
        const tz = gz + (hashPos(gz, 5.7, gx) - 0.5) * SP * 0.95;
        const woods = (tz > z79 && tz < z79 + 300 && tx > cp.minX + 120 && tx < cp.minX + 480) || (tz < z102 && tx < cp.minX + 520);
        const glade = Math.sin(tx * 0.019 + 1.3) * Math.sin(tz * 0.016 + 0.4) > 0.6;
        const grove = Math.sin(tx * 0.009 + tz * 0.004) + Math.sin(tz * 0.011 - tx * 0.006 + 2.0); // dense groves vs open scatter
        const skip = grove > 0.6 ? 0.05 : (grove < -0.8 ? 0.55 : 0.2);
        if (!woods && (glade || hashPos(tx, 9.1, tz) < skip)) continue;
        if (blocked(tx, tz)) continue;
        const r = hashPos(tz, 6.6, tx);
        const scale = r < 0.18 ? 0.55 + r * 0.8 : 0.72 + Math.pow(r, 0.8) * 0.72; // some young understory trees
        treePositions.push({ x: tx, y: CP_LAWN_Y, z: tz, scale, species: mixSpecies(hashPos(tx, 4.4, tz), 0.4, 0.15) });
      }
    }
  }

  // B5. The squares, the other parks & the plazas (sites laid out by city-grid.js)
  for (const s of parkTreeSites || []) treePositions.push(s);

  // Surveyed street trees; parks keep their authored terrain, clearings and tree layouts.
  let sidewalkTreePositions = placeStreetTrees(REAL_TREES, treePositions,
    (x, z) => !inPlaza(x, z, 1.5) && isClearOfPoles(x, z, 2.2), REAL_TREE_KINDS, REAL_TREE_HEIGHTS);
  for (const tree of sidewalkTreePositions) treePositions.push(tree);
  const treeField = createTreeField(scene, treePositions, colliders,
    { stream: TIER.stream, at: TIER.stream ? groundStreamCenter() : null });
  group.add(treeField.group);
  sidewalkTreePositions = sidewalkTreePositions.filter((t) => treeField.sites.has(t));
  console.info(`[streetDetails] ${treeField.stats.trees} trees (${sidewalkTreePositions.length} street trees)`);

  const grateMat = createTreeGrateMaterial();
  const pitCurbMat = new THREE.MeshStandardNodeMaterial({ color: 0x484642, roughness: 0.88 });
  const pitSoilMat = new THREE.MeshStandardNodeMaterial({ color: 0x241c14, roughness: 0.96 });

  // Curbside tree pit surrounds & dark soil beds, with concentric cast-iron grates on the Midtown avenues
  // (pits run along the curb: t.pitRot = PI/2 on cross streets)
  const pitCurbGeo = new THREE.BoxGeometry(1.7, 0.22, 2.6);
  const pitSoilGeo = new THREE.BoxGeometry(1.35, 0.23, 2.25);
  const pitGrateGeo = new THREE.RingGeometry(0.24, 0.82, 12, 1).rotateX(-Math.PI / 2);
  const pittedTrees = sidewalkTreePositions.filter((t) => !t.noPit); // Lamp: tree-lawn trees stand in grass
  const gratedTrees = pittedTrees.filter((t) => t.grate !== false);

  const pitCurbInst = new THREE.InstancedMesh(pitCurbGeo, pitCurbMat, Math.max(1, pittedTrees.length));
  const pitSoilInst = new THREE.InstancedMesh(pitSoilGeo, pitSoilMat, Math.max(1, pittedTrees.length));
  pitCurbInst.count = pitSoilInst.count = pittedTrees.length;
  const pitGrateInst = new THREE.InstancedMesh(pitGrateGeo, grateMat, Math.max(1, gratedTrees.length));
  pitCurbInst.receiveShadow = true;
  pitSoilInst.receiveShadow = true;
  pitGrateInst.receiveShadow = true;
  pitGrateInst.count = gratedTrees.length;

  pittedTrees.forEach((t, i) => {
    dummy.rotation.set(0, t.pitRot || 0, 0);
    dummy.scale.set(t.pitS || 1, 1, 1);
    dummy.position.set(t.x, 0.19, t.z);
    dummy.updateMatrix();
    pitCurbInst.setMatrixAt(i, dummy.matrix);

    dummy.position.set(t.x, 0.20, t.z);
    dummy.updateMatrix();
    pitSoilInst.setMatrixAt(i, dummy.matrix);
  });
  gratedTrees.forEach((t, i) => {
    dummy.rotation.set(0, 0, 0);
    dummy.position.set(t.x, 0.225, t.z);
    dummy.updateMatrix();
    pitGrateInst.setMatrixAt(i, dummy.matrix);
  });
  pitCurbInst.instanceMatrix.needsUpdate = true;
  pitSoilInst.instanceMatrix.needsUpdate = true;
  pitGrateInst.instanceMatrix.needsUpdate = true;
  // Their footprint would keep these 20 cm boxes drawn at any distance (scene-culling.js): culled with the cross-street
  // trees over them instead (trees.js MAX_DIST)
  for (const pit of [pitCurbInst, pitSoilInst, pitGrateInst]) {
    pit.computeBoundingSphere();
    pit.userData.cullDistance = 950;
  }
  group.add(pitCurbInst, pitSoilInst, pitGrateInst);

  function hashPos(x, y, z) {
    const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }

  // =========================================================================
  // 8. CLUSTERED STREETLIGHTS & STREET FURNITURE LIGHT POOLS
  // =========================================================================
  const parkLights = [];
  for (const s of parkLampSites || []) {
    parkLights.push(streetPointSites.length);
    streetPointSites.push({ x: s.x, y: s.y, z: s.z, color: 0xffe4b4, intensity: 32, dist: 14.0 });
  }

  const STREETLIGHT_SPOT_POOL = 36;
  const STREET_POINT_POOL = 48;
  const STREETLIGHT_DIST = 115;
  const STREET_POINT_DIST = 110;

  const streetLightsGroup = new THREE.Group();
  streetLightsGroup.name = 'StreetClusteredLights';
  scene.add(streetLightsGroup);

  const streetlightSpotPool = [];
  for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
    // Cobra-head LED luminaire: wide downward spread (0.96 rad half-angle) illuminating both road and sidewalk
    const spot = new THREE.SpotLight(0xffe8c2, 0, 25, 0.96, 0.82, 1.25);
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    streetLightsGroup.add(spot, spot.target);
    streetlightSpotPool.push(spot);
  }

  const streetPointPool = [];
  for (let i = 0; i < STREET_POINT_POOL; i++) {
    const pt = new THREE.PointLight(0xffe4b4, 0, 12, 1.35);
    pt.position.set(0, -1000, 0);
    streetLightsGroup.add(pt);
    streetPointPool.push(pt);
  }

  // Source positions are static. Query nearby cells instead of scanning the island every frame.
  const LIGHT_CELL = 128;
  function indexLights(sites) {
    const cells = new Map();
    for (const s of sites) {
      const key = Math.floor(s.x / LIGHT_CELL) + ',' + Math.floor(s.z / LIGHT_CELL);
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = []);
      cell.push(s);
    }
    return cells;
  }
  const cobraCells = indexLights(cobraLampSites);
  const pointCells = indexLights(streetPointSites);

  function nearbyLights(cells, camera, range, active) {
    const { x: cx, z: cz } = camera.position;
    const cy = camera.position.y - groundHeight(cx, cz); // Lamp: above the ground
    const me = camera.matrixWorld.elements;
    const fwdX = -me[8], fwdZ = -me[10];
    let count = 0;
    for (let ix = Math.floor((cx - range) / LIGHT_CELL); ix <= Math.floor((cx + range) / LIGHT_CELL); ix++) {
      for (let iz = Math.floor((cz - range) / LIGHT_CELL); iz <= Math.floor((cz + range) / LIGHT_CELL); iz++) {
        for (const s of cells.get(ix + ',' + iz) || []) {
          if (s.out) continue; // its pole was knocked over
          const dx = s.x - cx, dz = s.z - cz;
          const d2 = dx * dx + dz * dz + cy * cy;
          if (d2 > range * range) continue;
          const effDist = Math.sqrt(d2) + Math.max(0, 6.0 - dx * fwdX - dz * fwdZ) * 2.8;
          if (effDist >= range) continue;
          s._effDist = effDist;
          active[count++] = s;
        }
      }
    }
    active.length = count;
    if (count > 1) active.sort((a, b) => a._effDist - b._effDist);
    return count;
  }

  const activeCobras = [];
  const activePoints = [];

  function smoothFade(d, start, end) {
    const t = Math.min(1, Math.max(0, (end - d) / (end - start)));
    return t * t * (3 - 2 * t);
  }

  function update(camera) {
    if (!camera) return;
    treeField.update(camera.position);
    const glow = cityUniforms.uInteriorGlow.value;
    // Increase streetlight intensity toward dusk.
    const lampScale = Math.min(1.25, Math.max(0.0, (glow - 0.36) * 1.15));
    if (lampScale <= 0.001) {
      for (let i = 0; i < STREETLIGHT_SPOT_POOL; i++) {
        streetlightSpotPool[i].intensity = 0;
        streetlightSpotPool[i].position.set(0, -1000, 0);
      }
      for (let i = 0; i < STREET_POINT_POOL; i++) {
        streetPointPool[i].intensity = 0;
        streetPointPool[i].position.set(0, -1000, 0);
      }
      return;
    }

    const cobraCount = nearbyLights(cobraCells, camera, STREETLIGHT_DIST, activeCobras);

    const cobraCutoff = cobraCount > STREETLIGHT_SPOT_POOL
      ? Math.min(STREETLIGHT_DIST, activeCobras[STREETLIGHT_SPOT_POOL]._effDist)
      : STREETLIGHT_DIST;
    const spotUsed = Math.min(cobraCount, STREETLIGHT_SPOT_POOL);
    for (let i = 0; i < spotUsed; i++) {
      const s = activeCobras[i];
      const fade = smoothFade(s._effDist, cobraCutoff * 0.62, cobraCutoff);
      const spot = streetlightSpotPool[i];
      s.g ??= groundHeight(s.x, s.z); // Lamp: the lamp's sites are heights above the ground
      spot.position.set(s.x, s.g + s.y, s.z);
      spot.target.position.set(s.tx, s.g, s.tz);
      spot.target.updateMatrixWorld();
      spot.intensity = 88.0 * lampScale * fade;
    }
    for (let i = spotUsed; i < STREETLIGHT_SPOT_POOL; i++) {
      streetlightSpotPool[i].intensity = 0;
      streetlightSpotPool[i].position.set(0, -1000, 0);
    }

    const ptCount = nearbyLights(pointCells, camera, STREET_POINT_DIST, activePoints);

    const ptCutoff = ptCount > STREET_POINT_POOL
      ? Math.min(STREET_POINT_DIST, activePoints[STREET_POINT_POOL]._effDist)
      : STREET_POINT_DIST;
    const ptUsed = Math.min(ptCount, STREET_POINT_POOL);
    for (let i = 0; i < ptUsed; i++) {
      const s = activePoints[i];
      const fade = smoothFade(s._effDist, ptCutoff * 0.62, ptCutoff);
      const pt = streetPointPool[i];
      pt.color.setHex(s.color);
      s.g ??= groundHeight(s.x, s.z);
      pt.position.set(s.x, s.g + s.y, s.z);
      pt.distance = s.dist;
      pt.intensity = s.intensity * lampScale * fade;
    }
    for (let i = ptUsed; i < STREET_POINT_POOL; i++) {
      streetPointPool[i].intensity = 0;
      streetPointPool[i].position.set(0, -1000, 0);
    }
  }

  scene.add(group);
  // Tree trunks and lamp posts, solid to the player: { x, z, r }
  const obstacles = [];
  // Lamp: each can be knocked over by a hard enough hit (knockdowns.js): a tree by its trunk and height, a pole with
  // every piece of it (its instances in each mesh drawn from the lists own() noted)
  // (streamed, the field hands its planted trunks to main.js as they come and go)
  if (!TIER.stream) for (const o of treeField.obstacles()) obstacles.push(o);
  // A streetlight knocked over goes dark: its lamp (the head out on its arm, or the globe on top) and the pool under it
  const pm0 = new THREE.Matrix4().makeScale(0, 0, 0);
  function lightsOut(p) {
    for (const [cells, reach] of [[cobraCells, 3.2], [pointCells, 0.6]]) {
      const cx = Math.floor(p.x / LIGHT_CELL), cz = Math.floor(p.z / LIGHT_CELL);
      for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iz = cz - 1; iz <= cz + 1; iz++) {
        for (const s of cells.get(ix + ',' + iz) || []) if (Math.hypot(s.x - p.x, s.z - p.z) < reach) s.out = true;
      }
    }
    for (let k = 0; poolMesh && k < lightPools.length; k += 3) {
      if (Math.hypot(lightPools[k] - p.x, lightPools[k + 1] - p.z) > 4.5) continue;
      let mesh = poolMesh, i = k / 3;
      while (mesh.userData.movedTo?.[i]) [mesh, i] = mesh.userData.movedTo[i];
      mesh.setMatrixAt(i, pm0);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
  // the lampposts with glass globes in the parks and plazas (city-grid.js) go over too, globe, pool and light with them
  if (parkLampMeshes) {
    const [poleInst, globeInst, poolInst] = parkLampMeshes;
    (parkLampSites || []).forEach((s, i) => {
      obstacles.push({ x: s.x, z: s.z, r: 0.17, kind: 'lamp', height: 4.4, parts: [poleInst, i, globeInst, i], out: () => {
        streetPointSites[parkLights[i]].out = true;
        let mesh = poolInst, j = i;
        while (mesh.userData.movedTo?.[j]) [mesh, j] = mesh.userData.movedTo[j];
        mesh.setMatrixAt(j, pm0);
        mesh.instanceMatrix.needsUpdate = true;
      } });
    });
  }
  for (const cell of poleCells.values()) for (const p of cell) {
    const parts = [];
    for (let k = 0; k < p.parts.length; k += 2) for (const mesh of meshesOf.get(p.parts[k]) || []) parts.push(mesh, p.parts[k + 1]);
    obstacles.push({ x: p.x, z: p.z, r: Math.min(0.2, p.width * 0.4), kind: p.width >= 0.5 ? 'signal' : 'lamp', height: 8, parts, out: () => lightsOut(p) });
  }
  // hydrants break off their flange at a bump and fly, and the water main under them gushes (knockdowns.js)
  if (hydrantMesh) hydrantSites.forEach((h, i) => obstacles.push({ x: h.x, z: h.z, r: 0.2, kind: 'hydrant', height: 0.8, parts: [hydrantMesh, i] }));
  return { group, footprints, signalClock, signalIntersections, audioSignals, treeField, obstacles, update };
}

export { buildStreetDetails, createTrafficSignalLensMaterial };
