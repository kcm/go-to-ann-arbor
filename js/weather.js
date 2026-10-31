import * as THREE from 'three/webgpu';
import { Fn, float, floor, hash, instanceIndex, normalize, positionLocal, sin, uniform, vec3 } from 'three/tsl';

// Lamp: Ann Arbor's weather as it is now, from the National Weather Service's latest observation at Ann Arbor
// Municipal Airport (KARB, api.weather.gov, a US government work in the public domain), asked for when the city opens
// and every 15 minutes. It changes the "Now" sky (clouds, haze, a dimmer sun, wet roads) and lets rain or snow fall
// around the camera. Offline, or when the service doesn't answer, it's a fair day.

const STATION = 'KARB';
const FAIR = { kind: 'fair', amount: 0, text: 'Fair', tempF: null, wind: [0, 0], live: false };

// The observation's words and cloud layers, as one of: fair, partly, cloudy, overcast, fog, rain, storm, snow
function classify(props) {
  const text = (props.textDescription || '').toLowerCase();
  const layers = (props.cloudLayers || []).map((l) => l.amount);
  const heavy = /heavy/.test(text) ? 1 : /light|drizzle|flurr/.test(text) ? 0.35 : 0.65;
  let kind = 'fair';
  if (layers.includes('OVC')) kind = 'overcast';
  else if (layers.includes('BKN')) kind = 'cloudy';
  else if (layers.includes('SCT') || layers.includes('FEW')) kind = 'partly';
  if (/overcast/.test(text)) kind = 'overcast';
  else if (/mostly cloudy|cloudy/.test(text)) kind = 'cloudy';
  else if (/partly|mostly clear|mostly sunny/.test(text)) kind = 'partly';
  if (/fog|mist|haze|smoke/.test(text)) kind = 'fog';
  if (/rain|drizzle|shower/.test(text)) kind = 'rain';
  if (/thunder|storm/.test(text)) kind = 'storm';
  if (/snow|flurr|sleet|ice pellets|freezing/.test(text)) kind = 'snow';
  const amount = kind === 'rain' || kind === 'snow' || kind === 'storm' ? heavy : 0;
  return { kind, amount };
}

async function fetchWeather() {
  try {
    // A browser sends its own User-Agent, which the service accepts from a page; nothing of the player's goes with it
    const res = await fetch(`https://api.weather.gov/stations/${STATION}/observations/latest`, {
      headers: { Accept: 'application/geo+json' }
    });
    if (!res.ok) return FAIR;
    const props = (await res.json()).properties || {};
    const { kind, amount } = classify(props);
    const c = props.temperature && props.temperature.value;
    const speed = ((props.windSpeed && props.windSpeed.value) || 0) / 3.6; // km/h to m/s
    const from = ((props.windDirection && props.windDirection.value) || 0) * Math.PI / 180;
    // blowing toward: x east, z south
    const wind = [-Math.sin(from) * speed, Math.cos(from) * speed];
    return {
      kind, amount, wind, live: true,
      text: props.textDescription || 'Fair',
      tempF: Number.isFinite(c) ? Math.round(c * 9 / 5 + 32) : null
    };
  } catch {
    return FAIR;
  }
}

// How each kind of weather changes a time-of-day preset: clouds, the sun's strength, haze and wet roads
const LOOKS = {
  fair: null,
  partly: { cover: 0.5, density: 0.42, sun: 0.92, fog: 1.1, wet: 0 },
  cloudy: { cover: 0.72, density: 0.6, sun: 0.6, fog: 1.4, wet: 0 },
  overcast: { cover: 0.95, density: 0.85, sun: 0.28, fog: 2.0, wet: 0.1 },
  fog: { cover: 0.9, density: 0.8, sun: 0.3, fog: 9.0, wet: 0.25 },
  rain: { cover: 0.97, density: 0.9, sun: 0.22, fog: 3.2, wet: 0.85 },
  storm: { cover: 1.0, density: 1.0, sun: 0.14, fog: 4.0, wet: 1.0 },
  snow: { cover: 0.97, density: 0.85, sun: 0.3, fog: 4.5, wet: 0.2 }
};
function weatherPreset(p, w) {
  const look = w && LOOKS[w.kind];
  if (!look) return p;
  const grey = (hex, t) => {
    const c = new THREE.Color(hex), g = (c.r + c.g + c.b) / 3;
    return c.lerp(new THREE.Color(g, g, g * 1.04), t).getHex();
  };
  const t = 1 - look.sun;
  return {
    ...p,
    cloudCoverage: Math.max(p.cloudCoverage, look.cover),
    cloudDensity: Math.max(p.cloudDensity, look.density),
    sunIntensity: p.sunIntensity * look.sun,
    envIntensity: p.envIntensity * (0.75 + 0.25 * look.sun),
    hemiIntensity: p.hemiIntensity * (0.85 + 0.15 * look.sun),
    fogDensity: p.fogDensity * look.fog,
    fogColor: grey(p.fogColor, t * 0.8),
    skyHorizon: grey(p.skyHorizon, t * 0.7),
    skyTop: grey(p.skyTop, t * 0.6),
    sunColor: grey(p.sunColor, t * 0.5),
    roadWetness: Math.max(p.roadWetness, look.wet)
  };
}

