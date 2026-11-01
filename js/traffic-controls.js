import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundHeight } from './terrain.js';
import { color, mix, uniform } from 'three/tsl';
import { signalPhase } from './city-config.js';

// Lamp: Ann Arbor's traffic lights and stop & yield signs, where the road network put them (road-network.js, from
// OpenStreetMap): at a signalised intersection, a mast arm on the far right corner of every approach with a head over
// each of its lanes, lit by the same clock traffic obeys (the lens material picks red / amber / green by height above
// the ground: 5.78 / 5.42 / 5.06 m); at a sign, a post at the right curb by the stop line, facing the drivers coming
// up to it, with an ALL WAY plaque under the stop signs of an all-way stop.

const HEAD_Y = 5.42;
const ARM_Y = 6.05;

function signTexture(draw) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  draw(ctx);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const octagon = (ctx, r) => {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = Math.PI / 8 + (k * Math.PI) / 4;
    ctx.lineTo(128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
  }
  ctx.closePath();
};
const triangle = (ctx, r) => {
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = Math.PI / 2 + (k * Math.PI * 2) / 3;
    ctx.lineTo(128 + Math.cos(a) * r, 150 + Math.sin(a) * r);
  }
  ctx.closePath();
};

function stopFace(ctx) {
  octagon(ctx, 126);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  octagon(ctx, 116);
  ctx.fillStyle = '#b8141c';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 76px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('STOP', 128, 132);
}
function yieldFace(ctx) {
  triangle(ctx, 140);
  ctx.fillStyle = '#c3161e';
  ctx.fill();
  triangle(ctx, 88);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.fillStyle = '#c3161e';
  ctx.font = '800 30px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('YIELD', 128, 112);
}
function plaqueFace(ctx) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 64, 256, 128);
  ctx.fillStyle = '#b8141c';
  ctx.fillRect(8, 72, 240, 112);
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 64px Inter, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ALL WAY', 128, 130);
}
const silhouette = (shape) => (ctx) => {
  shape(ctx);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
};

// The lamps of a head, top to bottom, each lit through its part of the cycle traffic obeys (city-config.js's
// signalPhase, for the main road (axisIndex 0) or the cross street), switched by update() every frame
const LAMPS = ['red', 'amber', 'green'];
const LAMP_COLORS = { red: 0xff2a1e, amber: 0xffa20e, green: 0x1cff7a };
function lampMaterial(lamp) {
  const lit = color(LAMP_COLORS[lamp]);
  const on = uniform(0);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = mix(lit.mul(0.08), lit.mul(2.2), on); // a dark, tinted lens when off; bright enough to bloom when on
  mat.userData.on = on;
  return mat;
}

