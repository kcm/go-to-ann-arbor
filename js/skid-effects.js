import * as THREE from 'three/webgpu';
import { random } from '../lamp-game.js';
import { uv, smoothstep, attribute } from 'three/tsl';

// Rubber and smoke from the player's car when its back tires slide (the handbrake, or the tail stepping out): a dark
// streak laid behind each back wheel, fading the longer it's been on the road, and white tire smoke boiling up from
// the wheels, swelling and drifting as it thins. `car.skid` (controllers.js) says how hard they slide, 0 to 1.

const MAX_MARKS = 1600, MAX_SMOKE = 320;
const MARK_WIDTH = 0.26, MARK_FADE = 40; // m, seconds a streak takes to fade from the road
const SEGMENT = 0.35; // m between the points of a streak

function createSkidEffects(scene) {
  for (const old of scene.children.filter((c) => c.name === 'SkidEffects')) scene.remove(old);
  const group = new THREE.Group();
  group.name = 'SkidEffects';
  scene.add(group);

  // streaks: flat quads from one point to the next, their darkness in a per-instance attribute
  const markGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const dark = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKS), 1);
  dark.setUsage(THREE.DynamicDrawUsage);
  markGeo.setAttribute('dark', dark);
  const markMat = new THREE.MeshStandardNodeMaterial({ color: 0x0b0b0c, roughness: 0.9, metalness: 0, transparent: true,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  {
    // soft along the edges, a little patchy along its length
    const across = smoothstep(0.5, 0.25, uv().x.sub(0.5).abs());
    markMat.opacityNode = across.mul(attribute('dark', 'float'));
  }
  const marks = new THREE.InstancedMesh(markGeo, markMat, MAX_MARKS);
  marks.frustumCulled = false;
  marks.count = 0;
  marks.renderOrder = 1;
  const markAge = new Float32Array(MAX_MARKS), markStrength = new Float32Array(MAX_MARKS);
  let markCursor = 0, markCount = 0;

  // smoke: soft round puffs turned to the camera
  const smokeGeo = new THREE.PlaneGeometry(1, 1);
  const fade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SMOKE), 1);
  fade.setUsage(THREE.DynamicDrawUsage);
  smokeGeo.setAttribute('fade', fade);
  const smokeMat = new THREE.MeshStandardNodeMaterial({ color: 0xe4e4e2, roughness: 1, metalness: 0, transparent: true,
    depthWrite: false });
  {
    const d = uv().sub(0.5).length().mul(2);
    smokeMat.opacityNode = smoothstep(1, 0, d).pow(1.6).mul(attribute('fade', 'float')).mul(0.42);
    smokeMat.emissive = new THREE.Color(0x101010);
  }
  const smoke = new THREE.InstancedMesh(smokeGeo, smokeMat, MAX_SMOKE);
  smoke.frustumCulled = false;
  smoke.count = 0;
  smoke.renderOrder = 4;
  group.add(marks, smoke);
  const S = Array.from({ length: MAX_SMOKE }, () => ({ life: 0, age: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0 }));
  let smokeCursor = 0, smokeCarry = 0;

  // where each back wheel's streak last left off
  const wheelsLast = [{ on: false, x: 0, y: 0, z: 0 }, { on: false, x: 0, y: 0, z: 0 }];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), wp = new THREE.Vector3();
  let liveMarks = false;

  function lay(a, x, y, z, strength) {
    const dx = x - a.x, dz = z - a.z, len = Math.hypot(dx, dz);
    if (len < SEGMENT) return;
    const i = markCursor; markCursor = (markCursor + 1) % MAX_MARKS; markCount = Math.min(MAX_MARKS, markCount + 1);
    q.setFromAxisAngle(up, Math.atan2(dx, dz));
    p.set((x + a.x) / 2, (y + a.y) / 2, (z + a.z) / 2);
    sc.set(MARK_WIDTH, 1, len + 0.04);
    marks.setMatrixAt(i, m.compose(p, q, sc));
    markAge[i] = 0; markStrength[i] = 0.35 + 0.45 * strength * (0.8 + random() * 0.2);
    a.x = x; a.y = y; a.z = z;
    marks.instanceMatrix.needsUpdate = true;
  }

  function update(dt, car, driving, camera) {
    dt = Math.min(dt, 0.05);
    const skid = driving && car ? car.skid || 0 : 0;
    const rear = car?.wheels?.filter((w) => !w.isFront) || [];
    for (let k = 0; k < 2; k++) {
      const a = wheelsLast[k], w = rear[k];
      if (skid < 0.15 || !w) { a.on = false; continue; }
      w.steerPivot.getWorldPosition(wp);
      const y = car.position.y + 0.03;
      if (!a.on) { a.on = true; a.x = wp.x; a.y = y; a.z = wp.z; continue; }
      if (Math.hypot(wp.x - a.x, wp.z - a.z) > 6) { a.x = wp.x; a.y = y; a.z = wp.z; continue; } // a teleport
      lay(a, wp.x, y, wp.z, skid);
    }
    // smoke boils off both back tires, more the harder they slide
    if (skid > 0.25 && rear.length) {
      smokeCarry += dt * 46 * skid;
      while (smokeCarry >= 1) {
        smokeCarry--;
        rear[smokeCursor % rear.length].steerPivot.getWorldPosition(wp);
        const s = S[smokeCursor]; smokeCursor = (smokeCursor + 1) % MAX_SMOKE;
        s.x = wp.x + (random() - 0.5) * 0.3; s.z = wp.z + (random() - 0.5) * 0.3; s.y = car.position.y + 0.25;
        s.vx = (random() - 0.5) * 1.2; s.vz = (random() - 0.5) * 1.2; s.vy = 0.5 + random() * 0.6;
        s.r = 0.6 + random() * 0.4; s.age = 0; s.life = 1.6 + random() * 1.2;
      }
    }

    // streaks fade over time
    if (markCount) {
      for (let i = 0; i < markCount; i++) {
        markAge[i] += dt;
        dark.array[i] = markStrength[i] * Math.max(0, 1 - markAge[i] / MARK_FADE);
      }
      marks.count = markCount;
      dark.needsUpdate = true;
      liveMarks = true;
    } else if (liveMarks) { marks.count = 0; liveMarks = false; }

    let n = 0;
    const drag = Math.exp(-1.6 * dt);
    for (const s of S) {
      if (s.life <= 0) continue;
      s.age += dt;
      if (s.age >= s.life) { s.life = 0; continue; }
      s.vx *= drag; s.vz *= drag; s.vy *= Math.exp(-0.6 * dt);
      s.x += (s.vx + 0.5) * dt; s.y += s.vy * dt; s.z += (s.vz + 0.2) * dt; // the same light breeze as the hydrants'
      const t = s.age / s.life, r = s.r * (1 + t * 3.2);
      p.set(s.x, s.y + r * 0.3, s.z);
      sc.set(r, r, r);
      smoke.setMatrixAt(n, m.compose(p, camera.quaternion, sc));
      fade.array[n] = Math.min(1, s.age / 0.15) * (1 - t) * (1 - t);
      n++;
    }
    smoke.count = n;
    if (n) { smoke.instanceMatrix.needsUpdate = true; fade.needsUpdate = true; }
  }

  return { update };
}

export { createSkidEffects };
