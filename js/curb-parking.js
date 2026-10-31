import { GEO } from './nyc-geodata.js';

// Lamp: the parking lanes along a street's curbs, as the map has them (OpenStreetMap's parking:both / :left / :right;
// untagged, only the metered streets downtown: tools' park_spec), each 2.4 m wide inside the curb. One answer for the
// lanes traffic drives in (road-network.js keeps them clear), the paint (road-paint.js draws each lane's edge line and
// its stalls' marks) and the parked cars (parked-cars.js stands them in the stalls), so a parked car never sits in a
// traffic lane and always sits between its marks.

const PARK_W = 2.4;
const STALL = 6.5; // a parallel-parking stall's length
const CORNER = 12; // no stalls this close to a street's ends (the corners and their crosswalks)

// The parking lane's width on the street's right and left as drawn, from the link's bits (1 right, 2 left)
function curbParking(bits) {
  return { right: bits & 1 ? PARK_W : 0, left: bits & 2 ? PARK_W : 0 };
}

// Every stall along every parking lane: its middle at the lane's middle (x, z), the way along the street (tx, tz),
// toward its curb (nx, nz), and its length and the lane's width
let stalls = null;
function curbStalls() {
  if (stalls) return stalls;
  stalls = [];
  const G = GEO.roadGraph;
  const N = G.nodes;
  for (const [a, b, , w, , , flat, , , , , , bits = 0] of G.links) {
    const park = curbParking(bits);
    if (!park.right && !park.left) continue;
    const pts = [[N[a * 2], N[a * 2 + 1]]];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
    pts.push([N[b * 2], N[b * 2 + 1]]);
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const count = Math.floor((total - 2 * CORNER) / STALL);
    if (count < 1) continue;
    // whole stalls, centred between the corners
    const first = (total - count * STALL) / 2 + STALL / 2;
    let run = 0, k = 0;
    for (let i = 1; i < pts.length && k < count; i++) {
      const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
      const L = Math.hypot(x1 - x0, z1 - z0);
      if (L < 0.01) continue;
      const tx = (x1 - x0) / L, tz = (z1 - z0) / L;
      while (k < count && first + k * STALL <= run + L) {
        const s = first + k * STALL - run;
        k++;
        // the right-hand curb going this way is (-tz, tx) (x east, z south)
        for (const side of [1, -1]) {
          const lane = side > 0 ? park.right : park.left;
          if (!lane) continue;
          const nx = -tz * side, nz = tx * side, off = w / 2 - lane / 2;
          stalls.push({ x: x0 + tx * s + nx * off, z: z0 + tz * s + nz * off, tx, tz, nx, nz, side, length: STALL, lane });
        }
      }
      run += L;
    }
  }
  return stalls;
}

export { curbParking, curbStalls, PARK_W };
