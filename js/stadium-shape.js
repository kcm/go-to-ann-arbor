import { STADIUM } from './stadium-geodata.js';

// Michigan Stadium's bowl, shared by terrain.js (which digs the ground out under it) and landmarks.js (which builds its
// stands): the real field wall and outer wall from OpenStreetMap (stadium-geodata.js), and along every ray from the
// field's middle the same cross-section, in metres from the ground around the stadium:
//   the field 15 m down · its wall · the rows of seats rising to the rim 5 m up · a walkway · the outer wall.

const N = STADIUM.rIn.length;
const FIELD_Y = -15, WALL_TOP = -13.6, SEAT_TOP = 5, RIM_Y = 5.6, WALL_Y = 7.2;
const AISLE_IN = 1.6;   // the walk between the field wall and the first row
const CONCOURSE = 6.5;  // from the top row to the outer wall's face

// Field-wall and outer-wall radii at an angle (radians, from +x toward +z)
function radiiAt(angle) {
  let f = (angle / (Math.PI * 2)) * N;
  f = ((f % N) + N) % N;
  const k = Math.floor(f), a = f - k, j = (k + 1) % N;
  return [STADIUM.rIn[k] * (1 - a) + STADIUM.rIn[j] * a, STADIUM.rOut[k] * (1 - a) + STADIUM.rOut[j] * a];
}

// The bowl's surface under (x, z), relative to the ground around, or null outside the outer wall
function bowlSurface(x, z) {
  const dx = x - STADIUM.cx, dz = z - STADIUM.cz, r = Math.hypot(dx, dz);
  const [rIn, rOut] = radiiAt(Math.atan2(dz, dx));
  if (r >= rOut) return null;
  if (r <= rIn + AISLE_IN) return r <= rIn ? FIELD_Y : WALL_TOP;
  const r1 = rOut - CONCOURSE;
  if (r >= r1) return RIM_Y;
  return WALL_TOP + (SEAT_TOP - WALL_TOP) * (r - rIn - AISLE_IN) / (r1 - rIn - AISLE_IN);
}

export { STADIUM, N, radiiAt, bowlSurface, FIELD_Y, WALL_TOP, SEAT_TOP, RIM_Y, WALL_Y, AISLE_IN, CONCOURSE };
