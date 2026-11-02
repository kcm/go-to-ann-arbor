import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  vec4,
  uniform,
  mix,
  fog,
  pmremTexture,
  positionWorld,
  cameraPosition,
  length,
  normalize,
  max,
  exp,
  abs,
  select
} from 'three/tsl';
import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightNode } from 'three/addons/lights/SunLightNode.js';
import { cityUniforms } from './tsl-materials.js';
import { groundHeight } from './terrain.js';
import { hot } from '../lamp-game.js';
import { weatherPreset } from './weather.js';

// Lamp: the lighting systems made, kept through a change of this file (lamp-game.js, "Changes while it's played"), so
// a new TIME_PRESETS is put on the sky at once (the end of this file).
const live = hot(import.meta);
const systems = (live.data.systems ??= new Set());

// Atmospheric sky, environment lighting, sunlight and time-of-day presets.

const TIME_PRESETS = {
  golden: {
    id: 'golden',
    sunDir: new THREE.Vector3(-0.44, 0.58, -0.68).normalize(),
    sunColor: 0xffca92,
    sunIntensity: 5.8,
    hemiSky: 0x9abbe6,
    hemiGround: 0xc88a62, // Warm terracotta / limestone upward canyon bounce
    hemiIntensity: 1.75,
    skyTop: 0x2c568c,
    skyHorizon: 0xebd1b5,
    fogColor: 0xdcc5ae,
    fogDensity: 0.00024,
    interiorGlow: 0.48,
    roadWetness: 0.28,
    envIntensity: 0.54,
    canyonBounce: 0.52,
    turbidity: 8.0,
    rayleigh: 2.8,
    mieCoefficient: 0.008,
    mieDirectionalG: 0.88,
    cloudCoverage: 0.36,
    cloudDensity: 0.38,
    skyExposure: 0.148,
    nightFactor: 0.0
  },
  midday: {
    id: 'midday',
    sunDir: new THREE.Vector3(-0.34, 0.82, -0.46).normalize(),
    sunColor: 0xfff5e8,
    sunIntensity: 6.0, // Lamp: softer than it was (midday read too bright)
    hemiSky: 0xaad2ff,
    hemiGround: 0xb89678, // Warm sunlit masonry & pavement bounce
    hemiIntensity: 1.85,
    skyTop: 0x225ea8,
    skyHorizon: 0xc8dff5,
    fogColor: 0xc6dcf2,
    fogDensity: 0.00018,
    interiorGlow: 0.24,
    roadWetness: 0.08,
    envIntensity: 0.58,
    canyonBounce: 0.58,
    turbidity: 6.5,
    rayleigh: 2.4,
    mieCoefficient: 0.006,
    mieDirectionalG: 0.86,
    cloudCoverage: 0.32,
    cloudDensity: 0.35,
    skyExposure: 0.142,
    nightFactor: 0.0
  },
  twilight: {
    id: 'twilight',
    sunDir: new THREE.Vector3(-0.52, 0.36, -0.77).normalize(),
    sunColor: 0xff9466,
    sunIntensity: 3.1,
    hemiSky: 0x4c6ca8,
    hemiGround: 0x6e5048,
    hemiIntensity: 1.5, // Lamp: brighter fill (the game was too dark)
    skyTop: 0x102248,
    skyHorizon: 0xb86b6c,
    fogColor: 0x353c58,
    fogDensity: 0.00032,
    interiorGlow: 1.25,
    roadWetness: 0.55,
    envIntensity: 0.36,
    canyonBounce: 0.32,
    turbidity: 9.5,
    rayleigh: 3.4,
    mieCoefficient: 0.010,
    mieDirectionalG: 0.90,
    cloudCoverage: 0.40,
    cloudDensity: 0.42,
    skyExposure: 0.115,
    nightFactor: 0.28
  },
  midnight: {
    id: 'midnight',
    sunDir: new THREE.Vector3(0.42, 0.68, -0.60).normalize(),
    sunColor: 0x8cb0e8,
    sunIntensity: 2.1, // Lamp: a brighter moon (night was too dark)
    hemiSky: 0x3a5486,
    hemiGround: 0x4a3e46,
    hemiIntensity: 1.9, // Lamp: brighter fill (the game was too dark)
    skyTop: 0x060c1a,
    skyHorizon: 0x243858,
    fogColor: 0x0c1424,
    fogDensity: 0.00036,
    interiorGlow: 1.55,
    roadWetness: 0.62,
    envIntensity: 0.45,
    canyonBounce: 0.18,
    turbidity: 4.0,
    rayleigh: 1.5,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.80,
    cloudCoverage: 0.22,
    cloudDensity: 0.25,
    skyExposure: 0.022,
    nightFactor: 0.86
  }
};

