/**
 * modulation.js -- the temporal perceptual dimensions.
 *
 * Roughness and fluctuation are both amplitude modulation, and lumping them
 * together is the mistake the app next door makes. They are an order of
 * magnitude apart and they are different percepts:
 *
 *   FLUCTUATION peaks near 4 Hz. It is heard as a wobble, a sound that will
 *   not hold still. Clinically: an unsteady gesture, the child running out of
 *   breath, a production that wavers across its own length.
 *
 *   ROUGHNESS peaks near 70 Hz. Too fast to hear as separate events, so it
 *   fuses into a buzzy, gurgly, WET quality. Clinically this is the one to
 *   watch: it is the best candidate for the slushiness of a lateral release,
 *   where air breaking around the sides of the tongue modulates the noise far
 *   faster than any deliberate gesture could.
 *
 * They need different machinery, because of where the data comes from. A
 * frame of time-domain samples is about 43 ms long, which holds two or three
 * cycles of a 70 Hz modulation but not even a fifth of a cycle at 4 Hz. So
 * roughness is measured WITHIN a frame and fluctuation ACROSS frames, each on
 * the only timescale that can carry it.
 *
 * Nothing here touches the FFT. These are waveform measurements, and a 2048
 * point transform has already averaged away everything faster than about
 * 12 Hz before any downstream setting can be chosen.
 */

const EPS = 1e-20;

/** Samples discarded while the envelope filters settle. */
const SETTLE = 300;
/** Carrier isolation: roughness of the frication, not of the voice. */
const HP_HZ = 2000;
/** Envelope smoothing. Must pass the whole roughness band. */
const ENV_HZ = 400;

/**
 * Modulation frequencies probed for roughness, and their weights. A real
 * roughness model uses a broad bandpass peaking at 70 Hz; three points
 * sampled across that band is as much resolution as a 43 ms window supports
 * anyway -- the window length alone limits modulation resolution to about
 * 28 Hz, so these three are not independent and are not treated as such.
 */
const ROUGH_HZ = [40, 70, 110];
const ROUGH_W = [0.6, 1.0, 0.7];

/**
 * Reference rates, flanking the roughness band on both sides. Roughness is
 * measured as a PEAK against these, not as an absolute modulation depth, and
 * that choice is what makes the measure usable at all.
 *
 * Noise modulates itself. A band of noise with no modulation imposed on it
 * still has a wandering envelope, and how much depends on how wide the band
 * is -- which varies from one fricative to the next and from one child to the
 * next. An absolute depth therefore reads a steady /s/ as half rough before
 * anything is wrong with it. Dividing by the modulation energy at rates
 * nobody would call rough cancels that: self-modulation is flat across rate,
 * so the ratio sits at one for any steady noise of any bandwidth, and only a
 * real concentration near 70 Hz lifts it.
 */
const REF_HZ = [25, 180, 240, 300, 360];

/** Ratio at which roughness starts to count, and where it reads full. */
const ROUGH_FLOOR = 1.70;
const ROUGH_FULL = 7.0;

/**
 * Fluctuation: a one-pole bracket, geometric centre near 3-4 Hz. Built from
 * elapsed time rather than an assumed frame rate, so a throttled tab detunes
 * nothing.
 */
const FLUCT_SLOW_TAU = 0.12;
const FLUCT_FAST_TAU = 0.020;
/** The running mean square needs a longer window than the band itself. */
const FLUCT_AVG_TAU = 0.6;
const FLUCT_FULL = 0.34;
const FLUCT_FLOOR = 0.03;

