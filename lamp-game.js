// Lamp's game runtime for a game drawn with three.js, or with Phaser for a 2D game (lamp-phaser.js, which runs Phaser's
// scenes through this). Lamp writes this file before every build; don't edit it.
//
// The game is two functions, init and frame, given to game(): the runtime runs them about 60 times a second wherever
// the game is played (on the Mac and on an iPhone or iPad in Lamp's app around the page, on the Xbox in its web host),
// draws at 1920x1080 scaled to the screen (smaller when frames run slow there), and hands each frame the controllers
// as pads: a controller connected to the device, the keyboard as the first pad, and on a touch screen the touch
// controls it draws. Lamp's preview runs the same
// page out of sight from a script of the controller's moves, at exactly 1/60 s a frame with the same random numbers
// every play, so use frame.dt, random() and save()/load() from here, never requestAnimationFrame, Math.random, the
// clock or localStorage yourself. What the player is holding (a controller, and whose, the keyboard or the touch screen)
// is input(), and label() and glyph() name and draw a button for it, so a prompt never names one the player hasn't got.
//
//   import * as THREE from 'three';
//   import { game, BUTTON, STICK, random, sound, log, label, glyph, onInput, fixedStep } from './lamp-game.js';
//   const renderer = new THREE.WebGLRenderer({ antialias: true });
//   game({ renderer, async init() { … }, frame(f) { … renderer.render(scene, camera); } });

import device from './lamp-device.js';
import controllers from './lamp-controllers.js';

export const WIDTH = 1920, HEIGHT = 1080;

// The controller's buttons, as bits of a pad's down, pressed and released.
export const BUTTON = { A: 1, B: 2, X: 4, Y: 8, LB: 16, RB: 32, MENU: 64, VIEW: 128, UP: 256, DOWN: 512, LEFT: 1024, RIGHT: 2048,
                        LSTICK: 4096, RSTICK: 8192 };
// The sticks and triggers, for `label` and `glyph` (a pad reads them as lx, ly, rx, ry, lt and rt).
export const STICK = { LEFT: 'stick-left', RIGHT: 'stick-right' };
export const TRIGGER = { LT: 'lt', RT: 'rt' };

const preview = window.lampPreview || null;   // set by Lamp's preview before the page runs
const logs = [];
// The browser's own functions, kept before the runtime starts watching what the game's code leaves running (see
// "Running the game's code again"): the runtime's own listeners, timers and sound go through these, so they stay when
// the game's are taken away.
// A runtime run outside a page (Lamp's tests) may have none of them, and uses whatever the target has.
const events = globalThis.EventTarget && EventTarget.prototype;
const browser = {
    listen: events ? events.addEventListener : function (...rest) { return this.addEventListener(...rest); },
    unlisten: events ? events.removeEventListener : function (...rest) { return this.removeEventListener(...rest); },
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval, clearInterval: window.clearInterval,
    frame: window.requestAnimationFrame, cancelFrame: window.cancelAnimationFrame,
    AudioContext: window.AudioContext || window.webkitAudioContext, Worker: window.Worker,
};
const listen = (target, ...rest) => browser.listen.call(target, ...rest);
const after = (ms, fn) => browser.setTimeout.call(window, fn, ms);
const nextFrame = fn => browser.frame.call(window, fn);
// A runtime run outside a page (Lamp's tests) may have no performance clock.
const clockNow = () => globalThis.performance ? performance.now() : Date.now();

// MARK: Random numbers, the same each preview play (xorshift64*, as the C++ kit has it)

let seed = preview ? 1n : BigInt(Date.now()) | 1n;
const mask = (1n << 64n) - 1n;
// How many have been drawn, so a part that's kept rather than built again can skip the draws its build made.
let draws = 0;
export function random() {
    draws++;
    seed ^= seed >> 12n; seed ^= (seed << 25n) & mask; seed ^= seed >> 27n;
    return Number(((seed * 0x2545F4914F6CDD1Dn) & mask) >> 40n) / 16777216;
}
let clock = 0;
if (preview) {
    // three.js and the game's own code may reach for these: in the preview they're the game's clock and seed too.
    Math.random = random;
    performance.now = () => clock;
    Date.now = () => 1700000000000 + clock;
    window.__lampAdvance = ms => { clock += ms; };
}

// MARK: The log, saves and files

export function log(...parts) {
    const line = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
    const said = `[${time.toFixed(2)} s] ${line}`;
    if (preview) { if (logs.length < 400) logs.push(said); return; }
    // The app around the page puts its console into the app's log.
    console.log(said);
}
window.addEventListener('error', e => log(`Error: ${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => log(`Error: ${e.reason && e.reason.message || e.reason}`));

const saved = preview ? new Map() : null;
export function save(name, value) {
    const text = JSON.stringify(value);
    if (saved) saved.set(name, text); else try { localStorage.setItem('lamp.save.' + name, text); } catch (e) { return false; }
    return true;
}
export function load(name) {
    const text = saved ? saved.get(name) : (() => { try { return localStorage.getItem('lamp.save.' + name); } catch (e) { return null; } })();
    try { return text == null ? null : JSON.parse(text); } catch (e) { return null; }
}

// A file beside the page (assets/ship.glb), as bytes. Loaded through here (or texture(), model() and sound.load()),
// a file Lamp changes while the game is played can be put into it without starting again (see "Changes while it's
// played" below).
export async function asset(path) {
    took(clean(path));
    const answer = await fetch(fresh(path));
    if (!answer.ok) { log(`asset: no ${path}`); return null; }
    return answer.arrayBuffer();
}

// Work done in a worker (js/city-worker.js, a module beside the page), off the frame the game draws: `message` is sent
// to it, with `transfer` (ArrayBuffers handed over rather than copied), and what it posts back first is the answer,
// after which it ends. For the pure data work of a part built in the background (see "Building in the background"):
// parsing, and the arrays of positions, normals and indices that geometry is made from, posted back with their buffers
// as transfer. The part built with it is built again when the worker's file changes.
//
//   // js/city-worker.js: onmessage = e => { const positions = new Float32Array(…); postMessage({ positions }, [positions.buffer]); };
//   const { positions } = await work('js/city-worker.js', { blocks: MAP.blocks });
export function work(path, message, transfer = []) {
    read(clean(path));
    return new Promise((done, fail) => {
        const worker = new browser.Worker(`${addressOf(clean(path))}?lamp=${++versionCount}`, { type: 'module' });
        worker.onmessage = e => { worker.terminate(); done(e.data); };
        worker.onerror = e => { worker.terminate(); fail(new Error(`${path}: ${e.message || 'the worker failed'}`)); };
        worker.postMessage(message, transfer);
    });
}

// The files the game loaded through the runtime, and how the runtime puts a new copy of each in by itself.
const loaded = new Set(), swaps = new Map();
// Every file of the page this copy has read, through the runtime, fetched or started as a worker: what the running game
// holds may have come from any of them (`unusedFiles`, `waitsFor`). What a worker reads for itself the page never sees.
const everRead = new Set();
let workerStarted = false;
const clean = path => String(path).replace(/^\.?\//, '').split(/[?#]/)[0];
// Asked again after a change, a file is asked for by a new address, so nothing on the way keeps the old one.
let changes = 0;
const fresh = path => changes ? `${path}${String(path).includes('?') ? '&' : '?'}lamp=${changes}` : path;
// So is a file of the page's that the game's own code fetches (a city's building data), once anything has changed. What
// a part kept with keep() fetches as it's built is what it's built from (`read`), as a file loaded through the runtime is.
if (window.fetch) {
    const fetchFile = window.fetch;
    window.fetch = function (input, init) {
        const url = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
        const path = url ? pathOf(url) : null;
        if (path != null) read(clean(path));
        if (changes && !(init && init.cache) && path != null) init = { ...init, cache: 'no-store' };
        return fetchFile.call(this, input, init);
    };
}

// A picture beside the page as a three.js texture, set up by `setup(texture)` (its color space, wrapping, repeat…). A
// new copy of the picture goes into the same texture while the game is played, so every material using it shows it.
export async function texture(path, setup) {
    const THREE = await import('three');
    const loader = new THREE.TextureLoader();
    const made = await loader.loadAsync(fresh(path));
    if (setup) setup(made);
    took(clean(path));
    swaps.set(clean(path), [...(swaps.get(clean(path)) || []), async () => {
        const again = await loader.loadAsync(fresh(path));
        made.image = again.image;
        made.needsUpdate = true;
        again.dispose();
    }]);
    return made;
}

// A glTF model beside the page (.glb or .gltf), as a THREE.Group holding its scene, with its animations in
// `group.animations`. A new copy of the file replaces what's inside the group while the game is played, where the group
// is: a copy made with clone(), and a mixer playing its animations, are the game's to make again in assetChanged.
export async function model(path) {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const group = new THREE.Group();
    const fill = gltf => { group.clear(); group.add(gltf.scene); group.animations = gltf.animations; };
    fill(await loader.loadAsync(fresh(path)));
    group.name = clean(path);
    took(clean(path));
    swaps.set(clean(path), [...(swaps.get(clean(path)) || []), async () => {
        const old = [...group.children];
        fill(await loader.loadAsync(fresh(path)));
        for (const child of old) child.traverse(o => { o.geometry && o.geometry.dispose(); });
    }]);
    return group;
}

// MARK: Sound, mixed by the browser's Web Audio; the preview plays nothing and says what was played

const sounds = [];
let audio = null, effectsVolume = 1, musicVolume = 1, musicVoice = null, music = { gain: 0 };
const played = new Map();
// The effects playing now, so a change of the effects volume reaches them too.
const voices = new Set();
function context() {
    if (preview) return null;
    if (!audio) { try { audio = new browser.AudioContext({ sampleRate: 48000 }); } catch (e) { return null; } }
    if (audio.state === 'suspended') audio.resume();
    return audio;
}
// Played as soon as the page is touched, clicked or a key pressed, for a browser that holds sound back until then.
for (const kind of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(kind, () => context(), { passive: true });

function made(samples, name) {
    const s = { id: sounds.length + 1, name, samples, buffer: null };
    sounds.push(s);
    return s;
}
function bufferOf(s) {
    const ctx = context();
    if (!ctx || !s || !s.samples) return null;
    if (!s.buffer) {
        s.buffer = ctx.createBuffer(1, s.samples.length, 48000);
        s.buffer.copyToChannel(s.samples, 0);
    }
    return s.buffer;
}

export const sound = {
    // An effect made in code: a wave ('sine', 'square', 'triangle', 'saw', 'noise') from one pitch to another under a
    // simple envelope, in seconds.
    tone({ wave = 'square', from = 440, to = from, attack = 0.005, hold = 0.08, release = 0.1, volume = 0.6, name } = {}) {
        const n = Math.max(1, Math.round((attack + hold + release) * 48000));
        const out = new Float32Array(n);
        let phase = 0, noise = 0x2545F491;
        for (let i = 0; i < n; i++) {
            const t = i / 48000, at = t / Math.max(1e-6, attack + hold + release);
            const hz = from + (to - from) * at;
            phase = (phase + hz / 48000) % 1;
            let v;
            if (wave === 'sine') v = Math.sin(phase * 2 * Math.PI);
            else if (wave === 'triangle') v = 1 - 4 * Math.abs(phase - 0.5);
            else if (wave === 'saw') v = 2 * phase - 1;
            else if (wave === 'noise') { noise ^= noise << 13; noise ^= noise >>> 17; noise ^= noise << 5; v = ((noise >>> 0) / 4294967296) * 2 - 1; }
            else v = phase < 0.5 ? 1 : -1;
            const env = t < attack ? t / attack : t < attack + hold ? 1 : Math.max(0, 1 - (t - attack - hold) / Math.max(1e-6, release));
            out[i] = v * env * volume * 0.5;
        }
        return made(out, name || `${wave} ${Math.round(from)}→${Math.round(to)} Hz`);
    },
    // An effect from samples worked out in code: mono, -1 to 1, at `rate` a second.
    samples(values, rate = 48000, name = 'samples') {
        const n = Math.round(values.length * 48000 / rate), out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = values[Math.min(values.length - 1, Math.floor(i * rate / 48000))] || 0;
        return made(out, name);
    },
    // A sound file beside the page (.wav, .ogg, .mp3, .m4a), decoded whole: load each in init, never per frame.
    async load(path) {
        const s = made(null, path);
        // A new copy of the file is decoded into the same sound, so what plays it next plays the new one.
        const decode = async () => {
            const ctx = context();
            if (!ctx) return;
            try { s.buffer = await ctx.decodeAudioData(await (await fetch(fresh(path))).arrayBuffer()); } catch (e) { log(`sound: couldn't load ${path}`); }
        };
        took(clean(path));
        swaps.set(clean(path), [...(swaps.get(clean(path)) || []), decode]);
        await decode();
        return s;
    },
    // Plays an effect, and gives the voice playing it (null when it didn't): volume 0 to 1, pan -1 to 1, pitch 1 as
    // made (2 an octave up). loop plays it over and over until stopped.
    play(s, { volume = 1, pan = 0, pitch = 1, loop = false } = {}) {
        if (!s) return null;
        played.set(s.name, (played.get(s.name) || 0) + 1);
        const ctx = context(), buffer = bufferOf(s) || s.buffer;
        if (!ctx || !buffer) return null;
        const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
        source.buffer = buffer; source.loop = loop; source.playbackRate.value = pitch;
        gain.gain.value = volume * effectsVolume; panner.pan.value = pan;
        source.connect(gain).connect(panner).connect(ctx.destination);
        source.start();
        const voice = { source, gain, panner, volume };
        voices.add(voice);
        source.onended = () => voices.delete(voice);
        return voice;
    },
    set(voice, { volume, pan, pitch } = {}) {
        if (!voice) return;
        if (volume != null) { voice.volume = volume; voice.gain.gain.value = volume * effectsVolume; }
        if (pan != null) voice.panner.pan.value = pan;
        if (pitch != null) voice.source.playbackRate.value = pitch;
    },
    stop(voice) { try { voice && voice.source.stop(); } catch (e) {} },
    // Music: a sound played over and over under the effects (keep it quiet, 0.3 to 0.5); null fades it out.
    music(s, volume = 0.4) {
        const ctx = context();
        if (s) played.set('music: ' + s.name, 1);
        if (musicVoice && ctx) { const old = musicVoice; old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3); after(1500, () => sound.stop(old)); }
        musicVoice = null;
        music.gain = volume;
        if (!s || !ctx) return;
        const buffer = bufferOf(s) || s.buffer;
        if (!buffer) return;
        const source = ctx.createBufferSource(), gain = ctx.createGain(), panner = ctx.createStereoPanner();
        source.buffer = buffer; source.loop = true;
        gain.gain.value = 0;
        gain.gain.setTargetAtTime(volume * musicVolume, ctx.currentTime, 0.3);
        source.connect(gain).connect(panner).connect(ctx.destination);
        source.start();
        musicVoice = { source, gain, panner };
    },
    // The person's own volumes for effects and for music, 0 to 1: what the game's settings change, kept with save().
    volume(effects, musicLevel) {
        effectsVolume = effects; musicVolume = musicLevel;
        for (const voice of voices) voice.gain.gain.value = voice.volume * effectsVolume;
        if (musicVoice) musicVoice.gain.gain.value = music.gain * musicVolume;
    },
};

// MARK: The controllers

const keys = new Set();
// Only the keyboard's own keys: the Xbox's lamp.js sends the controller as key events too (which aren't trusted, being
// made by a script), and the controller is read whole through the Gamepad API.
// A Samsung or LG TV's remote names its keys only by number: its arrows are the keyboard's, OK is Enter, Back is Escape.
const REMOTE = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 13: 'Enter', 10009: 'Escape', 461: 'Escape' };
const codeOf = e => e.code || REMOTE[e.keyCode] || '';
window.addEventListener('keydown', e => { if (!e.isTrusted) return; const code = codeOf(e); keys.add(code); if (code.startsWith('Arrow') || code === 'Space' || code === 'Tab') e.preventDefault(); });
window.addEventListener('keyup', e => { if (e.isTrusted) keys.delete(codeOf(e)); });
window.addEventListener('blur', () => keys.clear());

// The keyboard as a pad: the keys for each button and for each way a stick or trigger goes, the first the one a
// prompt names (`label`), but for the left stick, where a game's `keyboardHints` can name the arrows instead.
const KEYS = { [BUTTON.A]: ['Space', 'Enter'], [BUTTON.B]: ['Escape', 'Backspace'], [BUTTON.X]: ['KeyF'], [BUTTON.Y]: ['KeyR'],
               [BUTTON.LB]: ['KeyQ'], [BUTTON.RB]: ['KeyE'], [BUTTON.MENU]: ['KeyP'], [BUTTON.VIEW]: ['Tab'],
               [BUTTON.UP]: ['ArrowUp'], [BUTTON.DOWN]: ['ArrowDown'], [BUTTON.LEFT]: ['ArrowLeft'], [BUTTON.RIGHT]: ['ArrowRight'] };
const STICK_KEYS = { left: { up: ['KeyW', 'ArrowUp'], left: ['KeyA', 'ArrowLeft'], down: ['KeyS', 'ArrowDown'], right: ['KeyD', 'ArrowRight'] },
                     right: { up: ['KeyI'], left: ['KeyJ'], down: ['KeyK'], right: ['KeyL'] } };
const TRIGGER_KEYS = { lt: ['KeyZ'], rt: ['KeyC'] };
// Which of the left stick's keys a prompt names, by their place in STICK_KEYS.left. Both always move the stick.
const LEFT_STICK_HINTS = { wasd: 0, arrows: 1 };
let leftStickHint = LEFT_STICK_HINTS.wasd;

function keyboardPad() {
    const any = codes => codes.some(c => keys.has(c)), axis = (plus, minus) => (any(plus) ? 1 : 0) - (any(minus) ? 1 : 0);
    const l = STICK_KEYS.left, r = STICK_KEYS.right;
    const pad = { lx: axis(l.right, l.left), ly: axis(l.up, l.down), rx: axis(r.right, r.left), ry: axis(r.up, r.down),
                  lt: any(TRIGGER_KEYS.lt) ? 1 : 0, rt: any(TRIGGER_KEYS.rt) ? 1 : 0, down: 0 };
    for (const bit in KEYS) if (any(KEYS[bit])) pad.down |= Number(bit);
    return pad;
}

const dead = v => Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85;
function gamepadPad(g) {
    const b = i => g.buttons[i] && g.buttons[i].pressed;
    const pad = { connected: true, lx: dead(g.axes[0] || 0), ly: -dead(g.axes[1] || 0), rx: dead(g.axes[2] || 0), ry: -dead(g.axes[3] || 0),
                  lt: g.buttons[6] ? g.buttons[6].value : 0, rt: g.buttons[7] ? g.buttons[7].value : 0, down: 0 };
    const bits = [BUTTON.A, BUTTON.B, BUTTON.X, BUTTON.Y, BUTTON.LB, BUTTON.RB, 0, 0, BUTTON.VIEW, BUTTON.MENU, BUTTON.LSTICK, BUTTON.RSTICK,
                  BUTTON.UP, BUTTON.DOWN, BUTTON.LEFT, BUTTON.RIGHT];
    bits.forEach((bit, i) => { if (bit && b(i)) pad.down |= bit; });
    pad.gamepad = g;
    return pad;
}