// ---------------------------------------------------------------------------------------------------------------------
// The real sun over Ann Arbor, worked out here (no network): where it is now, and when it rises and sets today
// ---------------------------------------------------------------------------------------------------------------------
const LAT = 42.2808, LON = -83.7430;
const RAD = Math.PI / 180;

// Altitude and azimuth (degrees; azimuth clockwise from north) of the sun at a moment (ms since 1970)
function sunPosition(ms) {
  const d = ms / 864e5 + 2440587.5 - 2451545.0; // days since J2000
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const lambda = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15;
  const h = ((gmst + LON) * RAD - ra);
  const phi = LAT * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h));
  const az = Math.atan2(-Math.cos(dec) * Math.sin(h), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(h) * Math.sin(phi));
  return { alt: alt / RAD, az: ((az / RAD) + 360) % 360 };
}

// Today's sunrise and sunset in Ann Arbor (ms), found where the sun's top edge crosses the horizon
function sunTimes(ms) {
  const local = new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/Detroit' });
  // local midnight, near enough: start at 4:00 UTC (midnight EDT / 23:00 EST) and search 26 hours
  const [m, day, y] = local.split('/').map(Number);
  const start = Date.UTC(y, m - 1, day, 4);
  const out = {};
  let prev = sunPosition(start).alt + 0.833;
  for (let t = start + 6e4 * 5; t < start + 26 * 36e5; t += 6e4 * 5) {
    const a = sunPosition(t).alt + 0.833;
    if (prev < 0 && a >= 0 && !out.rise) out.rise = t - 6e4 * 5 * (a / (a - prev));
    if (prev >= 0 && a < 0 && out.rise && !out.set) out.set = t - 6e4 * 5 * (a / (a - prev));
    prev = a;
  }
  return out;
}

// The look for the sun at `alt` degrees: the presets blended by how high it is, lit from where it really is
const STOPS = [[-10, 'midnight'], [-2, 'twilight'], [6, 'golden'], [25, 'midday']];
const mixColor = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
function presetForSun({ alt, az }) {
  let lo = STOPS[0], hi = STOPS[0];
  for (let i = 0; i < STOPS.length; i++) {
    if (alt >= STOPS[i][0]) { lo = STOPS[i]; hi = STOPS[Math.min(i + 1, STOPS.length - 1)]; }
  }
  const t = hi === lo ? 0 : Math.min(1, Math.max(0, (alt - lo[0]) / (hi[0] - lo[0])));
  const a = TIME_PRESETS[lo[1]], b = TIME_PRESETS[hi[1]];
  const p = { id: 'now', look: t < 0.5 ? a.id : b.id };
  for (const k of Object.keys(a)) {
    if (k === 'id' || k === 'sunDir') continue;
    p[k] = /Color|^hemi(Sky|Ground)$|^sky(Top|Horizon)$/.test(k) ? mixColor(a[k], b[k], t) : a[k] + (b[k] - a[k]) * t;
  }
  // the sun from its real bearing, kept a little above the horizon so it still lights the streets; under the
  // horizon the light turns into the moon's (the night preset's), high in the south-west
  const lit = Math.max(alt, 9) * RAD, bearing = az * RAD;
  const sun = new THREE.Vector3(Math.sin(bearing) * Math.cos(lit), Math.sin(lit), -Math.cos(bearing) * Math.cos(lit));
  const night = Math.min(1, Math.max(0, (-alt - 2) / 8));
  p.sunDir = sun.lerp(TIME_PRESETS.midnight.sunDir, night).normalize();
  return p;
}

class LightingSystem {
  // Lamp: the kept part it belongs to was built again (main.js). While the part is kept, so is this.
  release() { systems.delete(this); }

