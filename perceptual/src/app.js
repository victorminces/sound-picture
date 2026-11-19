/**
 * app.js -- wiring.
 *
 * Order matters in the loop below and the comments say why at each step. The
 * short version: everything is measured on the room-removed power spectrum
 * except the decision about whether there is a sound at all, which has to be
 * made on the raw one.
 */

import { startMic, describeMicError, FFT_SIZE } from './audio.js';
import { createNoiseFloor } from './noise.js';
import { createAuditoryModel } from './auditory.js';
import { createDimensions } from './dimensions.js';
import { createModulation } from './modulation.js';
import { createRenderer } from './viz.js';

const el = (id) => document.getElementById(id);
const ui = {
  stage: el('stage'),
  canvas: el('field'),
  start: el('start'),
  startWrap: el('startWrap'),
  status: el('status'),
  banner: el('banner'),
  roomBtn: el('roomBtn'),
  clearBtn: el('clearBtn'),
  mapToggle: el('mapToggle'),
  rangeLo: el('rangeLo'),
  rangeHi: el('rangeHi'),
  rangeOut: el('rangeOut'),
  grain: el('grain'),
  grainOut: el('grainOut'),
  grainContrast: el('grainContrast'),
  grainContrastOut: el('grainContrastOut'),
  grainThreshold: el('grainThreshold'),
  grainThresholdOut: el('grainThresholdOut'),
  out: {
    sharpness: el('oSharp'),
    spread: el('oSpread'),
    rough: el('oRough'),
    fluct: el('oFluct'),
    voicing: el('oVoice'),
    f0: el('oF0'),
    loudness: el('oLoud'),
    margin: el('oMargin'),
  },
};

/** A sound has to clear the measured room by this much to be drawn. */
const GATE_DB = 6;

/**
 * The automatic capture at startup, in seconds and in frames -- it ends when
 * BOTH have been satisfied.
 *
 * Seconds because a frame count is not a duration. A browser throttles
 * animation callbacks hard when its window is not the one in front, and at
 * the couple of frames a second that produces, a capture of "45 frames" is a
 * capture of half a minute, with the app showing nothing at all the whole
 * time and no sign of why. Frames because the median underneath needs a
 * population to be a median of, and a slow machine must not be given a floor
 * estimated from three frames.
 */
const STARTUP_SECONDS = 0.9;
const STARTUP_FRAMES = 10;
const ROOM_LABEL = 'Press and hold to record the room';
const MIN_HOLD_SECONDS = 0.4;

/** Display mapping for spread, in Bark. Measured, not guessed: a focused
 *  hiss sits near 3.5 and a smeared one near 5.6. */
const SPREAD_LO = 3.2, SPREAD_HI = 5.8;

let mic = null, floor = null, model = null, dims = null, mod = null;
let renderer = null;
let running = false;
let raf = 0, lastT = 0, colAcc = 0;
let startupUntil = 0, startupFrames = 0;

/** Smoothed display state. */
const sm = {
  sharpness: 2.0, spread: 0.5, level: 0, rough: 0, fluct: 0, voicing: 0,
};
let peakLoud = 1e-6;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function showBanner(text, ms) {
  ui.banner.textContent = text;
  ui.banner.hidden = false;
  if (ms) setTimeout(() => { ui.banner.hidden = true; }, ms);
}

function setStatus(text, kind) {
  ui.status.textContent = text || '';
  ui.status.className = 'status' + (kind ? ' ' + kind : '');
}

/* ---------------- hold to record the room ---------------- */

let holding = false, holdStart = 0;

function beginHold(ev) {
  if (holding || !floor) return;
  if (ev && ev.preventDefault) ev.preventDefault();
  holding = true;
  holdStart = performance.now();
  floor.beginHold();
  ui.roomBtn.setAttribute('aria-busy', 'true');
  ui.roomBtn.textContent = 'Recording… release when done';
  showBanner('Recording the room — keep quiet…', 0);
}

function endHold() {
  if (!holding) return;
  holding = false;
  const seconds = (performance.now() - holdStart) / 1000;
  const { accepted } = floor.endHold(seconds >= MIN_HOLD_SECONDS);
  ui.roomBtn.removeAttribute('aria-busy');
  ui.roomBtn.textContent = ROOM_LABEL;
  showBanner(accepted
    ? 'Room removed — ' + seconds.toFixed(1) + ' s recorded'
    : 'Too brief to use — hold it for a second or two', 2400);
}

