// Lamp's game runtime first: in Lamp's preview it sets the clock and random numbers before anything reads them.
import { game, hot, save, load, log, asset, input, onInput, label, glyph, pendingRestore, rumble, BUTTON, STICK, TRIGGER } from '../lamp-game.js';
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, vec3, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { getLocationLabel, isTypingInField, ROADS, LANDMARKS, TELEPORT_LOCATIONS } from './city-config.js';
import { buildCityGrid } from './city-grid.js';
import { buildOutskirts } from './outskirts.js';
import { buildLandmarks } from './landmarks.js';
import { buildRailways } from './railways.js';
import { buildParkedCars } from './parked-cars.js';
import { buildCityBlocks } from './buildings.js';
import { setDistricts } from './districts.js';
import { setRoofShapes } from './houses.js';
import { buildStreetDetails } from './street-details.js';
import { createTrafficSystem, createHighwayTraffic } from './traffic.js';
import { buildRoadPaint } from './road-paint.js';
import { buildTrafficControls } from './traffic-controls.js';
import { buildShopSigns } from './shop-signs.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem, sunTimes } from './lighting.js';
import { createKnockdowns } from './knockdowns.js';
import { createHydrantSpray } from './hydrant-spray.js';
import { CityMapSystem } from './city-map.js';
import { setupSceneCulling, updateSceneCulling, cullAlso, showShadowStandIns } from './scene-culling.js';
import { loadTerrain, setOnTerrain, groundHeight, waterLevel } from './terrain.js';
import { buildCascades } from './cascades.js';
import { buildRiverPeople } from './river-people.js';
import { CityAudioSystem } from './audio-system.js';
import { fetchWeather, createPrecipitation } from './weather.js';
import { fetchRiverFlow } from './river-gauge.js';

// In its own window on the Mac the top strip is the title bar, which takes the clicks: the top panels sit below it
if (window.webkit?.messageHandlers?.lampNative && /Mac/.test(navigator.platform) && navigator.maxTouchPoints === 0) document.documentElement.classList.add('mac-window');

// Application setup, shader warm-up and frame loop.
//
// Lamp: a change that can't be swapped into the running city runs this file's code again in place (lamp-game.js,
// "Running the game's code again"). What's slow to make is kept through that with live.keep: the renderer and its
// compiled shaders, the ground's heights (terrain.js) and each part of the city, which is built again only when its own
// code, the map data it's built from (its `from`: CITY_MAP and the rest below) or a part it's built from (its
// `inputs`) changed, the rest of the city kept as it is. The scene, the camera and the lights are kept too: three.js
// works out how to draw every object anew for a new one of them, which held the game still for a second at each change.
// Everything else here (the HUD, the controllers, the sound) is made again from the page as it is now.
const live = hot(import.meta);