  constructor(scene, renderer = null) {
    systems.add(this);
    this.scene = scene;
    this.activePresetId = 'golden';

    // Register SunLight with either supported Three.js light-node API.
    if (SunLight.registerNode) {
      SunLight.registerNode(SunLightNode);
    } else if (renderer && renderer.library) {
      renderer.library.addLight(SunLightNode, SunLight);
    }

    this.scene.fog = new THREE.FogExp2(0xdcc5ae, 0.00024);
    // Leave scene.background = null because SkyMesh renders the 360° sky dome, and setting
    // a THREE.Color on scene.background sets forceClear=true in WebGPURenderer's Background.update,
    // which would otherwise clear Cascade 0 when rendering Cascade 1 in SunShadowNode!
    this.scene.background = null;

    // Physical Preetham SkyMesh + Beer-Powder Clouds (from three/addons/objects/SkyMesh.js). Its unit box must contain
    // the camera wherever it flies over the 1:1 countryside (the town alone is about 7 km across; it renders at the far plane
    // whatever its size)
    this.sky = new SkyMesh();
    this.sky.scale.setScalar(200000);
    this.sky.turbidity.value = 8.0;
    this.sky.rayleigh.value = 2.8;
    this.sky.mieCoefficient.value = 0.008;
    this.sky.mieDirectionalG.value = 0.88;
    this.sky.cloudScale.value = 0.00018;
    this.sky.cloudSpeed.value = 0.000015;
    this.sky.cloudCoverage.value = 0.36;
    this.sky.cloudDensity.value = 0.38;
    this.sky.cloudElevation.value = 0.52;

    // Calibrate SkyMesh raw radiance (EE=1000 * 0.04) into standard exposure=1.0 HDR range
    this.uSkyExposure = uniform(0.148);
    this.uNightFactor = uniform(0.0);
    this.uNightSkyColor = uniform(new THREE.Color(0x0b1528));
    const rawSkyNode = this.sky.material.colorNode;
    this.sky.material.colorNode = Fn(() => {
      const raw = rawSkyNode;
      const dayCol = raw.rgb.mul(this.uSkyExposure);
      const finalSky = mix(dayCol, this.uNightSkyColor, this.uNightFactor);
      return vec4(finalSky, float(1.0));
    })();

    // In reversedDepthBuffer mode ([1..0]), camera.far is z = 0.0 (whereas SkyMesh defaults to z = w)
    if (renderer && renderer.reversedDepthBuffer) {
      const rawSkyVertexNode = this.sky.material.vertexNode;
      this.sky.material.vertexNode = Fn(() => {
        const pos = rawSkyVertexNode.toVar();
        pos.z.assign(0.0);
        return pos;
      })();
    }

    this.scene.add(this.sky);

    // Reuse the environment scene and PMREM generator when the lighting preset changes.
    this.pmremGenerator = renderer ? new THREE.PMREMGenerator(renderer) : null;
    this.envScene = new THREE.Scene();
    this.envRenderTarget = null;

    // Two-cascade sunlight points from its position toward the origin; no target object is needed.
    this.sunLight = new SunLight(0xffca92, 5.8);
    this.sunLight.position.copy(TIME_PRESETS.golden.sunDir);
    this.sunLight.castShadow = true;
    // Two cascades share an atlas: use 1536px tiles for fast shadow passes without pegging the GPU.
    const tile = 1536;
    this.sunLight.shadow.mapSize.set(tile, tile);
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 200;
    // Suppress shadow acne along the surface normal in world units
    // so short casters like cars, curbs, tree trunks, and pedestrians keep crisp contact shadows
    this.sunLight.shadow.normalBias = 0.05;
    this.scene.add(this.sunLight);

    // Subtle Hemisphere Sky + Warm Terracotta/Limestone Ground Bounce Fill
    // (Kept intentionally lower than sunLight so urban canyon shadows remain deep and crisp)
    this.hemiLight = new THREE.HemisphereLight(0x9abbe6, 0xc88a62, 1.05);
    this.hemiLight.position.set(0, 300, 0);
    this.scene.add(this.hemiLight);

    this.applyPreset('golden');

    // Sky-matched aerial perspective (replaces the flat FogExp2 colour): distant surfaces fade into the baked sky
    // radiance just above the horizon in their view direction (sun glow included), through an exponential haze layer
    // so helicopter / observatory views stay clearer than the horizon.
    this.uFogDensity = uniform(TIME_PRESETS.golden.fogDensity);
    this.uFogHeight = uniform(900.0);
    if (this.envRenderTarget) this.scene.fogNode = this.createAerialFogNode();
  }

  createAerialFogNode() {
    const toFrag = positionWorld.sub(cameraPosition);
    const dist = length(toFrag);
    const dir = toFrag.div(max(dist, 0.001));
    const horizonDir = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
    const skyColor = pmremTexture(this.envRenderTarget.texture, horizonDir, float(0.0)).rgb;
    // Mean haze density exp(-y / H) along the ray between the fragment and the camera
    const H = this.uFogHeight;
    const ya = max(positionWorld.y, 0.0);
    const yb = max(cameraPosition.y, 0.0);
    const dy = yb.sub(ya);
    const ea = exp(ya.div(H).negate());
    const eb = exp(yb.div(H).negate());
    const meanDensity = select(abs(dy).greaterThan(1.0), ea.sub(eb).mul(H).div(dy), ea);
    const tau = this.uFogDensity.mul(dist).mul(meanDensity);
    return fog(skyColor, float(1.0).sub(exp(tau.mul(tau).negate())));
  }

