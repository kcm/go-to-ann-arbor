Kind: game, drawn with three.js (Lamp's runtime in Web/lamp-game.js), at home on the Mac.
Look: a sunlit 3D Ann Arbor, Michigan at true scale (brick downtown, campus limestone, leafy neighborhoods, the Huron
River, Michigan maize #FFCB05 and blue #00274C on the Big House), with a translucent dark heads-up display over it: the
place and street at the bottom left over a minimap, the modes (Walk, Drive, Cycle, Fly, Paddle) at the bottom, the vehicle and
its speed at the bottom right, and time of day, Teleport, Map and sound at the top right.

# Ann Arbor

Slop Ann Arbor: Mr.doob's Slop New York (MIT, `Web/LICENSE-slop-newyork`, commit e35c06c in credits.json; its changes since 13dd142 merged in: road paint in culled chunks, crowd culling and a vertex-shaded far LOD for people, cell-by-cell tree LOD, fire escapes, storefronts and entrances, building collision, gamepad and car wheel material) moved from
Manhattan to Ann Arbor. The city inside the I-94/US-23/M-14 ring, about 7 by 6 km, with every street where it really
is, every building from the city's surveyed footprints and heights, the Huron River, parks, the Diag, street trees from
the city's inventory, traffic and people; Michigan Stadium ("the Big House") modelled by hand.

- **Getting around**: 1 walk, 2 drive your own black compact SUV (a Subaru Forester look, Michigan "GO BLU" plates; Ann Arbor has few taxis), 3 cycle, 4 fly a sightseeing helicopter, 5 paddle a kayak on the Huron (its current follows the river's real flow, below, carries it and turns it where the bow and stern feel different currents; only a blade in the water drives it, each stroke a surge, where a blade goes in and out the water's own surface ripples in rings, and a V wake runs off the bow, both tilting the water's shading, no overlays (`waterDisturb` in tsl-materials.js, set by `updateKayak`, `kayakRipple`, `updateRipples` in controllers.js); the HUD shows its speed over the bed; the Argo Cascades beside Argo Dam are paddleable: nine one-foot drops between rock weirs, from OpenStreetMap's channel and weirs (cascades.js: the water steps down weir by weir in `waterLevel`, the rocks block all but each chute, the current quickens through it, white water below tosses the kayak and it noses down each drop; the rapids are drawn in the water's own shader (`rapidsField` in tsl-materials.js: standing waves, chop and foam), the pond side of the dam is held at the pond's level behind a low wall (`DAM`, `pondSide`), the pond draws the kayak gently to the channel's head (`pondDraw`), and river.js cuts the water and banks every 3 m around the channel while leaving out dry land; the ground under the town (outskirts.js) takes the lowest ground around there so it never shows through). Kayakers and tubers float down from the cascades on a traced 2.4 km run, respawning at the top (river-people.js). F gets out of a car and into the nearest one, parked or moving (the moving one's driver is left behind; `enterOrExit` in controllers.js), but not above about 9 mph ("Slow down to get out"). Each car kind drives its own way (`CAR_HANDLING` in controllers.js: mass, top speed, pickup, grip, steering, body roll); traffic and parking include a low sports coupe (`BODY_SPECS.sports` in cars.js), the quickest to drive. Parked cars keep their lamps dark. Car crashes are rigid-body impulses: into walls and posts at the corner or face that touched, with bounce, sliding friction and spin (`carWallImpulse` in controllers.js); into traffic by mass (vehicle-physics.js); into parked cars, which are bodies of their own weight, shoved and spun, sliding to a stop on locked wheels and knocking the cars beside them (`shoveParked`/`settleParked` in controllers.js, `step` in parked-cars.js). On the bike, the map and minimap show bike lanes solid, shared lanes dashed and paved paths thin (city-map.js). W A S D or the
  arrows, Space or E up and Q or C down in the helicopter, Space (A, a touch button) the car's handbrake (locks the back
  wheels: scrubs speed, lets the tail slide), B horn. Dragging orbits the camera. Each way of getting around starts
  at its own view (`SCENIC_STARTS` in main.js): walking on the Diag facing Burton Tower, the car on Main St at
  William (a first play starts there), the bike in South University's bike lane, the helicopter high south of the
  stadium facing downtown, the kayak in the Argo Cascades' channel by Argo Park's dock, facing the rapids. 1 to 5 (`travelBy`) take the player there,
  unless that vehicle is within 40 m, when they just take it. The helicopter lands wherever its skids come down: the ground, Michigan Stadium's field
  and stands (it flies into the bowl; `helicopterFloor` in `controllers.js` uses `bowlSurface`), and any roof it
  was above: a house's own pitched roofs (houses.js gives the house's collider `roofs`, each a plane set), other
  buildings' flat tops. A roof it rests on doesn't push it sideways; one above it is still a wall.
- **Cameras**: V (Shift-V back): chase, action, first person and scenic ones (`diag`, `mainStreet`, `stateLiberty`,
  `burtonTower`, `burtonTop`, `bigHouse`, `arbRiver` in `cameras.js`).
- **Knocks and falls**: people, trees, signal and lamp poles and sign posts are solid (`obstacles` from
  street-details.js and traffic-controls.js, colliders marked `thin` so the helicopter ignores them). A person the
  player hits at speed goes limp: a 16-point Verlet ragdoll (`startRagdoll`, `stepRagdoll`, `solveRagdoll` in
  pedestrians.js, driven by `strike` in pedestrian-system.js), who then gets up through the dive's recovery, or is
  cleared once out of sight. A cyclist hitting something hard, or the player struck by a car, falls the same way
  (`knockDown`, `throwRider` in controllers.js), then stands up; a 'thud' cue and rumble go with each hit.
  A car hitting a tree, pole or sign post hard enough knocks it over (knockdowns.js): the speed it takes grows with
  a tree's trunk and falls with the car's mass; it tips about its foot the way the car went, lands with a thud or
  crash, stays down and stops being solid, and the car loses speed by how stout it was. A felled streetlight goes dark (its
  light sites get `out`, its pool is hidden); scene-culling.js notes where each split-up instance went (`movedTo`,
  `shadowCopy`) so a knocked-over piece moves where it's drawn (a chunk never inherits
  its source's notes). The parks' globe lampposts (`parkLampMeshes` from city-grid.js) are solid and fall the same way.
  Fire hydrants (obstacles of kind 'hydrant' from street-details.js) are thrown instead: they fly off tumbling the way
  the car went, bounce and scrape to rest (`throwHydrant`, `updateFlying` in knockdowns.js), and the broken riser gushes
  (hydrant-spray.js): a clear, streaming jet leaning with the breeze (a flared open cylinder with TSL streaks), thin
  speed-streaked drops falling back as rain with splashes, soft camera-facing mist puffs, and a spreading wet patch;
  full pressure 30 s, then shut off over 6 s. Its roar is `gush` in audio-system.js.
  Cars drive into the Big House over its rim: `carSurface` in stadium-shape.js is the car's ground there (the wall
  top, the concourse, then the stands' steps down to the field), and the bowl's colliders don't stop cars. Cars leave
  the ground when they come over a crest or up the stands fast (`carVertical` in controllers.js: ballistic flight,
  nose following the arc, a thump and rumble on landing); a step up too tall for the speed bounces them back.
  A jump can land the car on a building: `carRoof` makes the roofs under it its ground (kept in `_carStanding` so
  they aren't walls), and it drops off the edge at any speed. Sliding back tires (`car.skid`, from the handbrake or
  the tail stepping out) lay fading rubber streaks and white tire smoke (skid-effects.js). The player's own car is a
  maize sports car with GO BLU plates (OWN_CAR). The field has its yard numbers and goal arrows (landmarks.js).
- **Two wheels and boards** (motorcycles.js): sport bikes, cruisers, scooters, tourers and adventure bikes, plus
  bicycles, e-bikes (battery on the down tube, rear hub motor, fenders and rack; ridden to 28 mph), e-scooters and hoverboards, each a procedural model of smooth lofted shells (`loftGeometry`), real
  wheels (cast, wire or disc, with rotors), one mesh per kind for traffic. Riders are the town's skinned people
  (`PersonRig.perch` in pedestrians.js, posed from `motoRiderPose(kind)`, drawn through a `PersonCrowd` in traffic.js
  within RIDER_DISTANCE) wearing a real helmet (`buildHelmetGeometry`, full, open-face or bicycle by `HELMET_OF`). Motorbikes ride in lanes
  (1 in 10 of traffic); the quiet kinds (`quiet`, 1 in 10) keep to the curb side of the lane (`CURB_OFFSET`) at
  their own pace (`curbSpeed`), and cars pass them rather than queue (`ahead` in traffic.js). Any of them can be
  taken from traffic and ridden in car mode (`createBikeEntity`, handling in CAR_HANDLING); the player rides as their own
  person perched on it with the bike's helmet (`riderPose`, `riderMesh` is the helmet), so a crash over MOTO_THROW_SPEED into a wall or car throws them off (`throwMotoRider`).
  A big jump switches to a cinematic camera until landing (cameras.js), higher in the stadium.
- **Road work** (road-work.js): Michigan's closed blocks with cones, drums, barricades and detailed dump trucks
  and excavators; traffic routes around closed blocks, and anything driving into the cones knocks them aside.
  The dirt (piles, the truck's load, the bucket's scoop, the dug patch) is lumpy procedural mounds (`moundGeo`, `clods`)
  drawn with ambientCG's Ground 054 soil photo, projected from the world and tinted by vertex colour (`soil` attribute);
  the machines wear mud low down, streaks, dust on top and shade underneath, all in the one road-work material.
  The machines are drivable: `nearestMachine` feeds getting in (controllers' enterOrExit), `take` hides the parked one
  and `leave` puts it down where you got out, `claim` restores one held in a save, `home` (Reset) puts all back.
  The player's machine is built by `createMachineEntity` (six truck wheels, the front pair steering; the excavator
  slides on its tracks) with CAR_HANDLING's `dumptruck`/`excavator`, a bigger collision box (`MACHINE_BOX` → `playerBox`,
  also read by traffic and train contact) and the bus engine sound.