// The first controller as an app around the page reads it itself (Lamp's Android app, whose WebView doesn't promise
// the Gamepad API): sticks -1 to 1 with up positive, triggers 0 to 1, buttons as BUTTON bits.
// `vendor` is the controller's USB vendor, which an app from before it was sent leaves out.
let nativePad = null;
// All at rest is no controller in hand (one that went away sends that), so the touch controls can come back.
window.lampNativePad = (lx, ly, rx, ry, lt, rt, down, vendor) => {
    nativePad = down || lx || ly || rx || ry || lt || rt ? { connected: true, lx, ly, rx, ry, lt, rt, down, vendor } : null;
};

function merge(pad, more) {
    pad.down |= more.down;
    for (const axis of ['lx', 'ly', 'rx', 'ry', 'lt', 'rt']) if (Math.abs(more[axis]) > Math.abs(pad[axis])) pad[axis] = more[axis];
}

// The controller's rumble, 0 to 1 for its two motors, for `seconds` (a short shake by default).
export function rumble(pad, low, high, seconds = 0.2) {
    const g = (pads[pad] || {}).gamepad;
    if (preview) { if (low || high) log(`rumble: controller ${pad + 1} ${low.toFixed(2)} ${high.toFixed(2)}`); return; }
    g && g.vibrationActuator && g.vibrationActuator.playEffect('dual-rumble', { duration: seconds * 1000, strongMagnitude: low, weakMagnitude: high }).catch(() => {});
}

// MARK: Touch controls, on a touch screen while no controller is connected, or once the screen is touched

let touchButtons = BUTTON.A | BUTTON.B | BUTTON.MENU;
// A page with touch controls of its own, or one that reads the keyboard itself, turns Lamp's off (`game`).
let drawsTouch = true, readsKeyboard = true;
const touch = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0 };
// A tap shorter than a frame still reaches the game: held for the next frame it reads.
let tapped = 0;
let touchShown = false, touchLayer = null;
const touchScreen = !preview && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

function buildTouch() {
    touchLayer = document.createElement('div');
    touchLayer.style.cssText = 'position:fixed;inset:0;z-index:10;touch-action:none;user-select:none;-webkit-user-select:none;font:700 22px -apple-system,system-ui,sans-serif;color:#fff';
    const stick = (side, axes) => {
        const zone = document.createElement('div');
        zone.style.cssText = `position:absolute;top:0;bottom:0;${side}:0;width:50%`;
        const ring = document.createElement('div'), knob = document.createElement('div');
        ring.style.cssText = 'position:absolute;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;background:rgba(255,255,255,.18);display:none';
        knob.style.cssText = 'position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;background:rgba(255,255,255,.45);display:none';
        zone.append(ring, knob);
        // Where the left stick is, before a thumb is on it.
        const rest = document.createElement('div');
        if (side === 'left') {
            rest.style.cssText = 'position:absolute;left:calc(40px + env(safe-area-inset-left));bottom:calc(32px + env(safe-area-inset-bottom));width:120px;height:120px;border-radius:50%;border:2px solid rgba(255,255,255,.25)';
            zone.append(rest);
        }
        let id = null, sx = 0, sy = 0;
        listen(zone, 'pointerdown', e => { id = e.pointerId; sx = e.clientX; sy = e.clientY; zone.setPointerCapture(id); move(e); });
        const move = e => {
            if (e.pointerId !== id) return;
            let dx = e.clientX - sx, dy = e.clientY - sy;
            const length = Math.hypot(dx, dy), scale = Math.min(1, 60 / Math.max(1, length));
            dx *= scale; dy *= scale;
            touch[axes[0]] = dx / 60; touch[axes[1]] = -dy / 60;
            const r = zone.getBoundingClientRect();
            ring.style.left = (sx - r.left) + 'px'; ring.style.top = (sy - r.top) + 'px';
            knob.style.left = (sx - r.left + dx) + 'px'; knob.style.top = (sy - r.top + dy) + 'px';
            ring.style.display = knob.style.display = 'block';
            rest.style.display = 'none';
        };
        listen(zone, 'pointermove', move);
        const end = e => {
            if (e.pointerId !== id) return;
            id = null; touch[axes[0]] = touch[axes[1]] = 0;
            ring.style.display = knob.style.display = 'none';
            rest.style.display = '';
        };
        listen(zone, 'pointerup', end); listen(zone, 'pointercancel', end);
        return zone;
    };
    touchLayer.append(stick('left', ['lx', 'ly']));
    if (touchButtons & BUTTON.RSTICK) touchLayer.append(stick('right', ['rx', 'ry']));
    const button = (bit, title, css, small) => {
        if (!(touchButtons & bit)) return;
        const size = small ? 44 : 64;
        const b = document.createElement('div');
        b.textContent = title;
        b.style.cssText = `position:absolute;${css};width:${size}px;height:${size}px;line-height:${size}px;text-align:center;border-radius:50%;background:rgba(255,255,255,.22);font-size:${small ? 15 : 22}px`;
        const on = e => { e.stopPropagation(); touch.down |= bit; tapped |= bit; b.style.background = 'rgba(255,255,255,.5)'; b.setPointerCapture(e.pointerId); };
        const off = () => { touch.down &= ~bit; b.style.background = 'rgba(255,255,255,.22)'; };
        listen(b, 'pointerdown', on); listen(b, 'pointerup', off); listen(b, 'pointercancel', off);
        touchLayer.append(b);
    };
    // Kept clear of a phone's rounded corners and its camera (the safe area).
    const at = (x, side, y, edge) => `${side}:calc(${x}px + env(safe-area-inset-${side}));${edge}:calc(${y}px + env(safe-area-inset-${edge}))`;
    const face = bit => TOUCH_FACES[bit] || BASE.names[nameOf(bit)];
    button(BUTTON.A, face(BUTTON.A), at(110, 'right', 40, 'bottom'));
    button(BUTTON.B, face(BUTTON.B), at(40, 'right', 110, 'bottom'));
    button(BUTTON.X, face(BUTTON.X), at(180, 'right', 110, 'bottom'));
    button(BUTTON.Y, face(BUTTON.Y), at(110, 'right', 180, 'bottom'));
    button(BUTTON.LB, face(BUTTON.LB), at(30, 'left', 20, 'top'), true);
    button(BUTTON.VIEW, face(BUTTON.VIEW), at(90, 'left', 20, 'top'), true);
    button(BUTTON.MENU, face(BUTTON.MENU), at(90, 'right', 20, 'top'), true);
    button(BUTTON.RB, face(BUTTON.RB), at(30, 'right', 20, 'top'), true);
    document.body.append(touchLayer);
}
if (touchScreen) window.addEventListener('pointerdown', () => { if (!touchShown) { touchShown = true; showTouch(); } }, { capture: true });
function showTouch() { if (!drawsTouch) return; if (!touchLayer) buildTouch(); touchLayer.style.display = 'block'; touchShown = true; }
function hideTouch() { if (touchLayer) touchLayer.style.display = 'none'; touchShown = false; }

// MARK: What the player plays with, and what to call its buttons

// The page never works out which device it's on. Lamp writes it beside this file in every copy of the page
// (lamp-device.js, from the device's row in Lamp's table of devices): what its keyboard calls the keys keyboards name
// differently, the controller that comes with it, and the one layout every controller there has, where the device
// has one. The controllers a game names buttons for, and how each is told apart, are Lamp's list (lamp-controllers.js).
const LAYOUTS = Object.fromEntries(controllers.layouts.map(layout => [layout.id, layout]));
const BASE = LAYOUTS[controllers.base];

// The input the player used last: a controller (and whose), the keyboard (with the mouse) or the touch screen. A
// device that comes with a controller starts on it, a touch screen on touch, anything else and Lamp's preview on the
// keyboard (the controller named by the device's one layout where it has one, as every controller there is); it
// changes as soon as the player presses a key, touches the screen or moves a controller.
let current = preview ? { kind: 'keyboard' } : device.controller ? { kind: 'controller', family: device.layout || device.controller }
    : touchScreen ? { kind: 'touch' } : { kind: 'keyboard' };
// The controller's own name, for a model that marks a button differently from the rest of its layout (a DualShock's
// Share where a DualSense has Create).
let padName = '';
const variantOf = (family, name) => ((LAYOUTS[family] || {}).variants || []).find(v => new RegExp(v.match, 'i').test(name)) || null;
const listeners = new Set();

export function input() { return Object.assign({}, current); }
// Calls `changed(input())` now and again each time the player takes up another input, to draw the prompts and help
// for it; returns a function that stops it.
export function onInput(changed) {
    listeners.add(changed);
    try { changed(input()); } catch (e) { log(`Error: ${e.message}`); }
    return () => listeners.delete(changed);
}

const drawPrompts = () => { for (const changed of listeners) try { changed(input()); } catch (e) { log(`Error: ${e.message}`); } };

function use(kind, family, name = '') {
    if (preview) return;
    // A new controller of the same family can still change a label (a DualShock's Share where a DualSense has Create).
    const relabels = variantOf(family, name) !== variantOf(family, padName);
    padName = name;
    if (current.kind === kind && current.family === family && !relabels) return;
    current = family ? { kind, family } : { kind };
    log(`Lamp: playing with ${family ? (LAYOUTS[family] || {}).spoken || controllers.unknown : 'the ' + kind}.`);
    drawPrompts();
}

// Whose controller it is: the device's one layout where it has one, or else what the controller reports, its name as
// the browser gives it (with its USB vendor in Chrome's) or the vendor an app around the page sends with the pad. One
// from an app that doesn't send a vendor is taken as the base layout.
function familyOf(id) {
    if (device.layout) return device.layout;
    const found = controllers.layouts.find(layout => new RegExp(layout.match, 'i').test(id));
    return found ? found.id : 'other';
}
function vendorFamily(vendor) {
    if (device.layout) return device.layout;
    if (!vendor) return controllers.base;
    const found = controllers.layouts.find(layout => layout.vendors.includes(vendor));
    return found ? found.id : 'other';
}

if (!preview) {
    window.addEventListener('keydown', e => { if (e.isTrusted) use('keyboard'); }, { capture: true });
    window.addEventListener('pointerdown', e => {
        if (e.pointerType === 'touch' || e.pointerType === 'pen') use('touch'); else if (e.pointerType === 'mouse') use('keyboard');
    }, { capture: true, passive: true });
}

// What a prompt names each part of the pad by is the layout's (a part it leaves out is the base layout's): BUTTON.A
// is a place, the bottom face button, so a prompt names what's printed on the button in that place on the player's
// controller. The touch controls name their word buttons as these do.
const TOUCH_NAMES = { MENU: 'Menu', VIEW: 'View' };
// What the touch controls draw on a button whose name is a word.
const TOUCH_FACES = { [BUTTON.MENU]: '≡', [BUTTON.VIEW]: '⧉' };
const nameOf = what => typeof what === 'number' ? Object.keys(BUTTON).find(name => BUTTON[name] === what)
    : ({ [STICK.LEFT]: 'STICK_L', [STICK.RIGHT]: 'STICK_R', [TRIGGER.LT]: 'LT', [TRIGGER.RT]: 'RT' })[what];