// The generated data each part of the city is built from (its keep's `from`): a change to one, a street's lanes added to
// the map or new tree points, builds those parts again in place.
const CITY_MAP = 'js/city-geodata.js';
const BUILDING_DATA = ['js/building-geodata.js', 'js/building-geodata.bin.gz'];
const TREE_DATA = ['js/tree-geodata.js', 'js/tree-geodata.bin.gz', 'js/tree-placements.js'];

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  // Only shader compilation has measurable progress; other stages use the sweeping bar.
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };

  // Lamp: a start with the renderer kept (see the top of this file) shows no loading screen and doesn't wait for it
  let warmStart = false;
  async function showLoadingStage(message) {
    if (loadingStatus) loadingStatus.textContent = message;
    if (loadingTrack) loadingTrack.classList.add('is-indeterminate');
    if (document.hidden || warmStart) return;
    // Let the label paint before synchronous work. The timeout also lets hidden tabs keep loading.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        setTimeout(resolve, 0);
      });
    });
  }

  await showLoadingStage('Initializing graphics...');

  // 1. Initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer
  // Lamp: what a Mac draws. WebKit compiles the WebGPU path's shaders for 20-50 s before the first frame, and the
  // WebGL 2 one in a few, so it draws with WebGL 2. The clustered street, shop and car lights and the reflections
  // add ~8 s more to the start and are left off. Lamp's runtime draws it at 1920x1080 wherever it's played.
  const QUALITY = {
    antialias: true,
    shadows: true,
    streetLights: false,
    reflections: false,
    bloom: true,
    outskirts: true
  };
  // Kept through a change: a new one would compile every shader again.
  const renderer = await live.keep('renderer', async () => {
    const made = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true, forceWebGL: true });
    await made.init();
    return made;
  });
  // Lamp's runtime draws it at 1920x1080 and fits that to the window (game() below).
  renderer.shadowMap.enabled = QUALITY.shadows;
  if (QUALITY.streetLights) renderer.lighting = new ClusteredLighting(256, 32, 28, 48);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    initMark = now;
  };

  // Whether this renderer has compiled the city's shaders already: kept with it, so the code running again for a change
  // starts without the loading screen, the shader pass or the warm-up frame (what's new compiles as it's first drawn).
  const warm = live.keep('warm', () => ({ compiled: false }), { inputs: [renderer] });
  warmStart = warm.compiled;
  if (warmStart && loadingOverlay) {
    loadingOverlay.style.transition = 'none';
    loadingOverlay.classList.add('hidden');
  }
  markInit('renderer');

  // 2. Scene, atmosphere and lighting
  await showLoadingStage('Creating sky and environment lighting...');
  const scene = live.keep('scene', () => new THREE.Scene());
  // What the run before put in the scene goes first, so the lights built here own only what they add: each part of the
  // city comes back below, and the rest is made again.
  scene.clear();
  scene.matrixWorldAutoUpdate = true;
  const lighting = live.keep('lighting', () => {
    const made = new LightingSystem(scene, renderer);
    const own = [...scene.children];
    return { made, own, dispose() { made.release(); for (const object of own) object.removeFromParent(); } };
  }, { inputs: [scene, renderer] });
  scene.add(...lighting.own);
  const lightingSystem = lighting.made;
  const precipitation = createPrecipitation(); // rain & snow (weather.js)
  scene.add(precipitation.mesh);
  markInit('lighting');

  // Lamp: the ground's real heights, which everything below is set on (terrain.js)
  await showLoadingStage('Reading the ground\'s heights...');
  const heights = await loadTerrain();
  markInit('terrain');
  // 3. Build Ann Arbor's Geography, Landmarks, Blocks, Street Details & Traffic
  // Lamp: each part of the city is built into a group of its own, set on the ground and cut for culling there
  // (cityPart), and kept through a change that isn't its own (see the top of this file): `inputs` are what it's built
  // from, so a part built again builds again the parts made from it. Each part's time is in the "[init]" line.
  // `cull` is setupSceneCulling, named in each part's build so a change to the culling builds the culled parts again.
  function cityPart(build, { cull = null } = {}) {
    const group = new THREE.Group();
    const made = build(group);
    // A part that waits for its ground layers (terrain.js) is put together once they're in
    if (made instanceof Promise) return made.then((m) => finishPart(group, m, cull));
    return finishPart(group, made, cull);
  }
  function finishPart(group, made, cull) {
    // Island-wide static geometry: chunk & distance-cull the small props, shadow stand-ins for the big casters
    // (scene-culling.js)
    const culled = cull ? cull(group, [group], true) : [];
    return {
      group, made, culled,
      dispose() {
        group.removeFromParent();
        group.traverse((o) => { o.geometry?.dispose(); for (const m of [o.material].flat()) m?.dispose?.(); });
      }
    };
  }
  await showLoadingStage('Building streets, parks and the Huron River...');
  const grid = await live.keep('grid', () => cityPart(async (g) => {
    const made = buildCityGrid(g);
    // Lamp: the street level built flat at y = 0, set on the ground (cut on several cores the first time, then read
    // back from what that start saved: terrain.js)
    await setOnTerrain(g.getObjectByName('CityGrid'));
    return made;
  }, { cull: setupSceneCulling }), { inputs: [heights], from: [CITY_MAP, 'js/cascades.js', 'js/river.js', 'js/tsl-materials.js'] });
  const cityGrid = grid.made;
  markInit('cityGrid');
  // Lamp: the Argo Cascades' rocks and white water, on the steps of their water (cascades.js)
  const cascadesPart = live.keep('cascades', () => cityPart((g) => buildCascades(g, waterLevel)), { inputs: [heights, grid] });
  // Lamp: kayakers and tubers on their way down the river from the cascades (river-people.js)
  const riverPeoplePart = live.keep('riverPeople', () => cityPart((g) => buildRiverPeople(g)), { inputs: [heights, grid] });
  await showLoadingStage('Laying out the hills of Washtenaw County...');
  const outskirtsPart = live.keep('outskirts', () => cityPart((g) => buildOutskirts(g), { cull: setupSceneCulling }),
    { inputs: [heights, grid], from: ['js/outskirts.js'] });
  const outskirts = outskirtsPart.made;
  markInit('outskirts');
  await showLoadingStage('Building the Big House...');
  const landmarks = live.keep('landmarks', () => cityPart((g) => buildLandmarks(g), { cull: setupSceneCulling }), { inputs: [heights], from: [CITY_MAP, 'js/stadium-geodata.js'] });
  const landmarkColliders = landmarks.made.colliders;
  markInit('landmarks');
  await showLoadingStage('Generating building footprints and facades...');
  // house numbers by the front doors (build-addresses.py, the city's Address Points)
  // the city's land use and historic districts (build-districts.py): building looks and the location label ask them
  const districtBytes = await asset('data/districts.json');
  setDistricts(districtBytes ? JSON.parse(new TextDecoder().decode(districtBytes)) : null);
  const addressBytes = await asset('data/addresses.json');
  const addresses = addressBytes ? JSON.parse(new TextDecoder().decode(addressBytes)) : null;
  const gasBytes = await asset('data/gas-stations.json');
  const gasStations = gasBytes ? JSON.parse(new TextDecoder().decode(gasBytes)) : null;
  // the roof shapes OpenStreetMap's mappers tagged (build-roof-shapes.py), for the houses that have one
  const roofBytes = await asset('data/roof-shapes.json');
  setRoofShapes(roofBytes ? JSON.parse(new TextDecoder().decode(roofBytes)) : null);
  const blocks = live.keep('blocks', () => cityPart((g) => buildCityBlocks(g, landmarks.made.colliders, addresses, gasStations), { cull: setupSceneCulling }),
    { inputs: [heights, landmarks], from: [CITY_MAP, ...BUILDING_DATA, 'data/addresses.json', 'data/districts.json', 'data/gas-stations.json', 'data/roof-shapes.json'] });
  const cityBlocks = blocks.made;
  markInit('blocks');
  const allColliders = [...landmarkColliders, ...cityBlocks.colliders, ...outskirts.colliders, ...(cityGrid.colliders || [])];

  await showLoadingStage('Placing trees, streetlights and street furniture...');
  // Lamp: trees, lamps and street furniture were placed on the ground as they were built; the street level under them
  // is set on it here
  // the city's hydrants and park benches, tables, shelters and courts (build-street-furniture.py)
  const furnitureBytes = await asset('data/street-furniture.json');
  const streetFurniture = furnitureBytes ? JSON.parse(new TextDecoder().decode(furnitureBytes)) : null;
  const details = await live.keep('streetDetails', () => cityPart(async (g) => {
    const made = buildStreetDetails(g, allColliders, streetFurniture);
    await setOnTerrain(g.getObjectByName('StreetDetails'));
    return made;
  }, { cull: setupSceneCulling }), { inputs: [heights, grid, outskirtsPart, landmarks, blocks], from: [...TREE_DATA, 'data/street-furniture.json', 'js/street-details.js'] });
  const streetDetails = details.made;
  markInit('streetDetails');
  await showLoadingStage('Creating traffic and pedestrian routes...');
  // Buildings turned along non-grid streets have oriented colliders whose world bounds reach past their lots: they stay
  // inside the property line anyway, so the road network (lanes & sidewalks) doesn't need them.
  // Elevated building sections that clear even a bus don't obstruct ground traffic (Lamp: measured from the ground
  // under them, as colliders' heights are the world's since the city stands on terrain.js's heights).
  const traffic = live.keep('traffic', () => cityPart((g) => createTrafficSystem(g, grid.made.sidewalks, [
    ...grid.made.footprints,
    ...details.made.footprints,
    ...allColliders.filter((c) => !c.obb
      && (c.minY ?? 0) - groundHeight((c.minX + c.maxX) * 0.5, (c.minZ + c.maxZ) * 0.5) < 3.5)
  ], details.made.signalIntersections)), { inputs: [heights, grid, outskirtsPart, landmarks, blocks, details], from: [CITY_MAP] });
  const trafficSystem = traffic.made;
  markInit('traffic');
  const highway = live.keep('highwayTraffic', () => cityPart((g) => createHighwayTraffic(g, grid.made.highwayLanes)), { inputs: [grid], from: [CITY_MAP] });
  const highwayTraffic = highway.made;
  await showLoadingStage('Adding road markings...');
  const roadPaint = live.keep('roadPaint', () => cityPart((g) => {
    const made = buildRoadPaint(g, traffic.made.network);
    setOnTerrain(made, 0); // vertex by vertex: its strips come cut to length (road-paint.js)
    // in chunks, culled out of sight and far off (scene-culling.js); thin far strips are widened on screen
    made.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingSphere();
      o.geometry.boundingSphere.radius += 16;
    });
    return made;
  }, { cull: setupSceneCulling }), { inputs: [heights, traffic], from: [CITY_MAP, 'js/road-network.js'] });
  markInit('roadPaint');
  // Traffic lights and stop & yield signs where the road network put them (traffic-controls.js)
  const controlsPart = live.keep('trafficControls', () => cityPart((g) => buildTrafficControls(g, traffic.made.network), { cull: setupSceneCulling }), { inputs: [heights, traffic, details] });
  // Signs over the real shops, restaurants and cafes (shop-signs.js, from OpenStreetMap)
  const signsPart = live.keep('shopSigns', () => cityPart((g) => buildShopSigns(g), { cull: setupSceneCulling }), { inputs: [heights] });
  await showLoadingStage('Laying the railroads...');
  // The tracks and the trains on them, stood on the ground where they're built (railways.js)
  // where streets cross the tracks at grade, with gates (build-rail-crossings.py, OpenStreetMap)
  const crossingBytes = await asset('data/rail-crossings.json');
  const railCrossings = crossingBytes ? JSON.parse(new TextDecoder().decode(crossingBytes)) : [];
  // Amtrak's Wolverine stops at Ann Arbor on its timetable (build-wolverine.py, from Amtrak's GTFS feed)
  const wolverineBytes = await asset('data/wolverine.json');
  const wolverine = wolverineBytes ? JSON.parse(new TextDecoder().decode(wolverineBytes)) : null;
  const railPart = live.keep('railways', () => cityPart((g) => buildRailways(g, railCrossings, wolverine)), { inputs: [heights], from: ['data/rail-crossings.json', 'data/wolverine.json'] });
  const railways = railPart.made;
  // Cars parked in the lots and along the main streets downtown, solid to the player (parked-cars.js)
  const parkedPart = live.keep('parkedCars', () => cityPart((g) => buildParkedCars(g)), { inputs: [heights], from: ['js/parked-cars.js'] });
  const parkedCars = parkedPart.made;
  allColliders.push(...parkedCars.colliders);
  // Tree trunks, lamp posts, signal poles and sign posts: thin and solid, so the car crashes into them and the bike
  // throws its rider (`thin`: the helicopter flies through them)
  // and each goes over when a car hits it hard enough (knockdowns.js)
  for (const o of [...(details.made.obstacles || []), ...(controlsPart.made.obstacles || [])]) {
    const g = groundHeight(o.x, o.z);
    const knock = o.kind && (o.pose || o.parts?.length) ? { ...o, g, down: false } : null;
    allColliders.push({ minX: o.x - o.r, maxX: o.x + o.r, minZ: o.z - o.r, maxZ: o.z + o.r, minY: g - 1, maxY: g + 6, thin: true, knock });
  }
  // a hydrant knocked off its main gushes water (hydrant-spray.js)
  const hydrantSpray = createHydrantSpray(scene);
  const gushList = [];
  const knockdowns = createKnockdowns({
    onFall: (it, speed) => {
      log(`[knock] a ${it.kind} went over at ${Math.round(speed * 3.6)} km/h`);
      if (it.kind === 'hydrant') hydrantSpray.start(it.x, it.z);
    },
    onLand: (it, spin) => audioSystem?.cue(it.kind === 'tree' ? 'thud' : 'crash',
      { x: it.x + it.dx * it.height * 0.6, y: it.g, z: it.z + it.dz * it.height * 0.6 }, Math.min(1, 0.4 + spin * 0.2))
  });
  const parts = [grid, cascadesPart, riverPeoplePart, outskirtsPart, landmarks, blocks, details, traffic, highway, roadPaint, controlsPart, signsPart, railPart, parkedPart];
  for (const part of parts) {
    scene.add(part.group);
    cullAlso(part.culled);
  }
  // What a part hooks on its scene's renders is on its group, which three.js never calls (the trees follow the view
  // camera for their level of detail, trees.js): the scene calls it for each part.
  const partHooks = parts.map((part) => part.group).filter((g) => g.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender);
  scene.onBeforeRender = (...args) => { for (const g of partHooks) g.onBeforeRender(...args); };
  markInit('ground');

  // 4. Initialize Third-Person Controllers (Person, Car, Cyclist, Helicopter) & Multi-Camera System
  await showLoadingStage('Preparing player, vehicles and controls...');
  const controllerManager = new ThirdPersonControllerManager(scene, allColliders);
  controllerManager.knockdowns = knockdowns;
  controllerManager.parkedCars = parkedCars;
  const isOwnLook = (look) => look.kind === 'forester' && look.hex === 0x16181b;
  // The cars taken from parking spots and left in them in earlier plays (a part kept over a change has them still)
  if (!parkedCars.history.length) {
    const added = parkedCars.replay(load('parkedSwaps'));
    if (added.length) { allColliders.push(...added); controllerManager._colliderCells = null; }
  }
  // Where each way of getting around starts, a view of the city at each (heading 0 faces south, PI north)
  const SCENIC_STARTS = {
    // on the Diag, looking up Ingalls Mall to Burton Tower and Hill Auditorium
    person: { x: 845, z: 242, heading: Math.atan2(797 - 845, 23 - 242) },
    // Main St at William, in the northbound lane, looking up downtown's shopfronts
    car: { x: -23, z: 228, heading: Math.atan2(14.8, -378) },
    // South University's eastbound bike lane, campus on the left
    cyclist: { x: 660, z: 529, heading: Math.PI / 2 },
    // high over Stadium Blvd south of the Big House, the stadium below and downtown beyond it
    helicopter: { x: -30, z: 1950, heading: Math.PI, above: 130 },
    // on Argo Pond just above the Argo Cascades, facing the channel's head where it leaves the pond
    kayak: { x: 202.9, z: -1266.4, heading: 1.188 }
  };

  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    // Kept with Lamp's save(), which the preview keeps to one play, so every preview starts in the same place.
    const saved = load('player');
    if (saved?.version !== 2) {
      // a first play: each of them waiting at its own start, the player in the car on Main St
      for (const [mode, s] of Object.entries(SCENIC_STARTS)) {
        if (!controllerManager.entities[mode]) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(s.x, s.z, s.heading, s.above ? groundHeight(s.x, s.z) + s.above : null);
        // the kayak faces the cascades' channel, not the way the pond's water would turn it
        if (mode === 'kayak') { const k = controllerManager.entities.kayak; k.heading = s.heading; k.mesh.rotation.y = s.heading; }
      }
      controllerManager.setMode('car');
    }
    if (saved?.version === 2) {
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'car');
      // the car the player drives (one taken from a parking spot or traffic), and whether they're in something
      if (saved.carLook && !isOwnLook(saved.carLook)) controllerManager.restyleCar(saved.carLook);
      if (saved.activeMode !== 'person' && Object.hasOwn(controllerManager.entities, saved.activeMode)) {
        controllerManager.entities.person.riding = saved.activeMode;
        controllerManager.entities[saved.activeMode].leftEmpty = false;
      }
      for (const mode of saved.leftEmpty || []) if (controllerManager.entities[mode]) controllerManager.entities[mode].leftEmpty = true;
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      const leftEmpty = Object.keys(controllerManager.entities).filter((mode) => controllerManager.entities[mode].leftEmpty);
      save('player', { version: 2, activeMode: controllerManager.activeMode, entities, carLook: controllerManager.carLook, leftEmpty });
      save('parkedSwaps', parkedCars.history);
    } catch { /* Storage may be disabled or full. */ }
  }

  const keptCamera = live.keep('camera', () => CameraSystem.makeCamera());
  // a camera that once followed a broken position keeps it: start it again rather than draw nothing
  if (![keptCamera.position.x, keptCamera.position.y, keptCamera.position.z, keptCamera.quaternion.w].every(Number.isFinite)) {
    keptCamera.position.set(0, 50, 100); keptCamera.quaternion.identity(); keptCamera.updateMatrixWorld(true);
  }
  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager, keptCamera);
  cameraSystem.onResize(1920, 1080);
  const touchControls = new TouchControls(controllerManager);
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager, trafficSystem, highwayTraffic, streetDetails }, {
    onStateChange: updateSoundButton
  });
  function updateSoundButton() {
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', audioSystem.enabled ? 'Mute sound' : 'Enable sound');
    soundButton.title = audioSystem.supported ? `${audioSystem.enabled ? 'Mute' : 'Enable'} sound [N]` : 'Web Audio is unavailable';
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // someone knocked down by the player's car or bike: a thump there and a jolt in the hands
  const _thudAt = { x: 0, y: 0, z: 0 };
  trafficSystem.setPedestrianHitListener?.((x, z, speed) => {
    _thudAt.x = x; _thudAt.z = z; _thudAt.y = groundHeight(x, z) + 0.6;
    audioSystem.cue('thud', _thudAt, Math.min(1, 0.4 + speed / 20));
    rumble(0, Math.min(1, 0.3 + speed / 25), Math.min(1, 0.2 + speed / 30), 0.25);
    log(`Knocked someone down at ${speed.toFixed(1)} m/s`);
  });
  // the player hit by a car, on foot or on the bike
  trafficSystem.setPlayerStruckListener?.((vx, vz, speed, type) => {
    const at = controllerManager.getActiveEntity().position;
    audioSystem.cue('thud', at, Math.min(1, 0.5 + speed / 20));
    rumble(0, Math.min(1, 0.5 + speed / 20), Math.min(1, 0.4 + speed / 25), 0.35);
    if (type === 'cyclist') controllerManager.throwRider(speed, vx, vz);
    else controllerManager.knockDown(vx * 1.1, 1.5 + speed * 0.2, vz * 1.1, 0, 0.6);
    log(`Hit by a car at ${speed.toFixed(1)} m/s`);
  });
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
  markInit('controllers');

  // The shadow stand-ins each part made (cityPart) draw in this run's sun shadow
  showShadowStandIns(lightingSystem.sunLight.shadow);

  // Initialize static world matrices once, including the chunks and shadow proxies created above.
  // Crowd, tree and building-detail animation changes instance/pose buffers, not Object3D transforms.
  const dynamicRoots = [
    trafficSystem.group,
    highwayTraffic.group,
    railways.group.getObjectByName('Trains'),
    scene.getObjectByName('StoreClusteredLights'),
    scene.getObjectByName('StreetClusteredLights'),
    ...Object.values(controllerManager.entities).map((entity) => entity.mesh),
    controllerManager.entities.cyclist.helmet
  ];
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;
  markInit('culling');

  // Lamp: without the clustered lighting the many little street, shop and car lights go (the sun and sky stay)
  if (!QUALITY.streetLights) {
    const smallLights = [];
    scene.traverse((object) => { if (object.isPointLight || object.isSpotLight) smallLights.push(object); });
    for (const light of smallLights) light.removeFromParent();
    console.log(`[quality] removed ${smallLights.length} small lights`);
  }
  if (!QUALITY.outskirts) {
    const group = scene.getObjectByName('Outskirts');
    if (group) group.visible = false;
  }
  console.log(`[quality] ${JSON.stringify(QUALITY)}`);

  // On WebGPU, small InstancedMeshes (<= 1000 instances) keep their matrices in uniform buffers that three.js
  // re-uploads on every draw of every pass (~2.5 MB/frame with the shadow cascades, stalling the GPU queue).
  // Storage attributes only upload when needed; WebGL2 needs ordinary instanced attributes for correct transforms.
  if (renderer.backend.isWebGPUBackend) {
    scene.traverse((object) => {
      if (object.isInstancedMesh) {
        object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
      }
    });
  }

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  await showLoadingStage('Setting up visual effects, map and interface...');
  let renderPipeline, scenePass, colorGrade, sceneMRT = null;
  if (!QUALITY.reflections) {
    scenePass = pass(scene, cameraSystem.camera);
    colorGrade = createPostProcessing(renderer, scenePass.getTextureNode('output'), vec3(0), { bloom: QUALITY.bloom });
    renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);
  } else {
  scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassNormal = scenePass.getTextureNode('normal');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');

  const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera: cameraSystem.camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.50;
  ssrPass.screenEdgeFadeBlack = true;

  // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const reflections = ssrPass.mul(reflectionMask);
  colorGrade = createPostProcessing(renderer, scenePassColor, reflections);
  renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);
  }

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;
  touchControls.onGetInOut = () => getInOrOut();

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter', 'kayak'];
      travelBy(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onGetInOut: getInOrOut,
    onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
    onCloseMap: () => mapSystem.toggleFullMap(false)
  });

  // The guide to each mode's controls, written once: the keys the city reads (by their codes, as controllers.js and the
  // keydown handler below have them) and the controller's buttons, sticks and triggers (as gamepad-controls.js reads
  // Lamp's pad). It shows the half for what the player is holding, named and drawn by Lamp's runtime.
  const orbit = { keys: ['Drag'], pad: [STICK.RIGHT], does: 'Orbit' };
  const controlHints = {
    person: [{ keys: ['KeyW', 'KeyS'], does: 'Walk / Run' }, { keys: ['KeyA', 'KeyD'], does: 'Turn' },
      { pad: [STICK.LEFT], does: 'Walk / Run & turn' }, { keys: ['Space'], pad: [BUTTON.A], does: 'Jump' }, orbit],
    car: [{ keys: ['KeyW', 'KeyS'], pad: [TRIGGER.RT, TRIGGER.LT], does: 'Drive / Reverse' },
      { keys: ['KeyA', 'KeyD'], pad: [STICK.LEFT], does: 'Steer' }, { keys: ['KeyB'], does: 'Horn' }, orbit],
    cyclist: [{ keys: ['KeyW', 'KeyS'], pad: [TRIGGER.RT, TRIGGER.LT], does: 'Pedal / Brake' },
      { keys: ['KeyA', 'KeyD'], pad: [STICK.LEFT], does: 'Lean & Turn' }, orbit],
    helicopter: [{ keys: ['KeyW', 'KeyS'], does: 'Pitch' }, { keys: ['KeyA', 'KeyD'], does: 'Yaw' },
      { pad: [STICK.LEFT], does: 'Pitch & Yaw' }, { keys: ['Space', 'KeyE'], pad: [TRIGGER.RT], does: 'Ascend' },
      { keys: ['KeyQ', 'KeyC'], pad: [TRIGGER.LT], does: 'Descend' }],
    kayak: [{ keys: ['KeyW', 'KeyS'], does: 'Paddle / Back' }, { keys: ['KeyA', 'KeyD'], does: 'Turn' },
      { pad: [STICK.LEFT], does: 'Paddle & turn' }, orbit]
  };
  // Getting in and out, in every mode
  for (const [mode, hints] of Object.entries(controlHints)) {
    hints.push({ keys: ['KeyF'], pad: [BUTTON.X], does: mode === 'person' ? 'Get in' : 'Get out' });
  }
  // Top speeds in mph (controllers.js caps them at 8.2, 36, 19 & 52 m/s): full scale of the speed meter
  const topSpeedMph = { person: 18, car: 81, cyclist: 43, helicopter: 116, kayak: 12 };

  // Keys in the city's own keycaps; a controller's buttons as the runtime draws them for that controller.
  function renderControlHints(mode, on = input()) {
    if (!elControlsHint) return;
    const pad = on.kind === 'controller';
    const items = (controlHints[mode] || []).filter((hint) => pad ? hint.pad : hint.keys).map((hint) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const what of pad ? hint.pad : hint.keys) {
        if (pad) {
          const badge = glyph(what, on);
          if (badge) item.appendChild(badge);
          continue;
        }
        const kbd = document.createElement('kbd');
        kbd.textContent = label(what, on);
        item.appendChild(kbd);
      }
      const words = document.createElement('span');
      words.className = 'hint-label';
      words.textContent = hint.does;
      item.appendChild(words);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  // The keys named on the HUD's buttons (data-key, a key's code) and, with a controller, the button that does the same
  // (data-pad); a key with no button on the controller is hidden then (style.css, by body[data-input]).
  function relabelKeys(on) {
    document.body.dataset.input = on.kind;
    for (const kbd of document.querySelectorAll('kbd[data-key], kbd[data-pad]')) {
      const badge = on.kind === 'controller' && kbd.dataset.pad ? glyph(BUTTON[kbd.dataset.pad], on) : null;
      if (badge) kbd.replaceChildren(badge);
      else if (kbd.dataset.key) kbd.textContent = label(kbd.dataset.key, on);
    }
  }

  // The taxi-yellow pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
  }

  // 1 to 5 (the mode buttons, the bumpers): another way of getting around starts at its own view of the city, unless
  // it's already close by (the car the player just stepped out of), when the player simply takes it
  function travelBy(mode) {
    const cm = controllerManager;
    if (mode === cm.activeMode || !cm.entities[mode]) { selectMode(mode); return; }
    const here = cm.getActiveEntity().position, there = cm.entities[mode].position;
    const close = Math.hypot(there.x - here.x, there.z - here.z) < 40;
    selectMode(mode);
    if (!close) goToStart(mode);
  }
  function goToStart(mode) {
    const s = SCENIC_STARTS[mode];
    if (!s) return;
    controllerManager.teleportActiveTo(s.x, s.z, s.heading, s.above ? groundHeight(s.x, s.z) + s.above : null);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    savePlayerState();
  }

  // F (or the controller's X, or the touch button): out of what the player is in, or into the nearest thing: their car,
  // the bike, the kayak, the helicopter on the ground, a parked car or one going by (which the player's car becomes)
  // A short line in the middle of the screen that fades by itself (CSS .notice)
  let noticeEl = null, noticeTimer = 0;
  function showNotice(text) {
    if (!noticeEl) { noticeEl = document.createElement('div'); noticeEl.className = 'notice'; document.body.appendChild(noticeEl); }
    noticeEl.textContent = text;
    noticeEl.classList.add('show');
    noticeTimer = 1.6;
  }
  function tickNotice(dt) {
    if (noticeTimer > 0 && (noticeTimer -= dt) <= 0) noticeEl?.classList.remove('show');
  }

  function getInOrOut() {
    if (mapSystem.isFullMapOpen) return;
    const cm = controllerManager;
    const was = cm.activeMode;
    const choice = cm.enterOrExit(parkedCars, trafficSystem);
    if (!choice) return;
    if (choice.tooFast) { showNotice('Slow down to get out'); return; }
    const car = cm.entities.car;
    if (choice.parked || choice.moving) {
      // the car the player had is left parked where it is
      const drop = { ...cm.carLook, x: car.position.x, z: car.position.z, yaw: car.heading,
        y: Math.max(0, car.position.y - cm.getGroundHeight(car.position.x, car.position.z, 'car')) };
      const taken = choice.moving ? trafficSystem.takeCar(cm.entities.person.position.x, cm.entities.person.position.z, 5) : null;
      if (choice.moving && !taken) { cm.entities.person.riding = null; return; }
      const done = parkedCars.take(choice.parked || null, drop);
      if (done?.collider) { allColliders.push(done.collider); cm._colliderCells = null; }
      const look = choice.moving ? taken : done.look;
      const at = choice.moving ? taken : choice.parked;
      cm.restyleCar(look);
      cm.stopCar(car);
      car.position.set(at.x, cm.getGroundHeight(at.x, at.z, 'car') + (choice.parked?.y || 0), at.z);
      car.heading = choice.moving ? taken.yaw : choice.parked.yaw;
      car.prevX = car.position.x;
      car.prevZ = car.position.z;
      if (choice.moving) car.speed = taken.speed;
      car.mesh.position.copy(car.position);
      car.mesh.rotation.y = car.heading;
      log(choice.moving ? `[car] took a ${look.kind} out of traffic` : `[car] took a parked ${look.kind}`);
    }
    selectMode(choice.mode);
    const at = cm.getActiveEntity().position;
    if (choice.mode === 'car' || was === 'car') audioSystem.cue('door', at, 0.9);
    savePlayerState();
  }

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  // How many people are out: few late at night, busiest from mid-afternoon into the evening, and fewer in rain or snow
  const CROWD_BY_LOOK = { midday: 0.8, golden: 1, twilight: 0.85, midnight: 0.18 };
  function crowdBusy(timeId) {
    if (timeId !== 'now') return CROWD_BY_LOOK[timeId] ?? 0.8;
    const hour = +new Date(Date.now()).toLocaleString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', hourCycle: 'h23' });
    const byHour = [0.2, 0.14, 0.1, 0.06, 0.06, 0.08, 0.2, 0.35, 0.5, 0.55, 0.6, 0.7, 0.8, 0.8, 0.8, 0.9, 1, 1, 1, 1, 0.95, 0.85, 0.6, 0.35];
    const w = lightingSystem.weather;
    const wet = w && /rain|snow|storm|shower|sleet|drizzle/i.test(w.text || '') ? 0.6 : 1;
    const cold = w && w.tempF != null && w.tempF < 25 ? 0.75 : 1;
    return byHour[hour] * wet * cold;
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId, timeId === 'now');
    trafficSystem.setCrowdBusy?.(crowdBusy(timeId));
    // rain or snow falls only under the real sky
    precipitation.set(timeId === 'now' ? lightingSystem.weather : null);
    colorGrade.applyPreset(lightingSystem.lookId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
    if (timeId === 'now') describeNow();
  }
  // "Now": Ann Arbor's real sky, its sunrise and sunset worked out here, put on again every minute
  let nowCheckedAt = 0;
  function describeNow() {
    const btn = document.getElementById('time-now');
    if (!btn) return;
    const { rise, set } = sunTimes(Date.now());
    const at = (t) => (t ? new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/Detroit', hour: 'numeric', minute: '2-digit' }) : '—');
    btn.title = `Now in Ann Arbor · sunrise ${at(rise)}, sunset ${at(set)}`;
    const label = btn.querySelector('.seg-label');
    const w = lightingSystem.weather;
    const temp = w && w.tempF != null ? ` · ${w.tempF}°` : '';
    if (label) label.textContent = `Now · ${at(Date.now())}${temp}`;
    if (w && w.live) btn.title += ` · ${w.text}${w.tempF != null ? `, ${w.tempF}°F` : ''}`;
  }

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      // The camera control moves to the top on touch screens; open toward the available space.
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      travelBy(btn.getAttribute('data-mode'));
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // The GitHub link: the app around the page opens it in the browser (a link alone goes nowhere in its window)
  document.querySelector('.repo-link')?.addEventListener('click', (e) => {
    if (!window.LampNative?.available) return;
    e.preventDefault();
    window.LampNative.call('openRepo').catch(() => log('[github] the app could not open the link'));
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the place's name over its street corner, drawn as a pair of green street-name signs
  const roadNames = new Set(ROADS.map((r) => r.name));
  const placeNames = new Set(LANDMARKS.map((l) => l.name));
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    let place = '';
    let streets = label;
    const split = label.indexOf(' · ');
    if (split >= 0) {
      place = label.slice(0, split);
      streets = label.slice(split + 3);
    } else if (placeNames.has(label) || (!label.includes(' & ') && !roadNames.has(label))) {
      place = label;
      streets = '';
    }
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      if (streets.startsWith('near ')) {
        streets = streets.slice(5);
        const near = document.createElement('span');
        near.className = 'location-near';
        near.textContent = 'near';
        row.appendChild(near);
      }
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  function teleportTo(x, z, heading = Math.PI) {
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    mapSystem.waypoint = {
      x: destination.x,
      z: destination.z,
      name: getLocationLabel(destination.x, destination.z)
    };
    return destination;
  }

  const mapSystem = new CityMapSystem({
    controllerManager,
    cameraSystem,
    trafficSystem,
    allBlocks: cityBlocks.allBlocks,
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      const mapHint = document.getElementById('fullmap-hover-info');
      if (open && touchControls.available && mapHint) {
        mapHint.textContent = 'Tap to teleport · Drag to pan · Use + / − to zoom';
      }
    },
    onTeleport: teleportTo
  });

  teleportButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-teleport');
      const loc = TELEPORT_LOCATIONS[key];
      if (loc) {
        teleportTo(loc.x, loc.z, loc.heading);
      }
      closePopovers();
    });
  });

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }

  // Global keyboard shortcuts for modes (1-5), getting in and out (F), cameras (V / 6-0), and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    switch (e.code) {
      case 'Digit1':
        travelBy('person');
        break;
      case 'Digit2':
        travelBy('car');
        break;
      case 'Digit3':
        travelBy('cyclist');
        break;
      case 'Digit4':
        travelBy('helicopter');
        break;
      case 'Digit5':
        travelBy('kayak');
        break;
      case 'Digit6':
        selectCamera('chase', true);
        break;
      case 'Digit7':
        selectCamera('action', true);
        break;
      case 'Digit8':
        selectCamera('pov', true);
        break;
      case 'Digit9':
        selectCamera('mainStreet', true);
        break;
      case 'Digit0':
        selectCamera('stateLiberty', true);
        break;
      case 'KeyF':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) getInOrOut();
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
  });

  window.addEventListener('resize', () => {
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  });

  // Initialize the UI and chase camera around the restored player, or the default taxi on a first visit.
  selectMode(controllerManager.activeMode);
  // The HUD names what the player is holding, and changes as soon as they pick up something else.
  onInput((on) => {
    relabelKeys(on);
    renderControlHints(controllerManager.activeMode, on);
    touchControls.updateAvailability();
    placeModeIndicator();
  });
  selectCamera('chase', true);
  // Lamp: Ann Arbor's weather now (weather.js), on the "Now" sky and falling around the camera; asked for again every
  // 15 minutes of play
  let weatherAskedAt = -Infinity;
  const askWeather = (elapsed) => {
    weatherAskedAt = elapsed;
    fetchWeather().then((w) => {
      lightingSystem.weather = w;
      log(`[weather] ${w.live ? 'Ann Arbor now' : 'offline, so'}: ${w.text}${w.tempF != null ? `, ${w.tempF}°F` : ''}`);
      if (lightingSystem.activePresetId === 'now') selectTime('now');
    });
    // the Huron's flow at the USGS gauge, which the kayak's current follows
    fetchRiverFlow().then((r) => {
      controllerManager.riverScale = r.scale;
      log(`[river] ${r.live ? `Huron at Ann Arbor now: ${Math.round(r.cfs)} cubic feet a second` : 'offline, so its usual flow'}, current ×${r.scale.toFixed(2)}`);
    });
  };
  selectTime('now');
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // Compile shaders behind the loading screen. Overlapping compileAsync() jobs keep compilation moving
  // while individual jobs yield to the browser.
  const COMPILE_POOL = 16;
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  async function precompileShaders() {
    await showLoadingStage('Preparing reflections and bloom...');
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    renderPipeline.render();
    scene.visible = true;
    markInit('postFX');

    // Every visible object with frustum culling off (like the warm-up frame, see the loop). Plain meshes that share
    // a material share its shader, so one job compiles them in turn (the first build serves the rest); every
    // instanced mesh gets a build of its own unless its chunks share a pipeline
    const culled = [];
    const jobs = [];
    const jobByMaterial = new Map();
    const pipelines = new Set();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      // Use the first visible chunk: the original representative may be in an inactive tree cell. Shadow stand-ins
      // only draw in the shadow maps (the warm-up frame compiles those).
      if (o.userData.shadowProxy) return;
      const pipeline = o.userData.sharesPipelineWith || o;
      if (pipelines.has(pipeline)) return;
      pipelines.add(pipeline);
      if (o.isInstancedMesh || Array.isArray(o.material)) {
        jobs.push([o]);
        return;
      }
      let job = jobByMaterial.get(o.material);
      if (!job) {
        job = [];
        jobByMaterial.set(o.material, job);
        jobs.push(job);
      }
      job.push(o);
    });

    await showLoadingStage(`Compiling scene shaders... 0 / ${jobs.length} batches`);
    setLoadingProgress(0);
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    const compile = async (object) => {
      // Each compile starts in a task of its own: compileAsync() keeps one precompilation state on the renderer,
      // which must not be mid-step for two of them in the same microtask checkpoint
      await nextTask();
      try {
        await renderer.compileAsync(object, cameraSystem.camera, scene);
      } catch (e) {
        console.warn('[compile]', e); // the warm-up frame compiles it instead
      }
    };
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        for (const object of job) await compile(object);
        done++;
        if (loadingStatus) {
          loadingStatus.textContent = `Compiling scene shaders... ${done} / ${jobs.length} batches (${Math.round((done / jobs.length) * 100)}%)`;
        }
        setLoadingProgress(done / jobs.length);
      }
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }

  // Lamp's preview plays out of sight, frame by frame, with no screen to wait for: the warm-up frame compiles there.
  if (!window.lampPreview && !warmStart) await precompileShaders();
  markInit('compile');
  await showLoadingStage('Preparing shadows and the first frame...');

  // 6. The frame, which Lamp's runtime calls about 60 times a second (and its preview at exactly 1/60 s)
  let elapsed = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let heardStrokes = 0;
  let warmedUp = false; // see the first frame below

  if (elFps) elFps.textContent = '60';

  // Lamp: what each frame's work costs on this machine, logged every ten seconds (milliseconds a frame on average, and
  // the draws and triangles a frame), to see what slows it down
  const prof = { t: 0, n: 0, parts: new Map(), draws: 0, tris: 0, next: 10 };
  let profAt = 0;
  const mark = (name) => {
    const t = performance.now();
    prof.parts.set(name, (prof.parts.get(name) || 0) + (t - profAt));
    profAt = t;
  };
  renderer.info.autoReset = false;

  const frame = (f) => {
    profAt = performance.now();
    renderer.info.reset();
    const now = f.time * 1000;
    const rawDt = f.dt;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;
    tickNotice(dt);
    knockdowns.update(dt);
    hydrantSpray.update(dt, cameraSystem.camera);
    audioSystem?.gush?.(hydrantSpray.gushes(gushList));

    // Update 3rd-person controllers, camera, signals, traffic & vehicle collisions, building LODs, and dynamic shadow focus
    gamepadControls.supply(f.pads[0]);
    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed, cameraSystem.initialized ? cameraSystem.currentPos : null);
    // parked cars a crash shoved, sliding to a stop (parked-cars.js), and found where they are now
    for (const col of parkedCars.step(dt, (p) => controllerManager.settleParked(p))) controllerManager.refreshCollider(col);
    cameraSystem.update(dt, elapsed);
    streetDetails.signalClock.value = elapsed;
    controlsPart.made.update(elapsed);
    trafficSystem.update(
      dt,
      elapsed,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    mark('player & traffic');
    highwayTraffic.update(dt, cameraSystem.camera, controllerManager.getActiveEntity(), controllerManager.activeMode);
    mark('highway');
    railways.update(dt, (at) => audioSystem.trainHorn(at));
    parkedCars.update(cameraSystem.camera);
    riverPeoplePart.made.update(dt, elapsed, cameraSystem.currentPos);
    mark('trains & parked');
    const kayak = controllerManager.entities.kayak;
    if (kayak.strokes !== heardStrokes) {
      heardStrokes = kayak.strokes;
      if (controllerManager.activeMode === 'kayak') audioSystem.cue('splash', kayak.position, 0.8);
    }
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    if (outskirts.update) outskirts.update(elapsed);
    mark('misc');
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(cameraSystem.camera);
    mark('blocks');
    if (streetDetails.update) streetDetails.update(cameraSystem.camera);
    mark('street details');
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    if (lightingSystem.activePresetId === 'now' && elapsed - nowCheckedAt > 60) {
      nowCheckedAt = elapsed;
      selectTime('now');
    }
    if (elapsed - weatherAskedAt > 900) askWeather(elapsed);
    precipitation.update(cameraSystem.camera, elapsed);
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.lookId === 'midnight');
    mark('light, map, weather, sound');
    if (warmedUp) updateSceneCulling(cameraSystem.camera.position); // the warm-up frame draws every chunk
    // Traffic collisions can move the player after controller updates; finalize moving hierarchies here.
    for (const root of dynamicRoots) root.updateMatrixWorld();
    mark('culling');

    // Render frame via TSL RenderPipeline (SSR + Bloom)
    if (!warmedUp && !warmStart) {
      // First frame = pipeline warm-up behind the loading screen, for what precompileShaders() can't reach (the shadow
      // map passes): with frustum culling off, every visible material's pipelines compile now instead of stalling the
      // first time the camera turns towards it (one chunk / shadow stand-in per shared pipeline is enough)
      const culled = [];
      const pipelines = new Set();
      scene.traverseVisible((o) => {
        const pipeline = o.userData.sharesPipelineWith || o;
        if (pipelines.has(pipeline)) return;
        pipelines.add(pipeline);
        if (o.frustumCulled) {
          culled.push(o);
          o.frustumCulled = false;
        }
      });
      renderPipeline.render();
      for (const o of culled) o.frustumCulled = true;
      markInit('warmup');
    }
    renderPipeline.render();
    mark('render');
    prof.n++;
    prof.draws += renderer.info.render.drawCalls;
    prof.tris += renderer.info.render.triangles;
    if (elapsed >= prof.next && warmedUp) {
      prof.next = elapsed + 10;
      const parts = [...prof.parts].map(([k, v]) => `${k} ${(v / prof.n).toFixed(1)}`).join(', ');
      log(`[frame] ms a frame: ${parts}; ${Math.round(prof.draws / prof.n)} draws, ${(prof.tris / prof.n / 1e6).toFixed(2)}M triangles`);
      prof.parts.clear(); prof.n = prof.draws = prof.tris = 0;
    }
    if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
      // The loading screen stays up until the GPU has got through the first frame (and the pipelines its warm-up
      // compiled), i.e. until the city is actually on screen
      const device = renderer.backend.device;
      if (loadingStatus) loadingStatus.textContent = 'Waiting for graphics to finish the first frame...';
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        // Lamp's preview draws no frames on a screen, so a fade would never finish there: it goes at once.
        if (loadingOverlay && window.lampPreview) loadingOverlay.style.transition = 'none';
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        warm.compiled = true;
        audioSystem.ready = true;
        // Lamp: the Mac app lets the page play sound unasked, so the city is heard as it appears, not at the first key
        audioSystem.unlock();
        setLoadingProgress(1);
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const mph = Math.round((mode === 'kayak' ? activeEnt.groundSpeed || 0 : Math.abs(activeEnt.speed)) * 2.237);
      // Lamp: height above the ground below (terrain.js)
      const altFt = Math.max(0, Math.round((activeEnt.position.y - groundHeight(activeEnt.position.x, activeEnt.position.z)) * 3.281));

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(mph);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, mph / (topSpeedMph[mode] || 80))})`;
      if (elAltitude) elAltitude.textContent = altFt.toLocaleString('en-US');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(getLocationLabel(where.x, where.z));
    }
  };

  // The city reads its own keys and draws its own touch controls; a controller, and the preview's moves, come as the
  // first pad. The canvas goes back under the HUD, where the page laid it out.
  // Lamp: where the player is, kept through a change Lamp makes while the city is played (lamp-game.js, "Changes while
  // it's played"): the mode, where each of the person, car, bike and helicopter is, which way it faces and how fast it
  // goes, the camera and its zoom, the time of day, and whether the full map is open and the HUD hidden. The new code
  // starts from it once it has built the city, before its first frame; a field an older snapshot lacks keeps its
  // start value.
  function snapshot() {
    const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
      x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading, speed: entity.speed || 0
    }]));
    return { version: 2, activeMode: controllerManager.activeMode, entities, camera: cameraSystem.activePresetId,
             zoom: cameraSystem.zoomMultiplier, time: lightingSystem.activePresetId,
             map: mapSystem.isFullMapOpen, hudHidden: document.body.classList.contains('hud-minimized') };
  }
  function startFrom(state) {
    if (state?.version !== 2) return;
    for (const mode of Object.keys(controllerManager.entities)) {
      const p = state.entities?.[mode];
      if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
      controllerManager.setMode(mode);
      controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      if (Number.isFinite(p.speed)) controllerManager.entities[mode].speed = p.speed;
    }
    selectMode(Object.hasOwn(controllerManager.entities, state.activeMode) ? state.activeMode : controllerManager.activeMode);
    if (state.time) selectTime(state.time);
    if (state.camera) selectCamera(state.camera, true);
    if (Number.isFinite(state.zoom)) cameraSystem.zoomMultiplier = state.zoom;
    if (typeof state.hudHidden === 'boolean' && hudToggleBtn && state.hudHidden !== document.body.classList.contains('hud-minimized')) hudToggleBtn.click();
    if (state.map === true) mapSystem.toggleFullMap(true);
  }

  // sharp: drawing smaller never made frames faster here (the log showed it undone every time), it only blurred the city
  game({ renderer, init() { const was = pendingRestore(); if (was) startFrom(was); }, frame, touch: false, keyboard: false, snapshot, sharp: true,
    // What this run made that no part keeps goes with it: the map and the camera system are made afresh by the next.
    dispose() { cameraSystem.release(); mapSystem.release(); } });
  container.appendChild(renderer.domElement);
}

initApp();