- **The city**: time of day from the buttons at the top, Teleport (Main Street, the Diag, Burton Tower, the Michigan
  Theater, Kerrytown, the Big House, the Arb, Gallup Park), M the full map (true north up), H hides the HUD, N sound, and the reset button (after sound) puts the car, bike, kayak, helicopter and walker back at their starts (`resetGame` in `main.js`).
- **A controller** works too (`gamepad-controls.js`): left stick move or steer, right stick look, RT and LT gas and
  brake, A jump, LB and RB change mode, Y the camera, Menu the map and B closes it.
- The guide to the controls and the keys on the HUD's buttons show what the player is holding (`input()`, `label()`
  and `glyph()` from lamp-game.js, in `controlHints`, `renderControlHints` and `relabelKeys` in main.js).
- The game remembers where the player was between launches (`save('player')`, version 2 since the move from New York).
- **Badge and map**: the top left says "Go To Ann Arbor" and "GitHub ↗", which opens https://github.com/mrubens/go-to-ann-arbor
  (through `openRepo` in Sources/Native.swift in the app; a plain link elsewhere). Mr.doob's credit, "Made from
  Mr.doob's Slop New York", is under the full map's title. The game starts with no GPS route; Teleport sets one and
  the full map's "Clear route" button clears it (city-map.js).
