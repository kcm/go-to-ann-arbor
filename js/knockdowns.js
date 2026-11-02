import * as THREE from 'three/webgpu';
import { groundHeight } from './terrain.js';
import { random } from '../lamp-game.js';

// Trees, lamp posts, signal poles and sign posts a car can knock over (main.js gives each its collider). Whether a hit
// fells one depends on how fast the car comes at it head on, how heavy the car is, and how stout it is: a sign post
// gives at a crawl, a young street tree at about 30 km/h, a big old oak only to a fast, heavy car. It then tips over the
// way the car was going, about its foot, speeding up as it goes as a falling pole does, and lands with a bounce; it
// lies there from then on and stops being solid. The car loses some of its speed in the hit. A fire hydrant is made to
// break off its flange at a bump: it's thrown ahead of the car, tumbling, bounces along the ground and comes to rest.

const G = 9.8;
// The speed (m/s) at which a 1500 kg car fells each kind head on; a tree's grows with its trunk
const GIVE = { sign: 3.5, lamp: 9, signal: 12, hydrant: 2.2 };
const treeGive = (trunk) => 8.5 * Math.pow(Math.max(0.06, trunk) / 0.2, 1.5);

function createKnockdowns({ onFall = null, onLand = null } = {}) {
  const falling = [];
  const turn = new THREE.Matrix4();
  const toFoot = new THREE.Matrix4();
  const fromFoot = new THREE.Matrix4();
  const m = new THREE.Matrix4();
  const axis = new THREE.Vector3();

  // The speed a car of `mass` must come at it to fell it
  const giveOf = (item, mass) => (item.kind === 'tree' ? treeGive(item.trunk) : GIVE[item.kind] || 9) * Math.sqrt(1500 / mass);

  function pose(item) {
    axis.set(item.dz, 0, -item.dx);
    toFoot.makeTranslation(-item.x, -item.g, -item.z);
    fromFoot.makeTranslation(item.x, item.g, item.z);
    turn.makeRotationAxis(axis, item.angle).premultiply(fromFoot).multiply(toFoot);
    if (item.pose) { item.pose(turn); return; }
    const parts = item.parts;
    for (let k = 0; k < parts.length; k += 2) {
      m.fromArray(item.base, k * 8).premultiply(turn);
      place(parts[k], parts[k + 1], m);
    }
  }

  // Sets instance i of `mesh`, and wherever the culling moved it to be drawn (its chunk, scene-culling.js) and its
  // shadow's stand-in
  function place(mesh, i, matrix) {
    const moved = mesh.userData.movedTo?.[i];
    if (moved) place(moved[0], moved[1], matrix);
    else {
      mesh.setMatrixAt(i, matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
    const shadow = mesh.userData.shadowCopy?.[i];
    const proxy = shadow?.[0].mesh;
    if (proxy) {
      proxy.setMatrixAt(shadow[1], matrix);
      proxy.instanceMatrix.needsUpdate = true;
    }
  }

  // A car (its mass) came at `collider`'s item at `speed` head on, going (dx, dz): true when it falls. The car's speed
  // is then multiplied by what's returned in `keep`.
  const result = { keep: 1 };
  function hit(collider, speed, mass, dx, dz) {
    const item = collider.knock;
    if (!item || item.down) return null;
    const give = giveOf(item, mass);
    if (speed < give) return null;
    item.down = true;
    collider.maxY = -1e6; // no longer in the way
    const len = Math.hypot(dx, dz) || 1;
    item.dx = dx / len;
    item.dz = dz / len;
    item.angle = 0;
    if (item.kind === 'hydrant') return throwHydrant(item, speed);
    // knocked into a spin about its foot: harder hits throw it over faster
    item.spin = Math.min(2.6, (speed - give * 0.7) / Math.max(2, item.height) * 1.6 + 0.3);
    item.bounced = false;
    item.rest = item.kind === 'tree' ? 1.42 : 1.53; // a crown or a lamp head keeps it a little off the ground
    if (!item.pose) {
      item.base = new Float32Array(item.parts.length * 8);
      for (let k = 0; k < item.parts.length; k += 2) {
        item.parts[k].getMatrixAt(item.parts[k + 1], m);
        m.toArray(item.base, k * 8);
      }
    }
    falling.push(item);
    item.out?.(); // a streetlight goes dark
    onFall?.(item, speed);
    // a sign post barely slows the car; a tree it only just fells, nearly stops it
    result.keep = Math.max(0.15, 1 - 0.85 * (give / speed) ** 2);
    return result;
  }

  // Thrown off at about the car's speed, a little up, tumbling about an axis across its path; its centre of mass
  // (a little above its foot) flies as a ball does
  const flying = [];
  const spinQ = new THREE.Quaternion(), turnM = new THREE.Matrix4(), spinAxis = new THREE.Vector3();
  function throwHydrant(item, speed) {
    item.base = new Float32Array(16);
    item.parts[0].getMatrixAt(item.parts[1], m);
    m.toArray(item.base, 0);
    const ox = item.x, oy = m.elements[13] + 0.4, oz = item.z;
    const along = speed * (0.95 + random() * 0.3), side = (random() - 0.5) * speed * 0.25;
    item.fly = {
      ox, oy, oz, x: ox, y: oy, z: oz,
      vx: item.dx * along - item.dz * side, vy: 2.5 + speed * 0.32 + random() * 1.5, vz: item.dz * along + item.dx * side,
      q: new THREE.Quaternion(), ax: item.dz, ay: (random() - 0.5) * 0.6, az: -item.dx,
      w: 6 + speed * 0.9, bounces: 0
    };
    flying.push(item);
    onFall?.(item, speed);
    result.keep = Math.max(0.6, 1 - 0.5 * (GIVE.hydrant / speed));
    return result;
  }
  function poseFlying(item) {
    const f = item.fly;
    m.fromArray(item.base, 0);
    toFoot.makeTranslation(-f.ox, -f.oy, -f.oz);
    turnM.makeRotationFromQuaternion(f.q);
    fromFoot.makeTranslation(f.x, f.y, f.z);
    m.premultiply(toFoot).premultiply(turnM).premultiply(fromFoot);
    place(item.parts[0], item.parts[1], m);
  }
  function updateFlying(dt) {
    for (let n = flying.length - 1; n >= 0; n--) {
      const it = flying[n], f = it.fly;
      f.vy -= G * dt;
      f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
      spinAxis.set(f.ax, f.ay, f.az).normalize();
      f.q.premultiply(spinQ.setFromAxisAngle(spinAxis, f.w * dt));
      const floor = groundHeight(f.x, f.z) + 0.22;
      if (f.y < floor) {
        f.y = floor;
        if (f.vy < -1.2) {
          f.bounces++;
          if (f.bounces === 1) onLand?.(it, Math.min(3, -f.vy * 0.4));
          f.vy = -f.vy * 0.32;
          f.vx *= 0.62; f.vz *= 0.62; f.w *= 0.55;
        } else {
          // rolling and scraping to a stop on its side
          f.vy = 0;
          const k = Math.exp(-3.5 * dt);
          f.vx *= k; f.vz *= k; f.w *= Math.exp(-5 * dt);
          if (Math.hypot(f.vx, f.vz) < 0.15 && f.w < 0.3) flying.splice(n, 1);
        }
      }
      poseFlying(it);
    }
  }

  function update(dt) {
    if (flying.length) updateFlying(dt);
    for (let n = falling.length - 1; n >= 0; n--) {
      const it = falling[n];
      // a rod tipping about its end: angular acceleration 3g sin(angle) / 2h
      it.spin += (3 * G / (2 * Math.max(1.5, it.height))) * Math.sin(Math.max(0.05, it.angle)) * dt;
      it.angle += it.spin * dt;
      if (it.angle >= it.rest) {
        it.angle = it.rest;
        if (!it.bounced && it.spin > 0.6) {
          it.bounced = true;
          onLand?.(it, it.spin);
          it.spin = -it.spin * 0.18;
        } else {
          it.spin = 0;
          falling.splice(n, 1);
        }
      }
      pose(it);
    }
  }

  return { hit, update, get falling() { return falling.length + flying.length; } };
}

export { createKnockdowns };