// Rain streaks or snowflakes in a 70 m box that follows the camera, every drop placed and moved in the shader
const BOX = 70;
const MAX_DROPS = 9000;
function createPrecipitation() {
  const uCam = uniform(new THREE.Vector3());
  const uTime = uniform(0);
  const uFall = uniform(9);
  const uWind = uniform(new THREE.Vector2());
  const uSway = uniform(0);

  const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  geometry.instanceCount = 0;
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const uColor = uniform(new THREE.Color(0xc8d2dc));
  const uOpacity = uniform(0.3);
  const uSize = uniform(new THREE.Vector2(0.014, 0.7));
  material.colorNode = uColor;
  material.opacityNode = uOpacity;
  material.positionNode = Fn(() => {
    const i = float(instanceIndex);
    const base = vec3(hash(i), hash(i.add(17.31)), hash(i.add(41.77))).mul(BOX);
    const sway = sin(uTime.mul(0.9).add(i.mul(0.37))).mul(uSway);
    const drift = vec3(uWind.x.mul(uTime).add(sway), uFall.mul(uTime).negate(), uWind.y.mul(uTime).add(sway.mul(0.7)));
    const p = base.add(drift).sub(uCam);
    const rel = p.sub(floor(p.div(BOX)).mul(BOX)).sub(BOX / 2);
    const centre = uCam.add(rel);
    // turned to face the camera about the vertical, leaning with the wind
    const toCam = normalize(vec3(uCam.x.sub(centre.x), 0.0001, uCam.z.sub(centre.z)));
    const right = vec3(toCam.z, 0, toCam.x.negate());
    const lean = vec3(uWind.x, 0, uWind.y).div(uFall.max(1));
    // drops right by the camera shrink away, so none streaks across the view like a pole
    const near = rel.length().div(9).clamp(0.25, 1);
    const y = positionLocal.y.mul(uSize.y).mul(near);
    return centre.add(right.mul(positionLocal.x.mul(uSize.x).mul(near))).add(vec3(0, 1, 0).mul(y)).add(lean.mul(y));
  })();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Precipitation';
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.visible = false;

  const set = (w) => {
    const kind = w && w.kind;
    const falling = (kind === 'rain' || kind === 'storm' || kind === 'snow') && w.amount > 0;
    mesh.visible = falling;
    if (!falling) return;
    const snow = kind === 'snow';
    geometry.instanceCount = Math.round(MAX_DROPS * (snow ? 0.6 : 1) * Math.min(1, w.amount));
    uFall.value = snow ? 1.2 : kind === 'storm' ? 11 : 9;
    uSway.value = snow ? 0.6 : 0;
    uSize.value.set(snow ? 0.07 : 0.014, snow ? 0.07 : 0.7);
    uColor.value.setHex(snow ? 0xf4f7fa : 0xc8d2dc);
    uOpacity.value = snow ? 0.85 : 0.22;
    const [wx, wz] = w.wind || [0, 0];
    uWind.value.set(wx * (snow ? 0.5 : 0.3), wz * (snow ? 0.5 : 0.3));
  };
  const update = (camera, time) => {
    if (!mesh.visible) return;
    uCam.value.copy(camera.position);
    uTime.value = time;
  };
  return { mesh, set, update };
}

export { fetchWeather, weatherPreset, createPrecipitation, FAIR };