- **Churches**: a sizeable building on a religious parcel is drawn by churches.js (gable roof, bell tower and spire
  with a cross, lancet and rose windows, a door), 55 of them.

## Code

- The page is `Web/`: `index.html` the page and the HUD's markup, `css/style.css` the HUD's look. Lamp's files beside
  it are `lamp-game.js` (the runtime: the frame, the pads, saves), `lamp.js` and `three/` (three.js with its WebGPU
  renderer and node materials, `three/webgpu` and `three/tsl`, drawing with WebGL 2), loaded through the import map.
- `Web/js`, all ES modules:
  - `main.js`: start-up, `QUALITY` (what's drawn), the HUD, keys, and `frame(f)`, which Lamp's runtime calls about 60
    times a second (`game({ renderer, init, frame, touch: false, keyboard: false, snapshot })`: the city reads its own
    keys and draws its own touch controls; a controller comes as the first pad; after a change of code `init` starts
    the city where `snapshot()` left it, full map and hidden HUD included). Lamp draws it at 1920x1080 and fits that to the window.
  - The place: `city-geodata.js` (the real geography, generated data: don't edit by hand), `city-config.js` (streets,
    parks, water, the town's edge `TOWN_EDGE` and bounds `TOWN_BOUNDS`, `LANDMARKS`, in meters), `city-grid.js`, `landmarks.js`, `outskirts.js`, `road-network.js`,
    `road-paint.js`, `traffic-controls.js` (traffic lights on mast arms at OSM signals, switched each frame from
    city-config.js's signalPhase so they match what traffic obeys; stop & yield signs where road-network.js put
    them, mapped or inferred at side streets), `street-details.js` (lamps, signs, hydrants, tree pits), `street-props.js`, `trees.js` and
    `tree-placements.js`.
  - Buildings: `building-geodata.js` reads every surveyed building from `building-geodata.bin.gz` and
    `tree-geodata.js` every street tree from `tree-geodata.bin.gz` (both beside them, generated by Mr.doob's
    `tools/build-buildings.py` and `tools/build-trees.py`). `buildings.js` makes them
    into merged facades (`building-footprints.js`, one mesh per square kilometer) with their details
    (`building-details.js`, `fire-escapes.js`), colliders the shape of each outline (`building-collision.js`).
  - Looks: `tsl-materials.js` (every material, in TSL), `lighting.js` (`TIME_PRESETS`: sun, sky, fog for each time
    of day), `post-processing.js` (glow and color grading), `vehicle-lights.js`.
  - Things that move: `controllers.js` (the four ways to move, their physics and keys), `traffic.js` (cars and buses),
    `vehicle-physics.js` (how vehicles hit and push each other), `pedestrian-system.js` (the people around the player,
    how they cross and dodge), `pedestrians.js` (their bodies and gait) and `pedestrian-routes.js`; the vehicles are
    lofted from cross-sections in code with three.js's LoftGeometry: `cars.js`, `bus.js`, `helicopter.js`, and the
    pieces they share in `vehicles.js`.
  - `cameras.js`, `city-map.js` (the minimap and the full map), `scene-culling.js`, `audio-*.js` (the synthesized
    sounds), `gamepad-controls.js`, `touch-controls.js` (shown on a touch screen).
  - The ground: `terrain.js`. The city is built flat at street level (y = 0) and then set on the real ground's heights:
    `groundHeight(x, z)` is the one answer to "how high is the ground here", and everything asks it. `setOnTerrain`
    (called in main.js once the city is built) cuts the ground layers finer where the ground bends and lays them on
    it, and lifts whatever stands on it whole; buildings stand on the lowest ground under their outline (in
    `buildings.js`, which lifts their colliders, details and billboards with them) and landmarks under their lot
    (`groundUnder`), and the facade shader counts storeys from there (the `ground` attribute of `createFacadeBoxes` and
    `createBuildingFootprints`).
    The cutting is the slowest part of a start, so it's done once and saved: the height maths and the cut itself are
    plain functions in `ground-core.js`, run on several cores by `drape-worker.js` (each long triangle halved to 200 m
    first, so the one road quad over the town is shared out too); the draped layers, already in 800 m tiles, are saved
    in IndexedDB (a database per city part, `ground-layers-<part>`), keyed by a fingerprint of the heights, river,
    bridges, the cutting code and each layer's own geometry, and read back on later starts. setOnTerrain answers a
    promise when it has layers to cut; main.js awaits it in the grid and street-details parts. Ground layers are cut at
    16 cm down to 5 m edges (the road markings sit 10 cm over the road surface, `road-paint.js`). A layer stacked over another
    must sit more than that above it, or the one under shows through on slopes as long wedges: the lawns (LAWN_Y 0.34)
    are 12 cm over the sidewalk slab (SW_TOP 0.22) that fills each block under them. Driveways and front walks, a few mm over the
    lawn, are drawn in front of it with `drawOver` (terrain.js: each vertex pulled along its line of sight, so only its
    depth changes) instead of a real lift. Driveway aprons (small, four
    corners) are always concrete, so the sidewalk never shows a blacktop patch. Pavings with holes (the walk webs of the Diag and the quads) are
    concrete too; only wide paved yards are always blacktop. The map's footpaths (golf.js `buildTrails`) are the same concrete and draw over the lawn but
    under that paving (`drawOver` 3 cm vs 6 cm), since they run a little off the surveyed walks. The preview has no lasting
    database, so it always cuts. Start times (the open game, cold → saved): street level ~11.5 s → 3.7 s → 2.7 s.
    Cars, bikes, people, the helicopter's skids and the cameras follow it each frame; cars tilt with the slope
    (`groundTilt`). Something new that stands on the street: build it at y = 0 as before, and add
    `groundHeight(x, z)` where it's placed (or leave it in a group setOnTerrain sets).

- three.js is Lamp's (`Web/three`), older than the one Mr.doob now pins: the tree and sign materials keep
  alpha-test nodes (`alphaTestNode`/`maskShadowNode`) rather than `alphaTest`, the workaround he dropped in his commit
  c9c1900 once three.js fixed shadow casters re-checking their shaders every frame.

## Data

Everything ships with the game; the only things fetched while it runs are the live weather (`weather.js`: the National
Weather Service's latest observation at KARB, api.weather.gov, every 15 minutes; a fair day offline; no personal
details sent) and the Huron's flow (`river-gauge.js`: the USGS gauge "Huron River at Ann Arbor", site 04174500,
discharge in cubic feet a second, asked for with the weather; public domain; the kayak's current is scaled by
(cfs/500)^0.4 within 0.45 to 2.4, and runs at 1 offline). All the rest is generated by
`Assets/Tools/build-annarbor.py` (run with the venv's Python in `.lamp/reference/venv`; its downloads are cached in
`.lamp/reference/aa/`), which writes the files below in the same shapes Mr.doob's New York tools did:

- `Web/js/city-geodata.js` (Ann Arbor's map; `GEO.edge` the detailed area's outline): streets, blocks, parks, water and the land's outline from
  OpenStreetMap through the Overpass API (ODbL). World frame: 1 unit = 1 m, x east, z south, true north up
  (`GEO.frame.bearingDeg` 0), origin at Main St & Liberty St (42.27965, -83.74838).
- `Web/js/building-geodata.bin.gz`: the City of Ann Arbor's building footprints (AAGIS, from 2009 LiDAR, with average
  heights; https://ckan.a2gov.org/dataset/building-footprints), OSM heights where it has them.
- `Web/js/tree-geodata.bin.gz`: the City of Ann Arbor's street tree inventory. It states no license: fine to use here,
  but ask the city before publishing or sharing the game widely.
- `Web/data/elevation.bin.gz` (also from build-annarbor.py): ground heights from the open Terrain Tiles on AWS (Mapzen, USGS 3DEP), relative to the
  lowest ground in the box (downtown is about 28 m up, the river lowest).

Houses (survey kind 1 under 14 m, and small sheds and garages) are drawn by `houses.js`, not the facade shaders. Each
footprint is split (rasterised at 0.5 m in its oriented box) into a main block, the largest rectangle, and up to three
wings; the main block's roof is OSM's `roof:shape` where mapped (`data/roof-shapes.json`), else chosen from shape and
age (a gable to the street on narrow lots, hipped foursquares, side gables with dormers on 1.5-storey houses); wings get
lower cross gables or lean-tos. Storeys come from the survey height (LiDAR average, reads low: under 4.6 m 1, under
6.6 m 1.5, under 10 m 2, else 3). Roofs overhang with fascia, soffits and rake boards. Walls are one shader (`wallInfo`,
`houseInfo`, `houseStyle`: material, trim and door/shutter colors from a small palette texture, foundation height):
clapboard in an Ann Arbor palette, about one in five brick, some stone, stucco or shakes; sash windows, shutters on
some, a colored door on the front wall, gable and dormer windows, a visible foundation. Porches (posts or craftsman
brick piers, railings, a lean-to roof), steps, porch lights, shrubs and front walks to the street; railings, steps,
shrubs and lights are instanced and culled by distance. Everything is seeded by the house's position.
Residential blocks have a grass tree lawn between the curb and a
narrow sidewalk (`TREE_LAWN` in the generator, drawn with the lawns); street trees stand in it without pits
(`tree-placements.js`).
Driveways (`GEO.driveways`, drawn in `city-grid.js` as blacktop or concrete) are the paving from the city's 2023
Impervious Surfaces map (no license stated; https://a2maps.a2gov.org/a2arcgis/rest/services/ImperviousSurfaces/MapServer/7)
on residential lots, less the buildings; from each end of a piece that comes near the curb (the city often maps a
walk and its driveway as one piece, so each end is measured on its own) a strip runs out: a front walk
(under 2.6 m across) to the sidewalk, a driveway (2.6 to 7 m) to just inside the curb, where a flared concrete ramp (`GEO.curbCuts`, city-grid.js) runs down over
the curb to the gutter. Only pieces that reach the street or a small building (a garage) are kept (back patios and
stray bits read as dirt from above), and none in parks, whose paths are the trails; a piece that is nearly a rectangle is drawn as one, the rest simplified.
Most are pale concrete; a quarter, and pieces over 120 m², are mid-gray blacktop.
Trails (`GEO.trails`, OSM paths, footways, bike paths and tracks inside parks, woods, the cemetery and lawn blocks,
not sidewalks or golf courses) are flat ribbons from `buildTrails` in `golf.js`: dirt for unpaved, gray paving else.
Golf courses (`golf.js`, `GEO.golf`): striped fairways, greens with pins, tees, bunkers, cart paths. Railways
(`railways.js`, `GEO.rail`) lay track with ties and run trains that sound their horn (`audio-events.js`); cars and people ride on top of the
track (`trackTop`, used by `getGroundHeight` in controllers.js) and trains are solid, immovable bodies to the car
(`collideTrains`). Parked cars (`parked-cars.js`) fill parking-lot stalls and the curb parking lanes, never within
3.2 m of a track (`nearTrack`), near ones in full with wheels, far ones as simple
shapes; traffic is 70 cars and up to 16 buses. TheRide buses (`theride.js`, `data/theride.json.gz` from
`Assets/Tools/build-theride.py`, which reads TheRide's GTFS feed unzipped in .lamp/reference/gtfs): every trip on the
road now by Ann Arbor's clock and calendar (a date outside the feed's dates is moved by whole weeks into them) is given
a bus where its timetable puts it near the player, on its route's path matched to the road edges, stopping at each
real stop until its departure; stop signs stand at the curb by each stop. Buses wear plain city-bus colors, never TheRide's livery or logo (that needs
their permission): white, pale gray top, dark green band (`bus.js`); stop signs are plain green BUS STOP plates; the
bus's sign shows route number and destination. Rebuild the data when the
feed changes (it runs to Jan 2027). Curb parking lanes (`curb-parking.js`): the build's `park_spec` reads OSM
parking:both/left/right (untagged: Main, Liberty, Washington, State and S University downtown only) into link field 12
(bits 1 right, 2 left as drawn) and widens the street 2.4 m per side; traffic lanes stay inside them, road paint draws
each lane's line and its 6.5 m stall marks, and parked cars stand in those stalls.
Storefronts (upstream's `createStorefront` in tsl-materials.js): only on buildings marked `storefronts` in buildings.js (a shop building in the survey, or a shop or mixed-use parcel; never the University's, houses or churches), on their front walls (`WALL_KINDS.shop` in building-footprints.js); muted glass and frames, no painted sign names (`SIGN_NAMES = false`: the real names come from shop-signs.js). Other fronts get upstream's building entrances, and their ground floors keep the same windows as the floors above (the person wanted them to match). No awnings (the person disliked them): building-details.js makes only the odd scaffold shed.
A block is paved over (no lawn) only where its buildings and the city's paving map leave under a fifth of it
unpaved (downtown's Main and State Street blocks, strip malls, industry); campus and the neighborhoods keep grass.
A park's or golf course's slab (an odd-shaped lawn block) is only its sidewalk ring, so the lawn shows inside.
Parking lots (OSM) are striped by `parking-stripes.js`: an overlay whose stalls run off each lot's longest edge.
Park, wood and yard trees (`GEO.woods`) fill the city's Urban Tree Canopy map
(https://a2maps.a2gov.org/a2arcgis/rest/services/NaturalFeatures/MapServer/10, no license stated) about 7.5 m apart,
plus OSM's mapped trees; playgrounds (OSM, `GEO.playgrounds`) get wood chips, a play tower and swings (`playgrounds.js`).
A house wall the paving runs up to gets a garage door (`GEO.garageDoors`, single or double, drawn by the house shader).

More from the generator, each in `GEO`:
- Street classes, one-ways, lanes, bike lanes and speed limits (OSM) on the road graph, a street OSM gives no limit
  taking the city's Road Centerlines `SpeedLimit` (RoadsSpeedlimitCrash/MapServer/1, no license stated; matched within
  12 m and in line). Traffic (`traffic.js` CLASS_TRAFFIC) spawns and turns mostly onto main roads, few onto side
  streets and alleys, at each street's limit; `road-paint.js` paints lane
  lines and bike lanes (a centre turn lane ending at a bend tapers its solid edges into the double yellow that goes on), and continental crosswalks only where OSM maps a painted crossing (`GEO.controls.crossings`
  `[x, z, marked]`: 1 painted, 0 not, 2 not said, which gets one only at traffic lights), mid-block ones too.
- Traffic lights, stop and yield signs (`GEO.controls`, OSM) drawn by `traffic-controls.js`, lit by `signalPhase` in
  `city-config.js`, the same clock traffic obeys.
- Street trees by species and height (the city's inventory; `trees.js` SPECIES) and streetlights
  (`GEO.streetlights`, the city's Streetlights layer, no license stated). "Now" works out the real sun (`sunTimes`).
- Storefront signs (`GEO.signs`, OSM named shops, food, bars, services; `shop-signs.js`, one atlas) on the wall of the
  building each is in that faces the street; building names (`GEO.places`, the footprints' `Bldg_Name`) show in the
  location label as you pass (`buildingNameAt`).
- Amtrak's Wolverine (`data/wolverine.json`, `Assets/Tools/build-wolverine.py` from Amtrak's GTFS feed,
  https://content.amtrak.com/content/gtfs/GTFS.zip, unzipped in .lamp/reference/amtrak/feed; the feed states no
  license): each train's stop at Ann Arbor, [train, west or east, headsign, arrival, departure, days, first and last
  date]. `railways.js` runs the Michigan Subdivision's passenger train on it by Ann Arbor's clock (`runTimetable`):
  braking in toward the Depot Street station (`STATION`), standing at the platform until its departure, pulling out
  with its horn; with no train due it's out of sight. The two freights still run back and forth. Rebuild the data
  when the feed changes (this one runs to Oct 2027).
- Railroad crossings (`data/rail-crossings.json`, OSM level crossings, `Assets/Tools/build-rail-crossings.py`): every
  one gets gates (`railways.js` buildCrossingGates), a mast with crossbuck and red lamps at the right-hand curb each
  side, whose arms come down and lamps flash while a train is within 160 m.
- Street furniture (`data/street-furniture.json`, `Assets/Tools/build-street-furniture.py`): the City of Ann Arbor's
  Fire Hydrants (ckan.a2gov.org "fire-hydrants", no license stated), each moved onto the curb if its point is in the
  street and turned to face it; its Park Amenities ("park-amenities"): benches, trash cans, picnic tables, grills,
  drinking fountains, bike racks and picnic shelters; and OSM `leisure=pitch` courts (tennis, basketball, pickleball,
  volleyball, soccer; indoor ones left out), painted with their lines, nets, hoops and goals and draped on the ground
  (`street-details.js` section 6). Only the shelters cast shadows.
- House numbers (`data/addresses.json`, `Assets/Tools/build-addresses.py`): the City of Ann Arbor's Address Points
  (ckan.a2gov.org "address-points", no license stated; download cached in .lamp/reference/aa/addr). `houses.js` gives
  each house with a front wall the number of the address point inside its footprint (else the nearest within a few
  metres) on a dark plate with brass digits beside the front door, one instanced mesh whose shader picks the digits
  from a 0-9 atlas (`plate` attribute). No taxi fares: Ann Arbor has no taxis.
- Land use and historic districts (`data/districts.json`, `Assets/Tools/build-districts.py`, read by `districts.js`:
  `landUseAt`, `historicDistrictAt`): the City of Ann Arbor's Land Use parcels and Historic Districts
  (ckan.a2gov.org, no license stated). Inside a historic district the location label leads with its name, houses
  take heritage colors (oxblood, greens, ochre, slate) with more brick, gables, porches and chimneys and steeper
  roofs, and other buildings under 30 m (not the University's) are old red or buff brick; church land gets stone or
  brick, industry and research plain tan brick.
- Roof shapes (`data/roof-shapes.json`, `Assets/Tools/build-roof-shapes.py`): OSM `roof:shape` on Ann Arbor's
  buildings (ODbL; download cached in .lamp/reference/aa/roofs), [x, z, shape] at each building's centre.
- Gas stations (`data/gas-stations.json`, `Assets/Tools/build-gas-stations.py`, drawn by `gas-stations.js`): OSM
  `amenity=fuel` (ODbL; its download cached in .lamp/reference/aa/fuel). Each gets a white canopy with a plain
  colored band (no brands), pump islands with a column and two pumps each, and a lit underside at night. The canopy
  is OSM's roof outline, else the survey's canopy-shaped outline on the station (which `buildings.js` then leaves
  out), else set in the open part of its Auto Sales or Service parcel.
- Building owner (`Owned_By`): kind 5 University (collegiate red-brown brick or limestone, facades 8/9), kind 6 the
  city, county, schools and federal (tan civic brick or limestone, 10/9), in `buildings.js`.

What's Ann Arbor's by hand: `city-config.js` (`LANDMARK_SITES`, `TELEPORT_LOCATIONS`), `landmarks.js` (the Big House,
which clears the survey's buildings under its collider), `outskirts.js` (the farmland and ground around and under the
city), the names in `city-map.js` (`AREA_LABELS`), `cameras.js` and the HUD,
and the spawn points in `controllers.js`.

## Easy to change

- Time of day and the sky's colors: `TIME_PRESETS` in `lighting.js`.
- How a building, the roads or the park look: `tsl-materials.js`, `buildings.js`, `building-details.js`.
- The vehicles: `cars.js`, `bus.js`, `helicopter.js`; how they drive, fly and how fast: `controllers.js`.
- How busy the streets are: the counts in `traffic.js` and `pedestrian-system.js`.
- The HUD: `index.html` and `css/style.css`.
- What's drawn: `QUALITY` in `main.js`. Street lights and reflections add several seconds to the start and are off.

Keep it smooth: the log's `[frame]` line (every 10 s) gives each part of a frame's milliseconds, draws and triangles;
measured on campus (M4 Max): game logic under 1.5 ms, the drawing ~13 ms for ~1,380 draws and 11.4M triangles
(shadows included; the ground layers alone 3.6M in view), so it's the number of draws that costs. Try changes that draw more with the frame rate in the top left, and keep new geometry instanced or
merged like the rest. The whole city is built before the first frame, about half a minute in Lamp's preview: a look
takes that long.

Most changes go into the city as it's played, with nothing built again and the player where they are: the HUD's look
(`css/style.css`), how the player moves and the vehicles' tuning (`controllers.js`), the cameras (`cameras.js`), the
time presets (`lighting.js`), the map's drawing (`city-map.js`) and the controller (`gamepad-controls.js`), each a class
in a module ending with `hot(import.meta).accept()` from lamp-game.js ("Changes while it's played" there). Anything
else (`main.js`, `index.html`, what those constructors built once, a new module) runs the game's code again in place,
back where the player was, in a couple of seconds: `main.js` keeps the renderer and each part of the city
(`live.keep`), and builds a part again only when its own code, the generated data it's built from (its `from`:
`CITY_MAP`, `BUILDING_DATA`, `TREE_DATA`, `SUBWAY_DATA`) or a part it's built from (its `inputs`) changed, so a change
to the trees builds the street details, traffic and road paint again and the rest stays, and a change to the map data,
which nearly every part reads, builds the city again in place with the player where they are. A new part of the city goes the same way: built by its own
module into the group `cityPart` gives it, set on the ground inside that build, and kept in `main.js` with the data
it's built from as its `from` and the parts it's built from as its inputs. Something new that changes as it's played
(a mission, a race) goes in a module of its own, a class `main.js` makes one of.
Logo: an inline SVG in index.html (`.app-logo`): Burton Tower in navy against a maize sun over a road; the title is Go To Ann Arbor.

The page keeps every version of a module for as long as it's open, with whatever its variables point at, so what a
module holds at its top level is released when the code runs again: `hot(import.meta).dispose` for what the module
itself gathered, `release()` from the run or part that owns a system. Big tables that never change as it's played
(the buildings, the trees) are built inside `keep`, with what they're read from in `from`, so a run reuses them.

Memory (device-tier.js: light by default on desktop, full via `?tier=full`, phone on touch devices): the still parts of the city (main.js `still`, the streamed ground tiles, the streamed houses) keep their vertex data on the GPU only (gpu-only.js lets go of the script's copy once uploaded, sending out-of-sight pieces up after a few rounds). Where the tier streams (`TIER.stream` metres), parked cars come and go by 250 m cell (parked-cars.js, `onColliders`), trees by square kilometre (trees.js, `onObstacles`, their trunks solid through main.js), and the shop signs are painted at half size. memory-report.js logs the count once built and as spare copies go; the phone setting aims under 450 MB (about 350 MB measured in the preview). `?tier=phone` tries the phone setting.

Tree sizes (trees.js): a surveyed street tree grows to its real height (only a typo past 45 m is cut down); park, wood and yard trees (`likeStreet` from city-grid.js) take a height from the taller two-thirds of the surveyed street trees of their kind.