function buildTrafficControls(group, network) {
  group.name = 'TrafficControls';
  const dummy = new THREE.Object3D();
  const lists = new Map(); // name -> matrices
  const put = (name) => {
    dummy.updateMatrix();
    if (!lists.has(name)) lists.set(name, []);
    lists.get(name).push(dummy.matrix.clone());
  };
  const onRoad = (x, z) => network.isRoadClear && network.isRoadClear(x, z, 0.2);
  const at = (e, s, o) => [e.sx + e.dx * s + e.rx * o, e.sz + e.dz * s + e.rz * o];
  // out from the road along e's right until clear of it (null if it never is)
  const curbside = (e, s, o) => {
    for (let k = 0; k < 10; k++, o += 0.6) {
      const [x, z] = at(e, s, o);
      if (!onRoad(x, z)) return [x, z, o];
    }
    return null;
  };

  let lights = 0;
  let signs = 0;
  const obstacles = []; // signal poles and sign posts, solid to the player: { x, z, r }
  const faceYaw = (e) => Math.atan2(-e.dx, -e.dz); // a face turned towards the drivers coming along e
  for (const e of network.edges) {
    const n = e.to;
    if (n.shape || !e.lanes.length) continue;
    if (n.signal) {
      // the far side: across the intersection from the stop line
      const k = (n.x - (e.sx + e.dx * e.len)) * e.dx + (n.z - (e.sz + e.dz * e.len)) * e.dz;
      const s = e.len + Math.max(4, 2 * k + 1.5);
      const spot = curbside(e, s, e.half + 0.9);
      if (!spot) continue;
      const [px, pz, po] = spot;
      const g = groundHeight(px, pz);
      dummy.rotation.set(0, Math.atan2(e.dx, e.dz), 0);
      dummy.position.set(px, g + ARM_Y / 2 + 0.1, pz);
      dummy.scale.set(0.15, ARM_Y + 0.3, 0.15);
      put('pole');
      obstacles.push({ x: px, z: pz, r: 0.16 });
      // the arm out over the lanes coming up to it
      const reach = Math.min(13, Math.max(3, po - Math.min(...e.lanes) + 1.2));
      const [ax, az] = at(e, s, po - reach / 2);
      dummy.position.set(ax, g + ARM_Y, az);
      dummy.scale.set(0.12, 0.12, reach);
      dummy.rotation.set(0, Math.atan2(e.rx, e.rz), 0);
      put('arm');
      const lanes = e.lanes.slice().sort((a, b) => a - b).slice(-4);
      for (const o of lanes) {
        if (po - o > reach) continue;
        const [hx, hz] = at(e, s, o);
        dummy.rotation.set(0, Math.atan2(e.dx, e.dz), 0);
        dummy.position.set(hx, groundHeight(hx, hz) + HEAD_Y, hz);
        dummy.scale.set(1, 1, 1);
        put('head');
        for (const lamp of LAMPS) put(lamp + (e.axisIndex === 0 ? 'A' : 'B'));
        lights++;
      }
    } else if (e.control) {
      const spot = curbside(e, e.len - 0.4, e.half + 0.7);
      if (!spot) continue;
      const [px, pz] = spot;
      const g = groundHeight(px, pz);
      dummy.rotation.set(0, faceYaw(e), 0);
      dummy.position.set(px, g + 1.15, pz);
      dummy.scale.set(0.05, 2.3, 0.05);
      put('post');
      obstacles.push({ x: px, z: pz, r: 0.1 });
      dummy.position.set(px, g + 2.1, pz);
      dummy.scale.set(0.76, 0.76, 1);
      const yieldSign = e.control === 'yield';
      put(yieldSign ? 'yield' : 'stop');
      put(yieldSign ? 'yieldBack' : 'stopBack');
      if (!yieldSign && n.allStop) {
        dummy.position.set(px, g + 1.6, pz);
        dummy.scale.set(0.46, 0.46, 1);
        put('plaque');
        put('plaqueBack');
      }
      signs++;
    }
  }

  // Meshes
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x8c9196, roughness: 0.5, metalness: 0.7 });
  const housing = new THREE.MeshStandardNodeMaterial({ color: 0x26292c, roughness: 0.45, metalness: 0.2, side: THREE.DoubleSide });
  const W = 0.4, H = 1.12, D = 0.28, R = 0.145, LY = [0.36, 0, -0.36];
  const headGeo = mergeGeometries([
    new THREE.BoxGeometry(W, H, D),
    new THREE.BoxGeometry(0.07, ARM_Y - HEAD_Y - H / 2, 0.07).translate(0, (ARM_Y - HEAD_Y + H / 2) / 2, 0),
    new THREE.BoxGeometry(W + 0.24, H + 0.2, 0.02).translate(0, 0, -D / 2 - 0.01), // backplate
    ...LY.map((ly) => new THREE.CylinderGeometry(R + 0.03, R + 0.03, 0.24, 14, 1, true, Math.PI / 2, Math.PI)
      .rotateX(Math.PI / 2).translate(0, ly, D / 2 + 0.12))
  ]);
  // one lamp each: red on top, amber, green at the bottom, facing the drivers coming up to the head
  const lampGeo = LY.map((ly) => new THREE.CircleGeometry(R, 20).translate(0, ly, D / 2 + 0.004));
  const plane = new THREE.PlaneGeometry(1, 1);
  const back = plane.clone().rotateY(Math.PI).translate(0, 0, -0.01);
  const face = (draw) => new THREE.MeshStandardNodeMaterial({ map: signTexture(draw), alphaTest: 0.5, roughness: 0.5 });
  const backOf = (shape) => new THREE.MeshStandardNodeMaterial({
    color: 0x9a9ea2, alphaMap: signTexture(silhouette(shape)), alphaTest: 0.5, roughness: 0.6, metalness: 0.5
  });
  const plaqueShape = (ctx) => { ctx.beginPath(); ctx.rect(0, 64, 256, 128); };
  const kinds = {
    pole: [new THREE.CylinderGeometry(1, 1, 1, 10), metal, true],
    arm: [new THREE.CylinderGeometry(1, 1, 1, 8).rotateX(Math.PI / 2), metal, true],
    head: [headGeo, housing, true],
    ...Object.fromEntries(LAMPS.flatMap((lamp, i) => [
      [lamp + 'A', [lampGeo[i], lampMaterial(lamp), false]],
      [lamp + 'B', [lampGeo[i], lampMaterial(lamp), false]]
    ])),
    post: [new THREE.CylinderGeometry(1, 1, 1, 6), metal, true],
    stop: [plane, face(stopFace), true],
    stopBack: [back, backOf((ctx) => octagon(ctx, 126)), false],
    yield: [plane, face(yieldFace), true],
    yieldBack: [back, backOf((ctx) => triangle(ctx, 140)), false],
    plaque: [plane, face(plaqueFace), false],
    plaqueBack: [back, backOf(plaqueShape), false]
  };
  for (const [name, matrices] of lists) {
    const [geo, mat, shadow] = kinds[name];
    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    matrices.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    inst.castShadow = shadow;
    inst.name = 'TrafficControls_' + name;
    group.add(inst);
  }
  group.userData.terrain = 'set'; // each was stood on the ground as it was placed
  console.info(`[traffic controls] ${lights} signal heads, ${signs} stop & yield signs`);
  const lamps = LAMPS.flatMap((lamp) => [[lamp, true, kinds[lamp + 'A'][1]], [lamp, false, kinds[lamp + 'B'][1]]]);
  const update = (time) => {
    for (const [lamp, mainRoad, mat] of lamps) mat.userData.on.value = signalPhase(time, mainRoad) === lamp ? 1 : 0;
  };
  return { lights, signs, update, obstacles };
}

export { buildTrafficControls };
