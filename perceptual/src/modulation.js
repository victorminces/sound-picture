/**
 * modulation.js -- the temporal perceptual dimensions.
 *
 * Everything here is a property of the amplitude envelope, which arrives
 * continuously from the worklet rather than being recomputed inside each
 * overlapping analysis frame. That one change is what makes the measurements
 * below possible at all: a third of a second of envelope resolves modulation
 * rate to a few Hz, where a single 43 ms frame could not do better than about
 * 55 Hz and merged everything interesting into one number.
 *
 * Two bands are read off the same modulation spectrum:
 *
 *   FLUCTUATION, near 4 Hz. Heard as a wobble, a sound that will not hold
 *   still. A gesture wavering across its own length.
 *
 *   RAGGEDNESS, from about 15 to 160 Hz. Heard as pulsing at the low end and,
 *   as the rate climbs past the point where the ear can follow individual
 *   events, as a buzzy, gurgly, wet quality. A uvular /R/ sits near 30 Hz, an
 *   alveolar trill a little above, and the slushiness of a lateral release
 *   nearer 70. Because the rate is now resolvable, it is reported as a number
 *   in its own right instead of being collapsed into the strength.
 *
 * The strength is a PEAK against the rest of the band, not an absolute depth.
 * Noise modulates itself by an amount that depends on its bandwidth, which
 * varies from one fricative and one child to the next; an absolute threshold
 * is correct for one bandwidth and wrong for every other. Comparing the peak
 * against the median of the same spectrum cancels it, because self-modulation
 * is broad and a real modulation is not.
 *
 * The sibling app at the repository root gets this wrong, and the error is
 * total rather than partial: its flutter reads 0.00 at every modulation rate
 * tested. It passed its own calibration because that calibration used a
 * narrow synthetic carrier.
 */

const EPS = 1e-20;

/** Envelope history kept, in samples at the worklet's envelope rate. */
const RING = 1024;
/** Window used for the ragged band. Shorter, so it follows a sound. */
const ROUGH_WIN = 512;
/** Window used for fluctuation. Longer, because 4 Hz needs the time. */
const FLUCT_WIN = 1024;

/**
 * Probe rates for the ragged band. Spaced EVENLY at 5 Hz, not logarithmically,
 * because the spacing has to stay inside the window's resolution. A 341 ms
 * Hann window resolves about 6 Hz; log spacing put 17 Hz between the probes
 * at the top of the band, so a modulation at 95 Hz fell between 88 and 105
 * and was missed by both -- it scored 0.02 while 75 Hz scored 1.00.
 */
const ROUGH_RATES = [];
for (let hz = 15; hz <= 160; hz += 5) ROUGH_RATES.push(hz);

/** Probe rates for fluctuation. */
const FLUCT_RATES = [2.2, 3, 4, 5.5, 7.5, 10];

/** Peak-to-median ratio marking the bottom and top of the ragged display. */
const ROUGH_FLOOR = 2.6;
const ROUGH_FULL = 7.0;

/**
 * Fluctuation is scored on DEPTH, not on a peak-to-median ratio, and the two
 * bands differ here for a measured reason rather than a stylistic one.
 *
 * The ratio exists to cancel the self-modulation of noise, which is large and
 * strongly bandwidth-dependent up in the ragged band. Down at a few Hz it is
 * neither: steady noise measured 0.013 to 0.025 deep across a twelvefold
 * range of carrier bandwidth, against 0.40 or more for anything genuinely
 * wavering. An absolute threshold is therefore safe here and a ratio is not,
 * because at this window length the six probes overlap heavily and the median
 * of six correlated numbers is not a background estimate. Scored by ratio,
 * fluctuation read 1.00 at 2 Hz, 0.22 at 4 Hz and 1.00 at 7 Hz.
 */
const FLUCT_DEPTH_FLOOR = 0.06;
const FLUCT_DEPTH_FULL = 0.35;

/** Below this modulation depth there is nothing worth calling a texture. */
const DEPTH_FLOOR = 0.06;

/** Voice range, wide enough for a small child at the top. */
const F0_MIN = 70;
const F0_MAX = 420;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function median(values, n) {
  const copy = Array.prototype.slice.call(values, 0, n).sort((a, b) => a - b);
  const m = n >> 1;
  return n % 2 ? copy[m] : (copy[m - 1] + copy[m]) / 2;
}

