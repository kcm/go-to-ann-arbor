import * as THREE from 'three/webgpu';
import { groundHeight } from './terrain.js';
import { random } from '../lamp-game.js';
import { float, vec3, uv, time, sin, positionLocal, normalView, positionViewDirection, dot, abs, smoothstep, clamp, attribute } from 'three/tsl';

// Water from a hydrant knocked off its main (knockdowns.js): a column of water roaring out of the broken riser, rising
// some 8 to 10 m before it breaks up, the drops drifting with the wind and falling back as rain around it, splashing
// where they land, a haze of spray hanging around its top, and the pavement darkening wet in a spreading patch. It runs
// at full pressure for half a minute, then the crew shuts the valve and it sinks away. A few may run at once.

const MAX_DROPS = 2600, MAX_MIST = 260, MAX_GEYSERS = 4;
const FULL = 30, SHUTOFF = 6; // seconds at full pressure, then how long it takes to die down
const WIND_X = 0.9, WIND_Z = 0.35; // a light breeze leans the column and carries the spray

function createHydrantSpray(scene) {
  // the scene outlives a change to the code: take away the water a previous run left in it
  for (const old of scene.children.filter((c) => c.name === 'HydrantSpray')) scene.remove(old);
  const group = new THREE.Group();
  group.name = 'HydrantSpray';
  scene.add(group);

  // the column itself: a clear, glassy jet leaning a little with the breeze, its surface streaming upward, thickest
  // and clearest at its foot and tearing into spray as it rises
  const jetGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 32, true).translate(0, 0.5, 0);
  const jetMat = new THREE.MeshStandardNodeMaterial({ color: 0xd8e6ef, roughness: 0.05, metalness: 0.0, transparent: true,
    depthWrite: false, side: THREE.DoubleSide });
  {
    const y = uv().y, ang = uv().x.mul(Math.PI * 2);
    // radius flares from the riser's throat as the jet loses pressure, then frays near the top
    const flare = float(0.075).add(y.mul(y).mul(0.42)).add(sin(ang.mul(5).add(y.mul(17)).sub(time.mul(13))).mul(y).mul(0.05));
    const leanX = y.mul(y).mul(WIND_X * 0.9), leanZ = y.mul(y).mul(WIND_Z * 0.9);
    jetMat.positionNode = vec3(positionLocal.x.mul(flare).add(leanX), positionLocal.y, positionLocal.z.mul(flare).add(leanZ));
    // streaks rushing up the surface
    const streak = sin(ang.mul(9).add(sin(y.mul(6).sub(time.mul(7))).mul(1.6))).mul(0.5).add(0.5);
    const pulse = sin(y.mul(23).sub(time.mul(19)).add(sin(ang.mul(3)).mul(2))).mul(0.5).add(0.5);
    const edge = float(1).sub(abs(dot(normalView, positionViewDirection))).pow(1.5);
    const top = smoothstep(1.0, 0.55, y), foot = smoothstep(0.0, 0.04, y);
    jetMat.opacityNode = clamp(edge.mul(0.55).add(0.12).add(streak.mul(pulse).mul(0.35)).mul(top).mul(foot)
      .mul(float(1).sub(y.mul(0.45))), 0, 0.85);
    jetMat.emissiveNode = vec3(0.07, 0.085, 0.095).mul(streak.mul(0.5).add(0.5));
  }

  // drops: fine, streaked by their own speed, mostly see-through
  const dropMat = new THREE.MeshStandardNodeMaterial({ color: 0xe8f2fa, roughness: 0.1, metalness: 0, transparent: true,
    opacity: 0.38, depthWrite: false });
  dropMat.emissive = new THREE.Color(0x161b1f);
  const drops = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 5, 1), dropMat, MAX_DROPS);
  drops.frustumCulled = false;
  drops.count = 0;
  // spray: soft round puffs turned to face the camera, fading at their edges
  const mistMat = new THREE.MeshStandardNodeMaterial({ color: 0xeef4f8, roughness: 1, metalness: 0, transparent: true,
    depthWrite: false });
  {
    const d = uv().sub(0.5).length().mul(2);
    mistMat.opacityNode = smoothstep(1, 0, d).pow(2).mul(attribute('fade', 'float')).mul(0.22);
    mistMat.emissive = new THREE.Color(0x14181b);
  }
  const mistGeo = new THREE.PlaneGeometry(1, 1);
  const fade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MIST), 1);
  fade.setUsage(THREE.DynamicDrawUsage);
  mistGeo.setAttribute('fade', fade);
  const mist = new THREE.InstancedMesh(mistGeo, mistMat, MAX_MIST);
  mist.frustumCulled = false;
  mist.count = 0;
  group.add(drops, mist);

  const D = Array.from({ length: MAX_DROPS }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, age: 0, splash: false }));
  const M = Array.from({ length: MAX_MIST }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, r: 0, age: 0 }));
  let dropCursor = 0, mistCursor = 0;
  const geysers = [];
  const wetMat = new THREE.MeshStandardNodeMaterial({ color: 0x0f1418, roughness: 0.04, metalness: 0.1, transparent: true,
    opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const wetGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);

  const nextDrop = () => { const d = D[dropCursor]; dropCursor = (dropCursor + 1) % MAX_DROPS; return d; };

  function start(x, z) {
    if (geysers.length >= MAX_GEYSERS) stop(geysers[0]);
    const g = groundHeight(x, z);
    const wet = new THREE.Mesh(wetGeo, wetMat.clone());
    wet.position.set(x + WIND_X * 1.2, g + 0.05, z + WIND_Z * 1.2);
    wet.scale.setScalar(0.01);
    wet.renderOrder = 2;
    group.add(wet);
    const jet = new THREE.Mesh(jetGeo, jetMat);
    jet.position.set(x, g + 0.25, z);
    jet.frustumCulled = false;
    jet.renderOrder = 3;
    group.add(jet);
    geysers.push({ x, z, g, age: 0, carry: 0, mistCarry: 0, wet, jet });
  }
  function stop(gy) {
    group.remove(gy.wet, gy.jet);
    gy.wet.material.dispose();
    geysers.splice(geysers.indexOf(gy), 1);
  }
  // how hard it's running: a burst as it breaks, full pressure, then shut off
  const pressure = (age) => age < 0.4 ? 0.6 + age : age < FULL ? 1 : Math.max(0, 1 - (age - FULL) / SHUTOFF);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  let live = false;

  function update(dt, camera) {
    if (!geysers.length && !live) return;
    dt = Math.min(dt, 0.05);
    for (let n = geysers.length - 1; n >= 0; n--) {
      const gy = geysers[n];
      gy.age += dt;
      const pr = pressure(gy.age);
      // the wet patch spreads to about 7 m across and dries slowly after
      const spread = Math.min(1, gy.age / 18);
      gy.wet.scale.setScalar(0.6 + 3.2 * Math.sqrt(spread));
      gy.wet.material.opacity = 0.42 * Math.min(1, gy.age / 2) * (gy.age > FULL + SHUTOFF ? Math.max(0, 1 - (gy.age - FULL - SHUTOFF) / 20) : 1);
      if (gy.age > FULL + SHUTOFF + 20) { stop(gy); continue; }
      gy.jet.visible = pr > 0.02;
      gy.jet.scale.set(1, 9 * pr * (1 + 0.03 * Math.sin(gy.age * 23)), 1);
      if (pr <= 0) continue;
      // the column: drops leave the riser fast, a few wild ones off to the side
      gy.carry += dt * 650 * pr;
      while (gy.carry >= 1) {
        gy.carry--;
        const d = nextDrop();
        const a = random() * Math.PI * 2, wild = random() < 0.12;
        const h = (wild ? 1.6 + random() * 2.2 : 0.3 + random() * 1.1) * (0.6 + pr * 0.4);
        d.x = gy.x + Math.cos(a) * 0.07; d.z = gy.z + Math.sin(a) * 0.07; d.y = gy.g + 0.3;
        d.vx = Math.cos(a) * h; d.vz = Math.sin(a) * h;
        d.vy = (wild ? 7 + random() * 4 : 12 + random() * 2.6) * Math.sqrt(pr);
        d.r = 0.006 + random() * 0.012;
        d.age = 0; d.life = 4; d.splash = false;
      }
      // spray hanging where the column breaks up
      gy.mistCarry += dt * 28 * pr;
      while (gy.mistCarry >= 1) {
        gy.mistCarry--;
        const s = M[mistCursor]; mistCursor = (mistCursor + 1) % MAX_MIST;
        const a = random() * Math.PI * 2, rr = random() * 0.8;
        s.x = gy.x + Math.cos(a) * rr; s.z = gy.z + Math.sin(a) * rr;
        s.y = gy.g + (0.4 + random() * 0.6) * 8.5 * pr;
        s.vx = WIND_X * 0.8 + (random() - 0.5) * 0.6; s.vz = WIND_Z * 0.8 + (random() - 0.5) * 0.6;
        s.vy = -0.4 - random() * 0.6;
        s.r = 0.9 + random() * 0.9; s.age = 0; s.life = 2.2 + random() * 1.4;
      }
    }

    live = false;
    let n = 0;
    const drag = Math.exp(-0.35 * dt);
    for (const d of D) {
      if (d.life <= 0) continue;
      d.age += dt;
      d.vy -= 9.8 * dt;
      // air slows the drops and the breeze takes them, more once they've broken up and slowed
      d.vx = (d.vx - WIND_X) * drag + WIND_X; d.vz = (d.vz - WIND_Z) * drag + WIND_Z;
      d.vy *= drag;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      const floor = groundHeight(d.x, d.z) + 0.04;
      if (d.y < floor) {
        // a landing drop throws up a little splash, once
        if (!d.splash && d.vy < -3 && random() < 0.5) {
          d.splash = true; d.y = floor;
          const a = random() * Math.PI * 2, s = 0.6 + random() * 1.4;
          d.vx = Math.cos(a) * s; d.vz = Math.sin(a) * s; d.vy = 1 + random() * 1.8;
          d.r *= 0.7;
        } else { d.life = 0; continue; }
      }
      if (d.age > d.life) { d.life = 0; continue; }
      live = true;
      // a thin streak as long as the drop travels in a fortieth of a second, as the eye sees falling water
      const v = Math.hypot(d.vx, d.vy, d.vz);
      dir.set(d.vx, d.vy, d.vz).multiplyScalar(1 / (v || 1));
      q.setFromUnitVectors(up, dir);
      sc.set(d.r, d.r * 2 + v * 0.025, d.r);
      drops.setMatrixAt(n++, m.compose(p.set(d.x, d.y, d.z), q, sc));
    }
    drops.count = n;
    drops.instanceMatrix.needsUpdate = true;

    n = 0;
    if (camera) q.copy(camera.quaternion); else q.identity();
    for (const s of M) {
      if (s.life <= 0) continue;
      s.age += dt;
      if (s.age > s.life) { s.life = 0; continue; }
      live = true;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      // swells then thins out
      const k = s.age / s.life, r = s.r * (0.6 + k * 1.2);
      fade.array[n] = Math.sin(Math.PI * Math.min(1, k * 1.1 + 0.05));
      mist.setMatrixAt(n++, m.compose(p.set(s.x, s.y, s.z), q, sc.set(r, r, r)));
    }
    mist.count = n;
    mist.instanceMatrix.needsUpdate = true;
    fade.needsUpdate = true;
    live = live || geysers.length > 0;
  }

  // where water runs now, and how hard, for its sound
  function gushes(out) {
    out.length = 0;
    for (const gy of geysers) {
      const pr = pressure(gy.age);
      if (pr > 0) out.push({ x: gy.x, y: gy.g + 1, z: gy.z, level: pr });
    }
    return out;
  }

  return { group, start, update, gushes, get running() { return geysers.length; } };
}

export { createHydrantSpray };
