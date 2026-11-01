// Lamp: the Huron River's flow now, from the USGS gauge "Huron River at Ann Arbor" (site 04174500, the US Geological
// Survey's instantaneous values service, a US government work in the public domain), asked for when the city opens and
// every 15 minutes. The kayak's current follows it: faster after rain, lazier when the river is low. Offline, or when
// the service doesn't answer, the river runs at its usual flow.

const SITE = '04174500';
const USUAL_CFS = 500; // about the river's typical flow through town, in cubic feet a second
const USUAL = { cfs: USUAL_CFS, scale: 1, live: false };

// How much faster than usual the water moves for a flow: velocity grows about as the 0.4 power of discharge
function currentScale(cfs) {
  return Math.min(2.4, Math.max(0.45, (cfs / USUAL_CFS) ** 0.4));
}

async function fetchRiverFlow() {
  try {
    const res = await fetch(`https://waterservices.usgs.gov/nwis/iv/?sites=${SITE}&format=json&parameterCd=00060`);
    if (!res.ok) return USUAL;
    const series = (await res.json())?.value?.timeSeries?.[0];
    const values = series?.values?.[0]?.value || [];
    const cfs = Number(values[values.length - 1]?.value);
    if (!Number.isFinite(cfs) || cfs < 0) return USUAL;
    return { cfs, scale: currentScale(cfs), live: true };
  } catch {
    return USUAL;
  }
}

export { fetchRiverFlow, USUAL as USUAL_RIVER_FLOW };
