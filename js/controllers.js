import * as THREE from 'three/webgpu';
import {
  TOWN_BOUNDS,
  BIG_PARK_BOUNDS,
  getTownBoundsAtZ,
  isTypingInField,
  blockAt,
  streetZ
} from './city-config.js';
import { cityUniforms, createCarPaintMaterial, createContactShadowMaterial } from './tsl-materials.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  buildCarSidePatch,
  buildSteerableWheelGeo,
  carTipZ,
  createCarWheelMaterial,
  createLoftedCarMaterial
} from './cars.js';
import {
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './helicopter.js';
import { PersonCrowd, PersonRig, PEDESTRIAN_DIVE_DURATION } from './pedestrians.js';
import { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight } from './vehicle-lights.js';
import { bryantParkLawn } from './landmarks.js';
import { groundHeight, groundTilt, nearestWater, riverDepth, riverFlow, stadiumGround, waterLevel } from './terrain.js';
import { polygonContact, polygonContains } from './building-collision.js';
import { bowlSurface } from './stadium-shape.js';
import { hot } from '../lamp-game.js';

// Player models, animation and movement for walking, driving, cycling and flying.

// Spawn on Main St in downtown Ann Arbor, between William and Liberty, facing north up Main
const SPAWN_Z = 100;
// The kayak sets out on Argo Pond, by the canoe livery, and the river carries it on down towards Gallup Park
const KAYAK_LAUNCH = { x: 210, z: -1150 };
const KAYAK_CURRENT = 1.1; // m/s, out in the middle
// The player's own car: a black Forester with GO BLU plates
const OWN_CAR = { kind: 'forester', hex: 0x16181b, style: 0 };
const isOwnCar = (look) => look.kind === OWN_CAR.kind && look.hex === OWN_CAR.hex;
const groundCollider = { type: 'ground' };
// The skids' ends and middle, [across, along] in metres from the helicopter's middle
const HELI_SKIDS = [[0, 0], [-1.1, -1.8], [1.1, -1.8], [-1.1, 1.8], [1.1, 1.8]];

const CAR_DRIVE = {
  speed: 36, reverseSpeed: 10.5, acceleration: 4.5,
  powerSpeed: 14.5, // Above 52 km/h, engine power limits acceleration.
  rolling: 0.18, drag: 0.0012, coast: 0.6, brake: 9,
  wheelbase: 2.76, grip: 9.5, cornering: 10.5 // Wheelbase (m), tire and steering acceleration limits (m/s²).
};
// How each kind of car drives, over CAR_DRIVE: top speed, pull, braking, tire grip, how tight it turns (cornering and
// wheelbase), how quick the steering is (steer) and how far the body leans in a bend (roll) and pitches (pitch)
const CAR_HANDLING = {
  sedan: { speed: 38, acceleration: 5 },
  taxi: { speed: 38, acceleration: 5 },
  forester: { mass: 1600, speed: 36, acceleration: 4.6, grip: 10, cornering: 10.2, wheelbase: 2.67, roll: 0.014 }, // all-wheel drive
  suv: { mass: 2000, speed: 34, acceleration: 4.2, brake: 8.5, grip: 8.6, cornering: 9, wheelbase: 2.8, steer: 8, roll: 0.016 },
  minivan: { mass: 2000, speed: 33, acceleration: 3.8, brake: 8.5, grip: 8.4, cornering: 8.5, wheelbase: 3.03, steer: 7.5, roll: 0.015 },
  pickup: { mass: 2400, speed: 35, acceleration: 4.8, powerSpeed: 11, brake: 8, grip: 7.8, cornering: 7.6, wheelbase: 3.7, steer: 7, roll: 0.017, pitch: 0.034 },
  van: { mass: 2700, speed: 30, acceleration: 3.2, powerSpeed: 11, brake: 7.5, grip: 7.2, cornering: 7, wheelbase: 3.6, steer: 6.5, roll: 0.02, pitch: 0.036 },
  sports: { mass: 1450, speed: 54, acceleration: 8.5, powerSpeed: 24, brake: 12, drag: 0.0009, grip: 13, cornering: 14, wheelbase: 2.72, steer: 14, roll: 0.007, pitch: 0.016 }
};
const carDrive = (kind) => ({ mass: 1500, steer: 10, roll: 0.012, pitch: 0.026, ...CAR_DRIVE, ...CAR_HANDLING[kind] });
// Faster than this (m/s, about 14 km/h) and the doors stay shut
const EXIT_SPEED = 4;

const BICYCLE_DRIVE = {
  speed: 19, reverseSpeed: 4.5, acceleration: 9,
  rolling: 0.08, drag: 0.004, coast: 0.2, brake: 7.5 // Backward input is scaled to 0.6, giving 4.5 m/s² braking.
};

function driveSpeed(speed, throttle, dt, drive) {
  // Turning can project tiny sideways motion back into speed after braking to zero.
  // Treat a crawl as stopped when changing direction, so this cannot hold the brakes forever.
  if (speed * throttle < 0 && Math.abs(speed) < 0.05) speed = 0;
  const braking = speed * throttle < 0;
  const magnitude = Math.abs(speed);
  // Extra resistance on release gives a stronger slowdown while coasting.
  const deceleration = drive.rolling + (!throttle ? drive.coast : braking ? Math.abs(throttle) * drive.brake : 0);
  // Constant rolling resistance and quadratic air drag, without crossing zero or large-dt instability.
  const coasting = Math.max(0, magnitude - deceleration * dt) / (1 + drive.drag * magnitude * dt);
  if (!throttle || braking) return Math.sign(speed) * coasting;

  const limit = throttle < 0 ? drive.reverseSpeed : drive.speed;
  let acceleration = drive.acceleration;
  if (drive.powerSpeed) acceleration *= drive.powerSpeed / Math.max(drive.powerSpeed, magnitude);
  // Collision momentum above the powered limit decays naturally instead of being clamped.
  return Math.sign(throttle) * Math.min(Math.max(limit, coasting), coasting + Math.abs(throttle) * acceleration * dt);
}

// Walking surface for the player's pedestrian (its rig samples it around its feet)
const personGround = (controllers, x, z) => controllers.getGroundHeight(x, z, 'person');
const RIDER_THROW_SPEED = 5.5;
const DIVE_GET_UP = 1.15; // where a dive's prone pause begins: a fallen body gets up from there
const hash01 = (x) => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

function collisionBody(mode, radius, heading, margin = 0) {
  const car = mode === 'car';
  const sin = Math.sin(heading), cos = Math.cos(heading);
  const hx = 0.86 + margin, hz = 2.18 + margin;
  return {
    car, sin, cos, hx, hz, radius: radius + margin,
    extX: car ? Math.abs(cos) * hx + Math.abs(sin) * hz : radius + margin,
    extZ: car ? Math.abs(sin) * hx + Math.abs(cos) * hz : radius + margin,
    bottom: mode === 'helicopter' ? -0.25 : 0,
    top: mode === 'helicopter' ? 3.2 : car ? 1.8 : 1.9
  };
}

// The height of a building's roof at (x, z), or -Infinity outside it: a house's own pitched roofs (houses.js gives its
// collider their shapes), else the top of its outline
function roofHeightAt(c, x, z) {
  if (x < c.minX - 0.5 || x > c.maxX + 0.5 || z < c.minZ - 0.5 || z > c.maxZ + 0.5) return -Infinity;
  if (c.roofs) {
    let y = -Infinity;
    for (const R of c.roofs) {
      const dx = x - R.cx, dz = z - R.cz;
      const a = Math.abs(dx * R.ax + dz * R.az), b = dx * R.bx + dz * R.bz, ab = Math.abs(b);
      if (!(R.hb > 0.05) || a > R.ha + 0.3 || ab > R.hb + 0.45) continue;
      const k = Math.max(0, 1 - ab / R.hb);
      const h = R.type === 'flat' ? R.top + 0.35
        : R.type === 'hip' ? R.top + R.rh * Math.max(0, Math.min(k, (R.ha - a) / R.hb))
          : R.type === 'shed' ? R.top + R.rh * Math.max(0, Math.min(1, (R.high * b / R.hb + 1) / 2))
            : R.top + R.rh * k;
      y = Math.max(y, h);
    }
    return y;
  }
  if (c.polygon) return polygonContains(c.polygon, x, z) ? c.maxY : -Infinity;
  const o = c.obb;
  if (o) {
    const dx = x - o.cx, dz = z - o.cz;
    return Math.abs(dx * o.cs - dz * o.sn) <= o.hx && Math.abs(dx * o.sn + dz * o.cs) <= o.hz ? c.maxY : -Infinity;
  }
  return c.maxY;
}

// Michigan Stadium's collider (landmarks.js), which keeps cars and people outside its wall but not the helicopter
const isStadium = (c) => c.stadium || (c._bowl ??= !c.polygon && !c.obb
  && bowlSurface((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2) !== null);

// Movement and teleports share exact footprint checks after rejecting distant bounds.
// Walking/cycling/flying use circles; cars use oriented rectangles.
function buildingContact(c, x, y, z, body, contact) {
  if (y + body.bottom >= c.maxY || y + body.top <= (c.minY ?? 0)) return false;
  if (x + body.extX <= c.minX || x - body.extX >= c.maxX || z + body.extZ <= c.minZ || z - body.extZ >= c.maxZ) return false;
  if (c.polygon) return polygonContact(c.polygon, x, z, body, contact);
  const o = c.obb;
  const cs = o ? o.cs : 1, sn = o ? o.sn : 0;
  const hx = o ? o.hx : (c.maxX - c.minX) * 0.5;
  const hz = o ? o.hz : (c.maxZ - c.minZ) * 0.5;
  const dx = x - (o ? o.cx : (c.minX + c.maxX) * 0.5);
  const dz = z - (o ? o.cz : (c.minZ + c.maxZ) * 0.5);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  let nx = 0, nz = 0, depth = Infinity;
  if (body.car) {
    const ls = body.sin * cs - body.cos * sn, lc = body.sin * sn + body.cos * cs;
    for (let axis = 0; axis < 4; axis++) {
      const ax = axis === 0 ? 1 : axis === 1 ? 0 : axis === 2 ? lc : ls;
      const az = axis === 0 ? 0 : axis === 1 ? 1 : axis === 2 ? -ls : lc;
      const distance = lx * ax + lz * az;
      const overlap = hx * Math.abs(ax) + hz * Math.abs(az)
        + body.hx * Math.abs(ax * lc - az * ls) + body.hz * Math.abs(ax * ls + az * lc) - Math.abs(distance);
      if (overlap <= 0) return false;
      if (overlap < depth) {
        depth = overlap;
        const sign = distance <= 0 ? -1 : 1;
        nx = ax * sign; nz = az * sign;
      }
    }
  } else {
    const qx = lx - Math.max(-hx, Math.min(hx, lx));
    const qz = lz - Math.max(-hz, Math.min(hz, lz));
    const distance = Math.hypot(qx, qz);
    if (distance >= body.radius) return false;
    if (distance > 0) {
      nx = qx / distance; nz = qz / distance;
      depth = body.radius - distance;
    } else if (hx - Math.abs(lx) <= hz - Math.abs(lz)) {
      nx = lx <= 0 ? -1 : 1;
      depth = hx - Math.abs(lx) + body.radius;
    } else {
      nz = lz <= 0 ? -1 : 1;
      depth = hz - Math.abs(lz) + body.radius;
    }
  }
  if (contact) {
    contact.nx = nx * cs + nz * sn;
    contact.nz = -nx * sn + nz * cs;
    contact.depth = depth;
  }
  return true;
}

function createGoBluePlateTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f4f6f8';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#17325f';
  ctx.textAlign = 'center';
  ctx.font = '800 18px Inter, Arial, sans-serif';
  ctx.fillText('MICHIGAN', 128, 26);
  ctx.font = '900 50px JetBrains Mono, monospace';
  ctx.fillText('GO BLU', 128, 84);
  ctx.font = '700 13px Inter, Arial, sans-serif';
  ctx.fillText('PURE MICHIGAN', 128, 114);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

class ThirdPersonControllerManager {
  constructor(scene, colliders = []) {
    this.scene = scene;
    this.colliders = colliders;
    this._colliderCells = null; // built on first use, see nearColliders()
    this.riverScale = 1; // how fast the Huron runs against its usual flow, from the USGS gauge (river-gauge.js)
    this.activeMode = 'car'; // 'person' | 'car' | 'cyclist' | 'helicopter'

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false
    };

    this.entities = {
      person: this.createPersonEntity(),
      car: this.createCarEntity(),
      cyclist: this.createCyclistEntity(),
      helicopter: this.createHelicopterEntity(),
      kayak: this.createKayakEntity()
    };
    this.carLook = { ...OWN_CAR };

    Object.values(this.entities).forEach((ent) => {
      if (ent.mesh) {
        ent.mesh.traverse((child) => {
          if (
            child.isMesh &&
            !child.material?.isMeshBasicNodeMaterial &&
            child.material?.type !== 'MeshBasicNodeMaterial' &&
            !child.material?.transparent
          ) {
            child.castShadow = true;
            child.receiveShadow = true;
          }
        });
      }
    });

    // Lamp: whatever stands on the ground starts on it (terrain.js), not only the vehicle in use, which updates its own
    for (const key of ['person', 'car', 'cyclist']) {
      const e = this.entities[key];
      e.position.y = this.getGroundHeight(e.position.x, e.position.z, key);
      e.mesh.position.copy(e.position);
    }

    this.bindKeyboard();
  }

  setCollisionListener(listener) {
    this._collisionListener = typeof listener === 'function' ? listener : null;
    this._collisionEvent ??= { a: null, b: null, kind: '', x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, speed: 0 };
  }

  // Reuse one synchronous event; consumers must copy retained fields. Normal points from b toward a.
  reportCollision(a, b, kind, x, y, z, nx, ny, nz, speed) {
    if (!this._collisionListener || speed <= 0.5) return;
    const event = this._collisionEvent;
    event.a = a; event.b = b; event.kind = kind;
    event.x = x; event.y = y; event.z = z;
    event.nx = nx; event.ny = ny; event.nz = nz; event.speed = speed;
    this._collisionListener(event);
  }

  bindKeyboard() {
    const bindings = {
      forward: ['KeyW', 'ArrowUp'],
      backward: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'],
      right: ['KeyD', 'ArrowRight'],
      up: ['Space', 'KeyE'],
      down: ['KeyQ', 'KeyC']
    };
    const actionsByCode = new Map(Object.entries(bindings).flatMap(([action, codes]) => codes.map((code) => [code, action])));
    this._pressedCodes = new Set();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};

    const onKey = (e, isDown) => {
      const action = actionsByCode.get(e.code);
      if (!action || (isDown && isTypingInField(e))) return;
      if (isDown) this._pressedCodes.add(e.code);
      else this._pressedCodes.delete(e.code);
      // Releasing one binding must not cancel another key held for the same action.
      this._keyboardKeys[action] = bindings[action].some((code) => this._pressedCodes.has(code));
      this._blendInput(action);
    };

    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => this.resetInput());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.resetInput();
    });
  }

  _blendInput(action) {
    const keyboard = this._keyboardKeys[action] || false;
    const touch = this._touchKeys[action] || false;
    const gamepad = this._gamepadKeys[action] || false;
    const strength = Math.max(keyboard, touch, gamepad);
    // Preserve digital button values while allowing either analog source to be strongest.
    this.keys[action] = keyboard === true || touch === true || gamepad === true ? true : strength || false;
  }

  _setAnalogInput(source, action, value) {
    if (!Object.hasOwn(this.keys, action)) return;
    const strength = Number(value);
    source[action] = typeof value === 'boolean' ? value : Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
    this._blendInput(action);
  }

  setTouchInput(action, value) {
    this._setAnalogInput(this._touchKeys, action, value);
  }

  setGamepadInput(action, value) {
    this._setAnalogInput(this._gamepadKeys, action, value);
  }

  clearTouchInput() {
    this._touchKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  clearGamepadInput() {
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this._blendInput(action);
  }

  resetInput() {
    this._pressedCodes.clear();
    this._keyboardKeys = {};
    this._touchKeys = {};
    this._gamepadKeys = {};
    for (const action of Object.keys(this.keys)) this.keys[action] = false;
  }

  setMode(mode) {
    if (!this.entities[mode]) return;
    const person = this.entities.person;
    // On foot from inside something: out beside it
    const ridden = mode === 'person' && person.riding ? this.entities[person.riding] : null;
    person.riding = mode === 'person' ? null : person.riding;
    this.activeMode = mode;
    if (ridden) {
      ridden.leftEmpty = true;
      this.placePersonBeside(ridden);
    }
    const active = this.entities[mode];
    if (active.mesh) active.mesh.visible = true;
    if (active.helmet) active.helmet.visible = true;
    if (mode === 'person') active._charHidden = false;
    else if (mode === 'cyclist') {
      active._riderHidden = false;
      active._posedX = NaN;
    } else if (mode === 'kayak') active._paddlerHidden = false;
    const car = this.entities.car;
    if (mode !== 'car' && car?.carState) car.carState.value.x = car.carState.value.w = 0;
  }

  getActiveEntity() {
    return this.entities[this.activeMode];
  }

  teleportActiveTo(x, z, heading = Math.PI, savedAltitude = null) {
    const ent = this.getActiveEntity();
    this.resetInput();
    if (!Number.isFinite(heading)) heading = ent.heading;
    if (this.activeMode === 'kayak') {
      const water = Number.isFinite(x) && Number.isFinite(z) ? nearestWater(x, z, 2500) : null;
      if (water) {
        ent.position.set(water.x, waterLevel(water.x, water.z) ?? ent.position.y, water.z);
        ent.heading = this.downstreamHeading(water.x, water.z, heading);
      }
      ent.speed = ent.driftX = ent.driftZ = ent.turnVel = 0;
      ent._paddlerHidden = false;
      ent.mesh.position.copy(ent.position);
      ent.mesh.rotation.y = ent.heading;
      return { x: ent.position.x, z: ent.position.z };
    }
    const heli = this.activeMode === 'helicopter';
    const altitude = heli ? Math.max(groundHeight(x, z) + 0.25, Math.min(380, savedAltitude ?? Math.max(92, ent.position.y))) : 0;
    const destination = this.findTeleportPosition(x, z, heading, altitude);
    if (destination) {
      ent.position.x = destination.x;
      ent.position.z = destination.z;
      ent.heading = heading;
      ent.position.y = heli ? altitude : this.getGroundHeight(destination.x, destination.z, this.activeMode);
    }
    ent.speed = 0;
    if (this.activeMode === 'person') {
      ent.verticalVel = 0;
      ent._charHidden = false;
      if (ent.mesh) ent.mesh.visible = true;
      ent.fallen = null;
      ent.rig.ragdolling = false;
      ent.rig.reset(ent.position.x, ent.position.z, ent.heading, personGround, this);
      ent.crowd.begin();
      ent.crowd.add(ent.rig, 0);
      ent.crowd.end();
    } else if (this.activeMode === 'car') {
      ent.prevX = ent.position.x;
      ent.prevZ = ent.position.z;
      ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
      ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
      ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
      ent.chassisPivot.position.y = 0;
      ent.lastCollisionSpark = null;
      for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
      if (ent.carState) ent.carState.value.x = ent.carState.value.w = 0;
    } else if (this.activeMode === 'cyclist') {
      ent.leanAngle = ent.leanPivot.rotation.z = 0;
      ent._riderHidden = false;
      ent._posedX = NaN;
      if (ent.helmet) ent.helmet.visible = true;
    } else if (heli) {
      ent.verticalSpeed = ent.pitchAngle = ent.rollAngle = 0;
      ent.tiltPivot.rotation.x = ent.tiltPivot.rotation.z = 0;
      ent.tiltPivot.position.y = 0;
    }
    ent.mesh.position.copy(ent.position);
    ent.mesh.rotation.y = ent.heading;
    return { x: ent.position.x, z: ent.position.z };
  }

  // Find a fully clear arrival before moving the player. Sequential collision pushes can leave a player trapped
  // between overlapping buildings, so test whole candidate footprints instead; retain the old position if none fits.
  findTeleportPosition(x, z, heading, altitude) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const heli = this.activeMode === 'helicopter';
    const radius = heli ? 4.5 : this.activeMode === 'person' ? 0.48 : 0.65;
    const sinH = Math.sin(heading), cosH = Math.cos(heading);
    const shape = collisionBody(this.activeMode, radius, heading, 0.1);
    const reach = Math.max(shape.extX, shape.extZ);
    const margin = heli ? 6000 : 0;
    const entity = this.getActiveEntity();
    // Conservative body cylinders, including the taxi's corners, bicycle wheels and helicopter tail/rotor.
    const body = { person: [0.48, 1.9], car: [2.4, 1.9], cyclist: [1.0, 1.9], helicopter: [6.2, 3.2], kayak: [1.9, 1.2] };
    const others = Object.values(this.entities).filter(e => e !== entity).map(e => ({
      x: e.position.x, z: e.position.z, radius: body[e.type][0],
      bottom: e.position.y - (e.type === 'helicopter' ? 0.7 : 0), top: e.position.y + body[e.type][1]
    }));
    const cameraBack = Math.cos(0.09) * entity.chaseDistance;
    const cameraUp = entity.chaseHeight + Math.sin(0.09) * entity.chaseDistance * 0.85;
    const clampPoint = (px, pz) => {
      pz = Math.max(TOWN_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(TOWN_BOUNDS.maxZ + margin, pz));
      px = Math.max(TOWN_BOUNDS.minX - margin, Math.min(TOWN_BOUNDS.maxX + margin, px));
      if (!heli && getTownBoundsAtZ) {
        const shore = getTownBoundsAtZ(pz);
        const west = shore.westX + 8, east = shore.eastX - 8;
        if (west > east) return null;
        px = Math.max(west, Math.min(east, px));
      }
      return { x: px, z: pz };
    };
    const clear = (p) => {
      if (!p) return false;
      const baseY = heli ? altitude : this.getGroundHeight(p.x, p.z, this.activeMode);
      // Keep other player models out of both the arrival and its default chase view. A corridor also prevents a
      // parked car between camera and character from hiding the character even when the camera itself is outside it.
      const viewTop = baseY + Math.max(body[entity.type][1], cameraUp);
      for (const other of others) {
        if (other.bottom > viewTop + 0.3 || other.top < baseY - (heli ? 0.7 : 0) - 0.3) continue;
        const dx = other.x - p.x, dz = other.z - p.z;
        const back = Math.max(0, Math.min(cameraBack, -dx * sinH - dz * cosH));
        if (Math.hypot(dx + sinH * back, dz + cosH * back) < other.radius + Math.max(body[entity.type][0], 0.5) + 0.1) return false;
      }
      for (const c of this.nearColliders(p.x, p.z, reach)) {
        if (buildingContact(c, p.x, baseY, p.z, shape)) return false;
      }
      return true;
    };
    const origin = clampPoint(x, z);
    if (clear(origin)) return origin;
    // Four-metre rings cover nearby streets and courtyards, with bounded work even for a click inside a large block.
    const cx = origin ? origin.x : Math.max(TOWN_BOUNDS.minX, Math.min(TOWN_BOUNDS.maxX, x));
    const cz = origin ? origin.z : Math.max(TOWN_BOUNDS.minZ + 30, Math.min(TOWN_BOUNDS.maxZ, z));
    for (let distance = 4; distance <= 256; distance += 4) {
      for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI / 16;
        const p = clampPoint(cx + Math.cos(angle) * distance, cz + Math.sin(angle) * distance);
        if (clear(p)) return p;
      }
    }
    return null;
  }

  // =========================================================================
  // 1. PERSON (SKINNED PEDESTRIAN WITH PLANTED-FOOTSTEP IK GAIT, see pedestrians.js)
  // =========================================================================
  createPersonEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerPerson';

    // One skinned person, posed in world space every frame by its rig (walk, run, turn, jump)
    const crowd = new PersonCrowd(1, { farDistance: Infinity });
    crowd.meshes.forEach((m) => this.scene.add(m));
    const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });

    // Soft Under-Foot Contact Shadow (AO)
    const shadowGeo = new THREE.PlaneGeometry(0.95, 0.95);
    shadowGeo.rotateX(-Math.PI * 0.5);
    const pedShadow = new THREE.Mesh(shadowGeo, createContactShadowMaterial());
    pedShadow.position.y = 0.02;
    pedShadow.renderOrder = 998;
    root.add(pedShadow);

    this.scene.add(root);

    return {
      type: 'person',
      label: 'Pedestrian',
      mesh: root,
      crowd,
      rig,
      position: new THREE.Vector3(-30.2, TOWN_BOUNDS.sidewalkHeight, SPAWN_Z + 12),
      heading: Math.PI,
      speed: 0,
      verticalVel: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 4.3,
      chaseHeight: 1.95
    };
  }

  // =========================================================================
  // 2. CAR (3D LOFTED BLACK COMPACT SUV, A SUBARU FORESTER'S LINES: ROOF RAILS, BLACK CLADDING)
  // =========================================================================
  createCarEntity(look = OWN_CAR, root = new THREE.Group(), reuseLights = null) {
    root.name = 'PlayerCar';
    const own = isOwnCar(look);

    const chassisPivot = new THREE.Group();
    root.add(chassisPivot);

    const spec = BODY_SPECS[look.kind] || BODY_SPECS.forester;
    const taxiLoftMat = createLoftedCarMaterial(spec, look.hex);

    // 1. 3D Lofted SUV Body + Curved Windscreens + Crowned Roof + Side Mirrors + Roof Rails
    const carBodyGeo = buildCarGeometry(spec, false);
    const carBodyMesh = new THREE.Mesh(carBodyGeo, taxiLoftMat);
    carBodyMesh.castShadow = true;
    carBodyMesh.receiveShadow = true;
    chassisPivot.add(carBodyMesh);

    // 3. Michigan license plates on the raked bumpers, tilted to follow the fascias
    const nyPlateTex = own ? (this._goBluPlate ??= createGoBluePlateTexture()) : null;
    const nyPlateMat = own ? new THREE.MeshStandardNodeMaterial({ map: nyPlateTex, roughness: 0.28 }) : null;
    for (const front of own ? [true, false] : []) {
      const y = spec.plates[front ? 0 : 1];
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.14, 0.008), nyPlateMat);
      plate.position.set(0, y, carTipZ(spec, y, front) + (front ? 0.003 : -0.003));
      plate.rotation.x = Math.atan((carTipZ(spec, y + 0.07, front) - carTipZ(spec, y - 0.07, front)) / 0.14);
      chassisPivot.add(plate);
    }

    // 3b. Brake, reverse & turn lights are lit by the taxi material from its carState uniform (see updateCar)
    const carState = taxiLoftMat.userData.carState;

    // 4. Steerable & Spinning 3D LatheGeometry Tyres + Recessed 5-Spoke Alloy Wheels
    const leftWheelGeo = buildSteerableWheelGeo(spec, -1);
    const rightWheelGeo = buildSteerableWheelGeo(spec, 1);
    const taxiWheelMat = createCarWheelMaterial({ wheelRadius: spec.wheelRadius });

    const wheels = [];
    const wheelCoords = [
      { side: -1, z: spec.wheelZ, isFront: true },
      { side: 1, z: spec.wheelZ, isFront: true },
      { side: -1, z: -spec.wheelZ, isFront: false },
      { side: 1, z: -spec.wheelZ, isFront: false }
    ];
    for (const wc of wheelCoords) {
      const steerPivot = new THREE.Group();
      steerPivot.position.set(wc.side * spec.wheelX, spec.wheelRadius, wc.z);
      const tire = new THREE.Mesh(wc.side < 0 ? leftWheelGeo : rightWheelGeo, taxiWheelMat);
      tire.castShadow = true;
      tire.receiveShadow = true;
      steerPivot.add(tire);
      root.add(steerPivot);
      wheels.push({ steerPivot, tire, isFront: wc.isFront });
    }

    // 5. Ground contact shadow and paired headlight spotlights
    const carShadowGeo = new THREE.PlaneGeometry(2.22, 5.05);
    carShadowGeo.rotateX(-Math.PI * 0.5);
    const carShadow = new THREE.Mesh(carShadowGeo, createContactShadowMaterial());
    carShadow.position.set(0, 0.02, 0.0);
    carShadow.renderOrder = 998;
    root.add(carShadow);

    // a car taken from a parking spot keeps the lights the player's car had (so no light is added to the scene)
    const headLights = [];
    for (const side of [-1, 1]) {
      const old = reuseLights?.[side < 0 ? 0 : 1];
      const spot = old || createVehicleHeadlight();
      placeVehicleHeadlight(spot, spec, side);
      if (!old || old.parent) chassisPivot.add(spot, spot.target);
      headLights.push(spot);
    }

    if (!root.parent) this.scene.add(root);

    const kindName = { sedan: 'Sedan', suv: 'SUV', minivan: 'Minivan', pickup: 'Pickup', van: 'Van', forester: 'Forester', sports: 'Sports Car' };
    return {
      type: 'car',
      label: own ? 'Your Car' : `Borrowed ${kindName[look.kind] || 'Car'}`,
      mesh: root,
      chassisPivot,
      carState,
      headLights,
      wheels,
      position: new THREE.Vector3(-19.2, 0.0, SPAWN_Z + 12),
      prevX: -19.2,
      prevZ: SPAWN_Z + 12,
      heading: Math.PI,
      speed: 0,
      vx: 0,
      vz: 0,
      angularVel: 0,
      pitchVel: 0,
      rollVel: 0,
      heaveY: 0,
      heaveVel: 0,
      lastCollisionSpark: null,
      steerAngle: 0,
      wheelSpin: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.96, 0),
      chaseDistance: 6.9,
      chaseHeight: 2.12,
      drive: carDrive(look.kind)
    };
  }

  // =========================================================================
  // 3. CYCLIST (3D LOFTED RIDER + ROAD/CITI BICYCLE)
  // =========================================================================
  createCyclistEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerCyclist';

    const leanPivot = new THREE.Group();
    root.add(leanPivot);

    const frameMat = createCarPaintMaterial(0x0078e8);
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181a1e,
      roughness: 0.60
    });
    const chromeMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe0e8f0,
      roughness: 0.16,
      metalness: 0.78
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1c2028,
      roughness: 0.55
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf4f7fb,
      emissive: 0x181c22,
      roughness: 0.22,
      metalness: 0.25
    });

    const wheelTorusGeo = new THREE.TorusGeometry(0.35, 0.038, 12, 24);
    wheelTorusGeo.rotateY(Math.PI * 0.5);
    const rimTorusGeo = new THREE.TorusGeometry(0.31, 0.018, 8, 24);
    rimTorusGeo.rotateY(Math.PI * 0.5);

    const frontWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    frontWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    frontWheel.position.set(0, 0.38, 0.58);
    leanPivot.add(frontWheel);

    const rearWheel = new THREE.Mesh(wheelTorusGeo, tireMat);
    rearWheel.add(new THREE.Mesh(rimTorusGeo, chromeMat));
    rearWheel.position.set(0, 0.38, -0.58);
    leanPivot.add(rearWheel);

    // Rear red LED safety strobe on seatpost
    const tailLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 })
    );
    tailLed.position.set(0, 0.86, -0.32);
    leanPivot.add(tailLed);

    const topTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.72, 10), frameMat);
    topTube.rotation.x = Math.PI * 0.46;
    topTube.position.set(0, 0.78, 0.04);
    leanPivot.add(topTube);

    const downTube = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 10), frameMat);
    downTube.rotation.x = Math.PI * 0.28;
    downTube.position.set(0, 0.58, 0.16);
    leanPivot.add(downTube);

    const seatTube = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.64, 10), frameMat);
    seatTube.rotation.x = -0.22;
    seatTube.position.set(0, 0.66, -0.22);
    leanPivot.add(seatTube);

    const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), shortsMat);
    saddle.rotation.x = Math.PI * 0.5;
    saddle.scale.set(1.15, 1.0, 0.55);
    saddle.position.set(0, 0.96, -0.28);
    leanPivot.add(saddle);

    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.016, 0.68, 10), chromeMat);
    fork.rotation.x = -0.24;
    fork.position.set(0, 0.68, 0.48);
    leanPivot.add(fork);

    const handlebar = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.48, 10), chromeMat);
    handlebar.rotation.z = Math.PI * 0.5;
    handlebar.position.set(0, 0.98, 0.40);
    leanPivot.add(handlebar);

    // Pedal cranks at the bottom bracket (they turn with the pedal phase, the pedals stay level)
    const bikeFrame = {
      seat: new THREE.Vector3(0, 0.98, -0.28),
      bars: new THREE.Vector3(0, 0.98, 0.4),
      gripHalf: 0.22,
      bracket: new THREE.Vector3(0, 0.34, -0.145),
      crankLength: 0.17
    };
    const crankPivot = new THREE.Group();
    crankPivot.position.copy(bikeFrame.bracket);
    const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
    const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
    const pedals = [];
    for (const side of [1, -1]) {
      const arm = new THREE.Group();
      arm.rotation.x = side > 0 ? 0 : Math.PI;
      const crank = new THREE.Mesh(crankGeo, chromeMat);
      crank.position.x = side * 0.065;
      const pedal = new THREE.Mesh(pedalGeo, tireMat);
      pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
      arm.add(crank, pedal);
      crankPivot.add(arm);
      pedals.push(pedal);
    }
    leanPivot.add(crankPivot);

    // Skinned rider (see pedestrians.js), posed every frame with its hands on the grips and feet on the pedals; the
    // helmet rides on its head
    const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
    riderCrowd.meshes.forEach((m) => this.scene.add(m));
    const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
    helmet.scale.set(0.95, 0.68, 1.28);
    this.scene.add(helmet);

    const bikeShadowGeo = new THREE.PlaneGeometry(0.85, 2.25);
    bikeShadowGeo.rotateX(-Math.PI * 0.5);
    const bikeShadow = new THREE.Mesh(bikeShadowGeo, createContactShadowMaterial());
    bikeShadow.position.set(0, 0.02, 0.0);
    bikeShadow.renderOrder = 998;
    root.add(bikeShadow);

    const headLight = new THREE.SpotLight(0xf2f7ff, 0, 20, 0.34, 0.76, 1.25);
    headLight.position.set(0, 1.32, 0.62);
    headLight.target.position.set(0, 0.0, 7.6);
    leanPivot.add(headLight, headLight.target);

    this.scene.add(root);

    return {
      type: 'cyclist',
      label: 'Cyclist',
      mesh: root,
      leanPivot,
      frontWheel,
      rearWheel,
      crankPivot,
      pedals,
      bikeFrame,
      riderCrowd,
      riderRig,
      helmet,
      headLight,
      position: new THREE.Vector3(-18.2, 0.0, SPAWN_Z - 8),
      heading: Math.PI,
      speed: 0,
      leanAngle: 0,
      pedalPhase: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.35, 0),
      chaseDistance: 4.8,
      chaseHeight: 2.05
    };
  }

  // =========================================================================
  // 4. HELICOPTER (3D LOFTED SIGHTSEEING TWIN-TURBINE CHOPPER)
  // =========================================================================
  createHelicopterEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerHelicopter';

    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const heliLoftMat = createLoftedHelicopterMaterial();
    const blurDiscMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc8d8e8,
      transparent: true,
      opacity: 0.13,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    // 1. 3D Lofted Monocoque Fuselage + Tailboom + Twin-Turbine Cowling + Swept Fin + Stabilizers + Tubular Skids
    const heliBodyGeo = buildHelicopterBodyGeometry();
    const heliBodyMesh = new THREE.Mesh(heliBodyGeo, heliLoftMat);
    heliBodyMesh.castShadow = true;
    heliBodyMesh.receiveShadow = true;
    tiltPivot.add(heliBodyMesh);

    // 2. 4-Blade Main Rotor Assembly with Swashplate, Hub Dome & Yellow Safety Blade Tips
    const mainRotorPivot = new THREE.Group();
    mainRotorPivot.position.set(0, 2.66, -0.35);
    const mainRotorGeo = buildHelicopterMainRotorGeometry();
    const mainRotorMesh = new THREE.Mesh(mainRotorGeo, heliLoftMat);
    mainRotorMesh.castShadow = true;
    mainRotorPivot.add(mainRotorMesh);

    const blurDisc = new THREE.Mesh(new THREE.CylinderGeometry(4.85, 4.85, 0.015, 32), blurDiscMat);
    mainRotorPivot.add(blurDisc);
    tiltPivot.add(mainRotorPivot);

    // 3. 4-Blade Tail Rotor Assembly on Swept Vertical Fin
    const tailRotorPivot = new THREE.Group();
    tailRotorPivot.position.set(0.18, 2.02, -5.62);
    const tailRotorGeo = buildHelicopterTailRotorGeometry();
    const tailRotorMesh = new THREE.Mesh(tailRotorGeo, heliLoftMat);
    tailRotorPivot.add(tailRotorMesh);
    tiltPivot.add(tailRotorPivot);

    // 4. FAA Port (Red), Starboard (Green) & Anti-Collision Fin Beacon (Red) Navigation Strobes
    const navRed = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff2b2b })
    );
    navRed.position.set(-1.09, 1.54, -4.35);
    const navGreen = new THREE.Mesh(
      new THREE.SphereGeometry(0.036, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0x22ff66 })
    );
    navGreen.position.set(1.09, 1.54, -4.35);
    const navTail = new THREE.Mesh(
      new THREE.SphereGeometry(0.042, 8, 8),
      new THREE.MeshBasicNodeMaterial({ color: 0xff3b2b })
    );
    navTail.position.set(0, 2.84, -6.04);
    tiltPivot.add(navRed, navGreen, navTail);

    this.scene.add(root);

    return {
      type: 'helicopter',
      label: 'Sightseeing Helicopter',
      mesh: root,
      tiltPivot,
      mainRotorPivot,
      tailRotorPivot,
      position: new THREE.Vector3(-140, 96, SPAWN_Z + 80),
      heading: 2.6,
      speed: 0,
      verticalSpeed: 0,
      pitchAngle: 0,
      rollAngle: 0,
      cameraTargetOffset: new THREE.Vector3(0, 1.55, 0),
      chaseDistance: 11.4,
      chaseHeight: 3.3
    };
  }

  // The player's car becomes another (a parked car they got into): its body, paint and lights made again on the same root
  restyleCar(look) {
    const car = this.entities.car;
    if (!look || !BODY_SPECS[look.kind]) return;
    const root = car.mesh;
    const lights = car.headLights;
    for (const spot of lights || []) { spot.removeFromParent(); spot.target.removeFromParent(); }
    for (const child of [...root.children]) root.remove(child);
    const fresh = this.createCarEntity(look, root, lights);
    const { position, heading } = car;
    Object.assign(car, fresh, { position, heading, prevX: position.x, prevZ: position.z });
    root.traverse((child) => {
      if (child.isMesh && !child.material?.transparent && !child.material?.isMeshBasicNodeMaterial) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.carLook = { kind: look.kind, hex: look.hex, style: look.style ?? 0 };
    root.position.copy(position);
    root.rotation.y = heading;
    root.updateMatrixWorld(true);
  }

  // The car where it is now, standing still
  stopCar(ent = this.entities.car) {
    ent.prevX = ent.position.x;
    ent.prevZ = ent.position.z;
    ent.speed = ent.vx = ent.vz = ent.angularVel = ent.steerAngle = 0;
    ent.pitchVel = ent.rollVel = ent.heaveY = ent.heaveVel = 0;
    ent.chassisPivot.rotation.x = ent.chassisPivot.rotation.z = 0;
    ent.chassisPivot.position.y = 0;
    ent.lastCollisionSpark = null;
    for (const wheel of ent.wheels) if (wheel.isFront) wheel.steerPivot.rotation.y = 0;
    if (ent.carState) ent.carState.value.x = ent.carState.value.w = 0;
  }

  // =========================================================================
  // 5. KAYAK (A RED SIT-IN TOURING KAYAK, ITS PADDLER AND A TWO-BLADED PADDLE)
  // =========================================================================
  createKayakEntity() {
    const root = new THREE.Group();
    root.name = 'PlayerKayak';
    const tiltPivot = new THREE.Group();
    root.add(tiltPivot);

    const hullMat = createCarPaintMaterial(0xc8372a);
    const deckMat = createCarPaintMaterial(0xe0533a);
    const darkMat = new THREE.MeshStandardNodeMaterial({ color: 0x15171a, roughness: 0.75 });
    const shaftMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a2d33, roughness: 0.4, metalness: 0.5 });
    const bladeMat = new THREE.MeshStandardNodeMaterial({ color: 0xf2c230, roughness: 0.45 });

    // The hull and deck: halves of a long ellipsoid, narrowed to points at the bow and stern and rising a little there
    const L = 1.85, B = 0.36;
    const shape = (geo, height) => {
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const t = Math.min(1, Math.abs(pos.getZ(i)));
        pos.setXYZ(i, pos.getX(i) * B * (1 - 0.55 * t * t), pos.getY(i) * height * (1 - 0.25 * t * t) + 0.1 + 0.09 * t ** 3, pos.getZ(i) * L);
      }
      geo.computeVertexNormals();
      return geo;
    };
    const hull = new THREE.Mesh(shape(new THREE.SphereGeometry(1, 28, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0.2), hullMat);
    const deck = new THREE.Mesh(shape(new THREE.SphereGeometry(1, 28, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0.12), deckMat);
    const cockpit = new THREE.Mesh(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2).scale(0.23, 1, 0.37), darkMat);
    cockpit.position.set(0, 0.232, -0.12);
    const coaming = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 28).rotateX(Math.PI / 2).scale(0.24, 0.3, 0.38), darkMat);
    coaming.position.set(0, 0.236, -0.12);
    tiltPivot.add(hull, deck, cockpit, coaming);

    // The paddle: a shaft across the paddler's lap with a blade at each end, turned about by the stroke (see updateKayak)
    const paddle = new THREE.Group();
    paddle.position.set(0, 0.58, 0.16);
    paddle.add(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 2.1, 8).rotateZ(Math.PI / 2), shaftMat));
    for (const end of [1, -1]) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.012), bladeMat);
      blade.position.x = end * 1.02;
      paddle.add(blade);
    }
    tiltPivot.add(paddle);

    // The paddler (see pedestrians.js), sitting in the cockpit with their hands on the shaft
    const paddlerCrowd = new PersonCrowd(1, { farDistance: Infinity });
    paddlerCrowd.meshes.forEach((m) => this.scene.add(m));
    const paddlerRig = new PersonRig({ seed: 31.4, scale: 1.0, girth: 1.0, hair: 0.3 });

    const kayakShadowGeo = new THREE.PlaneGeometry(0.9, 3.9);
    kayakShadowGeo.rotateX(-Math.PI * 0.5);
    const kayakShadow = new THREE.Mesh(kayakShadowGeo, createContactShadowMaterial());
    kayakShadow.position.set(0, 0.015, 0);
    kayakShadow.renderOrder = 998;
    root.add(kayakShadow);

    this.scene.add(root);

    const launch = nearestWater(KAYAK_LAUNCH.x, KAYAK_LAUNCH.z, 400) || KAYAK_LAUNCH;
    const y = waterLevel(launch.x, launch.z) ?? groundHeight(launch.x, launch.z);
    return {
      type: 'kayak',
      label: 'Kayak',
      mesh: root,
      tiltPivot,
      paddle,
      paddlerCrowd,
      paddlerRig,
      seat: new THREE.Vector3(0, 0.02, -0.14),
      hands: [new THREE.Vector3(), new THREE.Vector3()],
      twist: 0,
      position: new THREE.Vector3(launch.x, y, launch.z),
      heading: this.downstreamHeading(launch.x, launch.z, Math.PI / 2),
      speed: 0,
      driftX: 0,
      driftZ: 0,
      turnVel: 0,
      leftEmpty: true, // it waits at the livery until someone gets in
      stroke: 0,
      strokeAmp: 0,
      strokes: 0,
      cameraTargetOffset: new THREE.Vector3(0, 0.85, 0),
      chaseDistance: 5.6,
      chaseHeight: 1.75
    };
  }

  // The way downstream at (x, z) as a heading, or `fallback` where the water doesn't run
  downstreamHeading(x, z, fallback = 0) {
    const flow = this._flow ??= { x: 0, z: 0 };
    return riverFlow(x, z, flow) ? Math.atan2(flow.x, flow.z) : fallback;
  }

  // On foot beside what the player was in: the car's driver's side (or the other, or behind or in front of it), the
  // bike's or the helicopter's side, the nearest dry bank to the kayak
  placePersonBeside(v) {
    const p = this.entities.person;
    const shape = collisionBody('person', 0.48, 0, 0.05);
    const free = (x, z) => {
      if (riverDepth(x, z) > 0.02) return false;
      const y = this.getGroundHeight(x, z, 'person');
      for (const c of this.nearColliders(x, z, 3)) if (buildingContact(c, x, y, z, shape)) return false;
      return true;
    };
    const sn = Math.sin(v.heading), cs = Math.cos(v.heading);
    let spot = null;
    if (v.type === 'kayak') {
      for (let r = 1.5; r <= 60 && !spot; r += 1.5) {
        for (let i = 0; i < 24; i++) {
          const a = v.heading + Math.PI / 2 + i * Math.PI / 12;
          const x = v.position.x + Math.sin(a) * r, z = v.position.z + Math.cos(a) * r;
          if (free(x, z)) { spot = { x, z }; break; }
        }
      }
    } else {
      const side = v.type === 'car' ? 1.75 : v.type === 'helicopter' ? 2.4 : 0.8;
      const end = v.type === 'car' ? 3.4 : v.type === 'helicopter' ? 7.5 : 1.6;
      for (const [s, f] of [[side, 0.4], [-side, 0.4], [0, -end], [0, end]]) {
        const x = v.position.x + cs * s + sn * f, z = v.position.z - sn * s + cs * f;
        if (free(x, z)) { spot = { x, z }; break; }
      }
    }
    const heading = v.type === 'kayak' && spot ? Math.atan2(spot.x - v.position.x, spot.z - v.position.z) : v.heading;
    if (!spot) {
      this.teleportActiveTo(v.position.x, v.position.z, heading);
      return;
    }
    p.position.set(spot.x, this.getGroundHeight(spot.x, spot.z, 'person'), spot.z);
    p.heading = heading;
    p.speed = 0;
    p.verticalVel = 0;
    p._charHidden = false;
    if (p.mesh) p.mesh.visible = true;
    p.rig.reset(p.position.x, p.position.z, p.heading, personGround, this);
    p.crowd.begin();
    p.crowd.add(p.rig, 0);
    p.crowd.end();
    p.mesh.position.copy(p.position);
    p.mesh.rotation.y = p.heading;
  }

  // F: out of whatever the player is in, or into the nearest thing to get into (their car, the bike, the kayak, the
  // helicopter, a parked car (`parked` finds one) or one going by in `traffic`). Says which mode to switch to, and the parked car to take; null
  // when there's nothing near to get into (or the helicopter is still in the air).
  enterOrExit(parked = null, traffic = null) {
    const mode = this.activeMode;
    const p = this.entities.person;
    if (p.fallen && mode === 'person') return null;
    if (mode !== 'person') {
      const v = this.getActiveEntity();
      if (mode === 'helicopter' && v.position.y - this.helicopterFloor(v, v.position.y) > 0.8) return null;
      if (mode === 'car' && Math.hypot(v.speed, v.vx || 0, v.vz || 0) > EXIT_SPEED) return { tooFast: true };
      v.speed = 0;
      if (mode === 'car') this.stopCar(v);
      if (mode === 'helicopter') v.verticalSpeed = 0;
      if (mode === 'kayak') v.driftX = v.driftZ = v.turnVel = 0;
      p.riding = mode;
      return { mode: 'person' };
    }
    let best = null, score = 1;
    const consider = (m, x, z, reach, car = null) => {
      const d = Math.hypot(x - p.position.x, z - p.position.z) / reach;
      if (d < score) { score = d; best = { mode: m, parked: car }; }
    };
    for (const [m, reach] of [['car', 4.2], ['cyclist', 2.4], ['kayak', 7], ['helicopter', 7.5]]) {
      const e = this.entities[m];
      if (m === 'helicopter' && e.position.y - this.helicopterFloor(e, e.position.y) > 0.8) continue;
      consider(m, e.position.x, e.position.z, reach);
    }
    const near = parked?.nearest(p.position.x, p.position.z, 4.2);
    if (near) consider('car', near.x, near.z, 4.2, near);
    // a car going by in traffic (traffic.js), within reach
    const passing = traffic?.nearestCar(p.position.x, p.position.z, 5);
    if (passing != null && passing / 5 < score) { score = passing / 5; best = { mode: 'car', moving: true }; }
    if (best) {
      p.riding = best.mode;
      this.entities[best.mode].leftEmpty = false;
    }
    return best;
  }

  // On a raised curb island (city-config.js BLOCKS: the real blocks, malls & plazas), not in a park
  isPointOnSidewalk(x, z) {
    const b = blockAt(x, z);
    return !!b && !(b.park > 0.6 && !b.median);
  }

  getGroundHeight(x, z, mode = 'person') {
    // Lamp: the ground's own height there (terrain.js), with what's laid on it
    const ground = groundHeight(x, z);
    // Inside a big park drawn on its own (none in Ann Arbor: city-config.js BIG_PARK_BOUNDS is far away)
    const cp = BIG_PARK_BOUNDS;
    if (x > cp.minX && x < cp.maxX && z > cp.minZ && z < cp.maxZ) {
      return ground + 1.24;
    }
    // Inside Bryant Park's Great Lawn (west of the New York Public Library, 40th-42nd St), which stands level
    const lawn = bryantParkLawn;
    if (lawn && x > lawn.minX && x < lawn.maxX && z > lawn.minZ && z < lawn.maxZ) {
      return lawn.top;
    }
    if (mode === 'person') {
      return ground + (this.isPointOnSidewalk(x, z) ? TOWN_BOUNDS.sidewalkHeight : 0.0);
    }
    if (mode === 'kayak') return waterLevel(x, z) ?? ground;
    return ground;
  }

  // Static colliders within `r` of (x, z), kept in their original order and indexed once into 48 m cells.
  nearColliders(x, z, r) {
    const CELL = 48;
    const key = (ix, iz) => (ix + 4096) * 8192 + (iz + 4096);
    if (!this._colliderCells) {
      this._colliderCells = new Map();
      this.colliders.forEach((c, i) => {
        c._order = i;
        for (let ix = Math.floor(c.minX / CELL); ix <= Math.floor(c.maxX / CELL); ix++) {
          for (let iz = Math.floor(c.minZ / CELL); iz <= Math.floor(c.maxZ / CELL); iz++) {
            const k = key(ix, iz);
            let list = this._colliderCells.get(k);
            if (!list) this._colliderCells.set(k, (list = []));
            list.push(c);
          }
        }
      });
      this._nearList = [];
      this._nearStamp = 0;
    }
    const out = this._nearList;
    out.length = 0;
    const stamp = ++this._nearStamp;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const list = this._colliderCells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c._seen === stamp) continue;
          c._seen = stamp;
          out.push(c);
        }
      }
    }
    if (out.length > 1) out.sort((a, b) => a._order - b._order);
    return out;
  }

  resolveHorizontalCollision(pos, radius, carEntity = null, entity = carEntity) {
    // The detailed town (the helicopter may roam out over the countryside around it)
    const heli = this.activeMode === 'helicopter';
    const m = heli ? 6000 : 0;
    pos.x = Math.max(TOWN_BOUNDS.minX - m, Math.min(TOWN_BOUNDS.maxX + m, pos.x));
    pos.z = Math.max(TOWN_BOUNDS.minZ + (heli ? -6000 : 30), Math.min(TOWN_BOUNDS.maxZ + m, pos.z));
    if (this.activeMode !== 'helicopter' && getTownBoundsAtZ) {
      const shore = getTownBoundsAtZ(pos.z);
      const minShoreX = shore.westX + 8.0;
      const maxShoreX = shore.eastX - 8.0;
      if (pos.x < minShoreX) {
        pos.x = minShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      } else if (pos.x > maxShoreX) {
        pos.x = maxShoreX;
        if (carEntity && carEntity.speed) carEntity.speed *= 0.4;
      }
    }

    const body = collisionBody(this.activeMode, radius, carEntity ? carEntity.heading : 0);
    const { sin: sinH, cos: cosH, extX, extZ } = body;
    const contact = this._buildingContact ??= { nx: 0, nz: 0, depth: 0 };

    const reach = Math.max(extX, extZ) + 6;
    let gx = pos.x;
    let gz = pos.z;
    let near = this.nearColliders(gx, gz, reach);
    const standing = heli ? this._heliStanding : null;
    for (let i = 0; i < near.length; i++) {
      const c = near[i];
      // the helicopter flies down into the stadium's bowl, and sits on the roof under its skids
      if (heli && (isStadium(c) || c.thin || standing?.has(c))) continue;
      if (buildingContact(c, pos.x, pos.y, pos.z, body, contact)) {
        const { nx, nz, depth } = contact;
        // a tree, pole or sign post the car hits hard enough goes over (knockdowns.js) instead of stopping it
        if (carEntity && c.knock && this.knockdowns) {
          const vx = sinH * carEntity.speed + (carEntity.vx || 0), vz = cosH * carEntity.speed + (carEntity.vz || 0);
          const felled = this.knockdowns.hit(c, -(vx * nx + vz * nz), carEntity.drive?.mass || 1500, vx, vz);
          if (felled) {
            this.reportCollision(entity, c, 'building', pos.x - nx * 1.2, pos.y + 0.56, pos.z - nz * 1.2, nx, 0, nz, -(vx * nx + vz * nz));
            carEntity.speed *= felled.keep;
            carEntity.vx = (carEntity.vx || 0) * felled.keep;
            carEntity.vz = (carEntity.vz || 0) * felled.keep;
            carEntity.pitchVel = (carEntity.pitchVel || 0) + 1.2;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + 0.6;
            continue;
          }
        }
        pos.x += nx * depth;
        pos.z += nz * depth;

        // a bike into a wall, a tree or a pole faster than a jog throws its rider
        if (entity?.type === 'cyclist'
          && -(Math.sin(entity.heading) * entity.speed * nx + Math.cos(entity.heading) * entity.speed * nz) > RIDER_THROW_SPEED) {
          this._riderThrow = Math.max(this._riderThrow || 0, Math.abs(entity.speed));
        }
        if (this._collisionListener && entity && entity.type !== 'person') {
          const sin = carEntity ? sinH : Math.sin(entity.heading);
          const cos = carEntity ? cosH : Math.cos(entity.heading);
          const approachSpeed = -((sin * entity.speed + (entity.vx || 0)) * nx + (cos * entity.speed + (entity.vz || 0)) * nz);
          const support = carEntity ? Math.abs(nx * cos - nz * sin) * 0.86 + Math.abs(nx * sin + nz * cos) * 2.18 : radius;
          this.reportCollision(entity, c, 'building', pos.x - nx * support, pos.y + (heli ? 1.1 : 0.56), pos.z - nz * support,
            nx, 0, nz, approachSpeed);
        }

        if (carEntity) {
          const totalVx = sinH * carEntity.speed + (carEntity.vx || 0);
          const totalVz = cosH * carEntity.speed + (carEntity.vz || 0);
          const vn = -(totalVx * nx + totalVz * nz);
          if (vn > 0.5) {
            const headOn = Math.abs(sinH * nx + cosH * nz);
            const sideDot = cosH * nx - sinH * nz;
            carEntity.vx = (carEntity.vx || 0) + nx * vn * 0.42;
            carEntity.vz = (carEntity.vz || 0) + nz * vn * 0.42;
            if (headOn > 0.72) {
              carEntity.speed = -carEntity.speed * 0.25;
            } else {
              carEntity.speed *= (1.0 - 0.62 * headOn);
              carEntity.angularVel = (carEntity.angularVel || 0) + sideDot * (sinH * nx + cosH * nz >= 0 ? -1 : 1) * Math.min(3.2, vn * 0.22);
            }
            carEntity.pitchVel = (carEntity.pitchVel || 0) + (sinH * nx + cosH * nz) * Math.min(14.0, vn) * 0.16;
            carEntity.rollVel = (carEntity.rollVel || 0) - sideDot * Math.min(14.0, vn) * 0.22;
            carEntity.heaveVel = (carEntity.heaveVel || 0) + Math.min(1.4, vn * 0.11);
            if (vn > 2.2) {
              carEntity.lastCollisionSpark = {
                x: pos.x - nx * extX * 0.92,
                y: 0.56,
                z: pos.z - nz * extZ * 0.92,
                nx,
                nz,
                speed: vn
              };
            }
          }
        }

        // A push that carried it far from where the candidates were gathered (dropped inside a building): gather
        // them again around where it is now, carrying on in the same order
        if (Math.abs(pos.x - gx) > 5 || Math.abs(pos.z - gz) > 5) {
          gx = pos.x;
          gz = pos.z;
          const order = c._order;
          near = this.nearColliders(gx, gz, reach);
          i = -1;
          while (i + 1 < near.length && near[i + 1]._order <= order) i++;
        }
      }
    }
  }

  // Pose the skinned characters once every entity has moved: the pedestrian's rig walks (or runs, turns, jumps) it to
  // where it now is, planting its feet on the ground; the cyclist sits on the bike, hands on the grips, feet on the
  // pedals, helmet on its head
  poseCharacters(dt, focusPos = null) {
    const focus = focusPos || this.getActiveEntity()?.position;
    const maxDistSq = 320 * 320;

    const p = this.entities.person;
    if (p) {
      const dx = focus ? p.position.x - focus.x : 0;
      const dz = focus ? p.position.z - focus.z : 0;
      if (!p.riding && (this.activeMode === 'person' || dx * dx + dz * dz <= maxDistSq)) {
        p._charHidden = false;
        if (p.mesh) p.mesh.visible = true;
        const air = p.position.y - this.getGroundHeight(p.position.x, p.position.z, 'person');
        if (p.fallen?.getUp >= 0) p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, 0, true, DIVE_GET_UP + p.fallen.getUp);
        else if (!p.fallen) p.rig.update(dt, p.position.x, p.position.z, p.heading, personGround, this, air > 0.02 ? air : 0);
        p.crowd.begin();
        p.crowd.add(p.rig, 0);
        p.crowd.end();
      } else if (!p._charHidden) {
        p.rig.placed = false;
        p.crowd.begin();
        p.crowd.end();
        if (p.crowd.updates > 2) {
          if (p.mesh) p.mesh.visible = false;
          p._charHidden = true;
        }
      }
    }

    const b = this.entities.cyclist;
    if (b) {
      const dx = focus ? b.position.x - focus.x : 0;
      const dz = focus ? b.position.z - focus.z : 0;
      if (this.activeMode === 'cyclist' || (!b.leftEmpty && dx * dx + dz * dz <= maxDistSq)) {
        if (b.helmet) b.helmet.visible = true;
        const moved =
          this.activeMode === 'cyclist' ||
          b._riderHidden ||
          b._posedX !== b.position.x ||
          b._posedY !== b.position.y ||
          b._posedZ !== b.position.z ||
          b._posedH !== b.heading ||
          b._posedLean !== b.leanAngle ||
          b._posedPedal !== b.pedalPhase;
        b._riderHidden = false;
        if (moved) {
          b.riderRig.ride(b.leanPivot, b.pedalPhase, b.bikeFrame);
          b.riderCrowd.begin();
          b.riderCrowd.add(b.riderRig, 0);
          b.riderCrowd.end();
          b.helmet.quaternion.copy(b.riderRig.headQuaternion);
          b.helmet.position.set(0, 0.175, -0.012).applyQuaternion(b.helmet.quaternion).add(b.riderRig.headPosition);
          b._posedX = b.position.x;
          b._posedY = b.position.y;
          b._posedZ = b.position.z;
          b._posedH = b.heading;
          b._posedLean = b.leanAngle;
          b._posedPedal = b.pedalPhase;
        }
      } else if (!b._riderHidden) {
        b.riderCrowd.begin();
        b.riderCrowd.end();
        if (b.riderCrowd.updates > 2) {
          if (b.helmet) b.helmet.visible = false;
          b._riderHidden = true;
          b._posedX = NaN;
        }
      }
    }

    const k = this.entities.kayak;
    if (k) {
      const dx = focus ? k.position.x - focus.x : 0;
      const dz = focus ? k.position.z - focus.z : 0;
      // the paddler is in it only while the player paddles it, or has left it with someone still in it
      const manned = this.activeMode === 'kayak' || !k.leftEmpty;
      if (manned && (this.activeMode === 'kayak' || dx * dx + dz * dz <= maxDistSq)) {
        k._paddlerHidden = false;
        k.paddlerRig.paddle(k.tiltPivot, k.seat, k.hands, k.twist);
        k.paddlerCrowd.begin();
        k.paddlerCrowd.add(k.paddlerRig, 0);
        k.paddlerCrowd.end();
      } else if (!k._paddlerHidden) {
        k.paddlerCrowd.begin();
        k.paddlerCrowd.end();
        if (k.paddlerCrowd.updates > 2) k._paddlerHidden = true;
      }
    }
  }

  update(dt, elapsed, focusPos = null) {
    const heli = this.entities.helicopter;
    heli.mainRotorPivot.rotation.y += dt * 24.0;
    heli.tailRotorPivot.rotation.x += dt * 32.0;

    if (this.activeMode === 'person') {
      this.updatePerson(dt, elapsed);
    } else if (this.entities.person.riding) {
      // In something: carried along with it, out of sight
      const p = this.entities.person;
      p.position.copy(this.entities[p.riding].position);
      p.speed = 0;
    } else {
      // Keep the sidewalk pedestrian walking naturally when not actively controlled
      const p = this.entities.person;
      const walkSpeed = 1.48;
      p.speed = walkSpeed;
      p.position.x += Math.sin(p.heading) * walkSpeed * dt;
      p.position.z += Math.cos(p.heading) * walkSpeed * dt;
      if (p.position.z < -340) p.heading = 0;
      else if (p.position.z > 340) p.heading = Math.PI;
      p.position.y = this.getGroundHeight(p.position.x, p.position.z, 'person');
    }

    if (this.activeMode === 'car') {
      this.updateCar(dt, elapsed);
    } else if (this.activeMode === 'cyclist') {
      this._riderThrow = 0;
      this.updateCyclist(dt, elapsed);
      if (this._riderThrow) this.throwRider(this._riderThrow);
    } else if (this.activeMode === 'helicopter') {
      this.updateHelicopter(dt, elapsed);
    } else if (this.activeMode === 'kayak') {
      this.updateKayak(dt, elapsed);
    }

    for (const key of Object.keys(this.entities)) {
      const e = this.entities[key];
      e.mesh.position.copy(e.position);
      // Lamp: a car or bike tilts with the slope under its wheels (terrain.js); yaw first, then pitch and roll
      if (e.type === 'car' || e.type === 'cyclist') {
        const [pitch, roll] = groundTilt(e.position.x, e.position.z, e.heading, e.type === 'car' ? 4.2 : 1.6, e.type === 'car' ? 1.8 : 0.4);
        e.mesh.rotation.set(-pitch, e.heading, e.type === 'car' ? -roll : 0, 'YXZ');
      } else {
        e.mesh.rotation.y = e.heading;
      }
    }

    // Modulate clustered vehicle & bike lights by time of day (off during Midday & Golden Hour; fade in at Dusk & Night)
    const glow = cityUniforms && cityUniforms.uInteriorGlow ? cityUniforms.uInteriorGlow.value : 0.48;
    const beamScale = Math.min(1.28, Math.max(0.0, (glow - 0.60) * 1.45));
    const car = this.entities.car;
    if (car.headLights) {
      for (const spot of car.headLights) {
        // Accelerating does not change the headlamp output or range.
        spot.intensity = HEADLIGHTS.intensity * beamScale;
      }
    }
    const bike = this.entities.cyclist;
    if (bike.headLight) {
      const bikeActive = this.activeMode === 'cyclist';
      bike.headLight.intensity = bikeActive ? 115 * beamScale : 0;
    }

    this.poseCharacters(dt, focusPos);
  }

  // Knocked off the bike or down by a car: the player's body goes limp, flung by (vx, vy, vz), and gets up where it
  // came to rest (through the push-up of a dive); the controls do nothing meanwhile
  knockDown(vx, vy, vz, spin = 0, tip = 0) {
    const p = this.entities.person;
    if (p.fallen && p.rig.ragdolling) {
      // a car still pushing the body knocks it on once, not every frame it touches
      if (p.rig.rag.time - (p.fallen.kick ?? -1) > 0.5) p.rig.kickRagdoll(vx * 0.6, vy * 0.5, vz * 0.6);
      p.fallen.kick = p.rig.rag.time;
      return;
    }
    if (!p.rig.placed) p.rig.reset(p.position.x, p.position.z, p.heading, personGround, this);
    p.rig.startRagdoll(vx, vy, vz, spin, tip);
    p.fallen = { getUp: -1 };
    p.speed = p.verticalVel = 0;
    p._charHidden = false;
    if (p.mesh) p.mesh.visible = true;
  }

  // Thrown over the handlebars of a bike that hit something hard at `speed` (or off it the way (hx, hz) a car hit
  // it): the bike stays where it stopped and the player lands on foot
  throwRider(speed, hx = 0, hz = 0) {
    const b = this.entities.cyclist, p = this.entities.person;
    const sn = Math.sin(b.heading), cs = Math.cos(b.heading);
    p.riding = null;
    b.leftEmpty = true;
    p.position.set(b.position.x + sn * 0.2, b.position.y, b.position.z + cs * 0.2);
    p.heading = b.heading;
    p.rig.reset(p.position.x, p.position.z, p.heading, personGround, this);
    this.setMode('person');
    b.speed = 0;
    const v = speed * 0.85;
    if (hx || hz) this.knockDown(sn * v * 0.5 + hx, 2 + speed * 0.15, cs * v * 0.5 + hz, (hash01(speed) - 0.5) * 4, 0.8);
    else this.knockDown(sn * v, 1.8 + speed * 0.12, cs * v, (hash01(speed) - 0.5) * 2, 1.6 + speed * 0.25);
  }

  updatePerson(dt) {
    const p = this.entities.person;
    if (p.fallen) {
      if (p.fallen.getUp < 0) {
        if (p.rig.stepRagdoll(dt, personGround, this, true)) {
          p.heading = p.rig.yaw = p.rig.ragdollHeading();
          p.rig.ragdolling = false;
          p.fallen.getUp = 0;
        }
        p.position.x = p.rig.x;
        p.position.z = p.rig.z;
      } else if ((p.fallen.getUp += dt) > PEDESTRIAN_DIVE_DURATION - DIVE_GET_UP) p.fallen = null;
      p.speed = p.verticalVel = 0;
      p.position.y = this.getGroundHeight(p.position.x, p.position.z, 'person');
      return;
    }
    const maxSpeed = 8.2;
    const turnRate = 2.6;

    let targetSpeed = 0;
    if (this.keys.forward) targetSpeed = maxSpeed * this.keys.forward;
    else if (this.keys.backward) targetSpeed = -maxSpeed * 0.65 * this.keys.backward;

    if (this.keys.left) p.heading += turnRate * dt * this.keys.left;
    if (this.keys.right) p.heading -= turnRate * dt * this.keys.right;

    const accelerating = Math.abs(targetSpeed) > Math.abs(p.speed) && p.speed * targetSpeed >= 0;
    const acceleration = accelerating ? 5.5 * Math.abs(targetSpeed) / maxSpeed : 12;
    p.speed += Math.max(-acceleration * dt, Math.min(acceleration * dt, targetSpeed - p.speed));

    p.position.x += Math.sin(p.heading) * p.speed * dt;
    p.position.z += Math.cos(p.heading) * p.speed * dt;
    this.resolveHorizontalCollision(p.position, 0.48);

    const groundY = this.getGroundHeight(p.position.x, p.position.z, 'person');
    const grounded = p.grounded ?? true;
    if (this.keys.up && grounded) {
      p.verticalVel = 5.2;
    }
    p.verticalVel -= 14.5 * dt;
    p.position.y += p.verticalVel * dt;
    // Lamp: walking downhill, or off a curb, keeps the feet on the ground rather than stepping into the air
    if (p.position.y < groundY || (grounded && p.verticalVel <= 0 && p.position.y - groundY < 0.4)) {
      p.position.y = groundY;
      p.verticalVel = 0;
      p.grounded = true;
    } else {
      p.grounded = false;
    }
  }

  updateCar(dt) {
    if (dt <= 0) return;
    const c = this.entities.car;
    const D = c.drive || (c.drive = carDrive(this.carLook?.kind));

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -this.keys.backward;

    const braking = c.speed * throttle < 0;

    let steerInput = 0;
    if (this.keys.left) steerInput = this.keys.left;
    if (this.keys.right) steerInput = -this.keys.right;

    const prevX = c.position.x;
    const prevZ = c.position.z;
    c.prevX = prevX;
    c.prevZ = prevZ;
    // Short steps keep grip, impacts and suspension consistent at different display rates.
    const steps = Math.ceil(dt * 120);
    const step = dt / steps;
    const steerResponse = 1 - Math.exp(-D.steer * step);
    const yawResponse = 1 - Math.exp(-5 * step);
    const tireResponse = 1 - Math.exp(-4 * step);
    for (let i = 0; i < steps; i++) {
      const sin = Math.sin(c.heading), cos = Math.cos(c.heading);
      const vx = sin * c.speed + c.vx, vz = cos * c.speed + c.vz;
      const forward = vx * sin + vz * cos;
      const sideways = vx * cos - vz * sin;
      const speed = driveSpeed(forward, throttle, step, D);
      const acceleration = (speed - forward) / step;
      // Braking and cornering share tire grip; air resistance does not use it.
      const tireAcceleration = acceleration + D.drag * forward * Math.abs(forward);
      const grip = Math.sqrt(Math.max(0, D.grip ** 2 - tireAcceleration ** 2));
      // A handbrake slide preserves steering while reducing lateral grip; fade it out at low speed.
      const handbrake = forward * throttle < 0 ? Math.abs(throttle) * Math.min(1, Math.abs(forward) / 5) : 0;
      const lateralGrip = grip * (1 - 0.7 * handbrake);
      const steeringGrip = grip + (D.grip - grip) * handbrake;

      // Full lock at parking speeds, progressively less steering at road speeds.
      const turn = D.wheelbase * D.cornering;
      const maxSteer = Math.atan(turn / Math.max(speed * speed, turn / Math.tan(0.60)));
      c.steerAngle += (steerInput * maxSteer - c.steerAngle) * steerResponse;
      const yawLimit = steeringGrip / Math.max(2, Math.abs(speed));
      const targetYaw = Math.max(-yawLimit, Math.min(yawLimit, speed * Math.tan(c.steerAngle) / D.wheelbase));
      // Collision spin remains part of the yaw velocity; the tires gradually regain control.
      const yawStep = steeringGrip * 0.65 * step;
      c.angularVel += Math.max(-yawStep, Math.min(yawStep, (targetYaw - c.angularVel) * yawResponse));
      c.heading += c.angularVel * step;

      // Turning the chassis must not instantly rotate its momentum. Tires remove sideways slip
      // with a bounded force; longitudinal momentum, including impacts, stays in speed.
      const nextSin = Math.sin(c.heading), nextCos = Math.cos(c.heading);
      const worldX = sin * speed + cos * sideways;
      const worldZ = cos * speed - sin * sideways;
      c.speed = worldX * nextSin + worldZ * nextCos;
      const slip = worldX * nextCos - worldZ * nextSin;
      const correction = Math.max(-lateralGrip * step, Math.min(lateralGrip * step, -slip * tireResponse));
      c.vx = nextCos * (slip + correction);
      c.vz = -nextSin * (slip + correction);
      c.position.x += (nextSin * c.speed + c.vx) * step;
      c.position.z += (nextCos * c.speed + c.vz) * step;
      this.resolveHorizontalCollision(c.position, 1.35, c);

      const targetPitch = -Math.max(-1, Math.min(1, acceleration / D.acceleration)) * D.pitch;
      const targetRoll = Math.max(-0.09, Math.min(0.09, correction / step * D.roll));
      c.pitchVel += ((targetPitch - c.chassisPivot.rotation.x) * 68 - c.pitchVel * 11.2) * step;
      c.rollVel += ((targetRoll - c.chassisPivot.rotation.z) * 68 - c.rollVel * 11.2) * step;
      c.chassisPivot.rotation.x = Math.max(-0.22, Math.min(0.22, c.chassisPivot.rotation.x + c.pitchVel * step));
      c.chassisPivot.rotation.z = Math.max(-0.26, Math.min(0.26, c.chassisPivot.rotation.z + c.rollVel * step));
      c.heaveVel += (-c.heaveY * 85 - c.heaveVel * 12) * step;
      c.heaveY = Math.max(-0.08, Math.min(0.14, c.heaveY + c.heaveVel * step));
    }
    c.position.y = this.getGroundHeight(c.position.x, c.position.z, 'car');
    c.chassisPivot.position.y = c.heaveY;

    if (c.carState) {
      c.carState.value.x = braking ? 1 : 0;
      c.carState.value.w = c.speed < -0.2 ? 1 : 0;
    }

    const forwardDist = (c.position.x - prevX) * Math.sin(c.heading) + (c.position.z - prevZ) * Math.cos(c.heading);
    const rawWheelStep = forwardDist / 0.35;
    const wheelStep = Math.sign(rawWheelStep) * Math.min(Math.abs(rawWheelStep), 0.48);
    c.wheelSpin = (c.wheelSpin + wheelStep) % (Math.PI * 2);
    for (const w of c.wheels) {
      w.tire.rotation.x = c.wheelSpin + (w.isFront ? 0.0 : 0.55);
      if (w.isFront) {
        w.steerPivot.rotation.y = c.steerAngle;
      }
    }
  }

  updateCyclist(dt) {
    const b = this.entities.cyclist;

    let throttle = 0;
    if (this.keys.forward) throttle = this.keys.forward;
    else if (this.keys.backward) throttle = -0.6 * this.keys.backward;

    b.speed = driveSpeed(b.speed, throttle, dt, BICYCLE_DRIVE);

    let turnInput = 0;
    if (this.keys.left) turnInput = this.keys.left;
    if (this.keys.right) turnInput = -this.keys.right;

    if (Math.abs(b.speed) > 0.15) {
      const dirSign = b.speed >= 0 ? 1 : -1;
      b.heading += turnInput * 2.15 * dirSign * dt;
    }

    b.position.x += Math.sin(b.heading) * b.speed * dt;
    b.position.z += Math.cos(b.heading) * b.speed * dt;
    this.resolveHorizontalCollision(b.position, 0.65, null, b);
    b.position.y = this.getGroundHeight(b.position.x, b.position.z, 'cyclist');

    const targetLean = -turnInput * Math.min(1.0, Math.abs(b.speed) / 9.0) * 0.34;
    b.leanAngle += (targetLean - b.leanAngle) * Math.min(1, dt * 9);
    b.leanPivot.rotation.z = b.leanAngle;

    const wheelDelta = (b.speed / 0.35) * dt;
    b.frontWheel.rotation.x += wheelDelta;
    b.rearWheel.rotation.x += wheelDelta;

    // The cranks turn with the rear wheel through the gears while pedalling (~110 rpm at cruising speed) and
    // freewheel otherwise; the rider's feet follow the pedals (see poseCharacters)
    if (throttle > 0 && wheelDelta > 0) b.pedalPhase += wheelDelta / 3.2;
    b.crankPivot.rotation.x = b.pedalPhase;
    for (const pedal of b.pedals) pedal.rotation.x = -b.pedalPhase;
  }

  // Paddling: forward and back paddle, left and right turn; the river's current carries the kayak downstream, and the
  // banks stop it (it only goes where the water is open, riverDepth). The paddle sweeps one blade then the other through
  // the water, and `strokes` counts each blade going in (the splash, main.js).
  updateKayak(dt, elapsed) {
    if (dt <= 0) return;
    const k = this.entities.kayak;
    const throttle = Number(this.keys.forward || 0) - 0.6 * Number(this.keys.backward || 0);
    const turn = Number(this.keys.left || 0) - Number(this.keys.right || 0);

    if (throttle) {
      const target = throttle * 4.4;
      const rate = 1.7 * dt;
      k.speed += Math.max(-rate, Math.min(rate, target - k.speed));
    } else {
      k.speed *= Math.exp(-0.45 * dt);
    }
    const turnTarget = turn * (0.95 + Math.min(1, Math.abs(k.speed) / 3) * 0.45);
    k.turnVel += (turnTarget - k.turnVel) * Math.min(1, dt * 3.2);

    // the current, strongest out in the middle of the river
    const flow = this._flow ??= { x: 0, z: 0 };
    let cx = 0, cz = 0;
    if (riverFlow(k.position.x, k.position.z, flow)) {
      const pull = KAYAK_CURRENT * this.riverScale * (0.4 + 0.6 * riverDepth(k.position.x, k.position.z));
      cx = flow.x * pull;
      cz = flow.z * pull;
    }
    const follow = Math.min(1, dt * 1.2);
    k.driftX += (cx - k.driftX) * follow;
    k.driftZ += (cz - k.driftZ) * follow;

    // afloat: the middle, the bow and the stern all over open water
    const afloat = (x, z, h) => {
      const sn = Math.sin(h) * 1.55, cs = Math.cos(h) * 1.55;
      return riverDepth(x, z) > 0.45 && riverDepth(x + sn, z + cs) > 0.2 && riverDepth(x - sn, z - cs) > 0.2;
    };
    const x = k.position.x, z = k.position.z;
    if (!afloat(x, z, k.heading) && riverDepth(x, z) < 0.2) {
      // somehow ashore: back to the nearest water
      const water = nearestWater(x, z, 2500);
      if (water) { k.position.x = water.x; k.position.z = water.z; }
    }
    let heading = k.heading + k.turnVel * dt;
    if (!afloat(k.position.x, k.position.z, heading)) { heading = k.heading; k.turnVel *= 0.3; }
    k.heading = heading;
    const vx = Math.sin(heading) * k.speed + k.driftX, vz = Math.cos(heading) * k.speed + k.driftZ;
    const nx = k.position.x + vx * dt, nz = k.position.z + vz * dt;
    if (afloat(nx, nz, heading)) {
      k.position.x = nx; k.position.z = nz;
    } else if (afloat(nx, k.position.z, heading)) {
      k.position.x = nx; k.speed *= 1 - Math.min(1, dt * 2); k.driftZ = 0;
    } else if (afloat(k.position.x, nz, heading)) {
      k.position.z = nz; k.speed *= 1 - Math.min(1, dt * 2); k.driftX = 0;
    } else {
      // nosed into the bank: stop, and ease back out towards deeper water
      if (Math.abs(k.speed) > 0.8) this.reportCollision(k, groundCollider, 'ground', nx, k.position.y + 0.2, nz, 0, 1, 0, Math.abs(k.speed) * 0.4);
      k.speed *= 0.3;
      k.driftX = k.driftZ = 0;
      const e = 1.5;
      const gx = riverDepth(k.position.x + e, k.position.z) - riverDepth(k.position.x - e, k.position.z);
      const gz = riverDepth(k.position.x, k.position.z + e) - riverDepth(k.position.x, k.position.z - e);
      const gl = Math.hypot(gx, gz);
      if (gl > 1e-4) {
        const px = k.position.x + gx / gl * 0.6 * dt, pz = k.position.z + gz / gl * 0.6 * dt;
        if (riverDepth(px, pz) >= riverDepth(k.position.x, k.position.z)) { k.position.x = px; k.position.z = pz; }
      }
    }
    k.position.y = waterLevel(k.position.x, k.position.z) ?? k.position.y;

    // the stroke: one blade, then the other, at a pace set by how hard the player paddles
    const effort = Math.min(1, Math.max(Math.abs(throttle), Math.abs(turn)));
    k.strokeAmp += ((effort > 0.05 ? 1 : 0) - k.strokeAmp) * Math.min(1, dt * 4);
    const entry = (phase) => Math.floor((phase - 0.15 * Math.PI) / Math.PI);
    const before = entry(k.stroke);
    if (effort > 0.05) k.stroke += dt * Math.PI * 2 * 0.75 * (0.6 + 0.4 * effort) * (throttle < 0 ? -1 : 1);
    if (entry(k.stroke) !== before) {
      k.strokes++;
      k.strokeSide = Math.sin(k.stroke) > 0 ? -1 : 1;
    }
    const roll = k.strokeAmp * 0.72 * Math.sin(k.stroke);
    const yaw = k.strokeAmp * 0.55 * Math.cos(k.stroke);
    k.paddle.rotation.set(0, yaw, roll, 'YZX');
    const dx = Math.cos(roll) * Math.cos(yaw), dy = Math.sin(roll), dz = -Math.cos(roll) * Math.sin(yaw);
    const c = k.paddle.position;
    k.hands[0].set(c.x + dx * 0.34, c.y + dy * 0.34, c.z + dz * 0.34);
    k.hands[1].set(c.x - dx * 0.34, c.y - dy * 0.34, c.z - dz * 0.34);
    k.twist = -yaw * 0.6;

    // bobbing on the water, leaning into turns and rocking with the stroke
    k.tiltPivot.position.y = Math.sin(elapsed * 1.7) * 0.015;
    k.tiltPivot.rotation.z = -k.turnVel * 0.06 * Math.min(1, Math.abs(k.speed) / 2) + Math.sin(elapsed * 1.3) * 0.012 + roll * 0.03;
    k.tiltPivot.rotation.x = Math.sin(elapsed * 1.1 + 0.7) * 0.008;
  }

  // Where the helicopter's skids come to rest: the highest of the ground (the stadium's bowl inside its wall) and the
  // roofs under its skids that it was above. The roofs it rests on are kept, so they don't push it aside.
  helicopterFloor(h, lastY) {
    const x = h.position.x, z = h.position.z;
    const bowl = bowlSurface(x, z);
    let floor = (bowl !== null ? stadiumGround() + bowl : groundHeight(x, z)) + 0.25;
    const standing = (this._heliStanding ??= new Set());
    standing.clear();
    const sn = Math.sin(h.heading), cs = Math.cos(h.heading);
    for (const c of this.nearColliders(x, z, 4)) {
      if (isStadium(c) || c.thin || c.maxY < floor - 0.25) continue;
      let top = -Infinity;
      for (const [s, f] of HELI_SKIDS) top = Math.max(top, roofHeightAt(c, x + cs * s + sn * f, z - sn * s + cs * f));
      // a roof it was above (or just landing on) holds it up; one above it is a wall it flew into
      if (!Number.isFinite(top) || top + 0.25 > lastY + 0.6) continue;
      standing.add(c);
      floor = Math.max(floor, top + 0.25);
    }
    return floor;
  }

  updateHelicopter(dt, elapsed) {
    const h = this.entities.helicopter;
    const maxHorizSpeed = 52.0;
    const maxVertSpeed = 16.0;

    let fwdInput = 0;
    if (this.keys.forward) fwdInput = this.keys.forward;
    else if (this.keys.backward) fwdInput = -this.keys.backward;

    let yawInput = 0;
    if (this.keys.left) yawInput = this.keys.left;
    if (this.keys.right) yawInput = -this.keys.right;

    let vertInput = 0;
    if (this.keys.up) vertInput = this.keys.up;
    else if (this.keys.down) vertInput = -this.keys.down;

    if (fwdInput !== 0) {
      h.speed += fwdInput * 24.0 * dt;
      h.speed = Math.max(-maxHorizSpeed * 0.6, Math.min(maxHorizSpeed, h.speed));
    } else {
      h.speed *= Math.max(0, 1 - dt * 1.8);
    }

    if (vertInput !== 0) {
      h.verticalSpeed += vertInput * 22.0 * dt;
      h.verticalSpeed = Math.max(-maxVertSpeed, Math.min(maxVertSpeed, h.verticalSpeed));
    } else {
      h.verticalSpeed *= Math.max(0, 1 - dt * 3.5);
    }

    h.heading += yawInput * 1.45 * dt;

    const lastY = h.position.y;
    h.position.x += Math.sin(h.heading) * h.speed * dt;
    h.position.z += Math.cos(h.heading) * h.speed * dt;
    h.position.y += h.verticalSpeed * dt;

    // Lamp: the skids rest on the ground wherever it is, on the stadium's field and stands, and on any roof it comes
    // down on from above
    let floor = this.helicopterFloor(h, lastY);
    if (!Number.isFinite(floor)) floor = groundHeight(h.position.x, h.position.z) + 0.25;
    if (h.position.y < floor) {
      this.reportCollision(h, groundCollider, 'ground', h.position.x, floor, h.position.z, 0, 1, 0, -h.verticalSpeed);
    }
    h.position.y = Math.max(floor, Math.min(380, h.position.y));
    this.resolveHorizontalCollision(h.position, 4.5, null, h);

    const targetPitch = (h.speed / maxHorizSpeed) * 0.24;
    const targetRoll = -yawInput * 0.28;
    h.pitchAngle += (targetPitch - h.pitchAngle) * Math.min(1, dt * 5);
    h.rollAngle += (targetRoll - h.rollAngle) * Math.min(1, dt * 5);

    h.tiltPivot.rotation.x = h.pitchAngle;
    h.tiltPivot.rotation.z = h.rollAngle;
    h.tiltPivot.position.y = Math.sin(elapsed * 2.6) * 0.18;
  }
}

// Lamp: a change to how the player moves (the update methods, CAR_DRIVE and the other tuning above) goes into the
// running city with the player where they are (lamp-game.js, "Changes while it's played"); one to what the constructor
// built once (the person's, the car's, the bike's and the helicopter's bodies, the taxi's door decal and plate, the keys)
// opens the page again. The taxi's textures are drawn by functions of this file's own, so their source is kept from one
// version to the next to tell.
const live = hot(import.meta);
const texturesNow = [createGoBluePlateTexture].map(String).join('\n');
const texturesBefore = live.data.taxiTextures ?? texturesNow;
live.data.taxiTextures = texturesNow;
live.accept((next, { changed }) => texturesNow === texturesBefore
  && !changed.some((name) => /\.(create\w*Entity|bindKeyboard)$/.test(name)));

export { ThirdPersonControllerManager };
