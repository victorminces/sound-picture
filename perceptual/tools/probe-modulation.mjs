/**
 * Offline check of the temporal dimensions.
 *
 * The claim being tested is the one that justifies having two measures
 * instead of one: that roughness answers near 70 Hz and fluctuation near
 * 4 Hz, and that neither answers much in the other's band. If they turn out
 * to track each other, the second one is dead weight and should go.
 *
 * Frames are handed over the way a browser hands them over -- 2048 samples at
 * a time with a 800 sample hop, so consecutive frames overlap by 60%, exactly
 * as they do from an AnalyserNode at 60 fps.
 */

import { createModulation } from '../src/modulation.js';

const SR = 48000, N = 2048, HOP = 800;

let seed = 20260118;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff * 2 - 1;
}

/**
 * Noise in a band around `centre`, amplitude-modulated at `modHz` to a depth
 * of `depth`. The band limiting matters: unfiltered white noise has a
 * fluctuating envelope of its own that would swamp a shallow modulation.
 */
function makeSignal(seconds, centre, modHz, depth, f0 = 0) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const w = 2 * Math.PI * centre / SR;
  const bw = 0.35;
  let s1 = 0, s2 = 0;
  const r = Math.exp(-Math.PI * bw * centre / SR);
  const c = 2 * r * Math.cos(w);
  for (let i = 0; i < n; i++) {
    const s0 = rnd() + c * s1 - r * r * s2;
    s2 = s1; s1 = s0;
    let a = 1;
    if (modHz > 0) a += depth * Math.sin(2 * Math.PI * modHz * i / SR);
    if (f0 > 0) {
      // A glottal pulse train modulating the noise, as in a voiced fricative.
      const ph = (i * f0 / SR) % 1;
      a *= 0.25 + 0.75 * Math.exp(-12 * ph);
    }
    x[i] = s0 * 0.02 * a;
  }
  return x;
}

function run(label, signal) {
  const mod = createModulation(SR);
  const frame = new Float32Array(N);
  let rough = 0, fluct = 0, ratio = 0, count = 0;
  for (let start = 0; start + N < signal.length; start += HOP) {
    frame.set(signal.subarray(start, start + N));
    const m = mod.analyze(frame, HOP / SR);
    // Skip the first half second: the fluctuation one-poles need to settle.
    if (start > SR * 0.6) { rough += m.rough; ratio += m.roughRatio; fluct += m.fluct; count++; }
  }
  return { label, rough: rough / count, ratio: ratio / count, fluct: fluct / count };
}

console.log('MODULATION RATE RESPONSE');
console.log('Band-passed noise at 7 kHz, 60% modulation depth, 3 s each.\n');
console.log('  modulation rate   ratio  roughness          fluctuation');
console.log('  ' + '-'.repeat(44));
const rows = [];
for (const hz of [0, 2, 4, 8, 15, 30, 50, 70, 100, 150, 250]) {
  const r = run(hz, makeSignal(3, 7000, hz, 0.6));
  rows.push(r);
  const bar = (v) => '#'.repeat(Math.round(v * 20)).padEnd(20);
  console.log('  ' + (hz === 0 ? 'steady' : hz + ' Hz').padEnd(18) +
    r.ratio.toFixed(2).padStart(5) + '  ' + r.rough.toFixed(2) + ' ' + bar(r.rough).slice(0, 10) + ' ' +
    r.fluct.toFixed(2) + '  ' + bar(r.fluct).slice(0, 10));
}

const peakRough = rows.reduce((a, b) => (b.rough > a.rough ? b : a));
const peakFluct = rows.slice(1).reduce((a, b) => (b.fluct > a.fluct ? b : a));
console.log('\n  roughness peaks at    ' + peakRough.label + ' Hz   (want ~70)');
console.log('  fluctuation peaks at  ' + peakFluct.label + ' Hz   (want ~4)');

console.log('\n\nDEPTH RESPONSE at 70 Hz -- more modulation must read as more.\n');
console.log('  depth   ratio  roughness');
console.log('  ' + '-'.repeat(20));
for (const d of [0, 0.15, 0.3, 0.5, 0.8]) {
  const r = run(d, makeSignal(3, 7000, 70, d));
  console.log('  ' + d.toFixed(2).padEnd(8) + r.ratio.toFixed(2).padStart(5) + r.rough.toFixed(2).padStart(8));
}

console.log('\n\nTHE VOICING CONFOUND');
console.log('A voiced fricative is modulated at F0 by the glottis. If F0 falls');
console.log('in the roughness band, the measure cannot tell that from a wet');
console.log('production. Children sit high, adult men sit low.\n');
console.log('  voice                 ratio  roughness');
console.log('  ' + '-'.repeat(34));
for (const [name, f0] of [
  ['child /z/, F0 300', 300],
  ['woman /z/, F0 200', 200],
  ['man /z/, F0 110', 110],
  ['man /z/, F0 85', 85],
]) {
  const r = run(name, makeSignal(3, 7000, 0, 0, f0));
  console.log('  ' + name.padEnd(22) + r.ratio.toFixed(2).padStart(5) + r.rough.toFixed(2).padStart(8));
}