/** Voice range, wide enough for a small child at the top. */
const F0_MIN = 70;
const F0_MAX = 420;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createModulation(sampleRate) {
  const hpK = Math.exp(-2 * Math.PI * HP_HZ / sampleRate);
  const envK = 1 - Math.exp(-2 * Math.PI * ENV_HZ / sampleRate);

  let env = null;
  let work = null;    // detrended, windowed copy of the envelope
  let win = null;     // Hann window, rebuilt only if the span changes

  // Fluctuation state, carried across frames.
  let slow = 0, fast = 0, msAc = 0;
  let primed = false;

  /**
   * Goertzel magnitude of `x` at `hz`, over `n` samples. Used instead of a
   * bandpass filter because an IIR would need most of this window just to
   * settle, and the window is all there is: consecutive frames from an
   * AnalyserNode overlap by an unknown amount, so filter state cannot be
   * carried across them without smearing.
   */
  function goertzel(x, n, hz) {
    const w = 2 * Math.PI * hz / sampleRate;
    const c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = x[i] + c * s1 - s2;
      s2 = s1; s1 = s0;
    }
    const re = s1 - s2 * Math.cos(w);
    const im = s2 * Math.sin(w);
    return 2 * Math.sqrt(re * re + im * im) / n;
  }

  /**
   * Detrend and window the envelope before any of that is asked of it.
   *
   * Both steps are load-bearing. The envelope's mean is far larger than any
   * modulation riding on it, and over a 36 ms window a DC term leaks into
   * every probe frequency below about 30 Hz -- enough, when it was left in,
   * to triple the reference level and drive the roughness ratio to nothing.
   * The Hann window then holds the leakage from a strong modulation at one
   * rate out of the probes at distant rates, at the cost of halving the
   * effective resolution. Scaling does not matter anywhere here: every number
   * these feed is a ratio of two of them.
   */
  function prepare(src, from, n, mean) {
    if (!work || work.length !== n) {
      work = new Float32Array(n);
      win = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      }
    }
    for (let i = 0; i < n; i++) work[i] = (src[from + i] - mean) * win[i];
    return work;
  }

  /**
   * Autocorrelation pitch with an octave guard. The guard is the whole
   * difficulty: the correlation at twice the true period is very nearly as
   * strong as at the period itself, so taking the maximum reports half the
   * real F0 on perfectly ordinary voices. Prefer the SHORTEST lag that is a
   * local peak and close to the best one.
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

    // Parabolic interpolation, worth it: without it F0 lands on whichever
    // integer lag is nearest, which at 300 Hz is a quantisation of ~20 Hz.
    const y0 = corr[chosen - 1], y1 = corr[chosen], y2 = corr[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    const lag = chosen + Math.max(-1, Math.min(1, shift));
    return { r: corr[chosen], f0: sampleRate / lag };
  }

  return {
    /**
     * @param {Float32Array} time raw waveform for this frame
     * @param {number} dt seconds since the previous call
     */
    analyze(time, dt) {
      const n = time.length;
      if (!env || env.length !== n) env = new Float32Array(n);

      // Two cascaded one-pole high passes, then rectify and smooth. The high
      // pass is what makes this a measure of the frication's own modulation
      // rather than of the glottal pulse train underneath it.
      let h1 = 0, h2 = 0, p1 = 0, p2 = 0, e = 0;
      for (let i = 0; i < n; i++) {
        const x = time[i];
        h1 = hpK * (h1 + x - p1); p1 = x;
        h2 = hpK * (h2 + h1 - p2); p2 = h1;
        const rect = h2 < 0 ? -h2 : h2;
        e += (rect - e) * envK;
        env[i] = e;
      }

      const span = n - SETTLE;
      let mean = 0;
      for (let i = SETTLE; i < n; i++) mean += env[i];
      mean /= span;

      let rough = 0, roughRatio = 0;
      if (mean > EPS && span > 64) {
        const w = prepare(env, SETTLE, span, mean);
        let acc = 0, wsum = 0;
        for (let j = 0; j < ROUGH_HZ.length; j++) {
          acc += ROUGH_W[j] * goertzel(w, span, ROUGH_HZ[j]);
          wsum += ROUGH_W[j];
        }
        let ref = 0;
        for (let j = 0; j < REF_HZ.length; j++) {
          ref += goertzel(w, span, REF_HZ[j]);
        }
        ref /= REF_HZ.length;
        roughRatio = ref > EPS ? (acc / wsum) / ref : 0;
        rough = clamp01((roughRatio - ROUGH_FLOOR) / (ROUGH_FULL - ROUGH_FLOOR));
      }

      // Fluctuation, across frames. One envelope sample per frame, bracketed
      // by two one-poles whose coefficients come from the elapsed time rather
      // than an assumed frame rate -- a throttled tab would otherwise detune
      // the band without any sign that it had.
      const step = Math.max(0.001, Math.min(0.2, dt || 0.016));
      const aSlow = 1 - Math.exp(-step / FLUCT_SLOW_TAU);
      const aFast = 1 - Math.exp(-step / FLUCT_FAST_TAU);
      const aAvg = 1 - Math.exp(-step / FLUCT_AVG_TAU);
      if (!primed) { slow = mean; fast = mean; primed = true; }
      slow += (mean - slow) * aSlow;
      fast += (mean - fast) * aFast;
      const ac = fast - slow;
      msAc += (ac * ac - msAc) * aAvg;
      const fluctIndex = slow > EPS ? Math.sqrt(msAc) / slow : 0;
      const fluct = clamp01((fluctIndex - FLUCT_FLOOR) / (FLUCT_FULL - FLUCT_FLOOR));

      const { r, f0 } = periodicity(time);

      let rms = 0;
      for (let i = 0; i < n; i++) rms += time[i] * time[i];
      rms = Math.sqrt(rms / n);

      return {
        rough,
        roughRatio,
        fluct,
        periodicity: r,
        f0Hz: f0,
        rms,
        hfMean: mean,
      };
    },

    reset() { primed = false; slow = 0; fast = 0; msAc = 0; },
  };
}