export function createModulation(sampleRate) {
  /** Envelope ring, written by the worklet's blocks, read oldest-to-newest. */
  const ring = new Float32Array(RING);
  let ringWrite = 0, ringFilled = 0;
  let envRate = 1500;

  const work = new Float32Array(RING);
  const hann = new Float32Array(RING);
  let hannLen = 0;

  const roughDepths = new Float32Array(ROUGH_RATES.length);
  const fluctDepths = new Float32Array(FLUCT_RATES.length);

  function buildHann(n) {
    if (hannLen === n) return;
    for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    hannLen = n;
  }

  /**
   * Copy the most recent `n` envelope samples out of the ring, oldest first,
   * with the mean removed and a Hann window applied. Both steps matter: the
   * envelope's mean dwarfs anything riding on it and would leak into every
   * low probe rate, and without the window a strong modulation at one rate
   * spills into probes at distant rates.
   */
  function prepare(n) {
    if (ringFilled < n) return 0;
    buildHann(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      const idx = (ringWrite - n + i + RING) % RING;
      work[i] = ring[idx];
      mean += work[i];
    }
    mean /= n;
    if (mean <= EPS) return 0;
    for (let i = 0; i < n; i++) work[i] = (work[i] - mean) * hann[i];
    return mean;
  }

  /** Modulation depth at `hz`: 1.0 would be modulation all the way to zero. */
  function depthAt(n, hz, mean) {
    const w = 2 * Math.PI * hz / envRate;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = work[i] + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const re = s1 - s2 * Math.cos(w);
    const im = s2 * Math.sin(w);
    // 2/n for a one-sided amplitude, and 2x again for the Hann window's
    // coherent gain of a half. Scaling cancels in the ratio but is kept so
    // that the depth reported alongside it means what it says.
    const amp = 4 * Math.sqrt(re * re + im * im) / n;
    return amp / mean;
  }

  function scanBand(rates, out, win) {
    const mean = prepare(win);
    if (!mean) return null;
    let peak = 0, peakIdx = 0;
    for (let i = 0; i < rates.length; i++) {
      out[i] = depthAt(win, rates[i], mean);
      if (out[i] > peak) { peak = out[i]; peakIdx = i; }
    }
    const med = median(out, rates.length);
    return {
      depth: peak,
      rate: rates[peakIdx],
      ratio: med > EPS ? peak / med : 0,
    };
  }

  /**
   * Autocorrelation pitch with an octave guard. The guard is the whole
   * difficulty: correlation at twice the true period is very nearly as strong
   * as at the period itself, so taking the maximum reports half the real F0
   * on ordinary voices. Prefer the SHORTEST lag that is a local peak and
   * close to the best one.
   */
  function periodicity(time) {
    const n = time.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += time[i];
    mean /= n;

    let energy = 0;
    for (let i = 0; i < n; i++) {
      const v = time[i] - mean;
      energy += v * v;
    }
    if (energy < 1e-12) return { r: 0, f0: 0 };

    const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX));
    const maxLag = Math.min(n - 2, Math.floor(sampleRate / F0_MIN));
    if (maxLag <= minLag) return { r: 0, f0: 0 };

    const corr = new Float32Array(maxLag + 1);
    let best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let s = 0;
      for (let i = 0; i < n - lag; i++) {
        s += (time[i] - mean) * (time[i + lag] - mean);
      }
      const r = s / energy;
      corr[lag] = r;
      if (r > best) best = r;
    }
    if (best <= 0) return { r: 0, f0: 0 };

    let chosen = -1;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (corr[lag] >= 0.88 * best &&
          corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
        chosen = lag;
        break;
      }
    }
    if (chosen < 0) return { r: best, f0: 0 };

    const y0 = corr[chosen - 1], y1 = corr[chosen], y2 = corr[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const lag = chosen + Math.max(-1, Math.min(1, shift));
    return { r: corr[chosen], f0: sampleRate / lag };
  }

  return {
    setEnvRate(hz) { if (hz > 0) envRate = hz; },

    /** Envelope samples from the worklet, in order, never overlapping. */
    pushEnvelope(block) {
      for (let i = 0; i < block.length; i++) {
        ring[ringWrite] = block[i];
        ringWrite = (ringWrite + 1) % RING;
      }
      ringFilled = Math.min(RING, ringFilled + block.length);
    },

    get ready() { return ringFilled >= FLUCT_WIN; },

    /**
     * @param {Float32Array} time raw waveform, for pitch only
     */
    analyze(time) {
      const r = scanBand(ROUGH_RATES, roughDepths, ROUGH_WIN);
      const f = scanBand(FLUCT_RATES, fluctDepths, FLUCT_WIN);

      let rough = 0, roughRate = 0, roughDepth = 0, roughRatio = 0;
      if (r) {
        roughRate = r.rate;
        roughDepth = r.depth;
        roughRatio = r.ratio;
        if (r.depth > DEPTH_FLOOR) {
          rough = clamp01((r.ratio - ROUGH_FLOOR) / (ROUGH_FULL - ROUGH_FLOOR));
        }
      }

      let fluct = 0, fluctRate = 0, fluctDepth = 0, fluctRatio = 0;
      if (f) {
        fluctRate = f.rate; fluctDepth = f.depth; fluctRatio = f.ratio;
        fluct = clamp01((f.depth - FLUCT_DEPTH_FLOOR) /
          (FLUCT_DEPTH_FULL - FLUCT_DEPTH_FLOOR));
      }

      const { r: per, f0 } = periodicity(time);

      let rms = 0;
      for (let i = 0; i < time.length; i++) rms += time[i] * time[i];
      rms = Math.sqrt(rms / time.length);

      return {
        rough, roughRate, roughDepth, roughRatio,
        fluct, fluctRate, fluctDepth, fluctRatio,
        periodicity: per,
        f0Hz: f0,
        rms,
      };
    },

    reset() { ringWrite = 0; ringFilled = 0; ring.fill(0); },
  };
}