ui.roomBtn.addEventListener('pointerdown', beginHold);
ui.roomBtn.addEventListener('pointercancel', endHold);
window.addEventListener('pointerup', endHold);
window.addEventListener('blur', endHold);
ui.roomBtn.addEventListener('keydown', (ev) => {
  if (ev.key === ' ' || ev.key === 'Enter') beginHold(ev);
});
ui.roomBtn.addEventListener('keyup', (ev) => {
  if (ev.key === ' ' || ev.key === 'Enter') endHold();
});

/* ---------------- controls ---------------- */

function pushRange() {
  const lo = Number(ui.rangeLo.value), hi = Number(ui.rangeHi.value);
  const a = Math.min(lo, hi - 0.5), b = Math.max(hi, lo + 0.5);
  ui.rangeOut.textContent = a.toFixed(1) + ' – ' + b.toFixed(1);
  if (renderer) renderer.setRange(a, b);
}
ui.rangeLo.addEventListener('input', pushRange);
ui.rangeHi.addEventListener('input', pushRange);
/**
 * Grain size is a control rather than a constant because what reads as a
 * texture depends on the screen, the viewing distance and the child. The
 * therapist is the one looking at it and should not have to wait on a deploy
 * to change it.
 */
function pushGrain() {
  const px = Number(ui.grain.value);
  ui.grainOut.textContent = px + ' px';
  if (renderer) renderer.setGrain(px);
}
ui.grain.addEventListener('input', pushGrain);

function pushGrainContrast() {
  const v = Number(ui.grainContrast.value);
  ui.grainContrastOut.textContent = v + '%';
  if (renderer) renderer.setGrainContrast(v / 100);
}
ui.grainContrast.addEventListener('input', pushGrainContrast);

function pushGrainThreshold() {
  const v = Number(ui.grainThreshold.value);
  ui.grainThresholdOut.textContent = v.toFixed(2);
  if (renderer) renderer.setGrainThreshold(v);
}
ui.grainThreshold.addEventListener('input', pushGrainThreshold);

ui.clearBtn.addEventListener('click', () => { if (renderer) renderer.clear(); });
ui.mapToggle.addEventListener('change', () => {
  if (renderer) renderer.setMap(ui.mapToggle.checked);
});

/* ---------------- the loop ---------------- */

const power = new Float32Array(FFT_SIZE / 2);

function dbToPower(db) {
  return db <= -175 || !Number.isFinite(db) ? 0 : Math.pow(10, db / 10);
}

