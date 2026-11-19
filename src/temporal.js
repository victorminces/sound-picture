/**
 * temporal.js -- time-domain analysis.
 *
 * Everything in here is measured directly from the waveform, with no FFT, and
 * therefore with none of the time-frequency tradeoff that governs the spectral
 * path. That matters most for roughness: a 2048-point FFT averages power over
 * 42.7 ms, which acts as a low-pass with its first null at 23 Hz, so any
 * raggedness faster than roughly 12 Hz is gone before anything downstream can
 * look at it. Rectifying the waveform instead costs nothing and keeps
 * modulation up to several hundred Hz.
 *
 * Filters are run fresh over each frame rather than carried across frames,
 * because frames arrive on animation callbacks and may overlap or skip
 * unpredictably; a settling margin is discarded at the start instead.
 */

import { createModulation } from './modulation.js';

/**
 * Roughness -- the ragged, wet or rattling quality of a sound -- comes from
 * modulation.js, the measure developed and checked in the perceptual app.
 *
 * It replaces a flutter measure that never worked: the coefficient of
 * variation of a smoothed envelope against a fixed threshold. How much a band
 * of noise varies on its own depends on how wide the band is, so the threshold
 * that passed against the narrow synthetic carrier it was calibrated on never
 * tripped on a real, wide /s/ -- it read 0.00 at every modulation rate tested.
 * The replacement removes the voice's own pulse first (with a YIN pitch
 * tracker), then scores modulation depth at 40-110 Hz above what smooth sounds
 * reach: clean vowels and /s/ read 0.00, a voiced uvular R about 0.8-1.0.
 */

export function createTemporalAnalyzer(sampleRate, frameSize) {
  const roughness = createModulation(sampleRate);

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

    // Periodicity, F0 and voicing for display and for the gate: unchanged.
    const { r, f0 } = periodicity(time);

    // Roughness, with the voice's own pulse removed before it is measured.
    const m = roughness.analyze(time);

    return {
      rms, rmsDb,
      rough: m.rough,            // 0 = smooth, 1 = strongly ragged
      roughDepth: m.roughDepth,  // raw modulation depth, before the floor
      periodicity: r,
      f0Hz: f0,
    };
  }

  return { analyze };
}
