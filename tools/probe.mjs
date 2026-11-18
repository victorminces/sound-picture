/**
 * probe.mjs -- offline checks on the analysis, with no browser involved.
 *
 * Three sections:
 *   1. the gate opens for sibilants, voiced and voiceless, and stays shut for
 *      vowels and silence;
 *   2. each production draws a visibly different display spectrum;
 *   3. the flutter measure separates steady noise from modulated noise, which
 *      is what sets the two calibration constants in temporal.js.
 *
 * Run with:  npm run probe
 */

import { createSpectralAnalyzer, specPos } from '../src/spectral.js';
import { createTemporalAnalyzer } from '../src/temporal.js';

const SR = 48000, N = 2048, BINS = N / 2, BINHZ = SR / N;
const spectral = createSpectralAnalyzer(SR, N);
const temporal = createTemporalAnalyzer(SR, N);

/** Build a dB spectrum from gaussian humps placed in log-frequency space. */
function spec(humps, floorDb = -97) {
  const db = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const f = Math.max(20, i * BINHZ);
    let lin = Math.pow(10, floorDb / 10);
    for (const h of humps) {
      const d = (Math.log2(f) - Math.log2(h.f)) / h.w;
      lin += Math.pow(10, h.db / 10) * Math.exp(-0.5 * d * d);
    }
    db[i] = 10 * Math.log10(lin);
  }
  return db;
}

const unvoiced = new Float32Array(N);
for (let i = 0; i < N; i++) unvoiced[i] = 0.05 * (Math.random() - 0.5);

function voicedTime(f0) {
  const t = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    t[i] = 0.30 * Math.sin((2 * Math.PI * f0 * i) / SR)
         + 0.12 * Math.sin((2 * Math.PI * 2 * f0 * i) / SR)
         + 0.03 * (Math.random() - 0.5);
  }
  return t;
}
const voiced = voicedTime(190);

/** Broadband room noise sitting above the floor that was learned at startup. */
function flat(db) {
  const a = new Float32Array(BINS);
  a.fill(db);
  return a;
}

const CASES = [
  ['silence',          [],                                                              unvoiced, false],
  ['correct /s/',      [{ f: 7200, db: -34, w: 0.42 }],                                 unvoiced, true],
  ['quiet /s/',        [{ f: 7200, db: -58, w: 0.42 }],                                 unvoiced, true],
  ['sh-like (palatal)',[{ f: 3500, db: -34, w: 0.45 }],                                 unvoiced, true],
  ['interdental th',   [{ f: 5000, db: -56, w: 1.25 }],                                 unvoiced, true],
  ['lateral slushy',   [{ f: 2900, db: -40, w: 0.5 }, { f: 6600, db: -43, w: 0.55 }],   unvoiced, true],
  ['clearly bimodal',  [{ f: 2500, db: -38, w: 0.22 }, { f: 7500, db: -40, w: 0.22 }],  unvoiced, true],
  ['/z/ (voiced s)',   [{ f: 7000, db: -37, w: 0.42 }, { f: 240, db: -24, w: 0.55 }],   voiced,   true],
  ['vowel ah',         [{ f: 730, db: -22, w: 0.34 }, { f: 1100, db: -27, w: 0.3 }],    voiced,   false],
  ['vowel ee',         [{ f: 300, db: -22, w: 0.3 }, { f: 2500, db: -30, w: 0.26 }],    voiced,   false],
  ['vowel oo',         [{ f: 330, db: -22, w: 0.32 }, { f: 900, db: -31, w: 0.3 }],      voiced,   false],
  ['loud vowel ah',    [{ f: 730, db: -10, w: 0.34 }, { f: 1100, db: -15, w: 0.3 }],    voiced,   false],
];

const silence = spec([]);
spectral.startNoiseLearn(45);
for (let i = 0; i < 45; i++) spectral.analyze(silence, { gateDb: 9, periodicity: 0 });

/** Run one case: temporal first, then spectral, as the app does. */
function run(sp, time, frames = 10) {
  let r = null, t = null;
  for (let k = 0; k < frames; k++) {
    t = temporal.analyze(time);
    r = spectral.analyze(sp, { gateDb: 9, periodicity: t.periodicity });
  }
  return { r, t };
}

function quiet(frames = 60) {
  for (let k = 0; k < frames; k++) {
    const t = temporal.analyze(unvoiced);
    spectral.analyze(silence, { gateDb: 9, periodicity: t.periodicity });
  }
}

const head = ['case', 'gate', 'loud', 'cogHz', 'axis', 'sprd', 'focus', 'hfR', 'bimod', 'notch', 'voic', 'per'];
const wid  = [19, 6, 6, 6, 5, 5, 6, 5, 6, 10, 5, 5];
const fmt = (vals) => vals.map((v, i) => String(v).padEnd(wid[i])).join('');

console.log('1. GATE AND SPECTRAL MEASURES');
console.log(fmt(head));
console.log('-'.repeat(wid.reduce((a, b) => a + b, 0)));

