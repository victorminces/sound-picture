/**
 * temporal.js -- time-domain analysis.
 *
 * Everything in here is measured directly from the waveform, with no FFT, and
 * therefore with none of the time-frequency tradeoff that governs the spectral
 * path. That matters most for flutter: a 2048-point FFT averages power over
 * 42.7 ms, which acts as a low-pass with its first null at 23 Hz, so any
 * raggedness faster than roughly 12 Hz is gone before anything downstream can
 * look at it. Rectifying the waveform instead costs nothing and keeps
 * modulation up to several hundred Hz.
 *
 * Filters are run fresh over each frame rather than carried across frames,
 * because frames arrive on animation callbacks and may overlap or skip
 * unpredictably; a settling margin is discarded at the start instead.
 */

const SETTLE = 320;          // samples dropped while the filters settle
const HP_HZ = 2000;          // isolate the fricative band before rectifying
const ENV_HZ = 400;          // envelope follower
const SLOW_HZ = 120;         // keeps slow modulation, drops intrinsic hiss

/**
 * Bandpass noise has a naturally fluctuating envelope even when the sound is
 * perfectly steady, so a raw coefficient of variation is never zero. These two
 * constants place the zero point just above that intrinsic level and set how
 * much excess modulation counts as fully ragged. Calibrated against synthetic
 * steady and modulated noise in tools/probe.mjs.
 */
const CV_FLOOR = 0.12;
const CV_SPAN = 0.34;

export function createTemporalAnalyzer(sampleRate, frameSize) {
  const hpA = Math.exp(-2 * Math.PI * HP_HZ / sampleRate);
  const envK = 1 - Math.exp(-2 * Math.PI * ENV_HZ / sampleRate);

  // --- decimated buffer for periodicity ---
  const DECIM = 4;
  const decLen = Math.floor(frameSize / DECIM);
  const dec = new Float32Array(decLen);
  const decRate = sampleRate / DECIM;
  const lagMin = Math.max(2, Math.floor(decRate / 400));
  const lagMax = Math.min(decLen - 32, Math.floor(decRate / 70));
  const corr = new Float32Array(lagMax + 2);

  /**
   * Normalised autocorrelation on a decimated copy. Returns both how periodic
   * the frame is and, from the winning lag, the fundamental.
   */
  function periodicity(time) {
    for (let j = 0; j < decLen; j++) {
      const o = j * DECIM;
      dec[j] = (time[o] + time[o + 1] + time[o + 2] + time[o + 3]) * 0.25;
    }
    let e0 = 0;
    for (let j = 0; j < decLen; j++) e0 += dec[j] * dec[j];
    if (e0 < 1e-9) return { r: 0, f0: 0 };

    let best = 0, bestLag = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const n = decLen - lag;
      let num = 0, ea = 0, eb = 0;
      for (let j = 0; j < n; j++) {
        const a = dec[j], b = dec[j + lag];
        num += a * b; ea += a * a; eb += b * b;
      }
      const r = num / (Math.sqrt(ea * eb) + 1e-12);
      corr[lag] = r;
      if (r > best) { best = r; bestLag = lag; }
    }

    // Octave guard. Autocorrelation is almost as strong at twice the true
    // period as at the period itself, so taking the global maximum reports F0
    // an octave low about as often as not. Prefer the shortest lag that is a
    // local peak and nearly as good as the winner.
    let chosen = bestLag;
    if (bestLag > 0) {
      const thresh = best * 0.88;
      for (let lag = lagMin + 1; lag < bestLag; lag++) {
        if (corr[lag] >= thresh && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
          chosen = lag;
          break;
        }
      }
    }

    // Parabolic interpolation around the chosen lag: the decimated rate gives
    // only about 8 Hz of resolution near 220 Hz, which would make the F0 line
    // visibly steppy.
    let refined = chosen;
    if (chosen > lagMin && chosen < lagMax) {
      const y0 = corr[chosen - 1], y1 = corr[chosen], y2 = corr[chosen + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-9) {
        const shift = 0.5 * (y0 - y2) / den;
        if (shift > -1 && shift < 1) refined = chosen + shift;
      }
    }

    return {
      r: Math.max(0, best),
      f0: refined > 0 && best > 0.3 ? decRate / refined : 0,
    };
  }

  /**
   * @param {Float32Array} time waveform, -1..1, length frameSize
   */
  function analyze(time) {
    const n = Math.min(time.length, frameSize);

    // --- overall level ---
    let sq = 0;
    for (let i = 0; i < n; i++) sq += time[i] * time[i];
    const rms = Math.sqrt(sq / n);
    const rmsDb = 20 * Math.log10(rms + 1e-12);

    // Periodicity first, because F0 sets where the envelope filter has to cut.
    const { r, f0 } = periodicity(time);

    // Every glottal pulse gates the frication, so a voiced sibilant's envelope
    // is modulated at F0 whether or not the airstream is ragged. That is
    // voicing, not slushiness, and we already display it separately. Keep the
    // envelope filter below F0 so it cannot be mistaken for flutter -- which
    // matters most for a low-pitched adult voice, where F0 sits right on the
    // fixed 120 Hz cutoff.
    const slowHz = (f0 > 0 && r > 0.4) ? Math.min(SLOW_HZ, 0.6 * f0) : SLOW_HZ;
    const slowK = 1 - Math.exp(-2 * Math.PI * slowHz / sampleRate);

    // --- high-band amplitude envelope ---
    // Two cascaded one-pole high-passes (-12 dB/octave) knock voicing down by
    // roughly 30 dB before rectification, so the envelope describes the
    // frication rather than the voice underneath it.
    let y1 = 0, p1 = 0, y2 = 0, p2 = 0;
    let env = 0, slow = 0;
    let sum = 0, sumSq = 0, count = 0;
    let peak = 0;

    for (let i = 0; i < n; i++) {
      const x = time[i];
      y1 = hpA * (y1 + x - p1); p1 = x;
      y2 = hpA * (y2 + y1 - p2); p2 = y1;

      env += (Math.abs(y2) - env) * envK;
      slow += (env - slow) * slowK;

      if (i >= SETTLE) {
        sum += slow;
        sumSq += slow * slow;
        count++;
        if (slow > peak) peak = slow;
      }
    }

    let flutter = 0, cv = 0, hfRms = 0;
    if (count > 0) {
      const mean = sum / count;
      hfRms = mean;
      if (mean > 1e-7) {
        const varr = Math.max(0, sumSq / count - mean * mean);
        cv = Math.sqrt(varr) / mean;
        flutter = Math.max(0, Math.min(1, (cv - CV_FLOOR) / CV_SPAN));
      }
    }

    return {
      rms, rmsDb,
      hfRms,
      hfDb: 20 * Math.log10(hfRms + 1e-12),
      cv,            // raw coefficient of variation, before the floor
      flutter,       // 0 = steady hiss, 1 = strongly modulated
      periodicity: r,
      f0Hz: f0,
    };
  }

  return { analyze };
}
