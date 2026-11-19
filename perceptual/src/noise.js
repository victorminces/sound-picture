/**
 * noise.js -- the room floor, captured and removed.
 *
 * Lifted from the sibilant app next door, where it went through several wrong
 * versions before this one. Two statistics come out of one capture, and they
 * are not interchangeable:
 *
 *   - the MEAN, estimated as a per-bin median scaled by 1/ln2, is what a
 *     signal's level is compared against when deciding whether there is any
 *     sound at all. An average is the right question there.
 *
 *   - a high PERCENTILE is what gets subtracted. The power in one FFT bin of a
 *     steady noise is exponentially distributed about its mean, so subtracting
 *     the mean leaves roughly a fifth of the bins standing on every frame --
 *     a speckle that fills the picture in a perfectly quiet room. A percentile
 *     is what the room actually reaches rather than what it averages.
 *
 * The median matters because a capture is made in a room with a child in it.
 * One cough, chair creak or breath inflates a mean floor by tens of dB and
 * then gates out ordinary speech. A median tolerates up to half the capture
 * being contaminated with no effect at all.
 */

const EPS = 1e-30;
/** Median of an exponential sits at ln2 of its mean; scale back up. */
const MEDIAN_TO_MEAN = 1.44;
/** Quantile used for the subtraction floor. */
const SUB_PCT = 0.90;
/** Exponential quantile at SUB_PCT, for the too-few-frames fallback. */
const SUB_FALLBACK = 2.3;
/** Fewer frames than this is a slip of the finger, not a capture. */
const MIN_FRAMES = 8;
/** ~4 s at 60 fps. */
const MAX_SNAPS = 240;

export function createNoiseFloor(binCount, sampleRate, fftSize) {
  const binHz = sampleRate / fftSize;
  const mean = new Float32Array(binCount);
  const sub = new Float32Array(binCount);
  const snaps = [];
  const pick = new Float32Array(MAX_SNAPS);

  let snapWrite = 0;
  let frames = 0;
  let learning = 0;
  let holding = false;
  let saved = null;
  let meanAllDb = -120;

  const binOf = (hz) =>
    Math.max(0, Math.min(binCount - 1, Math.round(hz / binHz)));
  /** Above room rumble, below nothing that matters: "is there sound". */
  const ALL_LO = binOf(200), ALL_HI = binOf(10000);

  function bandSum(arr, lo, hi) {
    let s = 0;
    for (let i = lo; i <= hi; i++) s += arr[i];
    return s;
  }

  function saveProfile() {
    saved = {
      mean: Float32Array.from(mean),
      sub: Float32Array.from(sub),
      frames,
      allDb: meanAllDb,
    };
  }

  function restoreProfile() {
    if (!saved) return;
    mean.set(saved.mean);
    sub.set(saved.sub);
    frames = saved.frames;
    meanAllDb = saved.allDb;
  }

  function reset() {
    mean.fill(0);
    sub.fill(0);
    frames = 0;
    snaps.length = 0;
    snapWrite = 0;
  }

  function startLearn(n = 45) {
    saveProfile();
    reset();
    learning = n;
    holding = false;
  }

  function beginHold() {
    saveProfile();
    reset();
    learning = 1;      // non-zero for as long as the hold lasts
    holding = true;
  }

  /**
   * Ends a held capture. Reports whether the sample was used, not just how
   * long it was: the caller must not announce success for a slip. Frame count
   * is a floor here, not the policy -- frames are a poor proxy for duration
   * when the frame rate varies, so the caller decides on elapsed time.
   */
  function endHold(commit = true) {
    holding = false;
    learning = 0;
    const n = frames;
    const accepted = commit && n >= MIN_FRAMES;
    if (accepted) finish();
    else restoreProfile();
    return { frames: n, accepted };
  }

  function finish() {
    const n = snaps.length;
    if (n >= MIN_FRAMES) {
      const mid = n >> 1;
      const pIdx = Math.min(n - 1, Math.floor(SUB_PCT * (n - 1)));
      for (let i = 0; i < binCount; i++) {
        for (let j = 0; j < n; j++) pick[j] = snaps[j][i];
        const slice = pick.subarray(0, n);
        slice.sort();
        const med = n % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
        mean[i] = med * MEDIAN_TO_MEAN;
        sub[i] = slice[pIdx];
      }
    } else {
      for (let i = 0; i < binCount; i++) {
        mean[i] /= Math.max(1, frames);
        sub[i] = mean[i] * SUB_FALLBACK;
      }
    }
    meanAllDb = 10 * Math.log10(bandSum(mean, ALL_LO, ALL_HI) + EPS);
  }

  return {
    /**
     * Feed every frame here first. Returns true while a capture is running,
     * in which case the caller should draw nothing and measure nothing.
     */
    learn(power) {
      if (learning <= 0) return false;
      for (let i = 0; i < binCount; i++) mean[i] += power[i];
      frames++;
      if (snaps.length < MAX_SNAPS) {
        snaps.push(Float32Array.from(power));
      } else {
        snaps[snapWrite].set(power);          // keep the most recent window
        snapWrite = (snapWrite + 1) % MAX_SNAPS;
      }
      if (!holding) {
        learning--;
        if (learning === 0 && frames > 0) finish();
      }
      return true;
    },

    /**
     * How far the whole band sits above the measured room, in dB. Must be
     * asked BEFORE subtraction: comparing a subtracted signal against an
     * unsubtracted floor understates the margin by roughly the noise level.
     */
    marginDb(power) {
      const raw = 10 * Math.log10(bandSum(power, ALL_LO, ALL_HI) + EPS);
      return raw - meanAllDb;
    },

    /** Remove the room, in place. */
    subtract(power) {
      for (let i = 0; i < binCount; i++) {
        const p = power[i] - sub[i];
        power[i] = p > 0 ? p : 0;
      }
    },

    startLearn,
    beginHold,
    endHold,
    get ready() { return frames >= MIN_FRAMES; },
  };
}