// A key's name as it's printed on the key, from its code (KeyboardEvent.code): the device's own name for it, or a PC
// keyboard's.
function keyName(code) {
    const named = { Space: 'Space', Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Tab: 'Tab',
                    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'Shift', ShiftRight: 'Shift',
                    ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
                    MetaLeft: 'Win', MetaRight: 'Win', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/' };
    return (device.keys || {})[code] || named[code] || (/^(Key|Digit|Numpad)(.+)$/.exec(code) || [])[2] || code;
}

function keysFor(name) {
    if (name === 'STICK_L' || name === 'STICK_R') {
        const s = STICK_KEYS[name === 'STICK_L' ? 'left' : 'right'], at = name === 'STICK_L' ? leftStickHint : 0;
        return [s.up[at], s.left[at], s.down[at], s.right[at]];
    }
    if (name === 'LT' || name === 'RT') return [TRIGGER_KEYS[name.toLowerCase()][0]];
    const codes = KEYS[BUTTON[name]];
    return codes ? [codes[0]] : null;
}

// What to call a button (BUTTON.A…), a stick (STICK.LEFT) or a trigger (TRIGGER.RT) on the input the player is using
// (or the one given): "A", "✕", "Space", "W A S D" ("↑ ← ↓ →" with game()'s `keyboardHints`). A key's code ('KeyH'), for a page that reads keys itself, is that
// key's name whatever the input. null when the input has nothing for it (no key for a stick's click, no touch button
// the game didn't ask for), so the prompt is left out.
export function label(what, on = current) {
    const name = nameOf(what);
    if (!name) return typeof what === 'string' ? keyName(what) : null;
    if (on.kind === 'keyboard') { const codes = readsKeyboard ? keysFor(name) : null; return codes ? codes.map(keyName).join(' ') : null; }
    if (on.kind === 'touch') {
        if (!drawsTouch) return null;
        if (name === 'STICK_L') return BASE.names.STICK_L;
        if (name === 'STICK_R') return touchButtons & BUTTON.RSTICK ? BASE.names.STICK_R : null;
        const bit = BUTTON[name];
        return bit && bit < BUTTON.UP && (touchButtons & bit) ? TOUCH_NAMES[name] || BASE.names[name] : null;
    }
    const variant = variantOf(on.family, padName);
    return (variant && variant.names[name]) || ((LAYOUTS[on.family] || {}).names || {})[name] || BASE.names[name];
}

// A badge for a button, stick or trigger as the player's input draws it (an Xbox controller's colored round letters,
// a PlayStation controller's shapes, a key's keycap), sized to the text around it: a <span> to put in a prompt or
// a help screen, or null where `label` is.
export function glyph(what, on = current) {
    const text = label(what, on);
    if (text == null) return null;
    const name = nameOf(what), el = document.createElement('span');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', text);
    el.style.cssText = 'display:inline-flex;gap:.18em;vertical-align:middle;line-height:1;white-space:nowrap';
    const badge = (content, css) => {
        const b = document.createElement('span');
        b.textContent = content;
        b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;height:1.7em;min-width:1.7em;'
            + 'padding:0 .4em;font:700 .8em/1 -apple-system,system-ui,"Segoe UI",sans-serif;letter-spacing:0;' + css;
        el.append(b);
    };
    if (on.kind === 'keyboard' || !name) {
        // A key: a light keycap with its lower edge, one for each key a stick takes.
        for (const key of text.split(' ')) badge(key, 'border-radius:.35em;background:linear-gradient(#fdfdfe,#e3e4e8);color:#1d1d22;'
            + 'border:1px solid #a9abb3;border-bottom-width:.2em;box-shadow:0 1px 2px rgba(0,0,0,.35)' + (key.length > 1 ? ';padding:0 .55em' : ''));
        return el;
    }
    const dark = 'background:#18191d;color:#fff;border:.12em solid rgba(255,255,255,.28);box-shadow:0 1px 3px rgba(0,0,0,.45);';
    if (on.kind === 'touch') {
        const face = TOUCH_FACES[BUTTON[name]] || text;
        badge(name.startsWith('STICK') ? '' : face, 'border-radius:50%;background:rgba(255,255,255,.22);color:#fff;'
            + (name.startsWith('STICK') ? 'border:.12em solid rgba(255,255,255,.45)' : 'border:0'));
        return el;
    }
    const layout = LAYOUTS[on.family] || {};
    if (['A', 'B', 'X', 'Y'].includes(name)) {
        const colour = (layout.faces || {})[name] || '#fff';
        badge(text, dark + `border-radius:50%;padding:0;color:${colour};` + (layout.faceSize ? `font-size:${layout.faceSize}` : ''));
    } else if (name.startsWith('STICK')) {
        // A stick: a ring with its side's letter in it.
        badge(name === 'STICK_L' ? 'L' : 'R', dark + 'border-radius:50%;padding:0;box-shadow:inset 0 0 0 .2em #18191d,inset 0 0 0 .3em rgba(255,255,255,.35)');
    } else if (['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(name)) {
        badge(({ UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' })[name], dark + 'border-radius:.3em;padding:0');
    } else if (name === 'LT' || name === 'RT') {
        badge(text, dark + 'border-radius:.75em .75em .3em .3em');
    } else if (name === 'LB' || name === 'RB') {
        badge(text, dark + 'border-radius:.3em .3em .6em .6em');
    } else if ((layout.menuGlyphs || {})[name]) {
        badge(layout.menuGlyphs[name], dark + 'border-radius:50%;padding:0');
    } else {
        // Menu and View by their words (Options, Create, + and −), and a stick's click.
        badge(text, dark + 'border-radius:.85em;' + (text.length > 2 ? 'font-size:.62em;text-transform:uppercase;letter-spacing:.04em' : ''));
    }
    return el;
}

// MARK: A fixed step, for physics

// Physics (Rapier's world.step(), or the game's own) wants the same step every time, whatever the device's frame rate:
// a step that follows the frame bounces and tunnels differently at 30, 60 and 120 frames a second, and the preview's
// replay only matches the play when the steps do. fixedStep(step) gives a function to call once a frame with f.dt: it
// runs step() as many times as the time since the last frame holds, at 1/60 s each (`rate` a second), and at most `most`
// times, so a device that can't keep up slows the game down rather than falling further behind. It returns how far the
// frame is into the next step, 0 to 1, for a game that places what it draws between the last two steps (most needn't).
// In the preview every frame is exactly one step.
//
//   const physics = fixedStep(() => world.step(events));
//   frame(f) { steer(f.pads[0]); physics(f.dt); place(); renderer.render(scene, camera); }
export function fixedStep(step, { rate = 60, most = 4 } = {}) {
    const h = 1 / rate;
    let owed = 0;
    return dt => {
        owed += dt;
        let n = 0;
        // A hair under a whole step still counts as one, so a frame of 1/60 s is always one step of 1/60 s.
        while (owed >= h - 1e-9 && n < most) { step(h); owed -= h; n++; }
        if (n === most) owed = Math.min(owed, h);
        return Math.max(0, owed) / h;
    };
}

// MARK: The frame

let time = 0, number = 0;
const pads = [0, 1, 2, 3].map(() => ({ connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0, pressed: 0, released: 0 }));
let renderer = null, frameFunction = null, scripted = null, before = [0, 0, 0, 0], seenControllers = -1;

// Whether a controller is being played with now: a button down or a stick off its center.
const inUse = g => g.buttons.some(b => b && b.pressed) || g.axes.some(a => Math.abs(a) > 0.3);

function readPads() {
    const found = scripted ? [] : Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(g => g && g.connected);
    // The touch controls are there from the start, step aside once a controller is played with (a connected one alone
    // may only be the simulator passing the Mac's through), and come back when the screen is touched.
    const played = found.find(inUse);
    const nativeInUse = nativePad && (nativePad.down || [nativePad.lx, nativePad.ly, nativePad.rx, nativePad.ry, nativePad.lt, nativePad.rt].some(a => Math.abs(a) > 0.3));
    if (touchScreen && !scripted) {
        if (seenControllers === -1) showTouch();
        if (touchShown && (played || nativeInUse)) hideTouch();
    }
    // The controller played with is the input now (and in the preview it stays the keyboard).
    if (played) use('controller', familyOf(played.id), played.id);
    else if (nativeInUse) use('controller', vendorFamily(nativePad.vendor));
    if (!scripted && found.length !== seenControllers) { seenControllers = found.length; log(`Lamp: ${found.length} controller${found.length === 1 ? '' : 's'} connected.`); }
    for (let i = 0; i < 4; i++) {
        let pad = found[i] ? gamepadPad(found[i]) : { connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, down: 0 };
        if (i === 0) {
            if (scripted) pad = Object.assign({}, scripted);
            else {
                if (nativePad) merge(pad, nativePad);
                if (readsKeyboard) merge(pad, keyboardPad());
                merge(pad, Object.assign({}, touch, { down: touch.down | tapped }));
                tapped = 0;
            }
            pad.connected = true;
        }
        pad.pressed = pad.down & ~before[i];
        pad.released = before[i] & ~pad.down;
        before[i] = pad.down;
        pads[i] = pad;
    }
}

// Phones' buttons, as a frame reads them. Lamp.controllers hears a button between frames, so what a game does at the top
// of a frame can't lose it: what each button did is kept here until the next frame takes it, a press and release between
// two frames still counting as both. `onButton` goes on as it was, for what can't wait for a frame. Held buttons follow
// the phone at all times. Presses and releases not yet taken go with a phone that leaves, and with the run of the game's
// code that was playing: what arrives while the code runs again changes what's held and is never replayed as a press.
const phoneButtons = new Map();
function phoneButton(player, name, down) {
    let buttons = phoneButtons.get(player);
    if (!buttons) phoneButtons.set(player, buttons = newPhoneButtons());
    if (!!buttons.down[name] === down) return;
    if (down) buttons.down[name] = true; else delete buttons.down[name];
    if (!phonesWaiting) (down ? buttons.pressed : buttons.released)[name] = true;
}
// A button's name comes from the phone, so nothing here inherits one.
const newPhoneButtons = () => ({ down: Object.create(null), pressed: Object.create(null), released: Object.create(null) });
function forgetPhoneEdges() {
    for (const buttons of phoneButtons.values()) { buttons.pressed = Object.create(null); buttons.released = Object.create(null); }
}
function readPhones() {
    if (!window.Lamp || !window.Lamp.controllers) return [];
    const list = window.Lamp.controllers.players().map(player => {
        const buttons = phoneButtons.get(player) || newPhoneButtons();
        return { player, down: Object.assign(Object.create(null), buttons.down), pressed: buttons.pressed, released: buttons.released };
    });
    forgetPhoneEdges();
    return list;
}

// What the frame function returns is handed back: in the preview a promise from it (lamp-phaser.js's, while a scene
// loads) is waited for before the next frame.
function step(dt) {
    readPads();
    const phonesNow = readPhones();
    time += dt;
    const said = frameFunction({ dt, time, number, width: WIDTH, height: HEIGHT, pads, phones: phonesNow });
    number++;
    return said;
}

// MARK: The frame rate, measured on the device

// Every ten seconds of play the log says how fast frames really came, so the agent sees the device's own frame rate,
// not the preview's fixed 1/60 s. And when frames run slow the game is drawn smaller and scaled up to the screen, a
// step at a time: on whatever device it is, a scene that fills the screen with pixels is the usual cost, and fewer
// pixels the usual cure. A step that doesn't make frames faster is undone and no more are tried, since then the
// drawing isn't what's slow (a busy frame function, or a screen that refreshes only 30 times a second).
const SCALES = [1, 0.75, 0.5], SLOW = 45;
let level = 0, adapting = true, rateBefore = 0, lastTick = 0;
const report = { frames: 0, time: 0, slowest: 0 }, check = { times: [], time: 0, warm: false };

function drawScale(to) {
    level = to;
    check.warm = false;
    renderer.setSize(Math.round(WIDTH * SCALES[level]), Math.round(HEIGHT * SCALES[level]), false);
}
// A page that sizes its own canvas (`fill`) is drawn at whatever it chose.
let fills = false;
const drawn = () => fills ? `${renderer.domElement.width}x${renderer.domElement.height}`
    : `${Math.round(WIDTH * SCALES[level])}x${Math.round(HEIGHT * SCALES[level])}`;

function measure(now) {
    const ms = lastTick ? now - lastTick : 0;
    lastTick = now;
    // A page out of sight gets no frames: the gap is a pause, not a slow frame.
    if (!ms || ms > 1000) return;
    report.frames++; report.time += ms; report.slowest = Math.max(report.slowest, ms);
    if (report.time >= 10000) {
        log(`Lamp: ${Math.round(report.frames * 1000 / report.time)} frames a second (frames ${(report.time / report.frames).toFixed(1)} ms on average, slowest ${report.slowest.toFixed(1)} ms), drawn at ${drawn()}.`);
        report.frames = report.time = report.slowest = 0;
    }
    if (!adapting) return;
    check.times.push(ms); check.time += ms;
    // Two seconds a check, after a second left out as play starts and after each change of size, for the shaders
    // compiled, files read and buffers made then. The rate is the typical frame's, the median: one long hitch (a
    // window shown, a file read) isn't a device too slow to draw.
    if (check.time < (check.warm ? 2000 : 1000)) return;
    const sorted = check.times.sort((a, b) => a - b), rate = 1000 / sorted[sorted.length >> 1], warm = check.warm;
    check.times = []; check.time = 0; check.warm = true;
    if (!warm) return;
    if (rateBefore) {
        if (rate < rateBefore * 1.15) {
            drawScale(level - 1);
            adapting = false;
            log(`Lamp: drawing smaller didn't make frames faster (${Math.round(rateBefore)} a second, then ${Math.round(rate)}), so the game is drawn at ${drawn()} again.`);
            return;
        }
        rateBefore = 0;
    }
    if (rate < SLOW && level < SCALES.length - 1) {
        rateBefore = rate;
        drawScale(level + 1);
        log(`Lamp: frames were slow (${Math.round(rate)} a second), so the game is now drawn at ${drawn()} and scaled up to the screen.`);
    }
}

// Fits the canvas to the window at the console's shape, black around it.
function fit() {
    const canvas = renderer.domElement, scale = Math.min(innerWidth / WIDTH, innerHeight / HEIGHT);
    canvas.style.cssText = `position:fixed;left:${(innerWidth - WIDTH * scale) / 2}px;top:${(innerHeight - HEIGHT * scale) / 2}px;width:${WIDTH * scale}px;height:${HEIGHT * scale}px`;
}

// The game: `renderer` a three.js WebGLRenderer the runtime sizes and places, `init` run once (and waited for, so it may
// load files), `frame(f)` each frame with f.dt, f.time, f.number and f.pads (pads[0] the first controller: lx, ly, rx,
// ry -1 to 1 with up positive, lt and rt 0 to 1, buttons as BUTTON bits in down, pressed and released) and f.phones (one
// { player, down, pressed, released } for each phone joined through Lamp.controllers, buttons by the names the phone
// page gives them: `p.pressed.a` is true for the one frame after a press, even one let go again since). `touch` names
// the buttons the touch controls show (BUTTON.A | BUTTON.B | BUTTON.MENU unless given; BUTTON.RSTICK adds a right stick),
// or `false` for a page that draws touch controls of its own. `keyboard: false` is for a page that reads the keys itself:
// the keyboard then isn't the first pad as well, so a key isn't heard twice. The preview's script is the first pad either way.
// `keyboardHints: { leftStick: 'arrows' }` is for a game whose person asked for the arrow keys: label() and glyph() name
// them for the left stick instead of W A S D ('wasd', the default). It only chooses the name: both keep moving the stick.
// The renderer may be a WebGLRenderer or, from 'three/webgpu', a WebGPURenderer (initialized before game() is called). A 2D
// game calls phaser() from lamp-phaser.js instead, which calls this with Phaser's canvas.
// `sharp: true` keeps it drawn at 1920x1080 however slow frames are (the log still says how fast they come).
// `fill: true` is for a page laid out at the window's size, as a web page is (a strategy game whose HUD is the page's own
// HTML, made for phones as well as TVs): the page puts the canvas where it wants it and sizes it itself, drawing it
// smaller when frames run slow, and the runtime only measures and logs the frame rate.
// `snapshot`, `restore`, `busy`, `assetChanged` and `dispose` keep the player's place through a change Lamp makes while
// the game is played (see "Changes while it's played" below).
export async function game({ renderer: given, init, frame, touch: buttons, keyboard = true, keyboardHints, sharp = false, fill = false,
                             snapshot, restore, busy, assetChanged, dispose, flat = false }) {
    // The game's code run again in place for a change calls this again: the page, the frame loop's clock and whatever
    // the game kept stay, and the new init starts from where the player was.
    const again = runningAgain;
    if (again) again.called = true;
    const old = renderer;
    renderer = given;
    watchRender(renderer);
    fills = fill;
    adapting = !sharp && !fill;
    // Drawn at full size from here (setSize below), however small the code run before drew it.
    level = 0; rateBefore = 0; check.times = []; check.time = 0; check.warm = false;
    frameFunction = frame;
    hooks = { snapshot, restore, busy, assetChanged, dispose };
    flatGame = flat;
    asksPlace = false;
    // A renderer the new code didn't keep goes with the old code (its canvas went with the old page).
    if (again && old && old !== given && !isKept(old)) { try { old.dispose && old.dispose(); } catch (e) {} }
    if (buttons === false) drawsTouch = false;
    else if (buttons != null) touchButtons = buttons;
    readsKeyboard = keyboard !== false;
    // Set on every call, so code run again for a change that takes the hint away goes back to the default. Prompts drawn
    // before this call are drawn again.
    const hint = LEFT_STICK_HINTS[keyboardHints && keyboardHints.leftStick] ?? LEFT_STICK_HINTS.wasd;
    if (hint !== leftStickHint) { leftStickHint = hint; drawPrompts(); }
    if (!fill) {
        renderer.setPixelRatio(1);
        renderer.setSize(WIDTH, HEIGHT, false);
    }
    document.documentElement.style.background = document.body.style.background = '#000';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    // A game's page is played, not read: nothing on it is selected, magnified or called up by a long press.
    document.body.style.webkitUserSelect = document.body.style.userSelect = 'none';
    document.body.style.webkitTouchCallout = 'none';
    document.body.style.touchAction = 'none';
    if (!fill) {
        document.body.append(renderer.domElement);
        fit();
        if (!fitting) { fitting = true; listen(window, 'resize', fit); }
    }
    // Where the player was, if the page is opened again for a change: known before init, so the game starts there.
    if (again) { pending = { state: again.state && again.state.state, held: again.state && again.state.held, gen: again.change.gen }; reopened = true; taken = false; }
    else if (!preview) { await claim(); keepPage(); }
    // What the game registered takes its place before init reads it.
    if (pending && pending.held) {
        restoring = pending.held;
        if (!again) guarding = true;
        for (const entry of states.values()) settle(entry);
    }
    // In the preview a start-up that fails ends the play with what it said, rather than leaving Lamp waiting for frames.
    if (init) {
        try { await init({ width: WIDTH, height: HEIGHT }); } catch (e) {
            if (again) return ranAgainFailed(again, e);
            if (taken || guarding) return startFresh(e);
            log(`Error: ${e && e.message || e}`);
            if (preview) { window.webkit.messageHandlers.lampPreview.postMessage({ done: true, failed: String(e && e.message || e), logs }); return; }
            throw e;
        }
    }
    if (preview) { if (again) { ranAgain(again); firstDrawn(0); } return runPreview(); }
    // Whatever the start set on a camera, it's where the player left it at the first frame.
    if (restoring) for (const entry of cameras.values()) putPose(entry, restoring.cameras[entry.id]);
    await putBack();
    if (again) ranAgain(again);
    // The first frame of code run again has its shaders compiled before it's drawn (`watchRender`).
    if (again && renderer.__lampRender) warming = 'ask';
    // One loop at a time: the game's code run again starts a new one, and the old one stops at its next frame.
    const mine = ++loops;
    reopenedFrame = 0;
    let last = 0;
    const loop = now => {
        if (mine !== loops) return;
        // Its shaders compiling: the frame before stays on screen, and the game waits for them.
        if (warming && warming !== 'ask') { nextFrame(loop); return; }
        const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
        // How long the page took to build the game, which Lamp reads to know how long its preview's build may take.
        if (!last && mine === 1) log(`Lamp: the game was built and drawn ${(now / 1000).toFixed(1)} s after the page opened.`);
        last = now;
        measure(now);
        drewThisFrame = false;
        const began = clockNow();
        try { step(dt); } catch (e) {
            // New code swapped in or run again that fails as it runs goes back out the safe way: the page opens again
            // from where the player was before it.
            if (swapGuard) { log(`Error: ${e && e.message || e}`); return swapFailed(e); }
            throw e;
        }
        // The first frame drawn from a snapshot has gone without an error: from here an error is the game's own.
        guarding = false;
        // A frame that drew nothing through the renderer has nothing to compile.
        if (warming === 'ask') warming = null;
        const cost = clockNow() - began;
        frameCost = frameCost ? frameCost * 0.9 + cost * 0.1 : cost;
        if (reporting && !warming) firstDrawn(cost);
        shoot();
        // Opened again for a change: it's on screen with this first frame.
        if (shownFor != null && !curtain && !runningAgain && reopenedFrame++ > 0) { tellHost(shownFor, 'shown'); shownFor = null; }
        lift();
        live();
        nextFrame(loop);
    };
    nextFrame(loop);
}

// MARK: Changes while it's played
//
// Lamp changes the game while the person plays it, and puts each change into the running game when it can, so the
// world it built (the scene, the renderer, geometry, compiled shaders) and the player stay as they are. A game says
// what's to stay by registering it (see "What the game registers"):
//
// - Files the game loaded through the runtime (asset(), texture(), model(), sound.load()): the runtime puts a new copy
//   of what it loaded in itself, and then calls the game's `assetChanged(path)` for each changed file, which replaces
//   anything of the game's own made from it (a material from a shader's source, a clone of a model, a level read from
//   JSON) and returns true when it has.
// - A stylesheet the page links: the new one replaces it.
// - A module of the game's that takes its new versions: one that calls `hot(import.meta).accept()` (below). Its new
//   version runs, and what it exports is put into what the running game holds: each exported class gets the new
//   methods (so every object made from it, made before or after, runs the new code with its own fields kept), each
//   exported plain object the new functions and the values the change changed (its other values, which the game may
//   have changed as it ran, stay), and each exported array the new contents when the change changed them. A module that doesn't take its changes is swapped through the modules that import
//   it: when every one of them, or one above it, takes them, it runs again for them, and they take theirs.
//
// Anything else runs the game's code again in place, keeping the player's place, the page, the renderer and what the
// game kept (see "Running the game's code again" below): the HTML, a module nothing above takes changes for (the one
// that starts the game, as a rule), a class whose constructor or fields changed (objects already made have the old
// fields) or that has private members (#name), an exported function or value that changed (whoever imported it holds
// the old one), or code a module's exported functions may use, changed outside its classes. Where that can't be done
// (a change to the import map, modules that import each other in a circle) the page opens again. The log says which,
// and why. Just before, what the game registered is held, and a game from before registering has `snapshot()`, which
// gives what matters of where the game is (the level, the player's position, the camera, the score, the mode, which
// menu or overlay is open…) as plain JSON. That game's new code starts straight there: `pendingRestore()` gives that state while the game starts (in init, or in a Phaser scene's
// init or create), so the game builds the place it was in rather than its title or intro, and the runtime calls
// nothing more. A game that doesn't read it and has `restore(state)` is started as usual and then given the state,
// before its first frame is drawn. A game without either starts again, from its own save() and load(). If starting
// from the state throws (init, a scene's create, restore or the first frame), the game starts fresh, and the log says
// so. New code swapped in or run again that throws in its first second opens the page again from the place before.
// While `busy()` is true (a match or a round under way, a race, a fight) a change that runs the code again waits, and
// goes in at the next moment busy() is false (a pause, between rounds); the person can also put it in at once. A swap
// goes in at once, busy or not. Where the app around the page has no Reload of Lamp's own, the page shows a small
// "Reload to apply" to press.
// Wherever else the game is played (Android, the Xbox, a TV, a phone), a change reaches it when Lamp installs it there
// again: the runtime keeps the latest snapshot, and the new copy restores it once, when it opens.
//
// A module that takes its changes ends with
//
//   hot(import.meta).accept();
//
// and keeps its state in objects made from the classes it exports (the game holds them: `new Traffic(scene)`), with
// its tuning in constants or plain objects it reads where it uses them, rather than copied into fields as an object is
// made: what a constructor built or copied stays as it was until the code runs again. Everything a module defines
// that the game calls goes out through its exports, classes above all; a class it keeps to itself keeps its old
// methods. `accept(next, { changed })` takes a function, called once the new version is in, with its exports and the
// names of what changed in them (`Traffic.update`, `TUNING.topSpeed`); it does what the change needs done that the
// swap doesn't (build again what a changed method built once), and returns false to have the code run again
// instead. For what a module makes at its top level (a listener, an element, a timer), `hot(import.meta).dispose(data
// => …)` takes it away as the old version goes, keeping in `data` what the next needs, which reads it as
// `hot(import.meta).data`. Nothing here runs in Lamp's preview or where changes come by an install.

let hooks = {}, started = false, waiting = null, pill = null;
// The place this copy starts in (claim()), whether the game read it (pendingRestore()), and whether an error now means
// the state didn't take.
let pending = null, reopened = false, taken = false, guarding = false;
const host = () => window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.lampLive;
// Putting in what was built in the background says only its report: the change it's part of has said the rest.
const tellHost = (gen, state, why, more) => { if (runningAgain && runningAgain.change.quiet && state !== 'report') return; try { const h = host(); h && h.postMessage({ gen, state, ...(why ? { why } : {}), ...more }); } catch (e) {} };
// What a change of these is, is code: swapped in, or the page is opened again for it.
const CODE = /\.(m?js|html?|css)$/i;
// Each copy of the page names its build (lamp-build.js, written with lamp-device.js), so a snapshot is restored only by a
// newer build. A copy without one restores only what the page itself kept for its reopening.
let buildID = null;
const build = preview ? Promise.resolve(null) : import('./lamp-build.js').then(m => (buildID = m.default), () => null);
const LIVE = 'lamp.live', LAST = 'lamp.live.last';
const store = kind => { try { return kind === 'session' ? sessionStorage : localStorage; } catch (e) { return null; } };

// Where the game is: `state` what its snapshot() gave, `held` what it registered (`heldNow`); null when it has neither.
function takeSnapshot() {
    const held = heldNow();
    let state = null;
    try {
        const given = hooks.snapshot ? hooks.snapshot() : undefined;
        if (given !== undefined) state = JSON.parse(JSON.stringify(given));
    } catch (e) { log(`Lamp: snapshot() failed (${e && e.message || e}).`); }
    return state == null && !held ? null : { state, held };
}

function isBusy() {
    try { return !!(hooks.busy && hooks.busy()); } catch (e) { return false; }
}

// Lamp's app around the page hands it a change: `changed` the files changed, `gen` its number, `now` when the person
// pressed Reload, `pill` when the page is to show its own Reload. Returns true: the page takes changes. One change is
// put in at a time, so one arriving during a swap waits for it.
let queue = Promise.resolve();
window.__lampLive = change => {
    if (preview) return false;
    changes = Math.max(changes + 1, change.gen || 0);
    queue = queue.then(() => {
        // What the code run again couldn't take in goes in as the page opens again, at Reload.
        if (waiting && waiting.reopens && change.now) { waiting = null; return reopen(change); }
        // A file taken away while a change waits, and made again since, is a changed file like any other.
        if (waiting) change = { ...change, changed: [...new Set([...waiting.changed, ...change.changed])],
            removed: [...new Set([...(waiting.removed || []).filter(p => !change.changed.includes(p)), ...(change.removed || [])])] };
        waiting = null;
        return apply(change);
    }).catch(e => log(`Lamp: ${e && e.message || e}`));
    return true;
};

// The app menu's Reload with no change waiting: the game opens again from its files, every part of it built afresh, with
// the player where they were.
// After any change being put in (one at a time, `queue`), with the place a rerun under way kept for itself, never one
// taken from a game it has half started again.
window.__lampReloadNow = () => {
    if (preview) return false;
    const held = runningAgain && runningAgain.state;
    queue = queue.then(() => reopen({ gen: changes, why: 'Reload' }, held || takeSnapshot()))
        .catch(e => log(`Lamp: ${e && e.message || e}`));
    return true;
};

async function apply(change) {
    let paths = (change.changed || []).map(clean);
    // Not started yet: nothing to keep.
    if (!started) { tellHost(change.gen, 'reloading'); location.reload(); return; }
    // Where the player is before anything is swapped, for the page to open from should the swap not take.
    const before = takeSnapshot(), roster = phonesHere(), began = performance.now();
    // Files taken away that the running game has no use for are no part of the change. With nothing else in it there's
    // nothing to put in, and the game goes on as it was.
    const unused = await unusedFiles(change, paths);
    if (unused.length) {
        for (const path of unused) texts.delete(path);
        paths = paths.filter(p => !unused.includes(p));
        change = { ...change, changed: paths };
        log(`Lamp: ${unused.join(', ')} ${unused.length === 1 ? 'was' : 'were'} taken away, and the running game has no use for ${unused.length === 1 ? 'it' : 'them'}.`);
        if (!paths.length) { hidePill(); tellHost(change.gen, 'swapped'); return; }
    }
    const said = [];
    let why = paths.length ? null : 'nothing to put in', touched = false;
    // A part declared as built from a changed file is built again, with everything else kept: a swap would leave it as
    // it was built.
    if (paths.some(p => /\.m?js$/i.test(p)) && [...kept.values()].some(k => k.from.length)) {
        try { await readModules(paths.filter(p => /\.m?js$/i.test(p))); } catch (e) {}
    }
    const own = builtFrom(paths);
    if (own) why = `${own.path} changed, which ${own.key} is built from`;
    for (const path of why ? [] : paths.filter(p => !CODE.test(p))) {
        let done = false;
        for (const swap of swaps.get(path) || []) { try { await swap(); done = true; } catch (e) { log(`Lamp: couldn't put in the new ${path} (${e && e.message || e}).`); } }
        if (hooks.assetChanged) { try { if (await hooks.assetChanged(path)) done = true; } catch (e) { log(`Error: assetChanged('${path}'): ${e && e.message || e}`); } }
        if (done) said.push(path);
        else why = why || (loaded.has(path) ? `${path} changed, and nothing in the running game takes the new one in`
            : `nothing the game loaded through lamp-game.js is made from ${path}`);
    }
    const code = paths.filter(p => CODE.test(p));
    if (!why && code.length) {
        const swapped = await swapCode(code);
        if (swapped.why) { why = swapped.why; touched = swapped.touched; } else said.push(...swapped.said);
    }
    if (!why) {
        log(`Lamp: put in ${said.join('; ')} while the game ran (${Math.round(performance.now() - began)} ms).`);
        if (code.length) { swapGuard = { until: time + 1, change, state: before }; markStale(code); }
        tellHost(change.gen, 'swapped');
        return;
    }
    change = { ...change, why, put: said };
    // A run that would start the game over waits for the person: only they can say the place is worth losing.
    if (!keepsPlace() && !change.now && !touched) {
        const unkept = unregistered();
        log(`Lamp: a change that runs the game's code again would start play over, since the game hasn't registered ${unkept.join(', ')}.`);
        return reopenOrHold({ ...change, why: `${why}; that would start play over, since the game hasn't registered ${unkept.join(', ')}` }, undefined);
    }
    // Half swapped is no place to wait in: the code runs again now, from where the player was before.
    if (isBusy() && !change.now && !touched) {
        waiting = change;
        log(`Lamp: a change that needs the game's code run again (${why}) waits for a pause in the game.`);
        tellHost(change.gen, 'held', why, { pause: true });
        if (change.pill) showPill();
        return;
    }
    return startAgain(touched ? { ...change, touched } : change, touched ? before : undefined, touched ? roster : undefined);
}

// A change that can't be swapped in: the game's code runs again in place, keeping the page, the renderer and what the
// game kept, or, where that can't be done, the page opens again. Either way from `state`, where the player was, and
// `roster`, the phones joined as it was taken: the new run hears of any who left since, whose place `state` still has.
function startAgain(change, state = takeSnapshot(), roster = phonesHere()) {
    const why = canRunAgain(change);
    if (why) return reopenOrHold({ ...change, why: `${change.why}; ${why}` }, state);
    return runAgain(change, state, roster);
}

// A change that needs the page opened again is held for the person's Reload, never opened under them: the app and the
// chat show Reload (`held`), and it goes in when they press it (`now`). The code run again in place goes in by itself.
// Lamp's preview, which nobody watches, opens a new page instead.
// A swap that already changed the running game (its old version's disposers run, its exports put in) leaves nothing safe
// to wait in: that opens the page again at once, from where the player was before it.
function reopenOrHold(change, state) {
    if (change.now || change.touched || preview) return reopen(change, state);
    waiting = { ...change, hard: true };
    log(`Lamp: a change that needs the game opened again (${change.why}) waits for Reload.`);
    tellHost(change.gen, 'held', change.why);
    if (change.pill) showPill();
}

// Opens the page again with the new code, with the player's place kept for the new code to restore: where it is now, or
// `state` taken before a swap that didn't take.
function reopen(change, snap = takeSnapshot()) {
    // A warm preview can't open its page again with a new play: Lamp starts it cold instead.
    if (preview) { window.webkit.messageHandlers.lampPreview.postMessage({ done: true, again: false, logs }); return; }
    hidePill();
    try { store('session').setItem(LIVE, JSON.stringify({ ...snap, input: current, padName, gen: change.gen })); } catch (e) {}
    const why = change.why ? ` (${change.why})` : '';
    log(snap == null ? `Lamp: opening the game again for a change of its code${why}; it has no snapshot(), so it starts from its own saves.`
        : `Lamp: opening the game again for a change of its code${why}, keeping where the player was.`);
    tellHost(change.gen, 'reloading', change.why);
    location.reload();
}

// Each frame: a waiting change goes in once the game isn't busy; the latest snapshot is kept for the next install.
let keptAt = 0;
function live() {
    if (swapGuard && time > swapGuard.until) swapGuard = null;
    if (swapWaits && !isBusy() && !runningAgain) { swapWaits = false; swapIn(); }
    if (waiting && !waiting.hard && !isBusy()) { const change = waiting; waiting = null; queue = queue.then(() => startAgain(change)).catch(e => log(`Lamp: ${e && e.message || e}`)); }
    if ((hooks.snapshot || cameras.size || states.size) && time - keptAt >= 5) { keptAt = time; keepLast(); }
}

// MARK: Swapping code in
//
// What the runtime knows of the game's modules: each that called hot(), by its path beside the page, with every version
// of it that has run (its exports, and the values of its plain objects as each version made them, to tell what a
// change changed from what the game changed as it ran), its source as the last version ran, and the address its
// latest version was loaded from, which a module loaded afresh imports it by.
const modules = new Map(), latest = new Map(), loading = new Set();
// The swap that went in last, watched for its first second: an error in it opens the page again.
let swapGuard = null, versionCount = 0;
// Where the page's files are, read when first needed: a copy of the runtime run outside a page has no URL.
let base = null;
const pageBase = () => base || (base = new URL('.', location.href));
const pathOf = url => {
    try {
        const u = new URL(url, location.href), b = pageBase();
        if (u.protocol !== b.protocol || u.host !== b.host || !u.pathname.startsWith(b.pathname)) return null;
        return decodeURIComponent(u.pathname.slice(b.pathname.length));
    } catch (e) { return null; }
};
const addressOf = path => new URL(path, pageBase()).href;
const source = f => Function.prototype.toString.call(f);
const isClass = v => typeof v === 'function' && /^class\b/.test(source(v));
const isPlain = v => !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const valueText = v => { try { return typeof v === 'function' ? 'function ' + source(v) : JSON.stringify(v) ?? String(v); } catch (e) { return String(v); } };
// Code as it reads with its comments and spacing gone, so a comment added beside a method changes nothing.
const bare = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '').replace(/\s+/g, '');

// A module's handle on its changes while the game is played (see "Changes while it's played" above): `accept()` takes
// them, `dispose(fn)` takes away what this version made as it goes, `data` is what the last version's disposers kept,
// `keep(key, build, { inputs, from, background })` a part of the game kept when its code runs again (see "Running the game's code
// again" and "Building in the background"), and
// `renderer(build)`, `camera(id, build)` and `state(id, { version, start })` what the runtime keeps for the game (see
// "What the game registers").
export function hot(meta) {
    const path = pathOf(meta && meta.url);
    // A page that takes no changes still restores what's registered when a newer install opens it.
    const quiet = { data: {}, accept() {}, dispose() {}, renderer: build => build(), camera, state,
                    keep(key, build, options) { const v = build(); return options && options.background && isSteps(v) ? stepThrough(v) : v; } };
    if ((preview && !preview.warm) || path == null || (!preview && !host())) return quiet;
    let entry = modules.get(path);
    if (!entry) modules.set(path, entry = { path, accepts: false, onAccept: null, disposers: [], data: {}, versions: [], text: null });
    // Each version says for itself whether it takes the next, and what to take away when it goes.
    entry.accepts = false;
    entry.onAccept = null;
    entry.disposers = [];
    if (!loading.has(path) && !entry.versions.length) {
        // The version the page loaded first, which every module that imported it holds: known once it has run.
        import(meta.url).then(ns => { if (!entry.versions.length) entry.versions.push(versionOf(ns)); }, () => {});
        fetch(meta.url, { cache: 'no-store' }).then(a => a.ok ? a.text() : null).then(t => { if (entry.text == null) entry.text = t; }, () => {});
    }
    return {
        data: entry.data,
        accept(callback) { entry.accepts = true; entry.onAccept = typeof callback === 'function' ? callback : null; },
        dispose(callback) { if (typeof callback === 'function') entry.disposers.push(callback); },
        keep(key, build, options) { return keep(path, key, build, options); },
        renderer(build) { return keep('', 'renderer', build, { lasting: true }); },
        camera, state,
    };
}

function versionOf(ns) {
    const made = {};
    for (const name of Object.keys(ns)) {
        if (Array.isArray(ns[name])) made[name] = valueText(ns[name]);
        if (!isPlain(ns[name])) continue;
        made[name] = {};
        for (const key of Object.keys(ns[name])) made[name][key] = valueText(ns[name][key]);
    }
    return { ns, made };
}

// The game's modules, read from the page: what each imports (static imports, re-exports and import() of a written-out
// path), so a change can go up to the modules that take it. Kept between changes, and read again for what changed.
const imports = new Map(), texts = new Map();
const SPECIFIER = /(\bimport\s*\(\s*|\bfrom\s*|\bimport\s+)(['"])([^'"\n]+)\2/g;
// Lamp's own files beside the page never change with the game, and three.js is large: they aren't read.
const lampOwn = path => /^(three|rapier|phaser)\//.test(path) || /^lamp(-[\w-]+)?\.js$/.test(path);
let importMap = null;
function resolve(specifier, from) {
    if (/^\.{0,2}\//.test(specifier)) return new URL(specifier, from).href;
    if (/^[a-z][\w+.-]*:/i.test(specifier)) return specifier;
    if (!importMap) {
        importMap = {};
        for (const s of document.querySelectorAll('script[type="importmap"]')) { try { Object.assign(importMap, JSON.parse(s.textContent).imports || {}); } catch (e) {} }
    }
    if (importMap[specifier]) return new URL(importMap[specifier], location.href).href;
    const prefix = Object.keys(importMap).filter(k => k.endsWith('/') && specifier.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return prefix ? new URL(importMap[prefix] + specifier.slice(prefix.length), location.href).href : null;
}
// A specifier nothing resolves (a bare name the import map doesn't have) names no file of the game's.
const importsIn = (text, from) => [...text.matchAll(SPECIFIER)].map(m => resolve(m[3], from)).filter(Boolean).map(pathOf)
    .filter(p => p != null && !lampOwn(p));
// The names a module's imports give it, each with the module it comes from: `a`, `b` and `ns` in
// `import a, { x as b } from './m.js'` and `import * as ns from './n.js'`.
const BINDINGS = /\bimport\s+([\w$*{}\s,]+?)\s+from\s*(['"])([^'"\n]+)\2/g;
const bindings = new Map();
function bindingsIn(text, from) {
    const names = new Map();
    for (const m of text.matchAll(BINDINGS)) {
        const target = resolve(m[3], from), path = target && pathOf(target);
        if (path == null || lampOwn(path)) continue;
        const clause = m[1].replace(/\*\s*as\s+/, '').replace(/[{}]/g, ',');
        for (const part of clause.split(',')) { const name = part.trim().split(/\s+as\s+/).pop(); if (name) names.set(name, path); }
    }
    return names;
}

async function readText(path) {
    const answer = await fetch(`${addressOf(path)}?lamp=${changes}`, { cache: 'no-store' });
    if (!answer.ok) throw new Error(`${path} couldn't be read`);
    return answer.text();
}

// `page` is the document whose module scripts start the game: the running page, or the page's HTML as it is now when
// the game's code runs again. The page's own scripts (inline) are kept by name in `inline`.
let rootPaths = [];
const inline = new Map();
async function readModules(changed, page = document) {
    for (const path of changed) imports.delete(path);
    const roots = [];
    for (const s of page.querySelectorAll('script[type="module"]')) {
        const src = s.getAttribute('src');
        const path = src ? pathOf(new URL(src, location.href).href) : `the page's own script ${roots.length + 1}`;
        if (path == null) continue;
        if (!src) { imports.set(path, importsIn(s.textContent, location.href)); bindings.set(path, bindingsIn(s.textContent, location.href)); inline.set(path, s.textContent); }
        roots.push(path);
    }
    rootPaths = roots;
    const unread = () => [...new Set([...roots, ...[...imports.values()].flat()])].filter(p => !imports.has(p));
    let next = unread();
    while (next.length) {
        await Promise.all(next.map(async path => {
            const text = await readText(path).catch(() => '');
            if (changed.includes(path)) texts.set(path, text);
            imports.set(path, importsIn(text, addressOf(path)));
            bindings.set(path, bindingsIn(text, addressOf(path)));
        }));
        next = unread();
    }
    return roots;
}

// Whether `text` names a file: by its whole name, so `world.js` doesn't name `orld.js`. Only a name: a comment naming the
// file counts, and two files of one name in different folders count as each other, which errs toward saying a file is used.
function names(text, path) {
    const name = path.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w$.-])${name}($|[^\\w$-])`).test(text);
}

// What of a change's files taken away the running game clearly has no use for: nothing it runs imports them, it never read
// them, no part is built from them, and neither its code, its page nor its stylesheets name them. Anything else (a
// worker it started, data it fetched, a module it imports, a name in a comment) is left in the change, which goes on to
// say honestly what came of it. With a worker started, what's read is only partly known, so no file is known to be
// unused, and a page that can't be read says the same. Not for the person's Reload, which puts everything in.
async function unusedFiles(change, paths) {
    const removed = (change.removed || []).map(clean).filter(p => paths.includes(p));
    if (!removed.length || change.now || workerStarted) return [];
    try {
        if (removed.includes(pagePath())) return [];
        const html = await readText(pagePath()), parsed = parse(html);
        await readModules(paths.filter(p => /\.m?js$/i.test(p)), parsed);
        const styles = [...parsed.querySelectorAll('link[rel~="stylesheet"]')].map(l => pathOf(new URL(l.getAttribute('href'), location.href).href));
        const asked = removed.filter(p => !lampOwn(p) && !imports.has(p) && !loaded.has(p) && !everRead.has(p) && !swaps.has(p) && !builtFrom([p]));
        const sources = [html];
        for (const path of [...imports.keys(), ...styles]) {
            if (path == null || lampOwn(path) || removed.includes(path)) continue;
            sources.push(texts.get(path) ?? inline.get(path) ?? await readText(path));
        }
        return asked.filter(p => !sources.some(text => names(text, p)));
    } catch (e) { return []; }
}

// Puts changed modules and stylesheets into the running game: { said } what went in, or { why } it couldn't, with
// `touched` when something was already taken away or swapped, so the page must open again now.
async function swapCode(paths) {
    const html = paths.find(p => /\.html?$/i.test(p));
    if (html) return { why: `${html} changed` };
    const code = paths.filter(p => /\.m?js$/i.test(p)), styles = paths.filter(p => /\.css$/i.test(p));
    const said = [];
    if (code.length) {
        const swapped = await swapModules(code);
        if (swapped.why) return swapped;
        said.push(...swapped.said);
    }
    for (const path of styles) {
        const links = [...document.querySelectorAll('link[rel~="stylesheet"]')].filter(l => pathOf(l.href) === path);
        if (!links.length) return { why: `no link in the page loads ${path}`, touched: said.length > 0 };
        try {
            await Promise.all(links.map(old => new Promise((done, failed) => {
                const next = old.cloneNode();
                next.href = `${addressOf(path)}?lamp=${++versionCount}`;
                next.onload = () => { old.remove(); done(); };
                next.onerror = () => { next.remove(); failed(new Error(`${path} didn't load`)); };
                old.after(next);
            })));
        } catch (e) { return { why: e.message, touched: said.length > 0 }; }
        said.push(path);
    }
    return { said };
}

async function swapModules(changed) {
    const roots = await readModules(changed);
    const importers = new Map();
    for (const [path, deps] of imports) for (const dep of deps) importers.set(dep, [...(importers.get(dep) || []), path]);
    const takes = path => { const m = modules.get(path); return !!(m && m.accepts && m.versions.length && m.text != null); };
    // Every module the change runs again, up to those that take it (the boundaries).
    const again = new Set(), boundaries = new Set();
    const up = path => {
        if (again.has(path)) return null;
        again.add(path);
        if (takes(path)) { boundaries.add(path); return null; }
        const by = importers.get(path) || [];
        if (!by.length) return roots.includes(path) ? `${path} doesn't take changes while the game runs` : `nothing imports ${path}`;
        for (const above of by) { const why = up(above); if (why) return why; }
        return null;
    };
    for (const path of changed) {
        if (lampOwn(path)) return { why: `Lamp's own ${path} changed` };
        if (!imports.has(path)) return { why: `nothing imports ${path}` };
        const why = up(path);
        if (why) return { why };
    }
    // Run again in order, what each imports before it.
    const order = [], seen = new Map();
    const visit = path => {
        if (seen.get(path) === 2) return true;
        if (seen.get(path) === 1) return false;
        seen.set(path, 1);
        for (const dep of imports.get(path) || []) if (again.has(dep) && !visit(dep)) return false;
        seen.set(path, 2);
        order.push(path);
        return true;
    };
    for (const path of again) if (!visit(path)) return { why: `${path} is in a circle of modules that import each other` };

    // What the old versions made at their top level goes before the new ones run, as each asked.
    let touched = false;
    redeclared = null;
    for (const path of order) {
        const m = modules.get(path);
        for (const dispose of m ? m.disposers : []) {
            touched = true;
            try { await dispose(m.data); } catch (e) { log(`Error: dispose in ${path}: ${e && e.message || e}`); }
        }
    }
    // The new versions, each importing the others' new versions and the rest of the game as it runs: a module none of
    // whose imports changed is loaded from its own address, with a new query; one that imports another that runs again
    // is loaded from its source with those imports pointed at the new versions.
    // Each new version's exports as it made them, read before any of the game's values are put into them.
    const loaded = new Map(), addresses = new Map(), made = new Map();
    for (const path of order) {
        const address = `${addressOf(path)}?lamp=${++versionCount}`;
        const deps = imports.get(path) || [];
        loading.add(path);
        try {
            const text = texts.get(path) ?? await readText(path);
            texts.set(path, text);
            let from = address;
            if (deps.some(d => again.has(d) || latest.has(d))) {
                const written = text.replace(SPECIFIER, (all, lead, quote, specifier) => {
                    const target = resolve(specifier, addressOf(path));
                    const p = target && pathOf(target);
                    if (!target) return all;
                    return lead + quote + (p != null && addresses.has(p) ? addresses.get(p) : p != null && latest.has(p) ? latest.get(p) : target) + quote;
                }).replace(/\bimport\.meta\b/g, `({ url: ${JSON.stringify(address)}, resolve: s => new URL(s, ${JSON.stringify(address)}).href })`);
                from = URL.createObjectURL(new Blob([written], { type: 'text/javascript' }));
            }
            loaded.set(path, await import(from));
            // The new version's top level has run (listeners, elements): from here a refusal opens the page again at once.
            touched = true;
            made.set(path, versionOf(loaded.get(path)));
            addresses.set(path, from);
        } catch (e) {
            return { why: `${path} didn't load (${e && e.message || e})`, touched: true };
        } finally { loading.delete(path); }
    }
    if (redeclared) return { why: `the declaration of ${redeclared} changed`, touched };
    // Each boundary's new exports must fit what the game holds of the old ones.
    for (const path of boundaries) {
        const rerun = (imports.get(path) || []).find(d => again.has(d));
        const why = fits(modules.get(path), loaded.get(path), texts.get(path), path, rerun);
        if (why) return { why, touched };
    }
    const said = [];
    for (const path of boundaries) {
        const m = modules.get(path), ns = loaded.get(path);
        const changedNames = putIn(m, ns);
        m.versions.push(made.get(path));
        m.text = texts.get(path);
        if (m.onAccept) {
            try {
                if (await m.onAccept(ns, { changed: changedNames }) === false) return { why: `${path} asked for the page to be opened again`, touched: true };
            } catch (e) { return { why: `accept in ${path} failed (${e && e.message || e})`, touched: true }; }
        }
        said.push(changedNames.length ? `${path} (${changedNames.slice(0, 8).join(', ')}${changedNames.length > 8 ? '…' : ''})` : path);
    }
    for (const path of order) {
        latest.set(path, addresses.get(path));
        const m = modules.get(path);
        if (m && !boundaries.has(path)) { m.versions.push(made.get(path)); m.text = texts.get(path); }
        if (!boundaries.has(path)) said.push(`${path}, run again for the modules that import it`);
    }
    for (const path of changed) texts.delete(path);
    return { said };
}

// Why the new exports can't be put into the old, or null when they can.
function fits(m, ns, text, path, rerun) {
    const last = m.versions[m.versions.length - 1].ns;
    let holdsCode = false;
    for (const name of Object.keys(ns)) {
        const now = ns[name], was = last[name];
        // A new export: nothing holds an old one.
        if (was === undefined) continue;
        if (isClass(now) || isClass(was)) {
            if (!isClass(now) || !isClass(was)) return `${name} in ${path} is a class in one version and not the other`;
            if (shell(was) !== shell(now)) return `the constructor or fields of ${name} in ${path} changed`;
            // An object's private members belong to the class that made it: a method of a new version can't read them.
            if (PRIVATE.test(source(now))) return `${name} in ${path} has private members (#name), which a new version's methods can't reach`;
        } else if (typeof now === 'function' || typeof was === 'function') {
            if (typeof now !== 'function' || typeof was !== 'function' || source(now) !== source(was)) return `${path} exports the function ${name}, which changed`;
            holdsCode = true;
        } else if ((isPlain(now) && isPlain(was)) || (Array.isArray(now) && Array.isArray(was))) {
            continue;
        } else if (valueText(now) !== valueText(was)) {
            return `${path} exports ${name}, whose value changed`;
        } else if (now && typeof now === 'object') holdsCode = true;
    }
    if (holdsCode && rerun) return `${path} exports functions, which go on using the old ${rerun}`;
    if (holdsCode && outside(m.text, last) !== outside(text, ns)) return `code outside the classes in ${path} changed, which what it exports may use`;
    return null;
}

// A use of a private member: `this.#speed`, `#speed in other`.
const PRIVATE = /\.\s*#[A-Za-z_$]|#[A-Za-z_$][\w$]*\s+in\b/;

// A class as it reads without its methods, accessors and static methods: its constructor, fields and what it extends.
function shell(C) {
    let text = source(C);
    for (const [from, skip] of [[C.prototype, ['constructor']], [C, ['length', 'name', 'prototype']]]) {
        for (const key of Reflect.ownKeys(from)) {
            if (skip.includes(key)) continue;
            const d = Object.getOwnPropertyDescriptor(from, key);
            for (const f of [d.value, d.get, d.set]) if (typeof f === 'function') { const s = source(f), i = text.indexOf(s); if (i >= 0) text = text.slice(0, i) + text.slice(i + s.length); }
        }
    }
    return bare(text);
}

// A module's source without its exported classes.
function outside(text, ns) {
    for (const value of Object.values(ns)) if (isClass(value)) { const s = source(value), i = text.indexOf(s); if (i >= 0) text = text.slice(0, i) + text.slice(i + s.length); }
    return bare(text);
}

// Puts a new version's exports into every earlier version's, which the game holds; returns what changed.
function putIn(m, ns) {
    const changed = new Set(), last = m.versions[m.versions.length - 1];
    for (const name of Object.keys(ns)) {
        const now = ns[name];
        const earlier = [...new Set(m.versions.map(v => v.ns[name]))].filter(v => v !== undefined && v !== now);
        if (isClass(now)) {
            for (const C of earlier) for (const key of putClass(C, now)) changed.add(`${name}.${key}`);
            // An object made by either version is an instance of both.
            const family = [...earlier, now];
            // A subclass inherits this static: it answers for its own class alone.
            function has(o) { return (family.includes(this) ? family : [this]).some(K => Function.prototype[Symbol.hasInstance].call(K, o)); }
            for (const K of family) Object.defineProperty(K, Symbol.hasInstance, { value: has, configurable: true });
        } else if (Array.isArray(now)) {
            // An array is taken whole: the change's new one when it changed it, else the one the game has.
            const held = earlier[earlier.length - 1];
            if (valueText(now) !== last.made[name] || !Array.isArray(held)) {
                changed.add(name);
                for (const A of earlier) if (Array.isArray(A)) A.splice(0, A.length, ...now);
            } else now.splice(0, now.length, ...held);
        } else if (isPlain(now)) {
            const before = last.made[name] || {}, held = earlier[earlier.length - 1];
            for (const key of Object.keys(now)) {
                const fresh = valueText(now[key]);
                if (fresh !== before[key]) changed.add(`${name}.${key}`);
                // What the change changed goes in; what it didn't keeps what the game made of it, in both copies.
                if (fresh !== before[key] || typeof now[key] === 'function' || !held || !(key in held)) for (const O of earlier) O[key] = now[key];
                else now[key] = held[key];
            }
        }
    }
    return [...changed];
}

function putClass(C, N) {
    const changed = [];
    const code = d => d ? [d.value, d.get, d.set].filter(f => typeof f === 'function').map(source).join('\n') : '';
    for (const [from, to, skip] of [[N.prototype, C.prototype, ['constructor']], [N, C, ['length', 'name', 'prototype', Symbol.hasInstance]]]) {
        // A method the new version no longer has goes, so an old object falls back to what it inherits, as a new one does.
        for (const key of Reflect.ownKeys(to)) {
            if (skip.includes(key) || Object.prototype.hasOwnProperty.call(from, key)) continue;
            const d = Object.getOwnPropertyDescriptor(to, key);
            if (!d.get && !d.set && typeof d.value !== 'function') continue;
            delete to[key];
            changed.push(String(key));
        }
        for (const key of Reflect.ownKeys(from)) {
            if (skip.includes(key)) continue;
            const d = Object.getOwnPropertyDescriptor(from, key);
            if (!d.get && !d.set && typeof d.value !== 'function') continue;
            if (code(Object.getOwnPropertyDescriptor(to, key)) !== code(d)) changed.push(String(key));
            Object.defineProperty(to, key, d);
        }
    }
    return changed;
}

// MARK: Running the game's code again
//
// A change that can't be swapped in (the HTML, the module that starts the game, a class whose fields changed, an
// exported function) runs the game's code again in place, as a page opened again would but without opening it: the old
// code's frame loop stops, its `dispose` and the modules' disposers run, and what it left running is taken away (see
// below); the page's HTML is put back as the new version has it (Lamp's own elements stay), every module of the game
// runs again in order (loaded from its source with its imports pointed at the new versions, as a swap loads one), and
// the module that starts the game calls game() again, whose init starts from the snapshot taken before (read with
// pendingRestore(), or given to restore()). What stays is what a reload loses: the WebGL or WebGPU context and the
// shaders compiled for it, the files the runtime loaded, the sound, the controllers, the phones that joined, and every
// part the game kept.
//
// A part is kept with `hot(import.meta).keep(key, build, { inputs, from, dispose, background })`: the first time it calls build()
// and returns what that made (or its promise), and when the code runs again it returns the same thing without building
// it, unless the module that kept it, or one it imports, changed since, the build function's own code changed, or one
// of `inputs` isn't the same as before (another part's result it's built from, as a dependency list goes), or a file
// it read as it was built (loaded through the runtime, asset(), texture(), model(), sound.load(), or fetched) changed.
// The module that starts the game imports everything and changes often, so what it keeps goes by the modules whose
// imports the build function names, and theirs: a change of its own code outside the build function keeps what it kept.
// `from` declares what the part is built from beyond that: files beside the page, a module meaning it and what it
// imports, a path ending in / a folder (`from: ['js/map-data.js', 'data/streets/']`). A change to one builds the part
// again in place even where its module would take the change by a swap, since a swap leaves what was built as it was,
// and the parts made from it (their `inputs`) with it; everything else stays, and so does the player's place. A part
// that's built again, or not asked for any more, goes: `dispose(value)` when given, else a three.js object (or each in a
// plain object, as { group }) is taken out of its scene and its geometry and materials let go, and anything else with
// dispose() or destroy() has it called. A part that's slow to build says `background: true`, and the game plays on
// while it's built again (see "Building in the background").
//
//   const renderer = await hot(import.meta).keep('renderer', async () => { const r = new THREE.WebGPURenderer(); await r.init(); return r; });
//   const blocks = live.keep('blocks', () => buildBlocks(landmarks.colliders), { inputs: [landmarks] });
//   const paint = live.keep('roadPaint', () => buildRoadPaint(streets.network), { inputs: [streets], from: ['js/map-data.js'] });
//
// After a run, Lamp is told what was built again (each part, how long it took and why) and what of the change nothing
// read again (a file the game uses whose part was kept, or that its code read once at the start): that waits for the
// person's Reload, which opens the page again, and Lamp's chat says so rather than that it's in. The first frame of the
// new code has its shaders compiled before it's drawn, with the last frame held on screen, and the report says how long
// the game stood still for the change, from the old code's last frame to the new code's first.
//
// What the game's code leaves running is watched from the start: listeners it adds (to the window, the document or
// anything else), timers, sound contexts it makes itself and workers. Each is taken away when the code runs again,
// unless a part kept it (made while a keep's build ran). A module's own state starts again with it, as on a reload.
// Running again isn't tried where the import map or a script that isn't a module changed, Lamp's own files changed,
// modules import each other in a circle, or the page has no module scripts: the change waits for the person's Reload
// (`reopenOrHold`), which opens the page again from the snapshot. New code that fails as it runs again, before init is
// done or in its first second, opens the page again at once, from the same snapshot. The renderer, the cameras and the
// game's state are registered rather than kept this way (see "What the game registers").

let runningAgain = null, loops = 0, fitting = false, pageText = null, watching = false, reopenedFrame = 0;
// What the game kept, by the module and key it was kept with.
const kept = new Map();
// Above 0 while a part's build function runs: what it starts belongs to the part, and stays.
let keeping = 0;

function keep(path, key, build, options = {}) {
    const { dispose, inputs = [], lasting = false, from = [], background = false } = typeof options === 'function' ? { dispose: options } : options;
    const id = `${path} ${key}`, text = lasting ? bare(source(build)) : source(build), had = kept.get(id), again = runningAgain;
    if (lasting && had && had.text !== text && redeclare(key)) return had.value;
    const sameAs = list => list.length === inputs.length && inputs.every((v, i) => Object.is(v, list[i]));
    const same = had && sameAs(had.inputs);
    const sources = [from].flat().filter(f => typeof f === 'string' && f).map(clean);
    const sameSources = had && had.from.join('\n') === sources.join('\n');
    // A part being built in the background goes on being built while nothing it's built from changed again, and the
    // game goes on with the part it has until the new one swaps in.
    if (had && had.pending) {
        const p = had.pending;
        if (!had.stale && p.text === text && sameAs(p.inputs) && p.from.join('\n') === sources.join('\n')) {
            had.used = true;
            if (again) tally.building.push({ key, cause: p.cause });
            return had.value;
        }
        stopBuilding(had);
    }
    // In the preview a part whose async build drew random numbers while it waited is built again: how many were its
    // own can't be told, and a play must give the numbers a cold one does.
    if (had && !had.stale && had.text === text && same && sameSources && !(preview && had.draws == null)) {
        had.used = true;
        // Built in the background since the code last ran: in the game from this run on.
        if (again && had.fresh) { had.fresh = false; tally.swapped.push(had); }
        else if (again) tally.kept.push(key);
        // The random numbers its build drew are drawn past, so what comes after gets the numbers it got then.
        for (let i = 0; i < (had.draws || 0); i++) random();
        return had.value;
    }
    // Why it's built again, for the agent: the file that changed, its own code, or a part it's built from.
    const cause = !had ? null : typeof had.stale === 'string' ? had.stale : had.text !== text ? 'its build changed'
        : !same ? 'a part it\'s built from was built again' : !sameSources ? 'what it\'s built from changed' : null;
    // Built from a part that's being built in the background: built from the new one once that swaps in, and until
    // then the game goes on with the one it has.
    // (an async part's value is its promise; what the game passes on is what it gave, `made`)
    if (again && had && !lasting && !preview && inputs.some(v => [...kept.values()].some(k => k.pending && (Object.is(k.value, v) || Object.is(k.made, v))))) {
        had.used = true;
        tally.waiting.push(key);
        return had.value;
    }
    // A part built in the background is built again while the game goes on with the one it has (see "Building in the
    // background").
    if (background && again && had && !lasting && !preview) {
        had.used = true;
        had.stale = false;
        had.pending = { text, inputs, from: sources, dispose: typeof dispose === 'function' ? dispose : null, build, cause,
                        gen: again.change.gen, began: performance.now(), busy: 0, steps: null, assets: new Set(), timers: [] };
        backgrounds.add(had);
        tally.building.push({ key, cause });
        slices();
        return had.value;
    }
    const entry = { path, key, text, inputs, lasting, from: sources, dispose: typeof dispose === 'function' ? dispose : null, used: true,
                    stale: false, value: undefined, made: undefined, assets: new Set(), draws: 0, cause, ms: null };
    const began = performance.now();
    // What the build starts as it runs belongs to the part. An async build's later work can't be told from other code
    // that runs while it waits, so of what's started meanwhile only what's the part's own stays with it: listeners on
    // the part (its object, its canvas, an element inside it) and a worker or sound context that is the part or one of
    // its values. The rest is watched as the game's; a timer started while it waits can't be told apart, so a part that
    // started one still running is built again when the code next runs (a part keeps a timer it starts before its first
    // await).
    keeping++;
    building.push(entry);
    const drawn = draws;
    let value;
    // A build made of steps (a generator) is built whole the first time: there's no part yet to play with meanwhile.
    try { value = build(); if (background && isSteps(value)) value = stepThrough(value); } finally { keeping--; building.pop(); entry.draws = draws - drawn; }
    if (value && typeof value.then === 'function') {
        const waiting = { added: [], made: [], timers: [], assets: entry.assets };
        keepsWaiting.add(waiting);
        value = Promise.resolve(value).finally(() => keepsWaiting.delete(waiting));
        const drawnBefore = draws;
        value.then(v => { entry.made = v; entry.timers = waiting.timers; entry.ms = performance.now() - began; if (draws !== drawnBefore) entry.draws = null; own(v, waiting); },
            () => { if (kept.get(id) === entry) kept.delete(id); });
    } else { entry.made = value; entry.ms = performance.now() - began; }
    entry.value = value;
    // The part it replaces goes, sparing what the new one shares with it (materials made once, so compiled once).
    if (had) Promise.resolve(value).then(v => letGo(had, usedBy(v)), () => letGo(had));
    kept.set(id, entry);
    if (again && had) tally.built.push(entry);
    return value;
}

// The kept parts built from one of `paths`, as the game declared them (`from`: a file, a module and what it imports, or
// a folder ending in /): a change to one is the part's own, so it's built again in place rather than swapped around it.
function builtFrom(paths) {
    for (const k of kept.values()) {
        if (k.lasting || !k.from.length) continue;
        const deps = new Set();
        for (const f of k.from) if (!f.endsWith('/')) { deps.add(f); for (const dep of below(f)) deps.add(dep); }
        const hit = paths.find(p => deps.has(p) || k.from.some(f => f.endsWith('/') && p.startsWith(f)));
        if (hit) return { key: k.key, path: hit };
    }
    return null;
}

const isKept = v => [...kept.values()].some(k => k.made === v);

// Async builds still running, each with the listeners added while it ran.
const keepsWaiting = new Set();
// The parts whose build is running now, and the files the runtime loaded for each (`took`): a change to one of those
// files builds the part again.
const building = [];
function took(path) {
    loaded.add(path);
    read(path);
}
// A file of the page's read, through the runtime or fetched: by the parts being built, and since the code last ran again
// (`readSince`, for what of a change nothing read again: `waitsFor`).
let readSince = new Set();
function read(path) {
    readSince.add(path);
    everRead.add(path);
    for (const entry of building) entry.assets.add(path);
    for (const waiting of keepsWaiting) waiting.assets.add(path);
}
// The parts' timer lists a timer's callback runs for, while it runs.
let timedFor = null;
function own(made, waiting) {
    const parts = [made, made && made.domElement, made && made.canvas].filter(o => o && typeof o === 'object');
    const of = target => parts.some(p => p === target || (p.contains && target.nodeType && p.contains(target)));
    const values = made && typeof made === 'object' ? [made, ...Object.values(made)] : [made];
    for (const [thing, end] of waiting.made) if (values.includes(thing)) owned.delete(end);
    for (const [target, listener] of waiting.added) {
        if (!of(target)) continue;
        const list = listenersOf.get(target), i = list ? list.indexOf(listener) : -1;
        if (i >= 0) list.splice(i, 1);
    }
}

// `spare` holds the geometry and materials a part that replaces this one goes on using (made once and shared by both,
// so the new part's shaders were compiled long ago): those stay.
function letGo(k, spare = new Set()) {
    // A part built in the background lets go of the one it replaced once it's let go of itself.
    if (k.replaces) { letGo(k.replaces); k.replaces = null; }
    Promise.resolve(k.value).then(v => {
        try {
            if (k.dispose) return k.dispose(v);
            // A part that's a plain object of three.js objects ({ group, heights }) lets go of each.
            for (const o of objectsOf(v)) {
                o.removeFromParent();
                o.traverse(o => {
                    if (o.geometry && !spare.has(o.geometry)) o.geometry.dispose();
                    for (const m of [o.material].flat()) if (m && m.dispose && !spare.has(m)) m.dispose();
                });
            }
            if (v && !v.isObject3D && typeof v.dispose === 'function') v.dispose();
            else if (v && !v.isObject3D && typeof v.destroy === 'function') v.destroy(true);
        } catch (e) { log(`Lamp: letting go of ${k.key} kept in ${k.path} failed (${e && e.message || e}).`); }
    }, () => {});
}

// MARK: Building in the background
//
// A part that takes long to build (a city from its map data, a terrain, a navigation mesh) says so with
// `background: true`, and when a change builds it again the game goes on as it was while the new one is built: frames
// keep coming, the controller and the game's logic keep working with the part it has, and a small "Building…" shows
// over the game. Once the new part is built, its materials' shaders are compiled while the old one is still drawn, and
// the code runs again in place with it, as for any change, which takes about a frame since everything else is kept:
// what used the old part uses the new one from there, and the old one goes. A part built from one being built (its
// `inputs`) is built again from the new one once that's in, and parts that must change together are built in one
// part. The first build, with no part to play meanwhile, is built whole as the game starts.
//
// Its build is made of steps or waits for its work done elsewhere:
//
//   - a generator that yields between steps (a row of the city, a chunk of the terrain), which the runtime steps a few
//     milliseconds each frame;
//   - or an async function that hands the pure data work (parsing, geometry arrays) to a worker with work(), making
//     only the three.js objects itself from the arrays it gets back;
//   - a plain function is built in one go a frame after the code ran again: it still holds that frame, but nothing
//     else does.
//
//   const city = live.keep('city', function* () {
//       const rows = [];
//       for (const block of MAP.blocks) { rows.push(buildBlock(block)); yield; }
//       return { group: merge(rows) };
//   }, { from: ['js/map-data.js'], background: true });
//
// The part's three.js objects are compiled for the scene the game last drew, with the camera it drew it with, when the
// part is one or a plain object holding them ({ group }), a material a frame. A material made anew still holds the frames
// on screen while its shader compiles, so a part's materials are made once, in a kept part of their own, and the part
// built in the background makes only geometry with them: the old part goes without the materials the new one uses. The log and Lamp's report say what was built in the
// background and for how long, and how long the game stood still for the change (about a frame).

// The parts being built in the background: each the part the game has now, with what's being built in `pending`.
const backgrounds = new Set();
// Each frame, the steps of what's built in the background get this many milliseconds, fewer when the game's own
// frame is slow, so the game keeps its frame rate as it's built.
let slicing = false, frameCost = 0;
const isSteps = v => !!v && typeof v.next === 'function' && typeof v[Symbol.iterator] === 'function' && typeof v.then !== 'function';
function stepThrough(steps) {
    for (;;) { const s = steps.next(); if (s.done) return s.value; }
}
function slices() {
    if (slicing || !backgrounds.size) return;
    slicing = true;
    after(400, () => { if (backgrounds.size) showHint(); });
    // Between frames, or every 50 ms where frames come slower (a window out of sight), so the build goes on.
    const mine = ++sliceCount, go = () => { if (mine === sliceCount) { sliceCount++; slice(); } };
    nextFrame(go);
    after(50, go);
}
let sliceCount = 0;
function slice() {
    const began = performance.now(), budget = Math.max(4, Math.min(10, 14 - frameCost));
    for (const k of [...backgrounds]) {
        while (k.pending && !k.pending.waits && performance.now() - began < budget) stepPart(k);
    }
    slicing = false;
    if ([...backgrounds].some(k => k.pending && !k.pending.waits)) slices();
}
function stepPart(k) {
    const p = k.pending, t = performance.now();
    keeping++;
    building.push(p);
    try {
        if (!p.steps) {
            const made = p.build();
            if (isSteps(made)) { p.steps = made; return; }
            if (made && typeof made.then === 'function') {
                // Its work is done elsewhere (a worker): what it starts meanwhile is the part's when it's the part's own.
                p.waits = true;
                const waiting = { added: [], made: [], timers: p.timers, assets: p.assets };
                keepsWaiting.add(waiting);
                Promise.resolve(made).finally(() => keepsWaiting.delete(waiting))
                    .then(v => { own(v, waiting); built(k, p, v); }, e => failed(k, p, e));
                return;
            }
            return built(k, p, made);
        }
        const s = p.steps.next();
        if (s.done) built(k, p, s.value);
    } catch (e) { failed(k, p, e); }
    finally { keeping--; building.pop(); p.busy += performance.now() - t; }
}
// Whether a part being built in the background is built from `path`: what changed it, what its last build read, or
// what it declares it's built from. Its new build reads it, so it doesn't wait for Reload.
function buildingFrom(path) {
    for (const k of backgrounds) {
        if (!k.pending) continue;
        if (k.pending.cause === path || k.assets.has(path) || k.pending.assets.has(path)) return true;
        if (k.from.some(f => f === path || (f.endsWith('/') && path.startsWith(f)) || (!f.endsWith('/') && below(f).has(path)))) return true;
    }
    return false;
}

// Built: its shaders are compiled while the old part is drawn, and it waits to be swapped in with the others.
async function built(k, p, value) {
    p.waits = true;
    p.ms = performance.now() - p.began;
    p.compiled = await compileAhead(value);
    // Not while the code runs again: that run decides which part the game goes on with.
    while (runningAgain) await new Promise(done => after(50, done));
    // Built again since, or let go of: what this build made goes.
    if (k.pending !== p) {
        // Sparing what the parts kept still use: the materials made once and shared, the geometry of the part on screen.
        const spare = new Set();
        for (const other of kept.values()) for (const used of usedBy(other.made)) spare.add(used);
        return letGo({ key: k.key, path: k.path, value, dispose: p.dispose }, spare);
    }
    k.pending = null;
    backgrounds.delete(k);
    const entry = { path: k.path, key: k.key, text: p.text, inputs: p.inputs, lasting: false, from: p.from, dispose: p.dispose, used: false,
                    stale: false, value, made: value, assets: p.assets, timers: p.timers, draws: 0, cause: p.cause, ms: p.ms,
                    busy: p.busy, compiled: p.compiled, gen: p.gen, fresh: true, replaces: k };
    kept.set(`${k.path} ${k.key}`, entry);
    log(`Lamp: ${k.key} was built in the background in ${seconds(p.ms)} while the game ran${p.compiled == null ? '' : ` (its shaders compiled ahead in ${Math.round(p.compiled)} ms)`}.`);
    if (!backgrounds.size) swapIn();
}
function failed(k, p, e) {
    if (k.pending !== p) return;
    k.pending = null;
    backgrounds.delete(k);
    if (p.steps) { try { p.steps.return(); } catch (e2) {} }
    const why = `building ${k.key} in the background failed (${e && e.message || e}), so the game goes on with the one it had`;
    log(`Error: ${why}.`);
    // Lamp hears it's no longer being built, and the agent why.
    tellHost(p.gen, 'report', why, { built: [{ part: k.key, background: true, ms: Math.round(performance.now() - p.began), cause: 'its build failed' }], waits: [], later: true });
    if (!backgrounds.size) { hideHint(); swapIn(); }
}
function stopBuilding(k) {
    const p = k.pending;
    k.pending = null;
    backgrounds.delete(k);
    if (p && p.steps) { try { p.steps.return(); } catch (e) {} }
    if (!backgrounds.size) hideHint();
}
const seconds = ms => ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;

// What the game drew last (the first render of the frame), for compiling a part ahead for that scene and camera; and a
// compile under way before the first frame after the code ran again (`warming`).
let lastDrawn = null, drewThisFrame = false, warming = null, warmed = null;
// Watches the renderer's render() for what it draws, and after the code ran again has its first frame's shaders
// compiled with compileAsync() before it's drawn, the old frame held on screen meanwhile, so nothing compiles in a
// frame the player sees. A renderer without compileAsync (Phaser's) is left as it is.
function watchRender(r) {
    if (!r || r.__lampRender || typeof r.render !== 'function' || typeof r.compileAsync !== 'function') return;
    const draw = r.render;
    r.__lampRender = true;
    r.render = function (scene, camera, ...rest) {
        if (!drewThisFrame && scene && scene.isObject3D && camera && camera.isCamera) { lastDrawn = { scene, camera }; drewThisFrame = true; }
        if (warming === 'ask' && lastDrawn) {
            const t = performance.now();
            warming = Promise.resolve().then(() => this.compileAsync(scene, camera)).catch(() => {})
                .then(() => { warmed = performance.now() - t; warming = null; });
            return;
        }
        if (warming) return;
        return draw.call(this, scene, camera, ...rest);
    };
}
// A part's three.js objects compiled ahead for the scene and camera the game draws, a material at a time with a frame
// between: a pipeline's compiling holds the frames the GPU presents meanwhile (WebKit's WebGPU), so one at a time keeps
// each hold to one material's.
const objectsOf = v => v && v.isObject3D ? [v] : isPlain(v) ? Object.values(v).filter(o => o && o.isObject3D) : [];
// The geometry and materials of a part's three.js objects.
function usedBy(v) {
    const used = new Set();
    for (const o of objectsOf(v)) o.traverse(m => { if (m.geometry) used.add(m.geometry); for (const x of [m.material].flat()) if (x) used.add(x); });
    return used;
}
async function compileAhead(value) {
    const objects = objectsOf(value);
    if (!objects.length || !lastDrawn || !renderer || typeof renderer.compileAsync !== 'function') return null;
    const t = performance.now(), seen = new Set(), each = [];
    for (const o of objects) o.traverse(m => {
        const materials = [m.material].flat().filter(Boolean);
        if (!materials.length || materials.every(x => seen.has(x))) return;
        materials.forEach(x => seen.add(x));
        each.push(m);
    });
    for (const m of each) {
        try { await renderer.compileAsync(m, lastDrawn.camera, lastDrawn.scene); } catch (e) {}
        await new Promise(nextFrame);
    }
    return performance.now() - t;
}

// The parts built in the background go in: the code runs again in place, at once, or at the next pause while the game
// is busy. A change that ran the code again meanwhile has already put them in.
let swapWaits = false;
function swapIn() {
    queue = queue.then(() => {
        const fresh = [...kept.values()].filter(k => k.fresh);
        if (!fresh.length || !frameFunction || runningAgain) return;
        if (isBusy()) { swapWaits = true; return; }
        hideHint();
        const gen = Math.max(...fresh.map(k => k.gen || 0));
        return runAgain({ gen, why: `${fresh.map(k => k.key).join(', ')} built in the background`, changed: [], quiet: true }, takeSnapshot(), phonesHere());
    }).catch(e => log(`Lamp: ${e && e.message || e}`));
}

// "Building…" over the game while a part is built in the background, at the top right, below where the app around
// the page puts its own buttons.
let hint = null;
function showHint() {
    if (preview || !document.body) return;
    if (!hint) {
        hint = document.createElement('div');
        hint.textContent = 'Building…';
        hint.style.cssText = 'position:fixed;z-index:20;right:14px;top:calc(48px + env(safe-area-inset-top));pointer-events:none;'
            + 'padding:6px 14px;border-radius:16px;background:rgba(20,20,24,.6);color:rgba(255,255,255,.85);font:600 13px -apple-system,system-ui,sans-serif;'
            + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);transition:opacity .3s;opacity:0';
    }
    if (!hint.isConnected) document.body.append(hint);
    nextFrame(() => { if (hint) hint.style.opacity = '1'; });
}
function hideHint() { if (hint) hint.style.opacity = '0'; }

// MARK: What the game registers
//
// A part kept with keep() stays while its code does. What the game registers stays whatever else changes, because the
// runtime holds it by name rather than the game's code holding it, so a game that registers these keeps its state
// through every change that doesn't change the thing itself, the page opening again included:
//
//   const live = hot(import.meta);
//   const renderer = live.renderer(() => new THREE.WebGLRenderer({ antialias: true }));
//   const camera = live.camera('main', () => new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 500), { target: () => controls.target });
//   const play = live.state('play', { version: 1, start: () => ({ mode: 'title', level: 1, score: 0, player: { x: 0, z: 0 } }) });
//
// `renderer(build)`: there's one renderer. build() runs only when there isn't one yet: new code gets the renderer the
// game has before it could make a second, with its context and compiled shaders, and a change to any module leaves it
// alone. It's made again only when build's own code changes. An async build (`WebGPURenderer` and its init()) gives a
// promise: `await` it. Pass the result to game().
//
// `camera(id, build, { target })`: the camera build() makes stays, and where it is, how it's turned and what lens it has
// are put back before the first frame whatever the new start set, also when the page opens again or a new install does.
// So build() sets its starting pose and lens. `target()` gives something that has x, y and z the camera looks at and new
// code makes again (OrbitControls' `target`): it's read as the old code stops and set as the new code starts. A change
// to build's own code makes a new camera, at the old pose and with the new lens.
//
// `state(id, { version, start, migrate })`: `start()` gives a plain object, which is the game's to change as it plays and
// never to replace. Lamp snapshots it, as plain JSON, and before init the same object holds what it held: fields the new
// `start()` adds take their start values and every other keeps its value, nested plain objects field by field. So read
// it where it's used, build the start from it (`play.mode` says what to show, with no title drawn first) and keep
// nothing derived from it in a kept part. Raise `version` when a field's meaning changes: `migrate(old, oldVersion)`
// gives the new state, and a version raised with no migrate, or one that throws, starts that state from `start()`. At a
// fresh start, and in a new play of the preview, it's `start()`. It must be registered once per run, before game()
// starts or in init; read in a module's top level it still has its start values. A swap leaves what's registered as it
// is, so a change to a declaration in a module that takes its changes runs the code again.
//
// This holds only for what's registered. A renderer or camera the game's code makes for itself, or the state it keeps
// in its own variables, starts again with the code. So a change that would run the code again of a game whose place
// isn't kept (no state registered, and no snapshot() it reads back) waits for the person's Reload rather than starting
// play over, and says what isn't registered, for the agent to register in the same turn. Each run tells Lamp what it
// kept, built again and reset (`cameThrough`).

const cameras = new Map(), states = new Map();
// What the run starting now was given back.
let tally = { kept: [], built: [], reset: [], building: [], waiting: [], swapped: [] }, flatGame = false, asksPlace = false;
// What the run starting now is to put back: the old run's `heldNow()`, or what the page kept for its opening.
let restoring = null;
// What a swap's new versions declared differently. A swap keeps what's registered as it is, so it can't take that in: the
// code runs again, where the new declaration counts. True when a swap is under way to hear of it.
let redeclared = null;
const redeclare = what => {
    if (!loading.size || runningAgain) return false;
    redeclared = redeclared || what;
    return true;
};
const LENS = ['fov', 'aspect', 'near', 'far', 'zoom', 'focus', 'filmGauge', 'filmOffset', 'left', 'right', 'top', 'bottom'];

function camera(id, build, { target } = {}) {
    const text = bare(source(build)), again = runningAgain;
    let entry = cameras.get(id);
    if (entry && entry.used) {
        if (entry.text !== text) redeclare(`camera ${id}`);
        return entry.value;
    }
    // A new play of the preview starts from what build() sets, as a cold one does.
    if (!entry || entry.text !== text || (preview && again)) {
        if (entry && again) tally.built.push({ key: `camera ${id}`, ms: null, cause: 'its build changed' });
        cameras.set(id, entry = { id, text, value: build() });
    } else if (again) tally.kept.push(`camera ${id}`);
    entry.target = target;
    entry.used = true;
    return entry.value;
}

function poseOf({ value: c, target, text }) {
    const pose = { text, position: c.position.toArray(), quaternion: c.quaternion.toArray(), up: c.up.toArray(), lens: {} };
    for (const key of LENS) if (typeof c[key] === 'number') pose.lens[key] = c[key];
    const point = target && target();
    if (point) pose.target = [point.x, point.y, point.z];
    return pose;
}

function putPose(entry, pose) {
    if (!pose) return;
    const c = entry.value;
    c.position.fromArray(pose.position);
    c.quaternion.fromArray(pose.quaternion);
    c.up.fromArray(pose.up);
    // A camera whose build changed has the lens the change gave it.
    if (pose.text === entry.text) Object.assign(c, pose.lens);
    const point = entry.target && entry.target();
    if (point && pose.target) [point.x, point.y, point.z] = pose.target;
    if (c.updateProjectionMatrix) c.updateProjectionMatrix();
    if (c.updateMatrixWorld) c.updateMatrixWorld();
}

function state(id, { version = 1, start, migrate } = {}) {
    let entry = states.get(id);
    if (!entry) states.set(id, entry = { id, value: {} });
    const text = `${version} ${bare(source(start))} ${migrate ? bare(source(migrate)) : ''}`;
    if (entry.used) {
        if (entry.text !== text) redeclare(`state ${id}`);
        return entry.value;
    }
    Object.assign(entry, { version, start, migrate, text, used: true, settled: false });
    fill(entry.value, startOf(entry));
    if (restoring) settle(entry);
    return entry.value;
}

function startOf(entry) {
    const value = entry.start();
    if (!isPlain(value)) throw new Error(`state('${entry.id}'): start() gives a plain object`);
    return value;
}

// The same object throughout, for whoever already holds it.
function fill(into, from) {
    for (const key of Object.keys(into)) delete into[key];
    Object.assign(into, from);
}

const merged = (start, was) => {
    if (!isPlain(start) || !isPlain(was)) return was;
    const both = { ...start };
    for (const key of Object.keys(was)) both[key] = key in start ? merged(start[key], was[key]) : was[key];
    return both;
};

// Takes what the old run left into a registered state. Called as it's registered, and for those registered before
// game() found out where the page starts.
function settle(entry) {
    const was = restoring && restoring.states[entry.id];
    if (entry.settled || !entry.used || !was) return;
    entry.settled = true;
    const lost = why => { log(`Lamp: state ${entry.id} started from start() (${why}).`); tally.reset.push(`state ${entry.id}`); };
    if (was.version === entry.version) {
        fill(entry.value, merged(startOf(entry), was.value));
        tally.kept.push(`state ${entry.id}`);
    } else if (was.version < entry.version && entry.migrate) {
        try {
            fill(entry.value, merged(startOf(entry), entry.migrate(was.value, was.version)));
            tally.kept.push(`state ${entry.id}`);
        } catch (e) { lost(`migrate failed: ${e && e.message || e}`); }
    } else lost(`version ${was.version} became ${entry.version}${entry.migrate ? '' : ' with no migrate'}`);
}

// Whether the player's place outlasts the code: state registered, or a snapshot() the game reads back.
const keepsPlace = () => states.size > 0 || (!!hooks.snapshot && (!!hooks.restore || asksPlace));

const madeCamera = () => cameras.size > 0 || [...kept.values()].some(k => k.made && k.made.isCamera);

// What isn't registered, in the words the agent is told it in. A 2D game's renderer and cameras are Phaser's, made again
// from its state. A game that says nothing of its renderer is told of it only here: `isKept` also takes one kept by hand.
function unregistered() {
    const left = [];
    if (!flatGame && !isKept(renderer)) left.push('its renderer (live.renderer)');
    if (!flatGame && !madeCamera()) left.push('its camera (live.camera)');
    if (!keepsPlace()) left.push('its gameplay state (live.state)');
    return left;
}

// What came through a change, for the log and for the agent: kept, built again, reset, and what started again unasked
// because it isn't registered.
function cameThrough(waits = []) {
    const left = unregistered();
    const why = k => !k.cause ? '' : /^[^\s]+[./][^\s]+$/.test(k.cause) ? `, ${k.cause} changed` : `, ${k.cause}`;
    const built = tally.built.map(k => k.ms == null && !k.cause ? k.key : `${k.key} (${k.ms == null ? '' : `${Math.round(k.ms)} ms`}${k.ms == null ? why(k).slice(2) : why(k)})`);
    const swapped = tally.swapped.map(k => `${k.key} (built in ${seconds(k.ms)}${why(k)})`);
    return [tally.kept.length ? `kept ${tally.kept.join(', ')}` : '', built.length ? `built again ${built.join(', ')}` : '',
            tally.building.length ? `building in the background ${tally.building.map(k => k.key + why(k).replace(/^, /, ' (') + (k.cause ? ')' : '')).join(', ')}` : '',
            swapped.length ? `put in what was built in the background: ${swapped.join(', ')}` : '',
            tally.waiting.length ? `built again once what they're built from is in: ${tally.waiting.join(', ')}` : '',
            tally.reset.length ? `reset ${tally.reset.join(', ')}` : '', left.length ? `not registered, so started again: ${left.join(', ')}` : '',
            waits.length ? `waits for Reload: ${waits.join(', ')}, which nothing read again` : ''].filter(Boolean).join('; ');
}

// Everything registered, as plain JSON: for the new run, or for a page that opens again.
function heldNow() {
    if (!cameras.size && !states.size) return null;
    const held = { cameras: {}, states: {} };
    for (const [id, entry] of cameras) held.cameras[id] = poseOf(entry);
    for (const [id, entry] of states) {
        try { held.states[id] = { version: entry.version, value: JSON.parse(JSON.stringify(entry.value)) }; }
        catch (e) { log(`Lamp: state ${id} isn't plain JSON (${e && e.message || e}), so it isn't kept.`); }
    }
    return held;
}

// What a module imports, all the way down.
function below(path) {
    const all = new Set(), next = [path];
    while (next.length) for (const dep of imports.get(next.pop()) || []) if (!all.has(dep)) { all.add(dep); next.push(dep); }
    return all;
}

// What was kept by a changed module, or by one it imports, is built again when the code next runs. The module that
// starts the game imports everything and changes often, so what it kept goes by what the build function names: the
// modules whose imports it uses, and theirs.
function markStale(paths) {
    for (const k of kept.values()) {
        if (k.stale || k.lasting) continue;
        let deps;
        // A game bundled into one file (from TypeScript) imports nothing of its own: a change anywhere in it is its own.
        if (rootPaths.includes(k.path) && (bindings.get(k.path) || new Map()).size) {
            deps = new Set();
            for (const [name, from] of bindings.get(k.path) || []) {
                if (!new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\b`).test(k.text)) continue;
                deps.add(from);
                for (const dep of below(from)) deps.add(dep);
            }
        } else { deps = below(k.path); deps.add(k.path); }
        for (const f of k.from) if (!f.endsWith('/')) { deps.add(f); for (const dep of below(f)) deps.add(dep); }
        const hit = paths.find(p => deps.has(p) || k.assets.has(p) || k.from.some(f => f.endsWith('/') && p.startsWith(f)));
        if (hit) k.stale = hit;
    }
}

const pagePath = () => pathOf(location.href.split(/[?#]/)[0]) || 'index.html';
// The page's HTML as this copy started, to tell what of it a change changed.
function keepPage() {
    if (!watching) return;
    readText(pagePath()).then(t => { if (pageText == null) pageText = t; }, () => {});
}
const parse = text => new DOMParser().parseFromString(text, 'text/html');
// What of a page can't change under modules that have run: the import map and the scripts that aren't modules.
const fixed = page => JSON.stringify([...page.querySelectorAll('script')].filter(s => s.type !== 'module')
    .map(s => [s.type, s.getAttribute('src'), s.getAttribute('src') ? '' : s.textContent.trim()]));

// Why the code can't run again in place for a change, or null when it can.
function canRunAgain(change) {
    if (!watching) return 'the game\'s code runs again in place only where Lamp puts changes into the open game';
    if (!frameFunction) return 'the game hadn\'t started';
    const own = (change.changed || []).map(clean).find(p => lampOwn(p));
    if (own) return `Lamp's own ${own} changed`;
    return null;
}

// The game's modules that name a changed data file the runtime didn't load (one a module fetches itself, as a city's
// building data is), read as changed themselves: a part kept from what they made is built again from the new file
// rather than kept from the old one.
// `named` gets each changed file outside the modules (data, or a script nothing imports, as a worker's) that the game's
// code names, for what of a change nothing read again (`waitsFor`).
async function namingData(paths, order, named = new Set()) {
    const outside = paths.filter(p => !/\.(html?|css)$/i.test(p) && !imports.has(p));
    const data = paths.filter(p => !CODE.test(p) && !loaded.has(p));
    if (!outside.length) return [];
    const naming = [];
    for (const path of order) {
        if (lampOwn(path) || paths.includes(path)) continue;
        const text = texts.get(path) ?? inline.get(path) ?? await readText(path).catch(() => '');
        for (const p of outside) if (names(text, p)) named.add(p);
        if (data.some(p => names(text, p))) naming.push(path);
    }
    return naming;
}

// What of a change the code run again didn't take in: a file the game uses (one it loaded through the runtime, read in
// any other way, or that its code names) that nothing read again, nor put in as it was (`put`), so a part kept from it,
// or code that read it once, shows the old one until the page opens again. That waits for Reload.
function waitsFor(change, named) {
    return (change.changed || []).map(clean).filter(p => !/\.(html?|css)$/i.test(p) && !imports.has(p) && !readSince.has(p) && !buildingFrom(p)
        && !(change.put || []).includes(p) && (loaded.has(p) || everRead.has(p) || named.has(p)));
}

async function runAgain(change, state, roster) {
    const began = performance.now(), why = change.why;
    // What was built in the background waits for the next change that can run the code again.
    const cannot = reason => change.quiet ? log(`Lamp: ${why} waits for the next change (${reason}).`) : reopenOrHold({ ...change, why: `${why}; ${reason}` }, state);
    const paths = (change.changed || []).map(clean);
    let text, page;
    try { text = await readText(pagePath()); page = parse(text); } catch (e) { return cannot('its page couldn\'t be read'); }
    if (fixed(page) !== fixed(pageText != null ? parse(pageText) : document)) return cannot('its import map or a script that isn\'t a module changed');
    const classic = doc => [...doc.querySelectorAll('script[src]')].filter(s => s.type !== 'module' && s.type !== 'importmap')
        .map(s => pathOf(new URL(s.getAttribute('src'), location.href).href));
    const script = paths.find(p => classic(page).includes(p) || classic(document).includes(p));
    if (script) return cannot(`${script}, a script that isn't a module, changed`);
    // Every module of the game, in order, what each imports before it.
    const order = [];
    try {
        const roots = await readModules(paths.filter(p => /\.m?js$/i.test(p)), page);
        if (!roots.length) return cannot('the page has no module scripts');
        const seen = new Map();
        const visit = path => {
            if (seen.get(path) === 2) return;
            if (seen.get(path) === 1) throw new Error(`${path} is in a circle of modules that import each other`);
            seen.set(path, 1);
            for (const dep of imports.get(path) || []) visit(dep);
            seen.set(path, 2);
            order.push(path);
        };
        for (const root of roots) visit(root);
    } catch (e) { return cannot(e.message); }
    const named = new Set();
    markStale([...paths, ...await namingData(paths, order, named)]);

    if (!change.quiet) {
        tellHost(change.gen, 'rerun', why);
        log(`Lamp: running the game's code again in place for a change (${why}), keeping where the player was.`);
    }
    // The frame on screen now, held there until the new code draws its first.
    const still = preview ? null : await new Promise(done => { shooting = done; after(250, () => { if (shooting === done) { shooting = null; done(null); } }); });
    const again = runningAgain = { change, state, began, called: false, done: null, named };
    readSince = new Set();
    const done = new Promise(resolve => { again.done = resolve; });
    // The old code stops: its frame loop, what it asked to have taken away, and what it left running.
    loops++;
    again.stopped = performance.now();
    started = false;
    // What's registered, as the last frame left it, or as it was before a swap that went wrong, which may have changed
    // it. A preview's new play has none: it starts from the top.
    restoring = !state ? null : change.touched ? state.held : heldNow();
    tally = { kept: [], built: [], reset: [], building: [], waiting: [], swapped: [] };
    if (state) again.state = { ...state, held: restoring };
    for (const entry of [...cameras.values(), ...states.values()]) entry.used = entry.settled = false;
    swapGuard = null;
    hidePill();
    holdPhones(roster);
    const leaving = hooks;
    hooks = {};
    try { if (leaving.dispose) await leaving.dispose(); } catch (e) { log(`Error: dispose: ${e && e.message || e}`); }
    for (const [path, m] of modules) {
        for (const dispose of m.disposers) { try { await dispose(m.data); } catch (e) { log(`Error: dispose in ${path}: ${e && e.message || e}`); } }
        m.disposers = [];
    }
    // A part whose async build started a timer still running loses it now, so it's built again.
    for (const k of kept.values()) if ((k.timers || []).some(t => intervals.has(t) || timeouts.has(t))) k.stale = 'a timer it started';
    takeAwayLeft();
    if (phonesWaiting) phonesWaiting.leaving = false;
    listeners.clear();
    for (const voice of voices) sound.stop(voice);
    voices.clear();
    if (musicVoice) { sound.stop(musicVoice); musicVoice = null; }
    for (const k of kept.values()) k.used = false;
    await putPage(page, paths, still);
    pageText = text;
    // The new code, each module once, in order, importing the others' new versions.
    const addresses = new Map();
    for (const path of order) {
        const own = inline.has(path), address = own ? location.href : `${addressOf(path)}?lamp=${++versionCount}`;
        loading.add(path);
        try {
            const code = own ? inline.get(path) : (texts.get(path) ?? await readText(path));
            texts.set(path, code);
            const base = own ? location.href : addressOf(path);
            const written = code.replace(SPECIFIER, (all, lead, quote, specifier) => {
                const target = resolve(specifier, base);
                if (!target) return all;
                const p = pathOf(target);
                return lead + quote + (p != null && addresses.has(p) ? addresses.get(p) : target) + quote;
            }).replace(/\bimport\.meta\b/g, `({ url: ${JSON.stringify(address)}, resolve: s => new URL(s, ${JSON.stringify(address)}).href })`);
            const from = URL.createObjectURL(new Blob([written], { type: 'text/javascript' }));
            addresses.set(path, from);
            if (rootPaths.includes(path)) {
                // The module that starts the game: what it awaits may be the whole start, so it isn't waited for here.
                import(from).catch(e => ranAgainFailed(again, e));
                continue;
            }
            const ns = await import(from);
            const m = modules.get(path);
            if (m) { m.versions.push(versionOf(ns)); m.text = code; }
            latest.set(path, from);
        } catch (e) {
            return ranAgainFailed(again, `${path} didn't load (${e && e.message || e})`);
        } finally { loading.delete(path); }
    }
    for (const path of paths) texts.delete(path);
    for (const path of rootPaths) latest.set(path, addresses.get(path));
    after(120000, () => { if (runningAgain === again) ranAgainFailed(again, 'the game didn\'t start again within two minutes'); });
    return done;
}

// The page as the new HTML has it: what isn't a script in its head (a stylesheet it already links stays, unless it
// changed), and its body, with Lamp's own elements (the touch controls, the Reload button) kept.
async function putPage(page, paths, still) {
    const head = document.head, links = [...head.querySelectorAll('link[rel~="stylesheet"]')], loads = [], placed = [];
    for (const node of [...page.head.children]) {
        if (node.tagName === 'SCRIPT') continue;
        if (node.matches('link[rel~="stylesheet"]')) {
            const path = pathOf(new URL(node.getAttribute('href'), location.href).href);
            const have = links.find(l => pathOf(l.href) === path && !placed.includes(l));
            if (have && !paths.includes(path)) { placed.push(have); continue; }
            const fresh = document.adoptNode(node);
            if (path != null) fresh.href = `${addressOf(path)}?lamp=${++versionCount}`;
            loads.push(new Promise(done => { fresh.onload = fresh.onerror = done; after(5000, done); }));
            placed.push(fresh);
            continue;
        }
        placed.push(document.adoptNode(node));
    }
    // In the new page's order, since the order of stylesheets is the order of their rules. A stylesheet already linked
    // moves only when it's out of that order (moved, it's read again); the scripts and what goes stay where they are
    // until the new stylesheets have loaded, so the page is never shown unstyled.
    let before = null;
    for (const node of placed) {
        let at = before ? before.nextSibling : head.firstChild;
        while (at && (at.nodeType !== 1 || at.tagName === 'SCRIPT' || !placed.includes(at))) at = at.nextSibling;
        if (node !== at) head.insertBefore(node, at);
        before = node;
    }
    await Promise.all(loads);
    for (const node of [...head.children]) if (node.tagName !== 'SCRIPT' && !placed.includes(node)) node.remove();
    const body = document.body;
    for (const a of [...body.attributes]) body.removeAttribute(a.name);
    for (const a of [...page.body.attributes]) body.setAttribute(a.name, a.value);
    // The old page stays in view, still, over the new one until the new code has drawn (`lift`): its elements go last,
    // so the new code finds its own by id, and the frame it showed stands where the canvas was.
    const canvas = renderer && renderer.domElement;
    if (preview) { body.replaceChildren(...[...page.body.childNodes].map(n => document.adoptNode(n))); return; }
    const old = [...body.childNodes].filter(n => n !== touchLayer && n !== pill && n !== hint && n !== canvas && n !== curtain);
    if (curtain) curtain.remove();
    curtain = document.createElement('div');
    curtain.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    if (still) curtain.append(still);
    curtain.append(...old);
    // Scripts from the new page don't run as they go in: the modules run from runAgain.
    body.replaceChildren(...[...page.body.childNodes].map(n => document.adoptNode(n)), curtain, ...[touchLayer, pill, hint].filter(Boolean));
}

// The frame just drawn, as a picture placed where the game's canvas is, for runAgain to hold on screen; asked of the
// next frame, since a WebGL canvas keeps what it drew only until the frame is shown.
let shooting = null, curtain = null, lifting = 0;
// The change whose new code is about to be on screen, for `shown`: after a run in place as the old frame goes, after a
// reload at the first frame.
let shownFor = null;
function shoot() {
    if (!shooting) return;
    const done = shooting;
    shooting = null;
    let still = null;
    try {
        const drawn = renderer && renderer.domElement;
        const canvas = drawn && (drawn.tagName === 'CANVAS' ? drawn : drawn.querySelector && drawn.querySelector('canvas'));
        if (canvas && canvas.width && canvas.height) {
            const r = canvas.getBoundingClientRect();
            still = document.createElement('canvas');
            still.width = canvas.width; still.height = canvas.height;
            still.getContext('2d').drawImage(canvas, 0, 0);
            still.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        }
    } catch (e) { still = null; }
    done(still);
}
// Once the new code has drawn a couple of frames, the old page held over it fades away.
function lift() {
    if (!curtain || runningAgain || ++lifting < 3) return;
    // The change is on screen now: Lamp's light crosses the window as the old frame fades.
    if (shownFor != null) { tellHost(shownFor, 'shown'); shownFor = null; }
    const going = curtain;
    curtain = null;
    lifting = 0;
    going.style.transition = 'opacity 0.2s';
    going.style.opacity = '0';
    after(250, () => going.remove());
}

function ranAgain(again) {
    bringPhones();
    runningAgain = null;
    lifting = 0;
    // Putting in what was built in the background is the change's own going in, said by its report, not a change.
    shownFor = again.change.quiet ? null : again.change.gen;
    // No old frame held (a page with no canvas to picture): on screen at the next frame.
    if (!curtain && !again.change.quiet) after(0, () => { if (shownFor === again.change.gen) { tellHost(shownFor, 'shown'); shownFor = null; } });
    for (const [id, k] of kept) if (!k.used) { if (k.pending) stopBuilding(k); letGo(k); kept.delete(id); }
    // What a part built in the background replaced goes once the new one is on screen, not in its first frames.
    for (const k of kept.values()) if (k.used && k.replaces) { const old = k.replaces, spare = usedBy(k.made); k.replaces = null; after(1000, () => letGo(old, spare)); }
    for (const list of [cameras, states]) for (const [id, entry] of list) if (!entry.used) list.delete(id);
    restoring = null;
    const waits = waitsFor(again.change, again.named);
    const said = cameThrough(waits);
    // What was built again, each with how long it took and why, what's being built in the background, and what waits
    // for Reload: Lamp's chat and the agent's next look say it, so neither says the person sees what they don't. Said
    // once the new code's first frame is drawn, with how long the game stood still for it (`firstDrawn`).
    const ms = k => k.ms == null ? {} : { ms: Math.round(k.ms) }, cause = k => k.cause ? { cause: k.cause } : {};
    reporting = { again, said, ran: performance.now() - again.began, more: {
        built: [...tally.built.map(k => ({ part: k.key, ...ms(k), ...cause(k) })),
                ...tally.building.map(k => ({ part: k.key, background: true, ...cause(k) })),
                ...tally.swapped.map(k => ({ part: k.key, background: true, ...ms(k), ...cause(k) }))],
        kept: tally.kept.length, waits, ...(again.change.quiet ? { later: true } : {}) } };
    if (waits.length) {
        // The rest of the change goes in when the page opens again, at the person's Reload.
        waiting = { ...again.change, changed: waits, why: `nothing in the running game read ${waits.join(', ')} again`, hard: true, reopens: true };
        log(`Lamp: ${waits.join(', ')} changed, and nothing in the running game read ${waits.length === 1 ? 'it' : 'them'} again: that waits for Reload.`);
        if (again.change.pill) showPill();
    }
    swapGuard = { until: time + 1, change: again.change, state: again.state };
    again.done();
}

// The new code's first frame is drawn: what came through is said, with how long the game stood still for it, from the
// old code's last frame to this one, and that frame's own time.
let reporting = null;
function firstDrawn(cost) {
    if (!reporting) return;
    const { again, said, ran, more } = reporting, still = performance.now() - again.stopped, compiled = warmed;
    reporting = warmed = null;
    const timing = `the game stood still ${Math.round(still)} ms (its first frame ${Math.round(cost)} ms`
        + `${compiled == null ? '' : `, drawn once its shaders had compiled in ${Math.round(compiled)} ms`})`;
    log(again.change.quiet ? `Lamp: put in what was built in the background${said ? ` (${said})` : ''}; ${timing}.`
        : `Lamp: the game's code ran again in place${said ? ` (${said})` : ''} in ${Math.round(ran)} ms; ${timing}.`);
    tellHost(again.change.gen, 'report', said, { ...more, frozen: Math.round(still), firstFrame: Math.round(cost) });
}

// New code that fails before it's running opens the page again, from the same place.
function ranAgainFailed(again, e) {
    if (runningAgain !== again) return new Promise(() => {});
    runningAgain = null;
    log(`Error: ${e && e.message || e}`);
    reopen({ ...again.change, why: `the game's code run again failed (${e && e.message || e})` }, again.state);
    return new Promise(() => {});
}
if (!preview) {
    // Until the new code is running (`ranAgain`), anything it throws opens the page again: half a start is no place to play.
    listen(window, 'error', e => { if (runningAgain) ranAgainFailed(runningAgain, e.error || e.message); });
    listen(window, 'unhandledrejection', e => { if (runningAgain) ranAgainFailed(runningAgain, e.reason); });
}

// What the game's code leaves running: each listener by its target (held weakly, so an element thrown away goes with
// its listeners), timers, sound contexts and workers.
const listening = new Set(), listenersOf = new WeakMap(), timeouts = new Set(), intervals = new Set(), owned = new Set();
const captureOf = options => typeof options === 'boolean' ? options : !!(options && options.capture);
function watch() {
    watching = true;
    // A call with no receiver (`addEventListener(...)` written without `window.`) is the window's, as it is to the
    // browser's own function, which also turns down anything that isn't an event target before it's recorded.
    EventTarget.prototype.addEventListener = function (type, fn, options) {
        const target = this ?? window;
        browser.listen.call(target, type, fn, options);
        if (fn == null || keeping) return;
        let list = listenersOf.get(target);
        if (!list) {
            listenersOf.set(target, list = []);
            listening.add(new WeakRef(target));
            if (listening.size > 4000) for (const ref of listening) if (!ref.deref()) listening.delete(ref);
        }
        const listener = { type, fn, capture: captureOf(options) };
        list.push(listener);
        for (const waiting of keepsWaiting) waiting.added.push([target, listener]);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, options) {
        const target = this ?? window;
        browser.unlisten.call(target, type, fn, options);
        const list = listenersOf.get(target), capture = captureOf(options);
        if (list) { const i = list.findIndex(l => l.type === type && l.fn === fn && l.capture === capture); if (i >= 0) list.splice(i, 1); }
    };
    // A timer started while an async part's build waits is recorded against that part, and so is every timer its
    // callbacks start after (one that schedules its next tick), so the part is built again while any is running.
    const owners = () => [...[...keepsWaiting].map(waiting => waiting.timers), ...(timedFor || [])];
    const runFor = (lists, fn) => lists.length ? (...a) => { const was = timedFor; timedFor = lists; try { return fn(...a); } finally { timedFor = was; } } : fn;
    window.setTimeout = function (fn, ms, ...rest) {
        if (keeping || typeof fn !== 'function') return browser.setTimeout.call(window, fn, ms, ...rest);
        const lists = owners(), run = runFor(lists, fn);
        const id = browser.setTimeout.call(window, (...a) => { timeouts.delete(id); run(...a); }, ms, ...rest);
        timeouts.add(id);
        for (const list of lists) list.push(id);
        return id;
    };
    window.clearTimeout = id => { timeouts.delete(id); browser.clearTimeout.call(window, id); };
    window.setInterval = function (fn, ms, ...rest) {
        if (keeping || typeof fn !== 'function') return browser.setInterval.call(window, fn, ms, ...rest);
        const lists = owners();
        const id = browser.setInterval.call(window, runFor(lists, fn), ms, ...rest);
        intervals.add(id);
        for (const list of lists) list.push(id);
        return id;
    };
    window.clearInterval = id => { intervals.delete(id); browser.clearInterval.call(window, id); };
    const owning = (Made, end) => {
        const Watched = function (...args) {
            const made = new Made(...args);
            if (!keeping) {
                const ending = () => end(made);
                owned.add(ending);
                for (const waiting of keepsWaiting) waiting.made.push([made, ending]);
            }
            return made;
        };
        Watched.prototype = Made.prototype;
        return Watched;
    };
    if (browser.AudioContext) window.AudioContext = window.webkitAudioContext = owning(browser.AudioContext, c => c.state !== 'closed' && c.close());
    if (browser.Worker) {
        const Started = owning(browser.Worker, w => w.terminate());
        window.Worker = function (url, ...rest) {
            const path = pathOf(String(url));
            if (path != null) read(clean(path));
            workerStarted = true;
            return new Started(url, ...rest);
        };
        window.Worker.prototype = browser.Worker.prototype;
    }
    watchPhones();
}

function takeAwayLeft() {
    for (const ref of listening) {
        const target = ref.deref();
        if (!target) continue;
        for (const { type, fn, capture } of listenersOf.get(target) || []) browser.unlisten.call(target, type, fn, capture);
        listenersOf.delete(target);
    }
    listening.clear();
    for (const id of timeouts) browser.clearTimeout.call(window, id);
    for (const id of intervals) browser.clearInterval.call(window, id);
    timeouts.clear(); intervals.clear();
    for (const end of owned) { try { end(); } catch (e) {} }
    owned.clear();
}

// Phones belong to the page, as its link to them and their numbers do: running the game's code again neither stops nor
// starts them, and lamp.js's timers go through the browser's own functions, so `takeAwayLeft` doesn't reach them. What
// the code asked to hear of them belongs to that run of the code. The old run's calls end as it stops, and the new run's
// wait until it's ready for its first frame: then it's told who left and who is here (`bringPhones`), and input goes on
// from there. Presses and messages from in between are never replayed; what's held now is in `isHeld()`. A part the
// game kept keeps hearing what it asked to, all along.
const PHONE_EVENTS = ['onLink', 'onJoin', 'onLeave', 'onButton', 'onAxis', 'onMessage', 'onFile', 'onError'];
const PHONE_LASTING = ['onLink', 'onError'];   // about the session, not a player's input: nothing to wait for
const phoneCalls = new Set();
let phones = null, phonesWaiting = null;

function watchPhones() {
    phones = window.Lamp && window.Lamp.controllers;
    if (!phones) return;
    // A file that starts while no game's code can take it is turned down, so the phone says so rather than waiting.
    phones.onFile((player, file) => { if (phonesWaiting) file.cancel(); });
    for (const name of PHONE_EVENTS) {
        const add = phones[name];
        phones[name] = fn => {
            if (typeof fn !== 'function') return add.call(phones, fn);
            const call = { name, fn, kept: keeping > 0 };
            const off = add.call(phones, (...args) => {
                if (!phonesWaiting || call.kept || PHONE_LASTING.includes(name)) fn(...args);
            });
            call.end = () => { call.ended = true; phoneCalls.delete(call); off(); };
            if (!call.kept) phoneCalls.add(call);
            if (phonesWaiting) phonesWaiting.calls.push(call);
            return call.end;
        };
    }
    const stop = phones.stop;
    phones.stop = (...args) => {
        if (phonesWaiting && phonesWaiting.leaving) { log('Lamp: the phones stay joined while the game\'s code runs again.'); return; }
        return stop.apply(phones, args);
    };
}

const phonesHere = () => phones ? phones.players() : [];

function holdPhones(players) {
    forgetPhoneEdges();
    if (!phones) return;
    phonesWaiting = { players, calls: [], leaving: true };
    for (const call of [...phoneCalls]) call.end();
}

function bringPhones() {
    const waited = phonesWaiting;
    phonesWaiting = null;
    if (!waited) return;
    const here = phones.players();
    const tell = (name, player) => {
        for (const call of waited.calls) {
            if (call.name !== name || call.ended) continue;
            try { call.fn(player); } catch (e) { log(`Error: ${name}: ${e && e.message || e}`); }
        }
    };
    for (const player of waited.players) if (!here.includes(player)) tell('onLeave', player);
    for (const player of here) tell('onJoin', player);
}

// Swapped code that fails in its first second: the page opens again from where the player was before the swap.
function swapFailed(e) {
    const guard = swapGuard;
    swapGuard = null;
    reopen({ ...guard.change, why: `the code swapped in failed as it ran (${e && e.message || e})` }, guard.state);
}
if (!preview) window.addEventListener('error', e => { if (swapGuard) swapFailed(e.error || e.message); });

function keepLast() {
    if (!buildID) return;
    const snap = takeSnapshot();
    if (snap == null) return;
    try { store('local').setItem(LAST, JSON.stringify({ build: buildID, at: Date.now(), ...snap, input: current })); } catch (e) {}
}
if (!preview) {
    window.addEventListener('pagehide', () => { if (started) keepLast(); });
    document.addEventListener('visibilitychange', () => { if (started && document.hidden) keepLast(); });
}

// Where this copy of the page starts: the place it kept for its reopening, or else the latest snapshot of an older
// build (Lamp installed a new one since). Taken from storage as it's read, so it's restored at most once.
async function claim() {
    const session = store('session'), local = store('local');
    let said = null;
    try { said = JSON.parse(session.getItem(LIVE) || 'null'); session.removeItem(LIVE); reopened = !!said; } catch (e) {}
    if (said && said.fresh) { tellHost(said.gen, 'fresh'); return; }
    const id = await build;
    if (!said) {
        try {
            const last = JSON.parse(local.getItem(LAST) || 'null');
            // Within a quarter of an hour: an install that follows a change, not a game opened again another day.
            if (last && id && last.build !== id && Date.now() - last.at < 15 * 60 * 1000) { said = last; local.removeItem(LAST); }
        } catch (e) {}
    }
    if (said && said.input && said.input.kind) { current = said.input; padName = said.padName || ''; for (const changed of listeners) try { changed(input()); } catch (e) {} }
    pending = said;
    if (said && (said.state != null || said.held)) {
        // An error while the game starts from the state (in a Phaser scene's create, say, or the first frame) is the
        // state not taking.
        listen(window, 'error', e => { if (guarding) startFresh(e.error || e.message); });
    }
}

// The state the game was in before a change of its code (what snapshot() gave), for the game to start from; null when
// it starts fresh, and once it has started. Read it in init (or a Phaser scene's init or create) and build that place
// instead of the title or intro: reading it is the restore, and restore() isn't called.
export function pendingRestore() {
    asksPlace = true;
    if (started || !pending || pending.state == null) return null;
    taken = guarding = true;
    return pending.state;
}

// After init: a game that didn't read the state is given it through restore(), before its first frame.
async function putBack() {
    const said = pending;
    if (reopened && said && !said.fresh) shownFor = said.gen;
    if (taken) {
        log(reopened ? 'Lamp: the game started where it was, with the new code.' : 'Lamp: the game started where it was before it was installed again.');
        tellHost(said.gen, 'restored');
    } else if (said && said.state != null && hooks.restore) {
        guarding = true;
        try {
            await hooks.restore(said.state);
            log(reopened ? 'Lamp: the game is back where it was, with the new code.' : 'Lamp: the game is back where it was before it was installed again.');
            tellHost(said.gen, 'restored');
        } catch (e) { return startFresh(e); }
    } else if (said && said.held) {
        log(reopened ? 'Lamp: the game is back where it was, with the new code.' : 'Lamp: the game is back where it was before it was installed again.');
        tellHost(said.gen, 'restored');
    } else if (reopened && said && !said.fresh) tellHost(said.gen, 'started');
    if (reopened && said && !said.fresh && !runningAgain) {
        for (const entry of cameras.values()) if (said.held && said.held.cameras[entry.id]) tally.kept.push(`camera ${entry.id}`);
        tally.built.push(...[...kept.values()].map(k => ({ key: k.key, ms: k.ms, cause: null })));
        tellHost(said.gen, 'report', cameThrough(), {
            built: tally.built.map(k => ({ part: k.key, ...(k.ms == null ? {} : { ms: Math.round(k.ms) }) })), kept: tally.kept.length, waits: [] });
    }
    pending = null;
    restoring = null;
    started = true;
}

// Half put back is worse than fresh: the page opens once more without the snapshot.
function startFresh(e) {
    if (!guarding && !taken) return;
    guarding = taken = false;
    log(`Lamp: couldn't put the game back where it was (${e && e.message || e}), so it starts fresh.`);
    try { store('session').setItem(LIVE, JSON.stringify({ fresh: true, gen: pending && pending.gen })); } catch (e2) {}
    location.reload();
    return new Promise(() => {});
}

function showPill() {
    if (pill) { pill.style.display = 'block'; return; }
    pill = document.createElement('button');
    pill.textContent = 'Reload to apply';
    pill.style.cssText = 'position:fixed;z-index:20;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom));'
        + 'padding:8px 16px;border:0;border-radius:18px;background:rgba(20,20,24,.72);color:#fff;font:600 15px -apple-system,system-ui,sans-serif;'
        + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)';
    const press = e => { e.stopPropagation(); e.preventDefault(); if (waiting) { const change = { ...waiting, now: true }; waiting = null; queue = queue.then(() => change.reopens ? reopen(change) : startAgain(change)); } };
    listen(pill, 'pointerdown', press);
    document.body.append(pill);
}
function hidePill() { if (pill) pill.style.display = 'none'; }

// MARK: Lamp's preview: the script played out of sight, a picture where it says
//
// A preview Lamp keeps open between looks (`warm`) is handed each new play with the files changed since the last:
// the game's code runs again in place from a fresh start (see "Running the game's code again"), with the clock, the
// seed, the saves and the log as a new page has them, keeping what the game keeps, and the script plays. So only the
// first play of a while builds the whole game. A kept part skips the random numbers its build drew, so the same script
// gives the same pictures as a cold play; one whose async build drew any while it waited is built again. Returns false
// when it can't (the game hasn't started, or is starting), and Lamp opens a new preview.
// Where a play that has run long has got to, for Lamp to say: whether game() has been called, and the last lines logged.
if (preview) window.__lampPreviewState = () => ({ started: !!frameFunction, logs: logs.slice(-20) });
if (preview && preview.warm) {
    window.__lampPreviewAgain = next => {
        if (!frameFunction || runningAgain) return false;
        preview.script = next.script || [];
        // Files loaded afresh, under a new query, as a change in the open game has them.
        changes++;
        seed = 1n; clock = 0; time = 0; number = 0;
        saved.clear(); played.clear(); logs.length = 0;
        scripted = null; before = [0, 0, 0, 0];
        queue = queue.then(() => startAgain({ gen: 0, changed: next.changed || [], why: 'a new play in the preview' }, null))
            .catch(e => window.webkit.messageHandlers.lampPreview.postMessage({ done: true, again: false, logs: [String(e && e.message || e)] }));
        return true;
    };
}

// The game's phone page in the preview (`PhonePreview`): a `phone` line of the script is a step on the page, and the
// messages both ways wait for such a step, so they arrive between the same two frames in every play. The page's clock
// goes by the game's frames, handed over at each step, since a play runs far faster than the time it stands for. To the
// game the phone is a player that came another way than the relay (`Lamp.controllers._attach`).
let phone = null;
async function phoneStep(step) {
    if (!phone) {
        phone = { hooks: null, here: false, joined: false, out: [], frames: 0,
                  start(hooks) { this.hooks = hooks; },
                  stop() { this.hooks = null; this.joined = false; } };
        phone.route = { key: 'phone', place: 0, text: m => (phone.out.push(m), true),
                        say: data => (phone.out.push({ t: 'message', data }), true), binary: () => false, buffered: () => 0 };
        const controllers = window.Lamp && window.Lamp.controllers;
        if (controllers && controllers._attach) controllers._attach(phone);
    }
    // A page not joined yet gets its player number and what the game says on a join first: a person's press comes after
    // those, and a page may hold its controls until it has them.
    if (!phone.joined) await phoneExchange({ do: 'sync' });
    await phoneExchange(step);
}

async function phoneExchange(step) {
    const post = message => window.webkit.messageHandlers.lampPreview.postMessage(message);
    // Round again while either side has more to say: a game answers a join, and the page its player number, at once.
    for (let round = 0, next = step; round < 4; round++, next = { do: 'sync' }) {
        const elapsed = phone.frames * 1000 / 60;
        phone.frames = 0;
        const answer = await post({ phone: next, inbox: JSON.stringify(phone.out.splice(0)), hosted: !!phone.hooks, elapsed });
        if (answer == null) { log('Lamp: the phone page did not open in the preview.'); return; }
        const messages = JSON.parse(answer).messages || [];
        for (const m of messages) {
            if (m.t === 'hello') phone.here = true;
            if (m.t === 'bye') { phone.here = false; if (phone.joined) phone.hooks.leave('phone'); phone.joined = false; }
            // A game that starts its controllers after the page opened has it join then.
            if (phone.here && phone.hooks && !phone.joined) { phone.hooks.join('phone', phone.route); phone.joined = true; }
            if (phone.joined && m.t !== 'hello') phone.hooks.input('phone', m);
        }
        if (phone.here && phone.hooks && !phone.joined) { phone.hooks.join('phone', phone.route); phone.joined = true; }
        if (!messages.length && !phone.out.length) return;
    }
}

async function runPreview() {
    // Lamp answers each picture once it has taken it, of the whole page as drawn (the canvas and anything over it).
    const post = message => window.webkit.messageHandlers.lampPreview.postMessage(message);
    let mostCalls = 0, mostTriangles = 0, triangles = 0, frames = 0;
    const limit = 60 * 600;
    // The game is built: what's left is the play itself. Lamp times the build by this, to know how long the next may take.
    post({ playing: true });
    for (const line of preview.script) {
        const words = line.trim().split(/\s+/);
        if (words[0] === 'phone') {
            await phoneStep(JSON.parse(line.trim().slice(6)));
            continue;
        }
        if (words[0] === 'shot') {
            if (phone) await phoneStep({ do: 'sync' });
            await post({ shot: words[1] });
            continue;
        }
        if (words[0] !== 'hold') continue;
        const [n, lx, ly, rx, ry, lt, rt, down] = words.slice(1).map(Number);
        scripted = { lx, ly, rx, ry, lt, rt, down: down | 0 };
        for (let i = 0; i < n && frames < limit; i++) {
            window.__lampAdvance(1000 / 60);
            renderer.info.reset();
            renderer.info.autoReset = false;
            try { const waiting = step(1 / 60); if (waiting && waiting.then) await waiting; } catch (e) { log(`Error: ${e.message}`); post({ done: true, failed: e.message, logs }); return; }
            const info = renderer.info.render;
            mostCalls = Math.max(mostCalls, info.calls);
            mostTriangles = Math.max(mostTriangles, info.triangles);
            triangles += info.triangles;
            frames++;
            if (phone) phone.frames++;
        }
    }
    const said = [...played.entries()].map(([name, count]) => count > 1 ? `${name} ${count} times` : name);
    post({ done: true, logs,
           stats: `${frames} frames (${(frames / 60).toFixed(1)} s of play); at most ${mostCalls} draws and ${mostTriangles} triangles in a frame, ${Math.round(frames ? triangles / frames : 0)} triangles a frame on average.`,
           sound: said.length ? 'played ' + said.join(', ') : 'nothing played' });
}

// Heard for as long as the page lasts, under what `watchPhones` wraps, so it belongs to no run of the game's code.
if (window.Lamp && window.Lamp.controllers) {
    window.Lamp.controllers.onButton(phoneButton);
    window.Lamp.controllers.onLeave(player => phoneButtons.delete(player));
}

// Watched from here, after the runtime's own listeners: only where Lamp puts changes into the open game, or plays
// again in a preview it keeps warm.
if (preview ? preview.warm : host()) watch();
