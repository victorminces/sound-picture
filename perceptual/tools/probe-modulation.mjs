/**
 * Offline check of the temporal dimensions.
 *
 * The envelope chain from the worklet is reproduced here exactly, so this
 * tests the measurement rather than a convenient stand-in for it.
 *
 * What has to hold:
 *   1. the reported RATE must be right, because it is now shown as a number
 *   2. a trill at 25-35 Hz must register -- the previous version scored a
 *      French /R/ at 0.04 out of 1, which is why this was rebuilt
 *   3. fluctuation must still answer near 4 Hz and nowhere near 70
 *   4. steady noise must read zero at every rate, whatever its bandwidth
 */

import { createModulation } from '../src/modulation.js';

const SR = 48000, N = 2048, HOP = 800;
const HP_HZ = 2000, ENV_HZ = 400, ENV_RATE = 1500;

let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };

/** Exactly what envelope-worklet.js does, on the whole signal at once. */
function envelopeOf(x) {
  const hpK = Math.exp(-2 * Math.PI * HP_HZ / SR);
  const envK = 1 - Math.exp(-2 * Math.PI * ENV_HZ / SR);
  const decim = Math.max(1, Math.round(SR / ENV_RATE));
  const out = new Float32Array(Math.floor(x.length / decim));
  let h1 = 0, h2 = 0, p1 = 0, p2 = 0, env = 0, acc = 0, c = 0, w = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i];
    h1 = hpK * (h1 + s - p1); p1 = s;
    h2 = hpK * (h2 + h1 - p2); p2 = h1;
    env += ((h2 < 0 ? -h2 : h2) - env) * envK;
    acc += env;
    if (++c >= decim) { if (w < out.length) out[w++] = acc / c; acc = 0; c = 0; }
  }
  return { env: out, rate: SR / decim };
}

/** Band-passed noise, optionally gated once per cycle like a trill. */
function signal(sec, carrierHz, bw, rateHz, depth, pulse) {
  const n = Math.round(sec * SR), x = new Float32Array(n);
  const w = 2 * Math.PI * carrierHz / SR;
  const r = Math.exp(-Math.PI * bw * carrierHz / SR);
  const c = 2 * r * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = rnd() + c * s1 - r * r * s2; s2 = s1; s1 = s0;
    let a = 1;
    if (rateHz > 0) {
      const ph = (i * rateHz / SR) % 1;
      const gate = pulse ? Math.exp(-6 * ph) : 0.5 + 0.5 * Math.sin(2 * Math.PI * ph);
      a = 1 - depth + depth * gate;
    }
    x[i] = s0 * 0.02 * a;
  }
  return x;
}

function run(sig) {
  const mod = createModulation(SR);
  const { env, rate } = envelopeOf(sig);
  mod.setEnvRate(rate);
  const frame = new Float32Array(N);
  const envPerHop = Math.round(HOP / SR * rate);
  let acc = { rough: 0, rate: 0, depth: 0, ratio: 0, fluct: 0, k: 0 };
  let envPos = 0;
  for (let s = 0; s + N < sig.length; s += HOP) {
    frame.set(sig.subarray(s, s + N));
    const chunk = env.subarray(envPos, Math.min(env.length, envPos + envPerHop));
    envPos += chunk.length;
    mod.pushEnvelope(chunk);
    const r = mod.analyze(frame);
    if (s > SR * 1.0 && mod.ready) {
      acc.rough += r.rough; acc.rate += r.roughRate; acc.depth += r.roughDepth;
      acc.ratio += r.roughRatio; acc.fluct += r.fluct; acc.k++;
    }
  }
  const k = Math.max(1, acc.k);
  return { rough: acc.rough / k, rate: acc.rate / k, depth: acc.depth / k,
           ratio: acc.ratio / k, fluct: acc.fluct / k };
}

const bar = (v) => '#'.repeat(Math.round(v * 14)).padEnd(14);

console.log('A TRILL, GATED NEARLY TO SILENCE ONCE PER CYCLE');
console.log('Uvular /R/ sits at 25-35 Hz. The reported rate is the new part.\n');
console.log('  true rate   reported   raggedness        depth  ratio');
console.log('  ' + '-'.repeat(60));
for (const hz of [20, 25, 30, 35, 45, 60, 75, 95, 130]) {
  const r = run(signal(4, 1800, 0.9, hz, 0.95, true));
  console.log('  ' + (hz + ' Hz').padEnd(12) + (r.rate.toFixed(0) + ' Hz').padEnd(11) +
    r.rough.toFixed(2) + ' ' + bar(r.rough) + r.depth.toFixed(2).padStart(6) +
    r.ratio.toFixed(1).padStart(7));
}

console.log('\n\nFLUCTUATION -- must still answer near 4 Hz only.\n');
console.log('  rate      fluctuation      raggedness');
console.log('  ' + '-'.repeat(46));
for (const hz of [2, 4, 7, 15, 30, 70]) {
  const r = run(signal(4, 7000, 0.35, hz, 0.6, false));
  console.log('  ' + (hz + ' Hz').padEnd(10) + r.fluct.toFixed(2) + ' ' +
    bar(r.fluct) + '  ' + r.rough.toFixed(2));
}

console.log('\n\nSTEADY NOISE AT FOUR BANDWIDTHS -- all must read zero.');
console.log('This is what the previous version got wrong: how much a noise');
console.log('band modulates itself depends on how wide it is.\n');
console.log('  carrier bandwidth   raggedness   fluctuation   ratio');
console.log('  ' + '-'.repeat(54));
for (const bw of [0.15, 0.35, 0.9, 1.8]) {
  const r = run(signal(4, 5000, bw, 0, 0, false));
  console.log('  ' + (bw + ' x centre').padEnd(20) + r.rough.toFixed(2).padStart(8) +
    r.fluct.toFixed(2).padStart(13) + r.ratio.toFixed(1).padStart(9));
}
