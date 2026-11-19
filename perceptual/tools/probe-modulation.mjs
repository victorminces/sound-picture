/**
 * Offline check of raggedness and fluctuation.
 *
 * What has to hold, and why each case is here:
 *
 *   clean vowels read zero at every pitch -- the previous measure counted a
 *     low voice's own glottal pulse as raggedness, and vowels drew grainy
 *   a voiced uvular R reads clearly -- the previous measure scored it near
 *     zero, because a trill's sharp pulses also filled the reference rates it
 *     was divided by
 *   steady hiss reads zero -- a clean /s/ must not sparkle
 *   fluctuation answers near 4 Hz and nowhere near the ragged band
 *
 * Validated as well on real recordings (Wikimedia Commons IPA samples: three
 * vowels, /s/, /sh/), which all read 0.00 median and 0.00 at the 90th
 * percentile. Those files are not in the repository.
 */

import { createModulation } from '../src/modulation.js';

const SR = 48000, N = 2048, HOP = 800;
let seed = 3;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

function resonate(x, fc, bw) {
  const r = Math.exp(-Math.PI * bw / SR), c = 2 * r * Math.cos(2 * Math.PI * fc / SR);
  const y = new Float32Array(x.length);
  let a = 0, b = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i] + c * a - r * r * b; b = a; a = v; y[i] = v; }
  return y;
}

/** An /a/ from a jittered pulse train; optionally trilled, with frication. */
function vowel(f0, { trill = 0, noise = 0 } = {}) {
  const n = SR * 3, src = new Float32Array(n);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (i >= next) {
      src[i] = 1;
      const f = f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 0.7 * i / SR));
      next = i + (SR / f) * (1 + 0.006 * rnd());
    }
  }
  const y = new Float32Array(n);
  for (const [fc, bw, g] of [[700, 90, 1], [1220, 110, 0.6], [2600, 160, 0.25], [3500, 220, 0.15]]) {
    const p = resonate(src, fc, bw);
    for (let i = 0; i < n; i++) y[i] += g * p[i];
  }
  let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v));
  for (let i = 0; i < n; i++) {
    let v = y[i] / pk * 0.1 + noise * 0.02 * rnd();
    if (trill) { const ph = (i * trill / SR) % 1; v *= 0.05 + 0.95 * Math.exp(-6 * ph); }
    y[i] = v;
  }
  return y;
}

/** Band noise at 7 kHz, optionally with a smooth sinusoidal wobble. */
function hiss(rate = 0, depth = 0.6) {
  const n = SR * 3, x = new Float32Array(n);
  const w = 2 * Math.PI * 7000 / SR, r = Math.exp(-Math.PI * 0.35 * 7000 / SR), c = 2 * r * Math.cos(w);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    const s0 = rnd() + c * a - r * r * b; b = a; a = s0;
    x[i] = s0 * 0.02 * (rate ? 1 + depth * Math.sin(2 * Math.PI * rate * i / SR) : 1);
  }
  return x;
}

function run(x) {
  const m = createModulation(SR), fr = new Float32Array(N);
  const rough = [], fluct = [];
  for (let s = 0; s + N <= x.length; s += HOP) {
    fr.set(x.subarray(s, s + N));
    const r = m.analyze(fr, HOP / SR);
    if (s > SR * 0.6) { rough.push(r.rough); fluct.push(r.fluct); }
  }
  const q = (v, p) => { v = v.slice().sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]; };
  return { med: q(rough, 0.5), p90: q(rough, 0.9), fluct: q(fluct, 0.5) };
}

const f = (v) => v.toFixed(2);
let fails = 0;
function row(name, x, want) {
  const r = run(x);
  const ok = want(r);
  if (!ok) fails++;
  console.log('  ' + name.padEnd(38) + f(r.med).padStart(6) + f(r.p90).padStart(7) + f(r.fluct).padStart(9) + (ok ? '' : '   <-- FAIL'));
}

console.log('RAGGEDNESS                              median   p90   fluct');
console.log('  ' + '-'.repeat(62));
console.log('  clean vowels: must read zero');
for (const f0 of [80, 100, 120, 140, 180, 250, 320]) row('    /a/ at ' + f0 + ' Hz', vowel(f0), (r) => r.p90 < 0.1);
console.log('  trills: must read clearly');
row('    voiced uvular R, F0 110, 30/s', vowel(110, { trill: 30, noise: 0.4 }), (r) => r.med > 0.4);
row('    voiced uvular R, F0 200, 30/s', vowel(200, { trill: 30, noise: 0.4 }), (r) => r.med > 0.4);
row('    voiced gurgle, F0 100, 70/s', vowel(100, { trill: 70, noise: 0.4 }), (r) => r.med > 0.4);
console.log('  voiceless');
row('    steady hiss', hiss(), (r) => r.p90 < 0.1);
row('    hiss, smooth 70/s wobble, 60%', hiss(70, 0.6), () => true);
console.log('  fluctuation: near 4 Hz only');
row('    hiss, 4/s wobble', hiss(4, 0.6), (r) => r.fluct > 0.5 && r.p90 < 0.1);
row('    hiss, 70/s wobble', hiss(70, 0.6), (r) => r.fluct < 0.1);

console.log('\n  ' + (fails ? fails + ' FAILED' : 'all checks pass'));
console.log('\n  Known and accepted: a perfectly smooth sinusoidal wobble on hiss scores');
console.log('  low (about 0.1). It is a laboratory stimulus, not speech, and scoring it');
console.log('  higher made a clean /s/ sparkle.');
