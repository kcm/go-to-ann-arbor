import * as THREE from 'three/webgpu';
import { attribute, color, float, mix, smoothstep, step, uniform, vec3 } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from './tsl-materials.js';

// Motorcycles in traffic: a sport bike, a cruiser, a scooter, a touring bike and an adventure bike, each with its rider,
// built from simple solids in the same frame as the cars (+z forward, y up from the ground, x to the left). Traffic
// draws them through the cars' instancing (traffic.js): `paintColor` paints the bodywork and the helmet, and `carState`'s
// x lights the tail lamp for braking. The wheels are part of the model.

// Per kind: wheel radii, wheelbase, tyre widths and wheel style, where the headlight sits (for the beam), the traffic
// sizes (as CAR_KINDS) and the paints they come in
const MOTO_SPECS = {
  sportbike: { rf: 0.31, rr: 0.31, wb: 1.4, wf: 0.12, wr: 0.19, wheel: 'cast', headY: 0.88, mass: 290, paints: [0x0a3fa8, 0xc8102e, 0x3a8d2f, 0xf2f2f2, 0x151515] },
  cruiser: { rf: 0.33, rr: 0.32, wb: 1.65, wf: 0.11, wr: 0.18, wheel: 'wire', headY: 0.98, mass: 380, paints: [0x111111, 0x6a0f12, 0x1d2f4a, 0xe8e2d0] },
  scooter: { rf: 0.21, rr: 0.21, wb: 1.3, wf: 0.1, wr: 0.12, wheel: 'disc', headY: 1.06, mass: 190, paints: [0x9fd3c7, 0xe8dcc0, 0xc8102e, 0x6fa8dc, 0xf2c14e] },
  touring: { rf: 0.33, rr: 0.33, wb: 1.62, wf: 0.13, wr: 0.18, wheel: 'cast', headY: 0.92, mass: 470, paints: [0x5a5f66, 0x2b2f36, 0x7a0e14, 0xd8d8d8] },
  adventure: { rf: 0.38, rr: 0.35, wb: 1.55, wf: 0.1, wr: 0.15, wheel: 'wire', headY: 1.12, mass: 320, paints: [0xf28c00, 0xf4f4f4, 0x1a1a1a, 0x0b5ed7] },
  // quiet ones that keep to the curb side of the lane at a cyclist's pace (traffic's `curb`), the hoverboard's two
  // wheels side by side (`side` out from the middle)
  bicycle: { rf: 0.34, rr: 0.34, wb: 1.04, wf: 0.035, wr: 0.035, wheel: 'wire', headY: 0.98, mass: 95, quiet: true, curbSpeed: 5.6, paints: [0x1f5fa8, 0x2f6b3a, 0xb22222, 0x111111, 0xd8d8d8, 0xe0a91c] },
  // a commuter e-bike: a bicycle with a battery on its down tube and a motor in the back hub, fenders and a rack,
  // quicker than a bicycle at the curb
  ebike: { rf: 0.35, rr: 0.35, wb: 1.12, wf: 0.05, wr: 0.05, wheel: 'wire', headY: 1.0, mass: 115, quiet: true, curbSpeed: 6.7, paints: [0x2b2f36, 0x3d5a80, 0xe9e9e6, 0x2f6b3a, 0x8c2f39, 0xd9a441] },
  escooter: { rf: 0.11, rr: 0.11, wb: 0.84, wf: 0.055, wr: 0.055, wheel: 'disc', headY: 1.02, mass: 92, quiet: true, curbSpeed: 5, paints: [0x2f9e44, 0x111111, 0xe8e8e8, 0x1c7ed6] },
  hoverboard: { rf: 0.085, rr: 0.085, wb: 0, side: 0.27, wf: 0.07, wr: 0.07, wheel: 'disc', headY: 0.14, mass: 85, quiet: true, curbSpeed: 3.8, paints: [0x111111, 0xd6336c, 0x1971c2, 0xe8e8e8, 0x7048e8] }
};
for (const [name, s] of Object.entries(MOTO_SPECS)) {
  Object.assign(s, {
    name, moto: true,
    wheelRadius: s.rr,
    zFront: s.wb / 2 + s.rf, zRear: -s.wb / 2 - s.rr,
    headlight: [0, s.headY],
    // traffic's sizes: half-length for spacing, half-width & half the wheelbase for the path, collision half-length
    half: s.wb / 2 + (s.quiet ? 0.45 : 0.55), halfWidth: s.side ? 0.38 : s.quiet ? 0.32 : 0.42, axle: Math.max(0.3, s.wb / 2), halfL: s.wb / 2 + 0.3
  });
}

// Plain colours of the parts that aren't painted
const BLACK = 0x16181b, TIRE = 0x101112, METAL = 0x5d6268, CHROME = 0xc9ced4, SEAT = 0x1c1c1e, GLASS = 0x2a3238;
const ALU = 0x9ea4aa, GOLD = 0xc49a35, CARBON = 0x222326;
const PAINT = { paint: 1, rough: 0.22, metal: 0.15 }, SHINY = { metal: 1, rough: 0.18 }, DARKMETAL = { metal: 0.6, rough: 0.4 };

