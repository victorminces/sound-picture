/**
 * modulation.js -- the temporal perceptual dimensions.
 *
 * A copy of perceptual/src/modulation.js, kept as a file of this app's own
 * rather than imported across, so that work on the perceptual app can never
 * change this one by accident. This app uses only `rough`, which replaces its
 * former flutter measure; `fluct` is computed but not displayed here.
 *
 * Roughness and fluctuation are both amplitude modulation, and lumping them
 * together is a mistake this app's old flutter measure made. They are an
 * order of magnitude apart and they are different percepts:
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

import { createPitchTracker } from './pitch.js';

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
 * Roughness is scored on modulation DEPTH -- how deeply the envelope rises
 * and falls in the band, as a fraction of its level -- after the voice's own
 * pulse has been removed (see removePitchLocked).
 *
 * It used to be scored as a ratio against reference rates either side of the
 * band, to cancel the self-modulation every noise has. That hid exactly the
 * sound it was meant to show. A trill is not a smooth wobble but a train of
 * sharp interruptions, and sharp pulses put energy at every rate, references
 * included, so the trill cancelled its own score: a synthetic uvular R had
 * depth 0.67 and ratio 2.3, which displayed as 0.1. Measured on real
 * recordings and synthetic sounds, depth separates them where the ratio did
 * not:
 *
 *   clean vowels, synthetic                   0.01
 *   real vowels, 90th percentile              0.09 - 0.26
 *   real /s/ and /sh/, 90th percentile        0.30 - 0.32
 *   voiced uvular R beating 30/s, median      0.57 - 0.67
 *   voiced gurgle at 70/s, median             0.72
 *
 * The floor sits above what smooth sounds reach on their own, including
 * the fade at the end of a vowel once the envelope is detrended.
 */
const DEPTH_FLOOR = 0.32;
/** Periodicity above which the voice's pulse is taken out of the envelope. */
const REMOVE_MIN_PERIODICITY = 0.45;
const DEPTH_FULL = 0.75;

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


const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createModulation(sampleRate) {
  const hpK = Math.exp(-2 * Math.PI * HP_HZ / sampleRate);
  const envK = 1 - Math.exp(-2 * Math.PI * ENV_HZ / sampleRate);

  let env = null;
  const tracker = createPitchTracker(sampleRate);
  let tmpl = null, tcount = null;
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
    // Remove the straight-line trend, not just the mean. A sound fading in or
    // out changes level across the 36 ms window, and a ramp has its energy at
    // the lowest rates -- right on the 40 Hz probe. With only the mean taken
    // out, every vowel ending read as rough, up to 0.8.
    const c = (n - 1) / 2;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) {
      const dx = i - c;
      sxy += dx * (src[from + i] - mean);
      sxx += dx * dx;
    }
    const slope = sxx > 0 ? sxy / sxx : 0;
    for (let i = 0; i < n; i++) {
      work[i] = (src[from + i] - mean - slope * (i - c)) * win[i];
    }
    return work;
  }

  /**
   * Remove the part of the envelope that repeats at the voice's own pitch.
   *
   * A voiced sound's energy above 2 kHz arrives as one burst per glottal
   * cycle, so its envelope is a pulse train at F0. For an adult voice that
   * lands on the 70 and 110 Hz probes and reads as raggedness -- real vowels
   * read up to 0.5 here as the pitch fell toward 100 Hz. Averaging the
   * envelope over every whole period in the frame gives the shape of one
   * cycle; subtracting that, cycle by cycle, leaves whatever is NOT locked to
   * the pitch. A trill, which beats at its own rate, survives. The voice
   * does not.
   *
   * This only works with a pitch estimate that can be trusted, which is why
   * it arrived together with the YIN tracker in pitch.js: the old
   * autocorrelation tracker made octave errors on a fifth of real vowel
   * frames, and removing the wrong period would remove nothing.
   */
  function removePitchLocked(e, from, to, period) {
    const span = to - from;
    if (!(period > 8) || span < 2 * period) return;
    const len = Math.ceil(period);
    if (!tmpl || tmpl.length < len) { tmpl = new Float64Array(len); tcount = new Uint16Array(len); }
    tmpl.fill(0, 0, len); tcount.fill(0, 0, len);
    for (let i = from; i < to; i++) {
      const j = Math.floor((i - from) % period);
      tmpl[j] += e[i]; tcount[j]++;
    }
    let tmean = 0, used = 0;
    for (let j = 0; j < len; j++) {
      if (tcount[j]) { tmpl[j] /= tcount[j]; tmean += tmpl[j]; used++; }
    }
    tmean /= Math.max(1, used);
    // Mean added back, so the envelope's level -- which fluctuation and the
    // normalisation both use -- is untouched.
    for (let i = from; i < to; i++) {
      const j = Math.floor((i - from) % period);
      e[i] -= tmpl[j] - tmean;
    }
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

      // Pitch first: it decides what to take out of the envelope. The bar is
      // deliberately lower than the voicing verdict. As a vowel dies away its
      // periodicity drops below that verdict while its pulse is still in the
      // envelope, and leaving the pulse in made vowel endings flare to 0.8.
      // A noise frame such as /s/ sits near 0.3 and is left alone.
      const pitch = tracker.analyze(time);
      if (pitch.periodicity >= REMOVE_MIN_PERIODICITY && pitch.candidateHz > 0) {
        removePitchLocked(env, SETTLE, n, sampleRate / pitch.candidateHz);
      }

      const span = n - SETTLE;
      let mean = 0;
      for (let i = SETTLE; i < n; i++) mean += env[i];
      mean /= span;

      let rough = 0, roughDepth = 0;
      if (mean > EPS && span > 64) {
        const w = prepare(env, SETTLE, span, mean);
        let acc = 0, wsum = 0;
        for (let j = 0; j < ROUGH_HZ.length; j++) {
          acc += ROUGH_W[j] * goertzel(w, span, ROUGH_HZ[j]);
          wsum += ROUGH_W[j];
        }
        // Goertzel amplitude, doubled for the Hann window's coherent gain of
        // a half, as a fraction of the envelope level.
        roughDepth = 2 * (acc / wsum) / mean;
        rough = clamp01((roughDepth - DEPTH_FLOOR) / (DEPTH_FULL - DEPTH_FLOOR));
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


      let rms = 0;
      for (let i = 0; i < n; i++) rms += time[i] * time[i];
      rms = Math.sqrt(rms / n);

      return {
        rough,
        roughDepth,
        fluct,
        periodicity: pitch.periodicity,
        aperiodicity: pitch.aperiodicity,
        voiced: pitch.voiced,
        f0Hz: pitch.f0Hz,
        rms,
        hfMean: mean,
      };
    },

    reset() { primed = false; slow = 0; fast = 0; msAc = 0; },
  };
}
