/**
 * auditory.js -- the substrate everything else is measured on.
 *
 * The app next door draws an FFT power spectrum on a log-frequency axis. That
 * is a picture of the signal. This one works on a picture of what the ear
 * does with the signal, which is a different thing in three ways that matter:
 *
 *   1. FREQUENCY. The ear's resolution is roughly constant in Bark, not in Hz
 *      and not quite in octaves either. Equal distance along this axis is
 *      equal perceived distance, so a display built on it does not exaggerate
 *      differences at the top of the range.
 *
 *   2. SENSITIVITY. The ear is far less sensitive at 60 Hz and at 15 kHz than
 *      at 3 kHz. An unweighted spectrum shows energy that nobody can hear.
 *
 *   3. LEVEL. Loudness grows as roughly the 0.23 power of intensity, not
 *      linearly and not quite as dB either, and a sound below threshold
 *      contributes nothing at all rather than a small amount.
 *
 * What comes out is a SPECIFIC LOUDNESS pattern: how much loudness sits at
 * each point along the Bark axis. Every dimension in dimensions.js is a
 * moment or a ratio of that pattern.
 *
 * Honesty about what this is: a working approximation of the Zwicker loudness
 * model, not an ISO 532-1 implementation. It uses Traunmueller's Bark
 * formula, Terhardt's threshold in quiet for both the outer/middle-ear
 * weighting and the threshold term, and Schroeder's level-independent
 * spreading function. The real model has level-dependent spreading, a
 * different upper slope per band, and a calibrated reference. Sharpness and
 * spread are ratios within the pattern and are insensitive to most of that;
 * absolute loudness in sone is NOT trustworthy here and is never presented as
 * such.
 */

const EPS = 1e-30;

/** Bark axis. 0.25 Bark steps over the range a microphone can actually see. */
export const BARK_LO = 1.0;
export const BARK_HI = 23.5;
export const BARK_STEP = 0.25;
export const N_BANDS = Math.round((BARK_HI - BARK_LO) / BARK_STEP) + 1;

/**
 * Traunmueller (1990), with his corrections at the two ends. Analytic, which
 * matters because it has to be inverted for the display axis.
 */
export function hzToBark(f) {
  let z = 26.81 / (1 + 1960 / Math.max(f, 1)) - 0.53;
  if (z < 2) z += 0.15 * (2 - z);
  if (z > 20.1) z += 0.22 * (z - 20.1);
  return z;
}

/** Inverse of the above, by bisection -- it is called once per band at setup. */
export function barkToHz(z) {
  let lo = 1, hi = 24000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hzToBark(mid) < z) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Terhardt's threshold in quiet, dB SPL. Used twice: inverted it is the
 * outer/middle-ear transfer, and as itself it is the level below which a band
 * contributes no loudness.
 */
export function thresholdQuietDb(f) {
  const k = Math.max(f, 20) / 1000;
  return 3.64 * Math.pow(k, -0.8)
    - 6.5 * Math.exp(-0.6 * Math.pow(k - 3.3, 2))
    + 1e-3 * Math.pow(k, 4);
}

/**
 * Schroeder's spreading function, in dB, for a masker `dz` Bark away.
 * Level-independent, which overstates upward spread for quiet sounds and
 * understates it for loud ones. Good enough for a pattern whose moments are
 * what gets used.
 */
function spreadDb(dz) {
  const a = dz + 0.474;
  return 15.81 + 7.5 * a - 17.5 * Math.sqrt(1 + a * a);
}

/**
 * @param {number} sampleRate
 * @param {number} fftSize
 * @param {{dbfsToSpl?:number}} [opts] level of a full-scale sine, in dB SPL.
 *   Uncalibrated by nature -- a web microphone reports no absolute level. It
 *   sets where the threshold term bites, so it shifts quiet sounds in or out
 *   of the pattern. 100 is a reasonable guess for a consumer microphone at
 *   conversational distance.
 */