let failures = 0;
for (const [name, humps, time, wantActive] of CASES) {
  quiet();
  const { r, t } = run(spec(humps), time);
  const ok = r.active === wantActive;
  if (!ok) failures++;
  console.log(fmt([
    name,
    (r.active ? 'OPEN' : 'shut') + (ok ? ' ' : '!'),
    r.loud ? 'yes' : 'no',
    Math.round(r.cogHz),
    specPos(r.cogHz).toFixed(2),
    r.spreadOct.toFixed(2),
    r.focus.toFixed(2),
    r.hfRatio.toFixed(2),
    r.bimodality.toFixed(2),
    r.notch ? Math.round(r.notch.hz) + 'Hz' : '-',
    r.voicing.toFixed(2),
    t.periodicity.toFixed(2),
  ]));
}

// Room noise that arrived after calibration: the case where an F0 line was
// being drawn over what is effectively silence.
console.log('\n   room noise above the learned floor:');
for (const [name, lvl] of [['floor +0 dB', -97], ['floor +10 dB', -87], ['floor +20 dB', -77]]) {
  quiet();
  let t = null, r = null;
  for (let k = 0; k < 6; k++) {
    t = temporal.analyze(unvoiced);
    r = spectral.analyze(flat(lvl), { gateDb: 9, periodicity: t.periodicity });
  }
  const drawn = r.voicing >= 0.25;
  if (drawn) failures++;
  console.log('     ' + name.padEnd(14) +
    'periodicity ' + t.periodicity.toFixed(2) +
    '   voicing ' + r.voicing.toFixed(2) +
    '   F0 ' + (t.f0Hz > 0 ? Math.round(t.f0Hz) + ' Hz' : '-').padEnd(8) +
    ' -> F0 line ' + (drawn ? 'DRAWN (bad)' : 'hidden'));
}

console.log('\n2. DISPLAY SPECTRUM  (80 Hz left .. 20 kHz right)');
const GLYPH = ' .:-=+*#%@';
for (const [name, humps, time, wantActive] of CASES) {
  if (!wantActive) continue;
  quiet();
  const { r } = run(spec(humps), time);
  let line = '';
  for (let b = 0; b < r.spectrum.length; b += 2) {
    line += GLYPH[Math.min(GLYPH.length - 1, Math.floor(r.spectrum[b] * GLYPH.length))];
  }
  console.log('  ' + name.padEnd(19) + '|' + line + '|');
}

/* ---------------------------------------------------------------- */

console.log('\n3. FLUTTER CALIBRATION');
console.log('   Bandpass noise has a fluctuating envelope even when steady, so the');
console.log('   zero point has to sit just above that intrinsic level.\n');

/** Broadband noise, optionally amplitude modulated. */
function noiseFrame(modHz, depth) {
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const m = modHz ? 1 + depth * Math.sin((2 * Math.PI * modHz * i) / SR) : 1;
    x[i] = (Math.random() * 2 - 1) * 0.3 * m;
  }
  return x;
}

const FLUTTER_CASES = [
  ['steady noise',        0,  0],
  ['modulated  20 Hz 60%', 20, 0.6],
  ['modulated  40 Hz 60%', 40, 0.6],
  ['modulated  40 Hz 100%', 40, 1.0],
  ['modulated  80 Hz 80%', 80, 0.8],
  ['modulated 160 Hz 80%', 160, 0.8],
];

console.log('   case                      cv     flutter');
console.log('   ' + '-'.repeat(42));
for (const [name, hz, depth] of FLUTTER_CASES) {
  // average several frames, since each is one random draw
  let cv = 0, fl = 0;
  const reps = 12;
  for (let i = 0; i < reps; i++) {
    const t = temporal.analyze(noiseFrame(hz, depth));
    cv += t.cv; fl += t.flutter;
  }
  console.log('   ' + name.padEnd(24) + (cv / reps).toFixed(3).padStart(6) + '   ' + (fl / reps).toFixed(3).padStart(6));
}

/* ---------------------------------------------------------------- */

console.log('\n4. DISPLAY REFERENCE LOCK');
console.log('   Freezing a reference pins the brightness scale to it, so a weaker');
console.log('   production then renders dimmer instead of being normalised back up.\n');

function peakOf(sp, time) {
  const { r } = run(sp, time, 14);
  let mx = 0;
  for (let i = 0; i < r.spectrum.length; i++) if (r.spectrum[i] > mx) mx = r.spectrum[i];
  return mx;
}

const loudS = spec([{ f: 7200, db: -34, w: 0.42 }]);
const weakS = spec([{ f: 7200, db: -46, w: 0.42 }]);   // 12 dB down

quiet();
const freeFloatLoud = peakOf(loudS, unvoiced);
quiet();
const freeFloatWeak = peakOf(weakS, unvoiced);

quiet();
peakOf(loudS, unvoiced);
spectral.lockDisplayTop();
const lockedLoud = peakOf(loudS, unvoiced);
const lockedWeak = peakOf(weakS, unvoiced);
spectral.unlockDisplayTop();

const ok = lockedWeak < lockedLoud - 0.15 && freeFloatWeak > 0.85;
if (!ok) failures++;

console.log('   floating:  loud peak ' + freeFloatLoud.toFixed(2) +
  '   weak peak ' + freeFloatWeak.toFixed(2) + '   (both normalise to full)');
console.log('   locked:    loud peak ' + lockedLoud.toFixed(2) +
  '   weak peak ' + lockedWeak.toFixed(2) + '   (weak now visibly dimmer)');
console.log('   ' + (ok ? 'lock behaves as intended' : 'LOCK NOT WORKING'));

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all expectations met'));
process.exit(failures ? 1 : 0);
