/**
 * app.js -- wiring: microphone -> analysis -> picture, plus the controls.
 *
 * Two analysis paths run side by side on every frame. The temporal path works
 * straight off the waveform and owns everything that needs millisecond
 * resolution: level, roughness, F0 and periodicity. The spectral path takes the
 * FFT and owns the envelope that gets drawn, plus the measures that are
 * summaries of that envelope. The gate needs both, so temporal runs first and
 * hands its periodicity to spectral.
 *
 * There is no target and no score anywhere in here.
 */

import { startMic, describeMicError, FFT_SIZE } from './audio.js';
import { createSpectralAnalyzer, specPos, SPEC_BANDS } from './spectral.js';
import { createTemporalAnalyzer } from './temporal.js';
import { createRenderer } from './viz.js';

const el = (id) => document.getElementById(id);

const ui = {
  gate: el('gate'), startBtn: el('startBtn'), gateErr: el('gateErr'),
  app: el('app'), canvas: el('view'),
  banner: el('banner'), bannerText: el('bannerText'),
  clearTrailBtn: el('clearTrailBtn'), roomBtn: el('roomBtn'),
  showCog: el('showCog'),
  bright: el('bright'), brightOut: el('brightOut'),
  tilt: el('tilt'), tiltOut: el('tiltOut'),
  collapseBtn: el('collapseBtn'), panelBody: el('panelBody'),
  roCog: el('roCog'), roSpread: el('roSpread'), roFocus: el('roFocus'),
  roHf: el('roHf'), roRough: el('roRough'), roNotch: el('roNotch'),
  roStab: el('roStab'), roVoice: el('roVoice'), roF0: el('roF0'),
  roLevel: el('roLevel'), roAbove: el('roAbove'),
};

let mic = null;
let spectral = null;
let temporal = null;
let renderer = null;
let raf = 0;

/**
 * Two smoothed copies of the spectrum. A single FFT frame of fricative noise
 * is genuinely speckly -- noise is noise -- so both views get a short
 * exponential average in time and a light average across bands. The field is
 * smoothed less than the shape, because on the field time is an axis.
 */
/**
 * How far above the measured room floor a sound must rise before it is treated
 * as sound at all. This was a slider; it is now fixed, because it only ever
 * needed to keep the room itself out of the numbers, and a control that does
 * nothing visible to the picture is a control that gets fiddled with for no
 * reason.
 */
const GATE_DB = 6;

const fieldSpec = new Float32Array(SPEC_BANDS);
const fieldTmp = new Float32Array(SPEC_BANDS);
const dispSpec = new Float32Array(SPEC_BANDS);

const state = {
  spectrum: dispSpec,
  // The renderer can still lay a frozen outline over the live shape, and the
  // analyzer can still pin the brightness scale to one. Neither has a control
  // any more; both are left in place rather than deleted, since this project
  // has no version control to recover them from.
  reference: null,
  referenceLabel: '',
  notch: null,
  opts: { showCog: true },
};

let colAcc = 0;
let lastReadoutAt = 0;
let bannerTimer = 0;
let smRough = 0;        // gated on sound, drives the grain
let smRoughRaw = 0;     // ungated, shown in the readout for diagnosis

/* ---------------- start ---------------- */

