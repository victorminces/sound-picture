/**
 * pitch.js -- fundamental frequency and voicing, by YIN.
 *
 * De Cheveigné and Kawahara (2002). Chosen over plain autocorrelation, which
 * this app used before, because autocorrelation's characteristic failure is
 * the octave error -- the correlation one period later is almost as strong
 * as at the period itself -- and on real voices the old tracker jumped
 * 130 -> 235 -> 105 Hz inside a single vowel. YIN's cumulative-mean
 * normalisation removes the bias that causes most of those, and its absolute
 * threshold picks the FIRST dip that is good enough rather than the deepest,
 * which is the other half of the problem.
 *
 * Two additions on top of the published algorithm:
 *
 *   - The signal is low-passed and decimated to about 16 kHz first. Pitch
 *     lives below 1 kHz; the decimation cuts the cost by nine and the low
 *     pass removes formant ripple that can masquerade as a short period.
 *
 *   - Continuity, the idea behind pYIN. When the voice is already being
 *     tracked, the candidates at half and twice the chosen period are scored
 *     too, with a cost for how far each would jump from the previous frame.
 *     A single noisy frame therefore cannot throw the estimate an octave, but
 *     a real, sustained octave change still goes through, because the
 *     evidence for it is better than the penalty.
 *
 * Output per frame: f0Hz (0 when unvoiced) and `aperiodicity`, YIN's own
 * measure of how well one period predicts the next -- near 0 for a clean
 * vowel, near 1 for noise. `periodicity` is reported as 1 - aperiodicity so
 * callers that thought in autocorrelation terms keep working.
 */

/** Range covers adult men in creak to excited small children. */
const F0_MIN = 65;
const F0_MAX = 600;
/** Rate the analysis runs at after decimation. */
const TARGET_RATE = 16000;
/** YIN's absolute threshold on the normalised difference. */
const THRESHOLD = 0.12;
/** Above this aperiodicity a frame is not treated as voiced at all. */
const VOICED_MAX = 0.30;
/** Cost of a jump of one octave, in units of aperiodicity. */
const JUMP_COST = 0.20;
/**
 * Octave guard. YIN's normalisation divides by the running mean of the
 * difference function, which favours the dip at TWICE the period whenever the
 * amplitude is changing -- exactly what happens at a vowel onset. On a real
 * schwa that put the first 80 ms an octave low (75 Hz against Praat's 150),
 * and the continuity rule then kept it there. If the dip at half the chosen
 * period is good in absolute terms and nearly as good as the chosen one, the
 * shorter period wins.
 */
const GUARD_DP = 0.25;
const GUARD_MARGIN = 0.10;
/** How long the previous estimate stays relevant without a voiced frame. */
const MEMORY_FRAMES = 8;
/** Low-pass corner applied before decimating. */
const LP_HZ = 1100;

/** Butterworth low-pass biquad coefficients (RBJ cookbook). */
function lowpass(fc, fs) {
  const w = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: (1 - cw) / 2 / a0, b1: (1 - cw) / a0, b2: (1 - cw) / 2 / a0,
    a1: -2 * cw / a0, a2: (1 - alpha) / a0,
  };
}

