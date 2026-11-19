/**
 * Offline check of the auditory substrate and the spectral dimensions.
 *
 * None of this can be checked with a microphone in the loop, because the
 * questions are about whether the numbers behave, not whether the app runs.
 * Three things have to hold or the display is lying:
 *
 *   1. sharpness has to order the sibilants the way a listener does
 *   2. sharpness must not move when only the level moves
 *   3. spread has to separate a focused hiss from a smeared one
 */

import { createAuditoryModel } from '../src/auditory.js';
import { createDimensions } from '../src/dimensions.js';

const SR = 48000, N = 2048, BINS = N / 2, BINHZ = SR / N;

const model = createAuditoryModel(SR, N);
const dims = createDimensions(model);

/** Noise band, Gaussian in log frequency, at a given total level in dBFS. */
function band(centreHz, octWidth, levelDbfs) {
  const p = new Float32Array(BINS);
  let sum = 0;
  for (let i = 1; i < BINS; i++) {
    const f = i * BINHZ;
    const d = Math.log2(f / centreHz) / octWidth;
    const v = Math.exp(-0.5 * d * d);
    p[i] = v;
    sum += v;
  }
  const target = Math.pow(10, levelDbfs / 10);
  for (let i = 0; i < BINS; i++) p[i] *= target / sum;
  return p;
}

/** Sum of two bands, for a smeared or double-peaked production. */
function mix(a, b) {
  const p = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) p[i] = a[i] + b[i];
  return p;
}

/** A vowel: three formants, harmonically structured. */
function vowel(f0, levelDbfs) {
  const p = new Float32Array(BINS);
  const forms = [[700, 0, 130], [1900, -7, 180], [3100, -14, 250]];
  let sum = 0;
  for (let n = 1; n * f0 < SR / 2; n++) {
    const f = n * f0;
    let env = -60;
    for (const [ff, amp, bw] of forms) {
      const d = (f - ff) / bw;
      env = Math.max(env, amp - 10 * d * d);
    }
    const v = Math.pow(10, (env - 12 * Math.log2(n)) / 10);
    const i = Math.round(f / BINHZ);
    if (i > 0 && i < BINS) { p[i] += v; sum += v; }
  }
  const target = Math.pow(10, levelDbfs / 10);
  for (let i = 0; i < BINS; i++) p[i] *= target / sum;
  return p;
}

const CASES = [
  ['/s/ child, 8 kHz', () => band(8000, 0.75, -30)],
  ['/s/ adult, 6 kHz', () => band(6000, 0.8, -30)],
  ['palatal, 4 kHz', () => band(4000, 0.85, -30)],
  ['/sh/, 3 kHz', () => band(3000, 0.9, -30)],
  ['smeared 3k + 8k', () => mix(band(3000, 0.9, -33), band(8000, 0.9, -33))],
  ['broad slushy', () => band(5000, 1.9, -30)],
  ['/f/ flat weak', () => band(6000, 2.4, -40)],
  ['vowel ah', () => vowel(230, -25)],
];

console.log('SPECTRAL DIMENSIONS, from the specific loudness pattern\n');
console.log('case                 loudness  sharpness  spread  peak   centroid');
console.log('                                          (Bark)  (Bark) (Bark)');
console.log('-'.repeat(68));
for (const [name, make] of CASES) {
  const m = dims.measure(model.pattern(make()));
  console.log(
    name.padEnd(21) +
    m.loudness.toFixed(2).padStart(7) +
    m.sharpness.toFixed(2).padStart(11) +
    m.spreadBark.toFixed(2).padStart(8) +
    m.peakZ.toFixed(1).padStart(7) +
    m.centroidZ.toFixed(1).padStart(9));
}

console.log('\n\nLEVEL INDEPENDENCE -- the same /s/ over a 30 dB range.');
console.log('Sharpness and spread must stay put; only loudness may move.\n');
console.log('level (dBFS)  loudness  sharpness  spread');
console.log('-'.repeat(42));
for (const lv of [-50, -40, -30, -20]) {
  const m = dims.measure(model.pattern(band(8000, 0.75, lv)));
  console.log(
    String(lv).padEnd(14) +
    m.loudness.toFixed(2).padStart(7) +
    m.sharpness.toFixed(2).padStart(11) +
    m.spreadBark.toFixed(2).padStart(8));
}

console.log('\n\nSHARPNESS AGAINST PLACE -- a hiss swept from 2 to 11 kHz.');
console.log('This has to be monotonic, or the display moves the wrong way.\n');
let prev = -1, mono = true;
const row = [];
for (const hz of [2000, 2800, 4000, 5600, 8000, 11000]) {
  const m = dims.measure(model.pattern(band(hz, 0.8, -30)));
  row.push((hz / 1000) + 'k=' + m.sharpness.toFixed(2));
  if (m.sharpness < prev) mono = false;
  prev = m.sharpness;
}
console.log('  ' + row.join('   '));
console.log('  monotonic: ' + (mono ? 'yes' : 'NO -- display would mislead'));