export function createAuditoryModel(sampleRate, fftSize, opts = {}) {
  const binCount = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const dbfsToSpl = opts.dbfsToSpl != null ? opts.dbfsToSpl : 100;

  /** Centre frequency and width of each Bark band. */
  const bandZ = new Float32Array(N_BANDS);
  const bandHz = new Float32Array(N_BANDS);
  for (let k = 0; k < N_BANDS; k++) {
    bandZ[k] = BARK_LO + k * BARK_STEP;
    bandHz[k] = barkToHz(bandZ[k]);
  }

  /**
   * Which band each FFT bin lands in, and the ear weighting it gets there.
   * Both are fixed by the geometry, so they are built once.
   */
  const binBand = new Int16Array(binCount);
  const binGain = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    const f = i * binHz;
    const z = hzToBark(f);
    if (f < 20 || z < BARK_LO - BARK_STEP || z > BARK_HI + BARK_STEP) {
      binBand[i] = -1;
      binGain[i] = 0;
      continue;
    }
    const k = Math.round((z - BARK_LO) / BARK_STEP);
    binBand[i] = Math.max(0, Math.min(N_BANDS - 1, k));
    // Inverted threshold in quiet, referenced to its minimum, as the
    // outer/middle ear transfer. Clamped so the far ends attenuate rather
    // than vanish, which keeps the pattern continuous.
    const atten = Math.min(40, Math.max(0, thresholdQuietDb(f) - 3));
    binGain[i] = Math.pow(10, -atten / 10);
  }

  /** Spreading kernel along z, truncated where it stops mattering. */
  const KERN_HALF = Math.round(6 / BARK_STEP);
  const kernel = new Float32Array(2 * KERN_HALF + 1);
  for (let j = -KERN_HALF; j <= KERN_HALF; j++) {
    kernel[j + KERN_HALF] = Math.pow(10, spreadDb(j * BARK_STEP) / 10);
  }

  /** Excitation at threshold in quiet, per band, in the same units as power. */
  const eThq = new Float32Array(N_BANDS);
  for (let k = 0; k < N_BANDS; k++) {
    const tq = thresholdQuietDb(bandHz[k]);
    // Threshold expressed as a power relative to full scale, then through the
    // same ear weighting the signal gets, so the two are comparable.
    const atten = Math.min(40, Math.max(0, tq - 3));
    eThq[k] = Math.pow(10, (tq - dbfsToSpl) / 10) * Math.pow(10, -atten / 10);
  }

  const raw = new Float32Array(N_BANDS);
  const excitation = new Float32Array(N_BANDS);
  const specific = new Float32Array(N_BANDS);

  /**
   * Zwicker's specific loudness. The subtraction of 1 is what makes a band at
   * threshold contribute exactly zero instead of a small positive amount --
   * which is why a quiet room draws as nothing here without any extra gating.
   */
  function specificLoudness(e, thq) {
    if (e <= 0) return 0;
    const ratio = e / (thq + EPS);
    const n = 0.08 * Math.pow(thq / 1e-12, 0.23)
      * (Math.pow(0.5 + 0.5 * ratio, 0.23) - 1);
    return n > 0 ? n : 0;
  }

  return {
    bandZ,
    bandHz,
    nBands: N_BANDS,

    /**
     * @param {Float32Array} power linear power per FFT bin, room already
     *   removed. Returns the specific loudness pattern, which is owned by
     *   this model and overwritten on the next call.
     */
    pattern(power) {
      raw.fill(0);
      for (let i = 0; i < binCount; i++) {
        const k = binBand[i];
        if (k < 0) continue;
        raw[k] += power[i] * binGain[i];
      }

      // Spread along z, so a narrow band of noise masks its neighbours the
      // way it really does. Without this a pure tone would read as having
      // zero spread, and two sounds a Bark apart would read as separate when
      // the ear hears one.
      excitation.fill(0);
      for (let k = 0; k < N_BANDS; k++) {
        const e = raw[k];
        if (e <= 0) continue;
        const lo = Math.max(0, k - KERN_HALF);
        const hi = Math.min(N_BANDS - 1, k + KERN_HALF);
        for (let j = lo; j <= hi; j++) {
          excitation[j] += e * kernel[j - k + KERN_HALF];
        }
      }

      for (let k = 0; k < N_BANDS; k++) {
        specific[k] = specificLoudness(excitation[k], eThq[k]);
      }
      return specific;
    },
  };
}