export function createPitchTracker(sampleRate, opts = {}) {
  const jumpCost = opts.jumpCost ?? JUMP_COST;
  const guardDp = opts.guardDp ?? GUARD_DP;
  const guardMargin = opts.guardMargin ?? GUARD_MARGIN;
  const dec = Math.max(1, Math.round(sampleRate / TARGET_RATE));
  const rate = sampleRate / dec;
  const tauMin = Math.max(2, Math.floor(rate / F0_MAX));
  const tauMax = Math.ceil(rate / F0_MIN);
  const lp = lowpass(LP_HZ, sampleRate);

  let x = null;
  const d = new Float32Array(tauMax + 2);
  const dp = new Float32Array(tauMax + 2);

  let prevF0 = 0;
  let sinceVoiced = 1e9;

  /** Two cascaded biquads, then keep every `dec`-th sample. */
  function downsample(time) {
    const n = Math.floor(time.length / dec);
    if (!x || x.length !== n) x = new Float32Array(n);
    let z1a = 0, z2a = 0, z1b = 0, z2b = 0, k = 0;
    for (let i = 0; i < time.length; i++) {
      const u = time[i];
      const ya = lp.b0 * u + z1a;
      z1a = lp.b1 * u - lp.a1 * ya + z2a;
      z2a = lp.b2 * u - lp.a2 * ya;
      const yb = lp.b0 * ya + z1b;
      z1b = lp.b1 * ya - lp.a1 * yb + z2b;
      z2b = lp.b2 * ya - lp.a2 * yb;
      if (i % dec === dec - 1 && k < n) x[k++] = yb;
    }
    return n;
  }

  /** Parabolic interpolation of the minimum around integer lag `t`. */
  function refine(t) {
    if (t <= tauMin || t >= tauMax) return t;
    const a = dp[t - 1], b = dp[t], c = dp[t + 1];
    const den = a - 2 * b + c;
    if (den <= 0) return t;
    const shift = 0.5 * (a - c) / den;
    return t + Math.max(-1, Math.min(1, shift));
  }

  /** The best local minimum of dp within +-6% of lag `t`, or -1. */
  function nearestDip(t) {
    const lo = Math.max(tauMin, Math.floor(t * 0.94));
    const hi = Math.min(tauMax - 1, Math.ceil(t * 1.06));
    let best = -1;
    for (let k = Math.max(lo, tauMin + 1); k <= hi; k++) {
      if (dp[k] <= dp[k - 1] && dp[k] <= dp[k + 1] && (best < 0 || dp[k] < dp[best])) best = k;
    }
    return best;
  }

  return {
    rate,

    /**
     * @param {Float32Array} time one frame of raw samples at `sampleRate`
     * @returns {{f0Hz:number, aperiodicity:number, periodicity:number, voiced:boolean}}
     */
    analyze(time) {
      const n = downsample(time);
      // Drop the first few milliseconds, where the filters are still settling.
      const skip = Math.min(48, Math.floor(n / 8));
      const W = n - skip - tauMax;
      if (W < 64) return { f0Hz: 0, candidateHz: 0, aperiodicity: 1, periodicity: 0, voiced: false };

      // Difference function, and its cumulative-mean normalisation.
      d[0] = 0;
      dp[0] = 1;
      let running = 0;
      for (let tau = 1; tau <= tauMax; tau++) {
        let s = 0;
        for (let j = skip; j < skip + W; j++) {
          const v = x[j] - x[j + tau];
          s += v * v;
        }
        d[tau] = s;
        running += s;
        dp[tau] = running > 0 ? s * tau / running : 1;
      }
      dp[tauMax + 1] = dp[tauMax];

      // The first dip under the threshold, followed down to its bottom. If
      // nothing clears it, the global minimum, which will usually be judged
      // unvoiced below.
      let tau = -1;
      for (let t = tauMin; t <= tauMax; t++) {
        if (dp[t] < THRESHOLD) {
          while (t + 1 <= tauMax && dp[t + 1] < dp[t]) t++;
          tau = t;
          break;
        }
      }
      if (tau < 0) {
        tau = tauMin;
        for (let t = tauMin + 1; t <= tauMax; t++) if (dp[t] < dp[tau]) tau = t;
      }

      // Octave guard, before continuity, so a wrong octave is never the
      // thing continuity learns to defend.
      for (let k = 0; k < 2; k++) {
        const half = nearestDip(tau / 2);
        if (half > 0 && dp[half] < guardDp && dp[half] < dp[tau] + guardMargin) tau = half;
        else break;
      }

      // Continuity: weigh the octave neighbours against the previous frame.
      if (jumpCost > 0 && prevF0 > 0 && sinceVoiced <= MEMORY_FRAMES) {
        const cost = (t) => dp[t] + jumpCost * Math.abs(Math.log2((rate / t) / prevF0));
        let best = tau, bestCost = cost(tau);
        for (const cand of [nearestDip(tau / 2), nearestDip(tau * 2)]) {
          if (cand > 0) {
            const c = cost(cand);
            if (c < bestCost) { best = cand; bestCost = c; }
          }
        }
        tau = best;
      }

      const ap = Math.max(0, Math.min(1, dp[tau]));
      const voiced = ap <= VOICED_MAX;
      // The best period is reported even when the frame is not confidently
      // voiced: a dying vowel is still periodic enough for its pitch to be
      // right, and code that needs the period -- not a voicing verdict -- can
      // use it.
      const candidate = rate / refine(tau);
      const f0 = voiced ? candidate : 0;

      if (voiced) { prevF0 = f0; sinceVoiced = 0; } else { sinceVoiced++; }

      return { f0Hz: f0, candidateHz: candidate, aperiodicity: ap, periodicity: 1 - ap, voiced };
    },

    reset() { prevF0 = 0; sinceVoiced = 1e9; },
  };
}