function tick(now) {
  raf = requestAnimationFrame(tick);
  const dt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
  lastT = now;

  mic.analyser.getFloatFrequencyData(mic.freqData);
  mic.analyser.getFloatTimeDomainData(mic.timeData);
  for (let i = 0; i < power.length; i++) power[i] = dbToPower(mic.freqData[i]);

  // The room capture consumes raw frames and nothing downstream runs while
  // it does -- measuring during a capture would measure the room.
  if (floor.learn(power)) {
    if (startupUntil) {
      startupFrames++;
      if (startupFrames >= STARTUP_FRAMES && performance.now() >= startupUntil) {
        floor.endHold(true);
        startupUntil = 0;
        ui.banner.hidden = true;
      }
    }
    renderer.draw({ active: false, level: 0 }, dt);
    return;
  }

  if (!ui.banner.hidden && !holding) ui.banner.hidden = true;

  // Asked of the RAW spectrum, before subtraction. Comparing a subtracted
  // signal against an unsubtracted floor understates the margin by roughly
  // the whole noise level.
  const marginDb = floor.marginDb(power);
  const loud = marginDb > GATE_DB;

  floor.subtract(power);
  const m = dims.measure(model.pattern(power));
  const t = mod.analyze(mic.timeData, dt);

  // Loudness is relative to this child's own recent speech. There is no
  // absolute reference available from a web microphone and pretending
  // otherwise would put a meaningless number on screen.
  if (m.loudness > peakLoud) peakLoud = m.loudness;
  else peakLoud = Math.max(1e-6, peakLoud * (1 - dt * 0.12));
  const level = loud ? clamp01(m.loudness / (peakLoud + 1e-9)) : 0;

  const voicing = loud ? clamp01((t.periodicity - 0.40) / 0.32) : 0;
  const spread = clamp01((m.spreadBark - SPREAD_LO) / (SPREAD_HI - SPREAD_LO));

  const aFast = 1 - Math.exp(-dt / 0.035);
  const aSlow = 1 - Math.exp(-dt / 0.090);
  if (loud) sm.sharpness += (m.sharpness - sm.sharpness) * aSlow;
  sm.spread += (spread - sm.spread) * aSlow;
  sm.level += (level - sm.level) * aFast;
  sm.rough += (t.rough - sm.rough) * aSlow;
  sm.fluct += (t.fluct - sm.fluct) * aSlow;
  sm.voicing += (voicing - sm.voicing) * aFast;

  const frame = {
    active: loud,
    level: sm.level,
    sharpness: sm.sharpness,
    spread: sm.spread,
    rough: sm.rough,
    fluct: sm.fluct,
    voicing: sm.voicing,
  };

  // One history column per fixed slice of time, not per animation frame, so
  // the ribbon scrolls at the same speed whatever the machine manages. The
  // cap stops a tab that was in the background from unspooling a minute of
  // history in one go when it comes back.
  colAcc += dt * renderer.colsPerSec;
  let pushes = 0;
  while (colAcc >= 1 && pushes < 8) { colAcc -= 1; pushes++; }
  for (let i = 0; i < pushes; i++) renderer.advance(frame, i === 0 ? dt : 0);
  renderer.draw(frame, dt);

  const o = ui.out;
  const show = (nodeKey, v) => { o[nodeKey].textContent = v; };
  if (loud) {
    show('sharpness', m.sharpness.toFixed(2));
    show('spread', m.spreadBark.toFixed(2) + ' Bark');
    show('rough', t.rough.toFixed(2) + '  (×' + t.roughRatio.toFixed(1) + ')');
    show('fluct', t.fluct.toFixed(2));
    show('voicing', voicing.toFixed(2));
    show('f0', voicing > 0.25 && t.f0Hz > 0 ? Math.round(t.f0Hz) + ' Hz' : '—');
    show('loudness', level.toFixed(2));
  } else {
    for (const k of ['sharpness', 'spread', 'rough', 'fluct', 'voicing', 'f0', 'loudness']) {
      show(k, '—');
    }
  }
  show('margin', marginDb.toFixed(1) + ' dB' + (loud ? '' : '  (below ' + GATE_DB + ')'));
}

/* ---------------- start ---------------- */

async function start() {
  ui.start.disabled = true;
  setStatus('Opening the microphone…');
  try {
    mic = await startMic();
  } catch (err) {
    ui.start.disabled = false;
    setStatus(describeMicError(err), 'bad');
    return;
  }

  floor = createNoiseFloor(mic.freqData.length, mic.sampleRate, FFT_SIZE);
  model = createAuditoryModel(mic.sampleRate, FFT_SIZE);
  dims = createDimensions(model);
  mod = createModulation(mic.sampleRate);
  renderer = createRenderer(ui.canvas);
  renderer.resize();
  pushRange();
  pushGrain();
  pushGrainContrast();
  pushGrainThreshold();
  renderer.setMap(ui.mapToggle.checked);

  const notes = [];
  if (mic.anyProcessingOn) {
    notes.push('the browser is still applying noise suppression or gain control, '
      + 'which reshapes exactly what this measures');
  }
  if (mic.lowRate) {
    notes.push('this device samples at ' + mic.sampleRate + ' Hz, too low to '
      + 'carry a child’s /s/');
  }
  setStatus(notes.length ? 'Note: ' + notes.join('; ') + '.' : mic.label, notes.length ? 'warn' : '');

  ui.startWrap.hidden = true;
  ui.stage.hidden = false;
  running = true;
  floor.beginHold();
  startupUntil = performance.now() + STARTUP_SECONDS * 1000;
  startupFrames = 0;
  showBanner('Listening to the room for a moment…', 0);
  lastT = 0;
  raf = requestAnimationFrame(tick);
}

ui.start.addEventListener('click', start);
window.addEventListener('resize', () => { if (renderer) renderer.resize(); });
window.addEventListener('beforeunload', () => {
  if (raf) cancelAnimationFrame(raf);
  if (mic) mic.stop();
});