ui.startBtn.addEventListener('click', async () => {
  ui.startBtn.disabled = true;
  ui.startBtn.textContent = 'Starting…';
  ui.gateErr.hidden = true;
  try {
    mic = await startMic();
    spectral = createSpectralAnalyzer(mic.sampleRate, FFT_SIZE);
    temporal = createTemporalAnalyzer(mic.sampleRate, FFT_SIZE);

    ui.gate.hidden = true;
    ui.app.hidden = false;

    renderer = createRenderer(ui.canvas);
    renderer.resize();
    window.addEventListener('resize', () => renderer.resize());
    if (window.ResizeObserver) new ResizeObserver(() => renderer.resize()).observe(ui.canvas);

    warnAboutCapture();
    pushDisplaySettings();
    measureRoom();

    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      tick(dt, now / 1000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  } catch (err) {
    ui.startBtn.disabled = false;
    ui.startBtn.textContent = 'Turn on the microphone';
    ui.gateErr.textContent = describeMicError(err);
    ui.gateErr.hidden = false;
  }
});

function warnAboutCapture() {
  const notes = [];
  if (mic.anyProcessingOn) {
    const on = Object.entries(mic.processing)
      .filter(([, v]) => v === true)
      .map(([k]) => k.replace(/([A-Z])/g, ' $1').toLowerCase().trim());
    notes.push('Browser audio processing is still active (' + on.join(', ') +
      '). The picture will be coloured by it.');
  }
  if (mic.lowRate) {
    notes.push('Input is running at ' + mic.sampleRate + ' Hz, which cuts off the ' +
      'frequencies where /s/ lives. Choose another microphone if you can.');
  }
  if (notes.length) {
    const p = document.createElement('p');
    p.className = 'warn';
    p.textContent = notes.join(' ');
    ui.panelBody.prepend(p);
  }
}

/* ---------------- banner ---------------- */

function showBanner(text, ms) {
  ui.bannerText.textContent = text;
  ui.banner.hidden = false;
  clearTimeout(bannerTimer);
  if (ms) bannerTimer = setTimeout(() => { ui.banner.hidden = true; }, ms);
}

function measureRoom() {
  spectral.startNoiseLearn(48);
  showBanner('Recording the room — stay quiet for a moment…', 0);
}

/* ---------------- hold to record the room ---------------- */

/**
 * Press and hold rather than a single click. The capture lasts exactly as long
 * as the button is held, which makes it obvious that something is being
 * recorded and lets the clinician take a longer, better sample of a difficult
 * room. Releasing anywhere ends it, so dragging off the button cannot leave
 * the capture running.
 */
const ROOM_LABEL = 'Press and hold to record and remove background noise';
/** Shorter than this is a slip of the finger, not a capture. */
const MIN_HOLD_SECONDS = 0.4;
let holdingRoom = false;
let holdStartedAt = 0;

function beginRoomHold(ev) {
  if (holdingRoom || !spectral) return;
  if (ev && ev.preventDefault) ev.preventDefault();
  holdingRoom = true;
  holdStartedAt = performance.now();
  spectral.beginNoiseHold();
  ui.roomBtn.setAttribute('aria-busy', 'true');
  ui.roomBtn.textContent = 'Recording… release when done';
  showBanner('Recording the room — keep quiet…', 0);
}

function endRoomHold() {
  if (!holdingRoom) return;
  holdingRoom = false;
  const seconds = (performance.now() - holdStartedAt) / 1000;
  const { accepted } = spectral.endNoiseHold(seconds >= MIN_HOLD_SECONDS);
  ui.roomBtn.removeAttribute('aria-busy');
  ui.roomBtn.textContent = ROOM_LABEL;
  if (!accepted) {
    showBanner('Too brief to use — hold it for a second or two', 2400);
  } else {
    showBanner('Background noise removed — ' + seconds.toFixed(1) +
      ' s recorded', 2000);
  }
}

ui.roomBtn.addEventListener('pointerdown', beginRoomHold);
ui.roomBtn.addEventListener('pointercancel', endRoomHold);
window.addEventListener('pointerup', endRoomHold);
window.addEventListener('blur', endRoomHold);

// Keyboard equivalent. keydown repeats while held, which the guard absorbs.
ui.roomBtn.addEventListener('keydown', (ev) => {
  if (ev.key === ' ' || ev.key === 'Enter') beginRoomHold(ev);
});
ui.roomBtn.addEventListener('keyup', (ev) => {
  if (ev.key === ' ' || ev.key === 'Enter') endRoomHold();
});

/* ---------------- main loop ---------------- */

function tick(dt, now) {
  mic.analyser.getFloatFrequencyData(mic.freqData);
  mic.analyser.getFloatTimeDomainData(mic.timeData);

  const t = temporal.analyze(mic.timeData);
  const f = spectral.analyze(mic.freqData, {
    gateDb: GATE_DB,
    periodicity: t.periodicity,
  });

  if (f.learningNoise) {
    renderer.draw(state);
    return;
  }
  if (!ui.banner.hidden && !holdingRoom) ui.banner.hidden = true;

  const aField = 1 - Math.exp(-dt / 0.030);
  const aShape = 1 - Math.exp(-dt / 0.055);

  for (let i = 0; i < SPEC_BANDS; i++) {
    fieldTmp[i] += (f.spectrum[i] - fieldTmp[i]) * aField;
    dispSpec[i] += (f.spectrum[i] - dispSpec[i]) * aShape;
  }
  blur3(fieldTmp, fieldSpec);

  // Roughness drives the grain. It rises in 25 ms and falls in 50: with one
  // slower time constant an R's grain spilled a fifth of a second into the
  // following vowel, and a short R never reached its full strength.
  //
  // Not gated, exactly as in the perceptual app. Grain is drawn only where
  // the spectrogram itself draws something, so silence stays smooth on its
  // own. Zeroing the raggedness whenever the loudness gate shut -- as this
  // did -- made the grain drop out of a quieter R hovering near the gate
  // while the spectrogram went on drawing the R, which is the case where
  // this app looked worse than the perceptual one. Gating on the sibilant
  // gate before that was worse still: a French R never opens it.
  smRough += (t.rough - smRough) * (1 - Math.exp(-dt / (t.rough > smRough ? 0.025 : 0.050)));
  smRoughRaw = smRough;

  state.notch = f.notch;
  state.rough = smRough;

  // Lay the history down on a clock, not on the frame rate, so the time axis
  // stays honest on a slow machine.
  colAcc += dt * renderer.colsPerSec;
  let cols = Math.floor(colAcc);
  colAcc -= cols;
  cols = Math.min(cols, 4);
  const cogPos = f.loud ? specPos(f.cogHz) : -1;
  for (let i = 0; i < cols; i++) {
    renderer.pushColumn(fieldSpec, cogPos, smRough, f.voicing, t.f0Hz);
  }

  state.opts.showCog = ui.showCog.checked;
  renderer.draw(state);

  if (now - lastReadoutAt > 0.12) {
    lastReadoutAt = now;
    updateReadouts(f, t);
  }
}

/* ---------------- readouts ---------------- */

function updateReadouts(f, t) {
  const dash = '—';

  ui.roLevel.textContent = f.levelAllDb > -119 ? f.levelAllDb.toFixed(0) + ' dB' : dash;
  // The single most diagnostic number in the panel: how far the current sound
  // sits above the recorded room, and therefore why anything is or is not
  // being reported.
  ui.roAbove.textContent = (f.aboveFloorDb >= 0 ? '+' : '') +
    f.aboveFloorDb.toFixed(0) + ' dB' + (f.loud ? '' : ' (below ' + GATE_DB + ')');
  ui.roF0.textContent = t.f0Hz > 0 && f.voicing > 0.3 ? Math.round(t.f0Hz) + ' Hz' : dash;
  ui.roRough.textContent = smRoughRaw.toFixed(2);

  if (!f.loud) {
    ui.roCog.textContent = dash;
    ui.roSpread.textContent = dash;
    ui.roFocus.textContent = dash;
    ui.roHf.textContent = dash;
    ui.roNotch.textContent = dash;
    ui.roStab.textContent = dash;
    ui.roVoice.textContent = dash;
    return;
  }
  ui.roCog.textContent = Math.round(f.cogHz) + ' Hz';
  ui.roSpread.textContent = f.spreadOct.toFixed(2) + ' oct';
  ui.roFocus.textContent = f.focus.toFixed(2);
  ui.roHf.textContent = f.hfRatio.toFixed(2);
  ui.roRough.textContent = smRough.toFixed(2);
  ui.roNotch.textContent = f.notch
    ? Math.round(f.notch.hz) + ' Hz, ' + f.notch.depthDb.toFixed(0) + ' dB'
    : 'none';
  ui.roStab.textContent = f.steadiness.toFixed(2);
  // Numeric, not just a word: when voicing misbehaves, the only way to tell
  // whether detection or drawing is at fault is to see the value.
  ui.roVoice.textContent = f.voicing.toFixed(2) +
    (f.voicing > 0.5 ? ' voiced' : f.voicing > 0.12 ? ' weak' : '');
}

/* ---------------- other controls ---------------- */

ui.clearTrailBtn.addEventListener('click', () => renderer && renderer.clearHistory());

function pushDisplaySettings() {
  const gainDb = Number(ui.bright.value);
  const tiltDbPerOct = Number(ui.tilt.value);
  ui.brightOut.textContent = (gainDb > 0 ? '+' : '') + gainDb + ' dB';
  ui.tiltOut.textContent = (tiltDbPerOct > 0 ? '+' : '') + tiltDbPerOct + ' dB/oct';
  if (spectral) spectral.setDisplay({ gainDb, tiltDbPerOct });
}
ui.bright.addEventListener('input', pushDisplaySettings);
ui.tilt.addEventListener('input', pushDisplaySettings);

ui.collapseBtn.addEventListener('click', () => {
  const collapsed = ui.app.classList.toggle('collapsed');
  ui.collapseBtn.textContent = collapsed ? 'Show' : 'Hide';
  ui.collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  if (renderer) requestAnimationFrame(() => renderer.resize());
});

/* ---------------- helpers ---------------- */

/** Three-tap average across neighbouring bands. */
function blur3(src, dst) {
  const n = SPEC_BANDS;
  dst[0] = (src[0] * 2 + src[1]) / 3;
  dst[n - 1] = (src[n - 1] * 2 + src[n - 2]) / 3;
  for (let i = 1; i < n - 1; i++) {
    dst[i] = (src[i - 1] + src[i] * 2 + src[i + 1]) * 0.25;
  }
}

window.addEventListener('beforeunload', () => {
  if (raf) cancelAnimationFrame(raf);
  if (mic) mic.stop();
});