// One part: its geometry, colour and finish. paint 1 takes the bike's paint; lamp 1 is a headlamp, 2 a tail lamp.
function finish(geo, hex, { paint = 0, lamp = 0, metal = 0, rough = 0.6 } = {}) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  const n = geo.attributes.position.count;
  const c = new THREE.Color(hex);
  const col = new Float32Array(n * 3), part = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3);
    part.set([paint, lamp, metal, rough], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('motoPart', new THREE.BufferAttribute(part, 4));
  return geo;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// A smooth shell lofted through cross-sections along z: each station [z, centre y, half width, half height, centre x],
// a superellipse (exponent e: 2 an ellipse, higher a rounded box), capped at both ends. Fairings, tanks, seats, tails,
// saddlebags and cowls are all made this way, so they curve like the real ones.
function loftGeometry(stations, n, e) {
  const st = stations.slice().sort((a, b) => b[0] - a[0]);
  const pos = [], idx = [];
  const ring = ([z, yc, hw, hh, x0 = 0]) => {
    const start = pos.length / 3;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      pos.push(x0 + hw * Math.sign(c) * Math.abs(c) ** (2 / e), yc + hh * Math.sign(s) * Math.abs(s) ** (2 / e), z);
    }
    return start;
  };
  const rings = st.map(ring);
  for (let k = 0; k + 1 < rings.length; k++) {
    const r0 = rings[k], r1 = rings[k + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(r0 + i, r1 + i, r0 + j, r0 + j, r1 + i, r1 + j);
    }
  }
  // caps, on vertices of their own so their edges stay crisp
  for (const [k, front] of [[0, true], [st.length - 1, false]]) {
    const c = pos.length / 3;
    pos.push(st[k][4] || 0, st[k][1], st[k][0]);
    const r = ring(st[k]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (front) idx.push(c, r + i, r + j); else idx.push(c, r + j, r + i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function makeBuilder(detail, wheels = true) {
  const parts = [];
  const seg = detail ? 12 : 6;
  const add = (geo, hex, opts) => parts.push(finish(geo, hex, opts));
  const place = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    geo.applyMatrix4(_m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
    return geo;
  };
  const along = (geo, a, b) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const dir = to.clone().sub(from);
    geo.applyMatrix4(_m.compose(from.add(to).multiplyScalar(0.5), _q.setFromUnitVectors(UP, dir.normalize()), new THREE.Vector3(1, 1, 1)));
    return geo;
  };
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const bodyOn = true;
  const b = {
    parts,
    get on() { return bodyOn; },
    box(w, h, d, x, y, z, hex, opts, rx = 0) { if (bodyOn) add(place(new THREE.BoxGeometry(w, h, d), x, y, z, rx), hex, opts); },
    // an ellipsoid of radii (sx, sy, sz)
    blob(sx, sy, sz, x, y, z, hex, opts, rx = 0) {
      if (!bodyOn) return;
      const g = new THREE.SphereGeometry(1, seg, Math.max(4, seg >> 1));
      g.scale(sx, sy, sz);
      add(place(g, x, y, z, rx), hex, opts);
    },
    // a round bar from a to b, through any points between
    tube(a, b2, r, hex, opts, ...more) {
      if (!bodyOn) return;
      const pts = [a, b2, ...more];
      for (let i = 0; i + 1 < pts.length; i++) {
        add(along(new THREE.CylinderGeometry(r, r, len(pts[i], pts[i + 1]), Math.max(5, seg >> 1), 1), pts[i], pts[i + 1]), hex, opts);
        if (i + 2 < pts.length) add(place(new THREE.SphereGeometry(r, Math.max(5, seg >> 1), 4), ...pts[i + 1]), hex, opts);
      }
    },
    // a disc (or a short drum) on the x axis
    disc(r, w, x, y, z, hex, opts, s = seg * 2) { if (bodyOn) add(place(new THREE.CylinderGeometry(r, r, w, s), x, y, z, 0, 0, Math.PI / 2), hex, opts); },
    // a smooth shell (loftGeometry); rx tilts it about the point p
    shell(stations, hex, opts, { e = 2.4, rx = 0, p = [0, 0, 0] } = {}) {
      if (!bodyOn) return;
      const g = loftGeometry(stations, detail ? 20 : 10, e);
      if (rx) { g.translate(-p[0], -p[1], -p[2]); g.rotateX(rx); g.translate(p[0], p[1], p[2]); }
      add(g, hex, opts);
    },
    // a fender: part of a hoop around the axle (y, z) on the x axis, from angle a0 to a1 (0 ahead, PI/2 on top)
    fender(r, w, y, z, a0, a1, hex, opts, x = 0) {
      if (!bodyOn) return;
      const g = new THREE.CylinderGeometry(r, r, w, seg * 2, 1, true, a0, a1 - a0);
      g.rotateZ(Math.PI / 2);
      add(place(g, x, y, z), hex, opts);
      // its edges rolled, so it has thickness
      for (const sx of [-1, 1]) {
        const t = new THREE.TorusGeometry(r, 0.012, 4, seg * 2, a1 - a0);
        t.rotateZ(a0);
        t.rotateY(-Math.PI / 2);
        add(place(t, x + sx * w / 2, y, z), hex, opts);
      }
    },
    // a wheel standing in the bike's plane: tyre with its rounded profile, rim, spokes of its style, hub and brake rotor
    wheel(r, z, width = 0.12, style = 'cast', rotors = 1, x = 0) {
      if (!wheels || !bodyOn) return;
      const first = parts.length;
      const t = Math.min(0.075, r * 0.25, width * 0.55);
      const tire = new THREE.TorusGeometry(r - t, t, Math.max(6, seg >> 1), seg * 3);
      tire.scale(1, 1, width / (2 * t));
      add(place(tire, 0, r, z, 0, Math.PI / 2), TIRE, { rough: 0.92 });
      const rim = r - t * 1.85;
      const band = new THREE.CylinderGeometry(rim, rim, width * 0.7, seg * 3, 1, true);
      add(place(band, 0, r, z, 0, 0, Math.PI / 2), style === 'wire' ? CHROME : 0x26282b, style === 'wire' ? SHINY : DARKMETAL);
      const lip = new THREE.TorusGeometry(rim, 0.009, 4, seg * 3);
      for (const sx of [-1, 1]) add(place(lip.clone(), sx * width * 0.35, r, z, 0, Math.PI / 2), CHROME, SHINY);
      const hubR = Math.max(0.035, r * 0.15);
      b.disc(hubR, width * 0.85, 0, r, z, ALU, { metal: 0.85, rough: 0.3 }, seg);
      if (style === 'cast') {
        // five split spokes
        for (let i = 0; i < 10; i++) {
          const a = (Math.floor(i / 2) / 5) * Math.PI * 2 + (i % 2 ? 0.13 : -0.13);
          const l = rim - hubR, mid = hubR + l / 2;
          add(place(new THREE.BoxGeometry(width * 0.22, l, 0.022), 0, r + Math.cos(a) * mid, z + Math.sin(a) * mid, a), 0x26282b, DARKMETAL);
        }
      } else if (style === 'wire') {
        for (let i = 0; i < (detail ? 32 : 12); i++) {
          const a = (i / (detail ? 32 : 12)) * Math.PI * 2, sx = i % 2 ? 1 : -1, a2 = a + sx * 0.22;
          const p0 = [sx * width * 0.3, r + Math.cos(a2) * hubR, z + Math.sin(a2) * hubR], p1 = [0, r + Math.cos(a) * rim, z + Math.sin(a) * rim];
          add(along(new THREE.CylinderGeometry(0.0045, 0.0045, len(p0, p1), 3, 1), p0, p1), CHROME, SHINY);
        }
      } else {
        b.disc(rim, width * 0.4, 0, r, z, 0xb9bdc2, { metal: 0.85, rough: 0.3 });
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          b.disc(rim * 0.2, width * 0.42, 0, r + Math.cos(a) * rim * 0.6, z + Math.sin(a) * rim * 0.6, 0x222326, DARKMETAL, 8);
        }
      }
      // brake rotors, drilled steel
      for (let k = 0; k < rotors; k++) {
        const x = (rotors === 2 ? (k ? 1 : -1) : -1) * (width * 0.5 + 0.012);
        b.disc(rim * 0.78, 0.008, x, r, z, 0xaeb3b8, { metal: 0.9, rough: 0.35 });
        b.disc(rim * 0.42, 0.012, x, r, z, 0x3a3c40, DARKMETAL, seg);
      }
      if (x) for (let i = first; i < parts.length; i++) parts[i].translate(x, 0, 0);
    }
  };
  return b;
}

// The rider, from where their hips, shoulders, head, hands, knees and feet are, kept for posing a person on the bike
// (PersonRig.perch, pedestrians.js); the bike's own geometry has no one on it
function rider(b, pose) {
  b.pose = { ...pose, standing: false };
}

// a V-twin: crankcase, two finned cylinders with their heads, the primary and the air cleaner (cruisers, tourers)
function vTwin(b, y, z, scale = 1) {
  b.blob(0.13 * scale, 0.13 * scale, 0.22 * scale, 0, y, z, METAL, DARKMETAL);
  b.disc(0.14 * scale, 0.05, 0.13 * scale, y - 0.02, z - 0.1, CHROME, SHINY);
  for (const [dz, lean] of [[0.09, 0.5], [-0.09, -0.5]]) {
    const bx = 0, by = y + 0.08 * scale, bz = z + dz * scale;
    const ax = Math.sin(lean), ay = Math.cos(lean);
    for (let i = 0; i < 7; i++) {
      const d = (0.06 + i * 0.035) * scale;
      const g = [bx, by + ay * d, bz + ax * d];
      b.tube([g[0], g[1] - ay * 0.006, g[2] - ax * 0.006], [g[0], g[1] + ay * 0.006, g[2] + ax * 0.006], 0.085 * scale, i === 6 ? CHROME : 0x2b2d30, i === 6 ? SHINY : DARKMETAL);
    }
    b.tube([bx, by + ay * 0.05 * scale, bz + ax * 0.05 * scale], [bx, by + ay * 0.29 * scale, bz + ax * 0.29 * scale], 0.06 * scale, 0x3a3c40, DARKMETAL);
    b.blob(0.07 * scale, 0.04 * scale, 0.08 * scale, bx, by + ay * 0.3 * scale, bz + ax * 0.3 * scale, CHROME, SHINY);
  }
  b.disc(0.11 * scale, 0.05, -0.14 * scale, y + 0.24 * scale, z, CHROME, SHINY);
}

// a standing rider (scooter, hoverboard): one foot ahead of the other, knees a little bent
function stander(b, deck, front, back, hand, lean = 0.08) {
  const hipY = deck + 0.92, hz = (front + back) / 2 - lean;
  rider(b, { hip: [0, hipY, hz], shoulder: [0, hipY + 0.5, hz + lean], head: [0, hipY + 0.68, hz + lean * 1.2], hand,
    knee: [0.1, deck + 0.47, hz + 0.08], foot: [0.1, deck + 0.06, (front + back) / 2] });
  b.pose.standing = true;
}

const MODELS = {
  bicycle(b, s) {
    const f = s.wb / 2, r = s.rr;
    b.wheel(s.rf, f, s.wf, s.wheel, 0); b.wheel(s.rr, -f, s.wr, s.wheel, 0);
    // diamond frame in its paint: head tube, top and down tubes, seat tube, the stays to the rear axle
    const head = [0, 0.86, f - 0.2], headLow = [0, 0.72, f - 0.16], bb = [0, 0.3, 0.02], seatTop = [0, 0.83, -0.18];
    b.tube(headLow, head, 0.022, 0xffffff, PAINT);
    b.tube(head, seatTop, 0.017, 0xffffff, PAINT);
    b.tube(headLow, bb, 0.02, 0xffffff, PAINT);
    b.tube(bb, seatTop, 0.018, 0xffffff, PAINT);
    for (const x of [-0.05, 0.05]) {
      b.tube([x, r, -f], [x * 0.4, 0.3, 0.02], 0.009, 0xffffff, PAINT);
      b.tube([x, r, -f], [x * 0.4, 0.8, -0.17], 0.009, 0xffffff, PAINT);
      b.tube([x, s.rf, f], [x * 0.6, 0.72, f - 0.16], 0.011, 0xffffff, PAINT);
    }
    // bars and stem, saddle and post, cranks and chainring, pedals
    b.tube(head, [0, 0.98, f - 0.24], 0.013, METAL, DARKMETAL);
    b.tube([-0.22, 0.98, f - 0.22], [0.22, 0.98, f - 0.22], 0.012, BLACK, DARKMETAL);
    for (const x of [-1, 1]) b.tube([x * 0.2, 0.98, f - 0.22], [x * 0.24, 0.98, f - 0.22], 0.017, 0x111111, { rough: 0.9 });
    b.tube(seatTop, [0, 0.95, -0.22], 0.013, ALU, SHINY);
    b.shell([[-0.08, 0.97, 0.03, 0.02], [-0.18, 0.97, 0.05, 0.022], [-0.32, 0.98, 0.075, 0.03]], SEAT, { rough: 0.8 });
    b.disc(0.09, 0.008, -0.05, 0.3, 0.02, 0x8a8f96, { metal: 0.85, rough: 0.35 }, 18);
    b.box(0.005, 0.012, f, -0.055, 0.3, -f / 2 + 0.01, 0x333333, DARKMETAL);
    for (const x of [-1, 1]) {
      b.tube([x * 0.07, 0.3, 0.02], [x * 0.08, 0.3 + x * 0.12, 0.02 + x * 0.1], 0.01, ALU, SHINY);
      b.box(0.08, 0.02, 0.06, x * 0.12, 0.3 + x * 0.12, 0.02 + x * 0.1, 0x1a1a1a);
    }
    b.blob(0.03, 0.025, 0.02, 0, 0.9, f - 0.1, 0xfff6e0, { lamp: 1, rough: 0.15 });
    b.blob(0.02, 0.02, 0.012, 0, 0.82, -0.26, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    rider(b, { hip: [0, 1.04, -0.25], shoulder: [0, 1.5, -0.02], head: [0, 1.68, 0.07], hand: [0.21, 1.0, f - 0.2],
      knee: [0.13, 0.78, 0.0], foot: [0.12, 0.4, 0.06] });
  },
  ebike(b, s) {
    const f = s.wb / 2, r = s.rr;
    b.wheel(s.rf, f, s.wf, s.wheel, 0); b.wheel(s.rr, -f, s.wr, s.wheel, 0);
    // a low step-over frame in its paint: a stout down tube swept to the bottom bracket, the seat tube, the stays
    const head = [0, 0.9, f - 0.2], headLow = [0, 0.7, f - 0.15], bb = [0, 0.3, 0.02], seatTop = [0, 0.82, -0.2];
    b.tube(headLow, head, 0.026, 0xffffff, PAINT);
    b.tube(headLow, [0, 0.42, 0.22], 0.032, 0xffffff, PAINT, bb);
    b.tube(bb, seatTop, 0.022, 0xffffff, PAINT);
    b.tube([0, 0.84, f - 0.21], [0, 0.66, -0.14], 0.016, 0xffffff, PAINT);
    for (const x of [-0.055, 0.055]) {
      b.tube([x, r, -f], [x * 0.4, 0.3, 0.02], 0.011, 0xffffff, PAINT);
      b.tube([x, r, -f], [x * 0.4, 0.78, -0.19], 0.011, 0xffffff, PAINT);
      b.tube([x, s.rf, f], [x * 0.6, 0.7, f - 0.15], 0.013, 0xffffff, PAINT);
    }
    // the battery along the down tube, the motor in the rear hub, the controller box by the cranks
    b.shell([[0.4, 0.6, 0.045, 0.045], [0.25, 0.47, 0.05, 0.05], [0.1, 0.37, 0.045, 0.045]], 0x1f2124, { rough: 0.35, metal: 0.2 }, { e: 3.2 });
    b.box(0.03, 0.02, 0.04, 0.05, 0.53, 0.3, 0x58d36b, { rough: 0.3 });
    b.disc(0.085, 0.09, 0, r, -f, 0x2a2c30, { metal: 0.6, rough: 0.35 }, 20);
    b.box(0.07, 0.07, 0.12, 0, 0.27, 0.08, 0x1f2124, { rough: 0.5 });
    // fenders and the rear rack
    b.fender(s.rf + 0.04, 0.07, s.rf, f, 0.5, 2.5, 0x1a1b1d, DARKMETAL);
    b.fender(s.rr + 0.04, 0.07, s.rr, -f, 0.55, 2.75, 0x1a1b1d, DARKMETAL);
    b.box(0.15, 0.012, 0.36, 0, 0.82, -f + 0.02, 0x1a1b1d, DARKMETAL);
    for (const x of [-0.07, 0.07]) b.tube([x, 0.82, -f + 0.16], [x, r, -f], 0.008, 0x1a1b1d, DARKMETAL);
    // upright bars on a riser stem with a little display, saddle and post, cranks and chainring, pedals
    b.tube(head, [0, 1.04, f - 0.27], 0.015, METAL, DARKMETAL);
    b.tube([-0.26, 1.05, f - 0.33], [0, 1.04, f - 0.27], 0.012, BLACK, DARKMETAL, [0.26, 1.05, f - 0.33]);
    for (const x of [-1, 1]) b.tube([x * 0.21, 1.05, f - 0.32], [x * 0.27, 1.05, f - 0.34], 0.018, 0x111111, { rough: 0.9 });
    b.box(0.06, 0.012, 0.04, 0.07, 1.06, f - 0.27, 0x141518, { rough: 0.2, metal: 0.3 });
    b.tube(seatTop, [0, 0.95, -0.24], 0.014, BLACK, DARKMETAL);
    b.shell([[-0.1, 0.97, 0.04, 0.025], [-0.2, 0.97, 0.07, 0.03], [-0.33, 0.98, 0.095, 0.035]], SEAT, { rough: 0.8 });
    b.disc(0.085, 0.008, -0.05, 0.3, 0.02, 0x8a8f96, { metal: 0.85, rough: 0.35 }, 18);
    b.box(0.005, 0.012, f, -0.055, 0.3, -f / 2 + 0.01, 0x333333, DARKMETAL);
    for (const x of [-1, 1]) {
      b.tube([x * 0.07, 0.3, 0.02], [x * 0.08, 0.3 + x * 0.12, 0.02 + x * 0.1], 0.01, ALU, SHINY);
      b.box(0.08, 0.02, 0.06, x * 0.12, 0.3 + x * 0.12, 0.02 + x * 0.1, 0x1a1a1a);
    }
    b.blob(0.035, 0.03, 0.025, 0, 0.95, f - 0.12, 0xfff6e0, { lamp: 1, rough: 0.15 });
    b.blob(0.03, 0.015, 0.012, 0, 0.84, -f - 0.15, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    // sat more upright than on a bicycle
    rider(b, { hip: [0, 1.04, -0.27], shoulder: [0, 1.53, -0.1], head: [0, 1.71, -0.03], hand: [0.22, 1.05, f - 0.32],
      knee: [0.13, 0.78, 0.0], foot: [0.12, 0.4, 0.06] });
  },
  escooter(b, s) {
    const f = s.wb / 2;
    b.wheel(s.rf, f, s.wf, s.wheel, 0); b.wheel(s.rr, -f, s.wr, s.wheel, 0);
    // the deck, its grip tape, the rear fender (the foot brake); the stem with its lamp, the bars and grips
    b.shell([[f - 0.12, 0.13, 0.075, 0.035], [0.1, 0.12, 0.085, 0.035], [-f + 0.08, 0.13, 0.08, 0.035]], 0xffffff, PAINT, { e: 4 });
    b.box(0.14, 0.006, 0.5, 0, 0.162, -0.04, 0x1a1a1a, { rough: 0.95 });
    b.fender(s.rr + 0.03, 0.07, s.rr, -f, 0.2, 2.2, BLACK, DARKMETAL);
    b.tube([0, s.rf, f], [0, 0.18, f - 0.05], 0.02, BLACK, DARKMETAL);
    b.tube([0, 0.15, f - 0.07], [0, 1.0, f - 0.2], 0.022, 0xffffff, PAINT);
    b.blob(0.035, 0.03, 0.02, 0, 0.42, f - 0.08, 0xfff6e0, { lamp: 1, rough: 0.15 });
    b.box(0.06, 0.03, 0.05, 0, 1.0, f - 0.19, 0x222326, { rough: 0.3, metal: 0.3 });
    b.tube([-0.25, 1.01, f - 0.2], [0.25, 1.01, f - 0.2], 0.013, BLACK, DARKMETAL);
    for (const x of [-1, 1]) b.tube([x * 0.18, 1.01, f - 0.2], [x * 0.26, 1.01, f - 0.2], 0.018, 0x111111, { rough: 0.9 });
    b.blob(0.03, 0.012, 0.012, 0, 0.17, -f - 0.1, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    stander(b, 0.16, 0.12, -0.18, [0.24, 1.0, f - 0.22], 0.04);
  },
  hoverboard(b, s) {
    // two wheels either side under their arches, the two halves of the deck and the pads where the feet go
    for (const x of [-s.side, s.side]) b.wheel(s.rf, 0, s.wf, s.wheel, 0, x);
    for (const x of [-1, 1]) {
      b.shell([[0.1, 0.1, 0.13, 0.045, x * 0.13], [-0.1, 0.1, 0.13, 0.045, x * 0.13]], 0xffffff, PAINT, { e: 3 });
      b.fender(s.rf + 0.02, 0.09, s.rf, 0, 0.0, Math.PI, 0xffffff, PAINT, x * s.side);
      b.box(0.11, 0.008, 0.14, x * 0.12, 0.148, 0, 0x1a1a1a, { rough: 0.95 });
    }
    b.blob(0.05, 0.012, 0.012, 0, 0.11, 0.1, 0xbfe9ff, { lamp: 1, rough: 0.15 });
    b.blob(0.05, 0.012, 0.012, 0, 0.11, -0.1, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    // the rider faces where it goes, feet apart on the pads
    rider(b, { hip: [0, 1.05, -0.03], shoulder: [0, 1.55, 0.02], head: [0, 1.73, 0.04], hand: [0.3, 1.02, 0.05],
      knee: [0.13, 0.6, 0.05], foot: [0.13, 0.19, 0] });
    b.pose.standing = true;
  },
  sportbike(b, s) {
    const f = s.wb / 2;
    b.wheel(s.rf, f, s.wf, s.wheel, 2); b.wheel(s.rr, -f, s.wr, s.wheel, 1);
    // fork: gold upper tubes, black sliders, calipers, the little front fender
    for (const x of [-0.085, 0.085]) {
      b.tube([x, s.rf, f], [x, 0.58, f - 0.08], 0.034, BLACK, DARKMETAL);
      b.tube([x, 0.58, f - 0.08], [x, 0.98, f - 0.25], 0.027, GOLD, { metal: 0.9, rough: 0.25 });
      b.box(0.04, 0.12, 0.08, x * 1.3, s.rf + 0.1, f - 0.12, 0xb81d1d, DARKMETAL);
    }
    b.box(0.22, 0.04, 0.12, 0, 0.98, f - 0.25, ALU, SHINY);
    b.fender(s.rf + 0.05, 0.13, s.rf, f, 0.25, 1.95, 0xffffff, PAINT);
    // the full fairing, nose to belly pan, the screen and the twin lamps and ram-air intake in its nose
    b.shell([[0.86, 0.86, 0.04, 0.05], [0.8, 0.86, 0.13, 0.12], [0.66, 0.84, 0.2, 0.2], [0.5, 0.76, 0.225, 0.3], [0.32, 0.64, 0.215, 0.36], [0.12, 0.55, 0.19, 0.32], [-0.02, 0.56, 0.15, 0.22]], 0xffffff, PAINT, { e: 2.3 });
    b.shell([[0.8, 1.0, 0.02, 0.01], [0.7, 1.05, 0.15, 0.012], [0.58, 1.08, 0.17, 0.012]], GLASS, { rough: 0.05, metal: 0.5 }, { e: 2.2 });
    for (const x of [-0.085, 0.085]) b.blob(0.055, 0.03, 0.04, x, 0.87, 0.82, 0xfff6e0, { lamp: 1, rough: 0.15 }, -0.3);
    b.box(0.07, 0.05, 0.05, 0, 0.78, 0.86, 0x0d0d0e);
    for (const x of [-1, 1]) {
      b.tube([x * 0.2, 0.96, 0.56], [x * 0.28, 1.0, 0.58], 0.008, BLACK);
      b.blob(0.05, 0.03, 0.02, x * 0.29, 1.0, 0.58, BLACK, DARKMETAL);
      b.tube([x * 0.09, 0.95, 0.46], [x * 0.27, 0.92, 0.4], 0.016, BLACK, DARKMETAL);
      b.tube([x * 0.21, 0.925, 0.42], [x * 0.3, 0.915, 0.39], 0.022, 0x101010, { rough: 0.9 });
      b.box(0.01, 0.15, 0.24, x * 0.215, 0.58, 0.28, 0x111111);
    }
    // tank, seat, tail with its lamp and plate
    b.shell([[0.4, 0.88, 0.1, 0.06], [0.3, 0.93, 0.18, 0.1], [0.12, 0.95, 0.2, 0.12], [-0.04, 0.92, 0.17, 0.11], [-0.14, 0.87, 0.11, 0.08]], 0xffffff, PAINT);
    b.shell([[-0.1, 0.89, 0.13, 0.04], [-0.3, 0.9, 0.12, 0.04], [-0.38, 0.93, 0.09, 0.03]], SEAT, { rough: 0.85 }, { e: 3 });
    b.shell([[-0.22, 0.86, 0.14, 0.09], [-0.42, 0.93, 0.12, 0.09], [-0.6, 0.99, 0.08, 0.06], [-0.72, 1.02, 0.03, 0.03]], 0xffffff, PAINT);
    b.blob(0.06, 0.02, 0.02, 0, 1.0, -0.71, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    b.tube([0, 0.95, -0.62], [0, 0.72, -0.78], 0.012, BLACK);
    b.box(0.17, 0.1, 0.008, 0, 0.7, -0.79, 0xf2f2ee, { rough: 0.4 }, 0.3);
    // swingarm, chain and sprocket, shock, engine below the fairing, underslung exhaust and its can
    for (const x of [-0.11, 0.11]) b.tube([x, 0.46, -0.04], [x, s.rr, -f], 0.03, ALU, { metal: 0.85, rough: 0.3 });
    b.box(0.012, 0.04, f, -0.13, 0.4, -f / 2, 0x111111, DARKMETAL);
    b.disc(0.1, 0.01, -0.13, s.rr, -f, 0x6b6f75, DARKMETAL, 16);
    b.tube([0, 0.5, -0.1], [0, 0.82, -0.22], 0.03, 0xe2b022, DARKMETAL);
    b.box(0.3, 0.24, 0.4, 0, 0.36, 0.12, 0x2b2d30, DARKMETAL);
    b.tube([0, 0.3, 0.42], [0, 0.18, 0.2], 0.03, 0x8a6a4a, { metal: 0.8, rough: 0.3 }, [0, 0.2, -0.05], [-0.12, 0.38, -0.25]);
    b.tube([-0.14, 0.4, -0.22], [-0.17, 0.62, -0.55], 0.065, CARBON, { metal: 0.3, rough: 0.35 });
    b.disc(0.045, 0.02, -0.17, 0.625, -0.56, CHROME, SHINY);
    for (const x of [-1, 1]) b.tube([x * 0.12, 0.45, -0.12], [x * 0.2, 0.45, -0.12], 0.012, ALU, SHINY);
    rider(b, { hip: [0, 1.0, -0.17], shoulder: [0, 1.32, 0.2], head: [0, 1.42, 0.38], hand: [0.27, 0.95, 0.42], knee: [0.21, 0.82, 0.12], foot: [0.18, 0.47, -0.12] });
  },
  cruiser(b, s) {
    const f = s.wb / 2;
    b.wheel(s.rf, f, s.wf, s.wheel, 1); b.wheel(s.rr, -f, s.wr, s.wheel, 1);
    // raked chrome fork and triple trees, the headlamp bucket, pull-back bars
    for (const x of [-0.1, 0.1]) b.tube([x, s.rf, f], [x, 1.08, f - 0.36], 0.032, CHROME, SHINY);
    for (const y of [0.92, 1.06]) b.box(0.28, 0.04, 0.1, 0, y, f - 0.36 + (1.08 - y) * 0.53, CHROME, SHINY);
    b.blob(0.1, 0.1, 0.09, 0, 0.98, f - 0.16, CHROME, SHINY);
    b.disc(0.085, 0.01, 0, 0.98, f - 0.07, 0xfff6e0, { lamp: 1, rough: 0.15 });
    b.shell([[f - 0.065, 0.98, 0.085, 0.085], [f - 0.075, 0.98, 0.085, 0.085]], 0xfff6e0, { lamp: 1, rough: 0.15 }, { e: 2 });
    for (const x of [-1, 1]) b.tube([x * 0.08, 1.1, 0.46], [x * 0.18, 1.28, 0.42], 0.018, CHROME, SHINY, [x * 0.38, 1.26, 0.3], [x * 0.44, 1.22, 0.2]);
    for (const x of [-1, 1]) b.tube([x * 0.44, 1.22, 0.2], [x * 0.47, 1.215, 0.12], 0.024, 0x111111, { rough: 0.9 });
    for (const x of [-1, 1]) b.blob(0.045, 0.045, 0.02, x * 0.26, 1.33, 0.38, CHROME, SHINY);
    b.fender(s.rf + 0.05, 0.16, s.rf, f, -0.25, 2.2, 0xffffff, PAINT);
    // frame, teardrop tank, the V-twin, staggered pipes
    b.tube([0, 1.02, f - 0.4], [0, 0.33, 0.38], 0.03, BLACK, DARKMETAL, [0, 0.26, -0.2], [0, 0.4, -0.55]);
    b.tube([0, 1.02, f - 0.4], [0, 0.8, -0.4], 0.03, BLACK, DARKMETAL);
    b.shell([[0.5, 0.97, 0.05, 0.05], [0.42, 0.99, 0.14, 0.1], [0.24, 0.99, 0.18, 0.12], [0.04, 0.95, 0.16, 0.11], [-0.1, 0.89, 0.08, 0.07]], 0xffffff, PAINT, { e: 2.1 });
    b.box(0.1, 0.012, 0.3, 0, 1.105, 0.2, CHROME, SHINY);
    vTwin(b, 0.42, 0.02);
    for (const [y, z0] of [[0.34, 0.24], [0.48, 0.0]]) b.tube([-0.12, y + 0.18, z0 + 0.1], [-0.2, y, z0 - 0.1], 0.04, CHROME, SHINY, [-0.21, y + 0.03, -1.0]);
    for (const y of [0.37, 0.51]) b.disc(0.035, 0.04, -0.21, y, -1.02, 0x111111, DARKMETAL, 10);
    // solo saddle, rear fender with its struts, lamp and plate, swingarm, shocks, floorboards
    b.shell([[-0.08, 0.78, 0.16, 0.06], [-0.28, 0.75, 0.2, 0.07], [-0.44, 0.8, 0.13, 0.06], [-0.5, 0.84, 0.06, 0.04]], 0x2a1a12, { rough: 0.7 }, { e: 2.6 });
    b.fender(s.rr + 0.06, 0.25, s.rr, -f, 0.7, 2.95, 0xffffff, PAINT);
    for (const x of [-0.13, 0.13]) b.tube([x, 0.62, -0.5], [x, 0.58, -1.05], 0.015, CHROME, SHINY);
    for (const x of [-0.12, 0.12]) b.tube([x, 0.36, -0.1], [x, s.rr, -f], 0.028, BLACK, DARKMETAL);
    for (const x of [-0.13, 0.13]) b.tube([x, s.rr + 0.05, -f + 0.1], [x, 0.66, -0.55], 0.03, CHROME, SHINY);
    b.blob(0.06, 0.03, 0.03, 0, s.rr * 2 + 0.06, -f - 0.36, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    b.box(0.17, 0.1, 0.008, 0, s.rr * 2 - 0.08, -f - 0.4, 0xf2f2ee, { rough: 0.4 }, 0.2);
    for (const x of [-1, 1]) b.box(0.13, 0.025, 0.3, x * 0.26, 0.36, 0.42, 0x1a1a1a, DARKMETAL);
    rider(b, { hip: [0, 0.82, -0.28], shoulder: [0, 1.38, -0.3], head: [0, 1.56, -0.27], hand: [0.43, 1.22, 0.18], knee: [0.23, 0.86, 0.24], foot: [0.25, 0.42, 0.42] });
  },
  scooter(b, s) {
    const f = s.wb / 2;
    b.wheel(s.rf, f, s.wf, s.wheel, 1); b.wheel(s.rr, -f, s.wr, s.wheel, 0);
    // single-sided front link, the fender over it
    b.tube([0.07, s.rf, f], [0.07, 0.52, f - 0.12], 0.03, METAL, DARKMETAL);
    b.fender(s.rf + 0.06, 0.15, s.rf, f, -0.3, 2.0, 0xffffff, PAINT);
    // leg shield, curving round the rider's legs, and the steering column inside it
    b.shell([[0.52, 0.66, 0.24, 0.36], [0.47, 0.66, 0.235, 0.355], [0.4, 0.66, 0.2, 0.3]], 0xffffff, PAINT, { e: 3.2, rx: -0.2, p: [0, 0.3, 0.46] });
    b.tube([0, 0.7, 0.44], [0, 1.0, 0.5], 0.05, 0xffffff, PAINT);
    // the handlebar cowl with its round lamp, the mirrors
    b.shell([[0.6, 1.07, 0.06, 0.06], [0.52, 1.08, 0.27, 0.07], [0.4, 1.06, 0.25, 0.06], [0.34, 1.04, 0.1, 0.05]], 0xffffff, PAINT, { e: 2.5 });
    b.disc(0.06, 0.02, 0, 1.08, 0.61, CHROME, SHINY);
    b.shell([[0.625, 1.08, 0.05, 0.05], [0.615, 1.08, 0.05, 0.05]], 0xfff6e0, { lamp: 1, rough: 0.15 }, { e: 2 });
    for (const x of [-1, 1]) {
      b.tube([x * 0.27, 1.07, 0.47], [x * 0.33, 1.07, 0.46], 0.02, 0x2a2a2a, { rough: 0.9 });
      b.tube([x * 0.2, 1.1, 0.47], [x * 0.26, 1.3, 0.44], 0.008, CHROME, SHINY);
      b.disc(0.045, 0.012, x * 0.26, 1.33, 0.44, CHROME, SHINY, 12);
    }
    // floorboard with its rubber strips, the swollen rear cowl, the seat, the engine and exhaust, the tail lamp
    b.box(0.34, 0.05, 0.56, 0, 0.3, 0.12, 0x3a3c40, { rough: 0.8 });
    for (let i = 0; i < 5; i++) b.box(0.025, 0.012, 0.5, -0.12 + i * 0.06, 0.33, 0.12, 0x1b1b1b, { rough: 0.95 });
    b.shell([[0.02, 0.44, 0.15, 0.13], [-0.18, 0.5, 0.25, 0.2], [-0.45, 0.55, 0.28, 0.22], [-0.7, 0.6, 0.22, 0.17], [-0.86, 0.64, 0.1, 0.08]], 0xffffff, PAINT, { e: 2.2 });
    b.shell([[-0.04, 0.78, 0.13, 0.05], [-0.2, 0.8, 0.15, 0.055], [-0.55, 0.81, 0.15, 0.055], [-0.72, 0.8, 0.12, 0.05]], 0x5a3a24, { rough: 0.7 }, { e: 3 });
    b.tube([0.0, 0.81, -0.74], [0.0, 0.82, -0.86], 0.012, CHROME, SHINY);
    b.box(0.2, 0.18, 0.3, 0.1, 0.24, -0.45, METAL, DARKMETAL);
    b.tube([-0.12, 0.2, -0.3], [-0.15, 0.25, -0.6], 0.055, 0x2b2d30, DARKMETAL);
    b.disc(0.03, 0.03, -0.15, 0.25, -0.62, CHROME, SHINY, 10);
    b.blob(0.07, 0.035, 0.02, 0, 0.63, -0.875, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    rider(b, { hip: [0, 0.86, -0.26], shoulder: [0, 1.38, -0.2], head: [0, 1.57, -0.16], hand: [0.29, 1.08, 0.46], knee: [0.18, 0.88, 0.17], foot: [0.14, 0.38, 0.2] });
  },
  touring(b, s) {
    const f = s.wb / 2;
    b.wheel(s.rf, f, s.wf, s.wheel, 2); b.wheel(s.rr, -f, s.wr, s.wheel, 1);
    for (const x of [-0.1, 0.1]) b.tube([x, s.rf, f], [x, 0.9, f - 0.24], 0.036, CHROME, SHINY);
    b.fender(s.rf + 0.05, 0.16, s.rf, f, -0.1, 2.1, 0xffffff, PAINT);
    // the batwing fairing, its screen and lamp, the mirrors
    b.shell([[0.78, 0.96, 0.1, 0.12], [0.7, 0.98, 0.34, 0.2], [0.58, 0.98, 0.42, 0.24], [0.44, 0.96, 0.4, 0.22], [0.36, 0.94, 0.3, 0.16]], 0xffffff, PAINT, { e: 2.3 });
    b.shell([[0.66, 1.2, 0.3, 0.012], [0.56, 1.36, 0.26, 0.012], [0.5, 1.44, 0.2, 0.01]], GLASS, { rough: 0.05, metal: 0.5 }, { e: 2.4 });
    b.blob(0.13, 0.06, 0.04, 0, 0.92, 0.82, 0xfff6e0, { lamp: 1, rough: 0.15 });
    for (const x of [-1, 1]) b.blob(0.06, 0.035, 0.03, x * 0.38, 1.04, 0.62, BLACK, DARKMETAL);
    // console & tank, the engine, crash bars, floorboards
    b.shell([[0.4, 0.98, 0.18, 0.12], [0.2, 1.0, 0.22, 0.13], [0.0, 0.96, 0.2, 0.12], [-0.12, 0.92, 0.12, 0.08]], 0xffffff, PAINT);
    vTwin(b, 0.42, 0.1, 1.1);
    b.tube([-0.32, 0.36, 0.5], [-0.34, 0.66, 0.42], 0.022, CHROME, SHINY, [0.34, 0.66, 0.42], [0.32, 0.36, 0.5]);
    for (const x of [-1, 1]) b.box(0.14, 0.025, 0.32, x * 0.27, 0.36, 0.3, 0x1a1a1a, DARKMETAL);
    // two-up seat with backrest, saddlebags, top case, lamps, exhausts
    b.shell([[-0.1, 0.88, 0.19, 0.07], [-0.4, 0.86, 0.2, 0.08], [-0.6, 0.94, 0.18, 0.08], [-0.82, 0.96, 0.16, 0.07]], SEAT, { rough: 0.8 }, { e: 2.8 });
    for (const x of [-1, 1]) b.shell([[-0.42, 0.64, 0.1, 0.2, x * 0.33], [-0.55, 0.65, 0.13, 0.22, x * 0.34], [-0.95, 0.66, 0.13, 0.22, x * 0.34], [-1.08, 0.66, 0.09, 0.18, x * 0.33]], 0xffffff, PAINT, { e: 3 });
    b.shell([[-0.86, 1.12, 0.2, 0.15], [-0.94, 1.14, 0.24, 0.18], [-1.14, 1.12, 0.24, 0.17], [-1.2, 1.1, 0.18, 0.13]], 0xffffff, PAINT, { e: 3 });
    b.box(0.36, 0.05, 0.01, 0, 1.08, -1.205, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    for (const x of [-1, 1]) b.box(0.1, 0.05, 0.01, x * 0.36, 0.72, -1.17, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    for (const x of [-1, 1]) b.tube([x * 0.2, 0.32, -0.2], [x * 0.24, 0.38, -1.05], 0.045, CHROME, SHINY);
    for (const x of [-0.12, 0.12]) b.tube([x, 0.38, -0.1], [x, s.rr, -f], 0.03, BLACK, DARKMETAL);
    rider(b, { hip: [0, 0.97, -0.25], shoulder: [0, 1.5, -0.16], head: [0, 1.68, -0.12], hand: [0.34, 1.12, 0.36], knee: [0.26, 0.97, 0.15], foot: [0.27, 0.42, 0.3] });
  },
  adventure(b, s) {
    const f = s.wb / 2;
    b.wheel(s.rf, f, s.wf, s.wheel, 2); b.wheel(s.rr, -f, s.wr, s.wheel, 1);
    for (const x of [-0.09, 0.09]) {
      b.tube([x, s.rf, f], [x, 0.7, f - 0.12], 0.036, BLACK, DARKMETAL);
      b.tube([x, 0.7, f - 0.12], [x, 1.12, f - 0.27], 0.029, GOLD, { metal: 0.9, rough: 0.25 });
    }
    b.fender(s.rf + 0.04, 0.12, s.rf, f, 0.3, 1.8, BLACK, DARKMETAL);
    // the beak, the upright fairing with its tall screen and twin lamps, hand guards
    b.shell([[0.96, 0.92, 0.03, 0.02], [0.82, 0.98, 0.1, 0.04], [0.66, 1.03, 0.13, 0.05]], 0xffffff, PAINT, { e: 2.4 });
    b.shell([[0.72, 1.12, 0.1, 0.12], [0.62, 1.12, 0.2, 0.17], [0.46, 1.06, 0.24, 0.2], [0.3, 1.0, 0.25, 0.2]], 0xffffff, PAINT, { e: 2.6 });
    b.shell([[0.7, 1.3, 0.16, 0.01], [0.62, 1.44, 0.15, 0.01], [0.58, 1.5, 0.12, 0.01]], GLASS, { rough: 0.05, metal: 0.5 }, { e: 2.6 });
    for (const x of [-0.07, 0.07]) b.blob(0.05, 0.05, 0.03, x, 1.12, 0.72, 0xfff6e0, { lamp: 1, rough: 0.15 });
    b.tube([-0.42, 1.28, 0.4], [-0.1, 1.26, 0.46], 0.016, BLACK, DARKMETAL, [0.1, 1.26, 0.46], [0.42, 1.28, 0.4]);
    for (const x of [-1, 1]) b.blob(0.05, 0.05, 0.1, x * 0.44, 1.28, 0.46, BLACK, { rough: 0.7 });
    // tank, seat, tail, engine with its skid plate and crash bars, high exhaust, aluminium panniers
    b.shell([[0.36, 1.0, 0.2, 0.11], [0.18, 1.04, 0.24, 0.14], [0.0, 1.02, 0.2, 0.13], [-0.14, 0.98, 0.13, 0.09]], 0xffffff, PAINT);
    b.shell([[-0.08, 1.02, 0.14, 0.045], [-0.5, 1.04, 0.14, 0.045], [-0.7, 1.06, 0.1, 0.04]], SEAT, { rough: 0.85 }, { e: 3 });
    b.shell([[-0.55, 1.0, 0.12, 0.06], [-0.85, 1.04, 0.07, 0.04], [-0.92, 1.04, 0.03, 0.02]], 0xffffff, PAINT);
    b.blob(0.05, 0.02, 0.02, 0, 1.03, -0.91, 0x6a0a0e, { lamp: 2, rough: 0.2 });
    b.box(0.3, 0.3, 0.42, 0, 0.58, 0.1, METAL, DARKMETAL);
    b.shell([[0.34, 0.42, 0.14, 0.06], [0.0, 0.36, 0.18, 0.05], [-0.18, 0.38, 0.14, 0.05]], ALU, { metal: 0.85, rough: 0.35 }, { e: 4 });
    for (const x of [-1, 1]) b.tube([x * 0.18, 0.95, 0.4], [x * 0.3, 0.7, 0.32], 0.018, BLACK, DARKMETAL, [x * 0.26, 0.45, 0.1]);
    b.tube([-0.14, 0.45, 0.2], [-0.2, 0.62, -0.3], 0.035, CHROME, SHINY);
    b.tube([-0.2, 0.62, -0.3], [-0.22, 0.92, -0.72], 0.07, ALU, { metal: 0.8, rough: 0.3 });
    for (const x of [-0.11, 0.11]) b.tube([x, 0.56, -0.06], [x, s.rr, -f], 0.03, ALU, { metal: 0.85, rough: 0.3 });
    for (const x of [-1, 1]) b.shell([[-0.5, 0.76, 0.09, 0.2, x * 0.36], [-0.95, 0.76, 0.09, 0.2, x * 0.36]], ALU, { metal: 0.8, rough: 0.4 }, { e: 8 });
    rider(b, { hip: [0, 1.12, -0.24], shoulder: [0, 1.63, -0.1], head: [0, 1.81, -0.07], hand: [0.4, 1.28, 0.44], knee: [0.23, 1.0, 0.16], foot: [0.21, 0.56, 0.0] });
  }
};

// riders: 'with' the bike and its rider in one (traffic), 'without' (the player's bike, its rider apart so they can be
// thrown off), or 'only' the rider
function buildMotoGeometry(spec, detail = true, wheels = true) {
  const b = makeBuilder(detail, wheels);
  MODELS[spec.name](b, spec);
  const geo = mergeGeometries(b.parts);
  geo.computeBoundingSphere();
  return geo;
}

// One wheel on its own, its axle at the origin, to spin and steer (the player's bike)
function buildMotoWheel(spec, front) {
  const b = makeBuilder(true);
  const twin = front && (spec.name === 'sportbike' || spec.name === 'touring' || spec.name === 'adventure');
  b.wheel(front ? spec.rf : spec.rr, 0, front ? spec.wf : spec.wr, spec.wheel, spec.quiet || (spec.name === 'scooter' && !front) ? 0 : twin ? 2 : 1);
  const geo = mergeGeometries(b.parts);
  geo.translate(0, -(front ? spec.rf : spec.rr), 0);
  return geo;
}

// One material for every kind: the part's colour or the bike's paint, its finish, and its lamps (dipped and tail lamps
// lit at night, the tail lamp brighter while braking)
// (traffic's, instanced), or one bike's (the player's): its paint fixed and its lamps from userData.carState
let _material = null;
function createMotoMaterial(fixedHex = null) {
  if (fixedHex === null && _material) return _material;
  const fixed = fixedHex !== null;
  const stateUniform = fixed ? uniform(new THREE.Vector4(0, 0, 0, 0)) : null;
  const part = attribute('motoPart', 'vec4');
  const state = fixed ? stateUniform : attribute('carState', 'vec4');
  const paint = fixed ? color(fixedHex) : attribute('paintColor', 'vec3');
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  mat.colorNode = mix(attribute('color', 'vec3'), paint, part.x);
  mat.metalnessNode = part.z;
  mat.roughnessNode = part.w;
  const night = smoothstep(0.6, 1.15, cityUniforms.uInteriorGlow);
  const head = step(0.5, part.y).mul(step(part.y, 1.5));
  const tail = step(1.5, part.y);
  mat.emissiveNode = color(0xfff4e0).mul(head.mul(night.mul(1.4).add(0.8)))
    .add(color(0xff0c16).mul(tail.mul(state.x.mul(2.3).add(night.mul(0.55)).add(0.24))))
    .add(vec3(float(0)));
  if (fixed) {
    mat.userData.carState = stateUniform;
    return mat;
  }
  _material = mat;
  return mat;
}

// Where a person goes on each kind (rider() in its model), measured once
const _poses = {};
function motoRiderPose(kind) {
  if (!_poses[kind]) {
    const b = makeBuilder(false, false);
    MODELS[kind](b, MOTO_SPECS[kind]);
    _poses[kind] = b.pose;
  }
  return _poses[kind];
}

// The helmet each kind's rider wears: full-face on a motorbike, open-face on a scooter, a vented one on a bicycle,
// none standing on an e-scooter or a hoverboard
const HELMET_OF = { sportbike: 'full', cruiser: 'open', scooter: 'open', touring: 'full', adventure: 'full', bicycle: 'bike', ebike: 'bike' };
const HELMET_PAINTS = [0x111214, 0x111214, 0xe9e9e6, 0x3c4046, 0x7a0e14, 0x1d2f4a, 0x9a9da1];

// A helmet in the head bone's space (PersonRig.headPosition, +Y up the head, +Z the face), painted with the paint
// (createMotoMaterial's paintColor) and its visor, vents and trim in their own colours
function buildHelmetGeometry(type) {
  const b = makeBuilder(true, false);
  const SHELL = { paint: 1, rough: 0.2, metal: 0.05 };
  if (type === 'full') {
    b.blob(0.132, 0.148, 0.152, 0, 0.112, -0.004, 0, SHELL);
    // the visor across the eyes, its pivots, and the chin bar's vent
    b.blob(0.112, 0.052, 0.07, 0, 0.122, 0.098, GLASS, { rough: 0.05, metal: 0.7 });
    for (const x of [-1, 1]) b.disc(0.022, 0.012, x * 0.128, 0.122, 0.04, 0x1c1c1e, { rough: 0.5 }, 10);
    b.box(0.05, 0.02, 0.02, 0, 0.012, 0.143, 0x1c1c1e, { rough: 0.6 });
    b.blob(0.118, 0.03, 0.13, 0, -0.025, -0.012, 0x1c1c1e, { rough: 0.7 });
  } else if (type === 'open') {
    b.blob(0.126, 0.13, 0.142, 0, 0.142, -0.016, 0, SHELL);
    b.blob(0.118, 0.05, 0.12, 0, 0.07, -0.034, 0x2a1d14, { rough: 0.7 });
    b.blob(0.1, 0.018, 0.04, 0, 0.17, 0.12, 0x1c1c1e, { rough: 0.5 });
  } else {
    b.blob(0.118, 0.085, 0.152, 0, 0.17, -0.016, 0, SHELL);
    for (const x of [-0.045, 0, 0.045]) b.box(0.016, 0.02, 0.2, x, 0.245, -0.016, 0x1c1c1e, { rough: 0.6 });
    b.box(0.2, 0.01, 0.012, 0, 0.115, 0.07, 0x1c1c1e, { rough: 0.6 });
  }
  const geo = mergeGeometries(b.parts);
  geo.computeBoundingSphere();
  return geo;
}

export { MOTO_SPECS, HELMET_OF, HELMET_PAINTS, buildMotoGeometry, buildMotoWheel, buildHelmetGeometry, createMotoMaterial, motoRiderPose };
