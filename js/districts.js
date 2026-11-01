// Ann Arbor's land use parcels and historic districts (data/districts.json, Assets/Tools/build-districts.py), from
// the City of Ann Arbor's open data. main.js hands the file to setDistricts before the city is built; until then
// every lookup answers "nothing here".

// Land use codes, as the build writes them
export const LAND_USE = {
  SINGLE_FAMILY: 1, TWO_FAMILY: 2, APARTMENTS: 3, HOTEL: 4, SHOPS: 5, OFFICES: 6, MIXED_USE: 7, CIVIC: 8,
  RELIGIOUS: 9, INDUSTRY: 10, RECREATION: 11, TRANSPORT: 12, VACANT: 13, CEMETERY: 14
};

const CELL = 100;
let parcels = new Map(); // cell key -> [{ use, ring, minX, maxX, minZ, maxZ }]
let historic = [];       // [{ name, rings, minX, maxX, minZ, maxZ }]

function bounds(ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]); maxX = Math.max(maxX, ring[i]);
    minZ = Math.min(minZ, ring[i + 1]); maxZ = Math.max(maxZ, ring[i + 1]);
  }
  return { minX, maxX, minZ, maxZ };
}

function inRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function setDistricts(data) {
  parcels = new Map();
  historic = [];
  if (!data) return;
  for (const row of data.landuse || []) {
    const ring = row.slice(1), b = bounds(ring);
    const p = { use: row[0], ring, ...b };
    for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
      for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
        const key = cx + ',' + cz;
        if (!parcels.has(key)) parcels.set(key, []);
        parcels.get(key).push(p);
      }
    }
  }
  for (const d of data.historic || []) {
    const all = d.rings.map(bounds);
    historic.push({
      name: d.name, rings: d.rings,
      minX: Math.min(...all.map((b) => b.minX)), maxX: Math.max(...all.map((b) => b.maxX)),
      minZ: Math.min(...all.map((b) => b.minZ)), maxZ: Math.max(...all.map((b) => b.maxZ))
    });
  }
}

/** The land use code of the parcel at (x, z), or 0 */
export function landUseAt(x, z) {
  for (const p of parcels.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) || []) {
    if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && inRing(p.ring, x, z)) return p.use;
  }
  return 0;
}

/** The name of the historic district at (x, z), or null */
export function historicDistrictAt(x, z) {
  for (const d of historic) {
    if (x < d.minX || x > d.maxX || z < d.minZ || z > d.maxZ) continue;
    if (d.rings.some((r) => inRing(r, x, z))) return d.name;
  }
  return null;
}

/** Every historic district, for the map: [{ name, rings }] */
export function historicDistricts() {
  return historic;
}
