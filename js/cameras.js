import * as THREE from 'three/webgpu';
import { groundHeight, stadiumGround } from './terrain.js';
import { hot } from '../lamp-game.js';

// Lamp: the camera systems made, kept through a change of this file (lamp-game.js, "Changes while it's played"), so a
// changed preset is put on the camera in use at once (the end of this file).
const live = hot(import.meta);
const systems = (live.data.systems ??= new Set());

// Lamp: scenic views placed at street level, which stand on the ground where they are
const STREET_VIEWS = new Set(['centralPark', 'fifthAve', 'timesSquare', 'chryslerGCT', 'observatory', 'bryantPark', 'waterfront']);

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       name: '3rd-Person Chase',         category: 'follow', fov: 56 },
  { id: 'action',      name: 'Low-Angle Action',         category: 'follow', fov: 60 },
  { id: 'pov',         name: 'First-Person / Cockpit',   category: 'follow', fov: 68 },
  { id: 'centralPark', name: 'The Diag',       category: 'scenic', fov: 52 },
  { id: 'fifthAve',    name: 'Main Street',   category: 'scenic', fov: 48 },
  { id: 'timesSquare', name: 'State & Liberty',  category: 'scenic', fov: 58 },
  { id: 'chryslerGCT', name: 'Burton Tower & Ingalls Mall', category: 'scenic', fov: 50 },
  { id: 'observatory', name: 'Atop Burton Tower',   category: 'scenic', fov: 52 },
  { id: 'bryantPark',  name: 'The Big House',       category: 'scenic', fov: 52 },
  { id: 'waterfront',  name: 'Arb & Huron River',     category: 'scenic', fov: 46 },
  { id: 'drone',       name: 'Auto-Director Aerial',     category: 'scenic', fov: 50 }
];

class CameraSystem {
  static makeCamera() {
    return new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      0.35,
      60000 // at 1:1 the boroughs & harbor run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );
  }

  constructor(domElement, controllerManager, camera = CameraSystem.makeCamera()) {
    systems.add(this);
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = camera;

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;

    switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(groundHeight(entity.position.x - Math.sin(totalYaw) * horizDist, entity.position.z - Math.cos(totalYaw) * horizDist) + 0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(groundHeight(entity.position.x, entity.position.z) + 0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'centralPark': {
        // The Diag: across the crossing paths toward the Hatcher Graduate Library
        const sway = Math.sin(elapsed * 0.22) * 3.5;
        desiredPos.set(930.0 + sway, 9.0, 220.0);
        desiredLook.set(820.0, 6.0, 360.0);
        break;
      }

      case 'fifthAve': {
        // Main Street at William, looking north up downtown's shopfronts
        const sway = Math.sin(elapsed * 0.25) * 1.8;
        desiredPos.set(-27.0 + sway, 5.5, 250.0);
        desiredLook.set(-12.0, 8.0, -150.0);
        break;
      }

      case 'timesSquare': {
        // State & Liberty, looking at the Michigan Theater's marquee
        const sway = Math.sin(elapsed * 0.3) * 3.0;
        desiredPos.set(600.0 + sway, 5.0, 40.0);
        desiredLook.set(500.0, 10.0, -15.0);
        break;
      }

      case 'chryslerGCT': {
        // Ingalls Mall, looking up at Burton Memorial Tower beside Hill Auditorium
        const sway = Math.cos(elapsed * 0.22) * 2.5;
        desiredPos.set(830.0 + sway, 4.0, 180.0);
        desiredLook.set(797.0, 30.0, 23.0);
        break;
      }

      case 'observatory': {
        // From the top of Burton Tower, panning across campus and downtown
        const pan = Math.sin(elapsed * 0.18) * 500.0;
        desiredPos.set(797.0, 44.0, 23.0);
        desiredLook.set(200.0 + pan, 5.0, 100.0);
        break;
      }

      case 'bryantPark': {
        // High over the Big House's north rim, looking down into the bowl and along the field
        const sway = Math.sin(elapsed * 0.25) * 20.0;
        const g = stadiumGround();
        desiredPos.set(-29.0 + sway, g + 75.0, 1330.0);
        desiredLook.set(-29.0, g - 15.0, 1560.0);
        break;
      }

      case 'waterfront': {
        // High over the Nichols Arboretum and the Huron River, looking back at the city
        const drift = Math.sin(elapsed * 0.15) * 60.0;
        desiredPos.set(2350.0, 70.0, -500.0 + drift);
        desiredLook.set(400.0, 0.0, 0.0);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 300.0 + Math.cos(elapsed * 0.19) * 60.0;
        desiredPos.set(
          Math.cos(angle) * radius + 350.0,
          alt,
          Math.sin(angle) * radius + 300.0
        );
        desiredLook.set(350.0, 250.0, 300.0);
        break;
      }
    }

    // Lamp: the street-level views stand on the ground where they are (terrain.js)
    if (STREET_VIEWS.has(this.activePresetId)) {
      const ground = groundHeight(desiredPos.x, desiredPos.z);
      desiredPos.y += ground;
      desiredLook.y += ground;
    }

    if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      this.followBaseY += (entity.position.y - this.followBaseY) * k;
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(groundHeight(this.currentPos.x, this.currentPos.z) + 0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);
  }
}

// Lamp: a change to how the cameras follow and frame the player, or to CAMERA_PRESETS, goes into the running city; one
// to the drag and wheel handling the constructor set up opens the page again.
live.accept((next, { changed }) => {
  // The camera is kept while the game's code runs again, which makes it anew once this file has changed.
  if (changed.includes('CameraSystem.makeCamera')) return false;
  if (changed.some((name) => /\.bindPointerControls$/.test(name))) return false;
  // The field of view is copied from the preset as it's chosen: the one in use takes the new preset now.
  for (const system of systems) system.setCameraPreset(system.activePresetId);
});

export { CAMERA_PRESETS, CameraSystem };