  bakeEnvironmentMap() {
    if (!this.pmremGenerator) return;
    // Bake physical SkyMesh (without solar disc) into scene.environment for realistic canyon IBL.
    // Reuses a single RenderTarget so texture identity never changes.
    this.sky.showSunDisc.value = 0;
    this.envScene.add(this.sky);
    this.envRenderTarget = this.pmremGenerator.fromScene(this.envScene, 0, 0.1, 100, {
      renderTarget: this.envRenderTarget
    });
    this.scene.environment = this.envRenderTarget.texture;
    this.sky.showSunDisc.value = 1;
    this.scene.add(this.sky);
  }

  applyPreset(presetId, force = false) {
    // Lamp: "Now" is Ann Arbor's real sky, with its weather (weather.js) on it
    const p = presetId === 'now' ? weatherPreset(presetForSun(sunPosition(Date.now())), this.weather)
      : TIME_PRESETS[presetId] || TIME_PRESETS.golden;
    if (!force && this.activePresetId === p.id && this.envRenderTarget !== null) {
      return;
    }
    this.activePresetId = p.id;
    // the color grade and the night sounds follow the preset nearest to it
    this.lookId = p.look || p.id;

    this.sunLight.color.setHex(p.sunColor);
    this.sunLight.intensity = p.sunIntensity;
    this.sunLight.position.copy(p.sunDir);
    this.sunLight.updateMatrixWorld();

    this.hemiLight.color.setHex(p.hemiSky);
    this.hemiLight.groundColor.setHex(p.hemiGround);
    this.hemiLight.intensity = p.hemiIntensity;

    this.scene.fog.color.setHex(p.fogColor);
    this.scene.fog.density = p.fogDensity;
    if (this.uFogDensity) this.uFogDensity.value = p.fogDensity;

    // Update physical Preetham SkyMesh uniforms
    this.sky.turbidity.value = p.turbidity;
    this.sky.rayleigh.value = p.rayleigh;
    this.sky.mieCoefficient.value = p.mieCoefficient;
    this.sky.mieDirectionalG.value = p.mieDirectionalG;
    this.sky.cloudCoverage.value = p.cloudCoverage;
    this.sky.cloudDensity.value = p.cloudDensity;
    this.sky.sunPosition.value.copy(p.sunDir);
    this.uSkyExposure.value = p.skyExposure;
    this.uNightFactor.value = p.nightFactor;

    cityUniforms.uSunColor.value.setHex(p.sunColor);
    cityUniforms.uSkyTopColor.value.setHex(p.skyTop);
    cityUniforms.uSkyHorizonColor.value.setHex(p.skyHorizon);
    cityUniforms.uSkySunDir.value.copy(p.sunDir);
    cityUniforms.uInteriorGlow.value = p.interiorGlow;
    cityUniforms.uRoadWetness.value = p.roadWetness;
    cityUniforms.uCanyonBounce.value = p.canyonBounce;

    this.scene.environmentIntensity = p.envIntensity;
    this.bakeEnvironmentMap();
  }

  update(focusPos) {
    // SunLightShadow automatically fits & texel-snaps its 2 cascades to the view camera frustum
    // every frame inside SunShadowNode.renderShadow(), splitting [near, far] halfway between a uniform and a
    // logarithmic split (the near cascade ends at ~far / 4). Keep far at 200 m at street level so the near cascade
    // stays sharp with 1536px tiles, and expand it with altitude (helicopter / observatory) so shadows reach down to street level.
    // Lamp: altitude above the ground under the camera (terrain.js)
    const altitude = focusPos && Number.isFinite(focusPos.y) ? Math.max(0, focusPos.y - groundHeight(focusPos.x, focusPos.z)) : 0;
    this.sunLight.shadow.camera.far = Math.max(200, Math.min(560, 180 + altitude * 1.5));
  }
}

// Lamp: a change to the time presets or how they're put on the city goes into the running city, at the time of day the
// player is in; one to what the constructor built (the sun, the sky, the fog's shader) opens the page again.
live.accept((next, { changed }) => {
  if (changed.some((name) => /\.(createAerialFogNode)$/.test(name))) return false;
  for (const system of systems) system.applyPreset(system.activePresetId, true);
});

export { LightingSystem, sunPosition, sunTimes };
