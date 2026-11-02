// How much of the city a device is given. The whole city laid on its hills holds about 3 GB, which a Mac with memory to
// spare draws as it is ('full'). A phone or tablet's browser is ended by the system well before that, so there
// ('phone') only the ground and the houses around the player are built, and filled in as they move (terrain.js,
// buildings.js: `STREAM`), with the far trees, houses and street details cut, no shadows or glow, a smaller drawing and
// fewer cars and people. A Mac with 16 GB or less ('light') streams the same way over a wider area and keeps the look.
// `?tier=phone`, `?tier=light` or `?tier=full` in the page's address chooses one, to try it.
import { log } from '../lamp-game.js';

const TIERS = {
  full: { name: 'full', stream: 0, shadows: true, bloom: true, antialias: true, scale: 1, traffic: 1, people: 1, farCut: 1, outskirts: true },
  // the ground and houses within 950 m built, the rest as the player comes near
  light: { name: 'light', stream: 950, shadows: true, bloom: true, antialias: true, scale: 0.85, traffic: 0.75, people: 0.75, farCut: 0.75, outskirts: true },
  // within about 1 km; trees, houses and street details drawn half as far; 1344x756; half the cars, a third of the people
  phone: { name: 'phone', stream: 1000, shadows: false, bloom: false, antialias: false, scale: 0.7, traffic: 0.5, people: 0.35, farCut: 0.5, outskirts: true }
};

// A phone or a tablet: an iPad says it's a Mac, but has a touch screen
export const TOUCH_DEVICE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
export const FIREFOX = /Firefox\//i.test(navigator.userAgent);

// The tier in use, chosen as this module loads (before anything that imports it builds the city): read by everything
// that builds it, at the top of its module too
export const TIER = { ...TIERS.full };

async function chooseTier() {
  let name = TOUCH_DEVICE ? 'phone' : 'light';
  let memory = null;
  // the app on a Mac knows how much memory it has; a standalone browser defaults to 'light' (full visuals, 1.8 km streaming)
  if (!TOUCH_DEVICE && window.LampNative?.available) {
    memory = await window.LampNative.call('memory').catch(() => null);
    name = (typeof memory === 'number' && memory > 17) ? 'full' : 'light';
  }
  const asked = new URLSearchParams(location.search).get('tier');
  if (TIERS[asked]) name = asked;
  Object.assign(TIER, TIERS[name]);
  // Firefox's macOS WebGL2 backend stalls heavily on 4x MSAA RGBA16F offscreen blits + 11-pass HDR bloom
  if (FIREFOX && !asked) {
    Object.assign(TIER, { bloom: false, antialias: false, scale: Math.min(TIER.scale, 0.75), farCut: Math.min(TIER.farCut, 0.65) });
  }
  log(`[tier] ${name}${memory ? ` (${Math.round(memory)} GB)` : ''}${TOUCH_DEVICE ? ', a touch device' : ''}${FIREFOX ? ', firefox' : ''}`);
  return TIER;
}
await chooseTier();
