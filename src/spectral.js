/**
 * spectral.js -- frequency-domain analysis.
 *
 * This path owns the envelope that gets drawn and the measures that are
 * summaries of that envelope's shape: centre of gravity, spread, high-frequency
 * ratio, bimodality, and any antiresonance notch. It deliberately uses a long
 * window and heavy band averaging, because every one of those quantities is an
 * average anyway and stability matters more than speed. Anything that needs
 * millisecond resolution lives in temporal.js and never touches an FFT.
 *
 * Moments are computed in log2(frequency) so that "spread" is measured in
 * octaves. On a linear Hz axis a high-frequency /s/ always looks wider than a
 * low-frequency sh purely because of where it sits, which would confound place
 * with focus. Log-frequency moments do not.
 */

const EPS = 1e-12;

export const BANDS = {
  anaLo: 1200,     // analysis band for spectral moments
  anaHi: 12000,
  voiceLo: 150,    // voice bar, above the worst of the room rumble
  voiceHi: 1000,
  fmtLo: 300,      // vowel formant region, for rejecting vowels
  fmtHi: 2600,
  lowMidLo: 1200,  // flat-carpet region: an interdental th fills this in
  lowMidHi: 2000,
  midLo: 2000,     // mid-frequency resonance region
  midHi: 4500,
  hiLo: 4500,      // grooved-/s/ region
  hiHi: 12000,
  notchLo: 2000,   // where a lateral antiresonance would plausibly sit
  notchHi: 6000,
  // The band used to decide whether anyone is making a sound. Not the whole
  // spectrum: rooms are loudest at the very bottom, so a band starting at
  // 60 Hz is dominated by rumble in BOTH the floor and the signal, and a voice
  // 25 dB above the room moves the total by under a decibel. Starting at
  // 200 Hz puts the test where speech energy actually lives.
  allLo: 200,
  allHi: 10000,
};

/**
 * Log-spaced display bands.
 *
 * The display band is deliberately wider than the measurement band at both
 * ends. It starts at 80 Hz so voicing and the voice bar of /z/ are visible,
 * and runs to 20 kHz so the weak, diffuse high-frequency energy of /f/ shows
 * in full.
 * Spectral moments stay on 1.2-12 kHz, because microphone response above that
 * is unreliable and widening it would shift every centre-of-gravity figure.
 * Nothing is kept off the screen for not being a sibilant.
 */
export const SPEC_BANDS = 128;
export const SPEC_LO = 80;
export const SPEC_HI = 20000;

/**
 * Width of the smoothing applied to the linear power spectrum before it is
 * binned for display.
 *
 * This is what turns a narrowband view into a wideband one. Harmonics sit F0
 * apart in Hz, so the kernel that erases them is constant in Hz too; formants
 * sit roughly 1300 Hz apart for a child, so staying well under that keeps the
 * envelope intact. The same choice sets the ~3 ms window of a classic wideband
 * spectrogram, arrived at from the other direction.
 *
 * Doing it here rather than by shortening the analysis window means we keep the
 * fine frequency resolution for the measurement path, and get a roughly
 * fourfold reduction in per-band estimate noise for free.
 */
export const ENVELOPE_HZ = 450;

/** Display tilt pivot: the frequency at which the tilt applies no gain. */
const TILT_PIVOT_HZ = 1000;
const SPEC_SPAN = Math.log2(SPEC_HI) - Math.log2(SPEC_LO);

export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Where a frequency sits on the display axis, 0 at 200 Hz to 1 at 12 kHz. */
export function specPos(hz) {
  if (!(hz > 0)) return 0;
  return clamp01((Math.log2(hz) - Math.log2(SPEC_LO)) / SPEC_SPAN);
}

/** The inverse, for axis labels. */
export function specHz(pos) {
  return Math.pow(2, Math.log2(SPEC_LO) + pos * SPEC_SPAN);
}

/** Centre frequency of display band k. */
export function bandHz(k) {
  return specHz((k + 0.5) / SPEC_BANDS);
}

/** Display band index nearest a frequency. */
export function bandIndex(hz) {
  return Math.max(0, Math.min(SPEC_BANDS - 1, Math.round(specPos(hz) * (SPEC_BANDS - 1))));
}

/**
 * Floor on usable frames, whatever the clock says. Deliberately low: elapsed
 * time is the policy and lives in the caller, so this only guards against
 * averaging almost nothing. Set any higher and a slow machine rejects holds
 * that were plenty long by the clock.
 */
const MIN_NOISE_FRAMES = 8;

/** Notch must be this deep, in dB, before it is reported at all. */
const NOTCH_MIN_DB = 8;

export function createSpectralAnalyzer(sampleRate, fftSize) {
  const binCount = fftSize >> 1;
  const binHz = sampleRate / fftSize;
  const nyquist = sampleRate / 2;

  const idx = (hz) => Math.max(0, Math.min(binCount - 1, Math.round(hz / binHz)));
  const clampHz = (hz) => Math.min(hz, nyquist * 0.94);

  const freq = new Float32Array(binCount);
  const log2f = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    freq[i] = i * binHz;
    log2f[i] = i > 0 ? Math.log2(freq[i]) : 0;
  }

  const B = {
    anaLo: idx(BANDS.anaLo), anaHi: idx(clampHz(BANDS.anaHi)),
    voiceLo: idx(BANDS.voiceLo), voiceHi: idx(BANDS.voiceHi),
    fmtLo: idx(BANDS.fmtLo), fmtHi: idx(BANDS.fmtHi),
    lowMidLo: idx(BANDS.lowMidLo), lowMidHi: idx(BANDS.lowMidHi),
    midLo: idx(BANDS.midLo), midHi: idx(BANDS.midHi),
    hiLo: idx(BANDS.hiLo), hiHi: idx(clampHz(BANDS.hiHi)),
    allLo: idx(BANDS.allLo), allHi: idx(clampHz(BANDS.allHi)),
  };

  const specEdges = new Int32Array(SPEC_BANDS + 1);
  for (let k = 0; k <= SPEC_BANDS; k++) {
    specEdges[k] = idx(clampHz(SPEC_LO * Math.pow(SPEC_HI / SPEC_LO, k / SPEC_BANDS)));
  }

  const power = new Float32Array(binCount);
  const powerWide = new Float32Array(binCount);   // constant-Hz smoothed, display only
  const prefix = new Float64Array(binCount + 1);
  const smooth = new Float32Array(binCount);
  const spectrum = new Float32Array(SPEC_BANDS);
  const bandDb = new Float32Array(SPEC_BANDS);     // smoothed and tilted, for display
  const bandDbRaw = new Float32Array(SPEC_BANDS);  // neither, for notch hunting

  const halfBins = Math.max(1, Math.round((ENVELOPE_HZ / 2) / binHz));

  /** Box filter of constant width in Hz, via a running sum. */
  function smoothLinearInto(src, dst) {
    prefix[0] = 0;
    for (let i = 0; i < binCount; i++) prefix[i + 1] = prefix[i] + src[i];
    for (let i = 0; i < binCount; i++) {
      const lo = i - halfBins < 0 ? 0 : i - halfBins;
      const hi = i + halfBins >= binCount ? binCount - 1 : i + halfBins;
      dst[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    }
  }

  // --- display controls ---
  let displayGainDb = 0;
  let tiltDbPerOct = 4;
  const tiltDb = new Float32Array(SPEC_BANDS);

  function recomputeTilt() {
    for (let k = 0; k < SPEC_BANDS; k++) {
      tiltDb[k] = tiltDbPerOct * Math.log2(bandHz(k) / TILT_PIVOT_HZ);
    }
  }
  recomputeTilt();

  /**
   * Display-only. The tilt is a constant offset per band, so two productions
   * stay comparable to each other and to a frozen reference; it only stops the
   * vowel region from setting the scale for the whole picture.
   */
  function setDisplay(o) {
    if (o.gainDb != null) displayGainDb = o.gainDb;
    if (o.tiltDbPerOct != null && o.tiltDbPerOct !== tiltDbPerOct) {
      tiltDbPerOct = o.tiltDbPerOct;
      recomputeTilt();
    }
  }

  // --- room noise ---
  //
  // The floor is the per-bin MEDIAN of the captured frames, not the mean.
  // Power means are dominated by their peaks, so a single breath, click or
  // chair creak during the capture drags the whole floor up, and every later
  // sound then measures as barely above the room. A median shrugs off up to
  // half the capture being contaminated, which matters because holding a
  // button in genuine silence for two seconds is harder than it sounds --
  // especially with a child in the room.
  const noise = new Float32Array(binCount);
  const NOISE_SNAPSHOTS = 240;        // ~4 s at 60 fps, 1 MB at 1024 bins
  const snaps = [];
  let snapWrite = 0;
  const pick = new Float32Array(NOISE_SNAPSHOTS);

  /**
   * A second floor, used only for the subtraction. The power in one bin of a
   * steady noise is exponentially distributed about its mean, so subtracting
   * the mean -- even 1.6x of it -- leaves about a fifth of the bins still
   * standing. That residue was the speckle that filled a quiet room's picture
   * and made a correct capture look worse than a mistaken one. A high
   * percentile of the same snapshots is what the room actually reaches, so
   * subtracting that empties it. The mean stays as the floor the band energies
   * and the gate are measured against, where an average is the right statistic.
   */
  const noiseSub = new Float32Array(binCount);
  const NOISE_SUB_PCT = 0.90;
  /** Exponential quantile at NOISE_SUB_PCT, for the too-few-frames fallback. */
  const SUB_FALLBACK = 2.3;

  /**
   * What the room draws as, per display band, once it has been through the
   * whole processing chain -- measured from the capture rather than predicted,
   * so it needs no assumption about the room or the microphone. Stored without
   * the tilt, which is a display offset that can change afterwards.
   */
  const noiseDispDb = new Float32Array(SPEC_BANDS).fill(-300);
  const dispSamples = new Float32Array(SPEC_BANDS * NOISE_SNAPSHOTS);
  const resid = new Float32Array(binCount);
  /** Fade a band in over this much clearance above its own room floor. */
  const ROOM_FADE_DB = 6;

  /**
   * Median of an exponentially distributed power estimate sits at ln(2) of
   * its mean, so scale back up to keep the floor comparable with the mean it
   * replaces. Modest and far less sensitive to the distribution than a lower
   * percentile would be.
   */
  const MEDIAN_TO_MEAN = 1.44;
  let noiseFrames = 0;
  let noiseBandDb = -90;
  let noiseHiDb = -90;
  let noiseSpecDb = -120;   // loudest display band of the room, smoothed+tilted
  let noiseRawDb = -120;    // the same, unsmoothed and untilted, for the notch
  let noiseVoiceDb = -120;  // floor of the voice band, for gating voicing
  let noiseAllDb = -120;    // broadband floor, for deciding there is sound
  let learningNoise = 0;
  let holdingNoise = false;

  // --- display scaling ---
  let dispPeakDb = -120;     // decaying peak, used when nothing is locked
  let lockedTopDb = null;    // set when a reference is frozen

  // --- steadiness history ---
  const HIST = 14;
  const cogHist = new Float32Array(HIST);
  let histN = 0, histW = 0;

  const notchFrom = bandIndex(BANDS.notchLo);
  const notchTo = bandIndex(BANDS.notchHi);

  /**
   * Room-noise capture.
   *
   * Two ways in. `startNoiseLearn(frames)` gathers a fixed number of frames
   * and is what runs once at startup so the app is usable immediately.
   * `beginNoiseHold()` / `endNoiseHold()` gather for as long as the clinician
   * holds the button down, which is the better option: a longer recording is
   * a better estimate of the room, and holding a button makes it obvious both
   * that something is being captured and exactly when.
   *
   * What is captured is subtracted from every later frame, so a steady fan or
   * hum stops contributing to the picture and to the measurements.
   */
  /**
   * The profile in force, kept whole so that an abandoned capture can put it
   * back. Without this, pressing the button and letting go too soon wiped a
   * good floor and left the half-gathered sum in its place -- a floor several
   * times too high, which over-subtracted so hard that the picture looked
   * cleaner than a correct capture made it.
   */
  let saved = null;

  function saveProfile() {
    saved = {
      noise: Float32Array.from(noise),
      sub: Float32Array.from(noiseSub),
      disp: Float32Array.from(noiseDispDb),
      frames: noiseFrames,
      bandDb: noiseBandDb, hiDb: noiseHiDb, voiceDb: noiseVoiceDb,
      allDb: noiseAllDb, specDb: noiseSpecDb, rawDb: noiseRawDb,
      peakDb: dispPeakDb,
    };
  }

  function restoreProfile() {
    if (!saved) return;
    noise.set(saved.noise);
    noiseSub.set(saved.sub);
    noiseDispDb.set(saved.disp);
    noiseFrames = saved.frames;
    noiseBandDb = saved.bandDb; noiseHiDb = saved.hiDb;
    noiseVoiceDb = saved.voiceDb; noiseAllDb = saved.allDb;
    noiseSpecDb = saved.specDb; noiseRawDb = saved.rawDb;
    dispPeakDb = saved.peakDb;
  }

  function resetCapture() {
    noise.fill(0);
    noiseSub.fill(0);
    noiseDispDb.fill(-300);
    noiseFrames = 0;
    snaps.length = 0;
    snapWrite = 0;
  }

  function startNoiseLearn(frames = 45) {
    saveProfile();
    resetCapture();
    learningNoise = frames;
    holdingNoise = false;
  }

  function beginNoiseHold() {
    saveProfile();
    resetCapture();
    learningNoise = 1;     // kept non-zero for as long as the hold lasts
    holdingNoise = true;
  }

  /**
   * Ends a held capture. Reports whether the sample was actually used, not
   * just how long it was: a brief slip of the finger keeps the previous
   * profile, and the caller must not announce success for it.
   *
   * The frame count here is a floor, not the policy. Frames are a poor proxy
   * for duration when the frame rate varies, so the caller passes `commit`
   * after checking elapsed time, which it is the only one that knows.
   */
  function endNoiseHold(commit = true) {
    holdingNoise = false;
    learningNoise = 0;
    const frames = noiseFrames;
    const accepted = commit && frames >= MIN_NOISE_FRAMES;
    if (accepted) finishNoiseLearn();
    else restoreProfile();  // too short to trust; put the previous one back
    return { frames, accepted };
  }

  /** Reduce what was gathered to a floor, and derive everything from it. */
  function finishNoiseLearn() {
    const n = snaps.length;
    if (n >= 8) {
      for (let i = 0; i < binCount; i++) {
        for (let j = 0; j < n; j++) pick[j] = snaps[j][i];
        const slice = pick.subarray(0, n);
        slice.sort();
        const m = n >> 1;
        const med = n % 2 ? slice[m] : (slice[m - 1] + slice[m]) / 2;
        noise[i] = med * MEDIAN_TO_MEAN;
        // The same sorted bin gives the subtraction floor for free.
        noiseSub[i] = slice[Math.min(n - 1, Math.floor(NOISE_SUB_PCT * (n - 1)))];
      }
    } else {
      // Too few frames to take a median of; fall back to the mean.
      for (let i = 0; i < binCount; i++) {
        noise[i] /= noiseFrames;
        noiseSub[i] = noise[i] * SUB_FALLBACK;
      }
    }
    noiseBandDb = 10 * Math.log10(bandSum(noise, B.anaLo, B.anaHi) + EPS);
    noiseHiDb = 10 * Math.log10(bandSum(noise, B.hiLo, B.hiHi) + EPS);
    noiseVoiceDb = 10 * Math.log10(bandSum(noise, B.voiceLo, B.voiceHi) + EPS);
    noiseAllDb = 10 * Math.log10(bandSum(noise, B.allLo, B.allHi) + EPS);

    smoothLinearInto(noise, powerWide);
    noiseSpecDb = -300;
    noiseRawDb = -300;
    for (let k = 0; k < SPEC_BANDS; k++) {
      const d = 10 * Math.log10(bandMean(powerWide, k) + EPS) + tiltDb[k];
      if (d > noiseSpecDb) noiseSpecDb = d;
      const raw = 10 * Math.log10(bandMean(noise, k) + EPS);
      if (raw > noiseRawDb) noiseRawDb = raw;
    }
    // What the room actually draws as, band by band. Every captured frame is
    // put through the same subtraction, smoothing and binning as a live one,
    // and a high percentile of the result becomes that band's floor. Measuring
    // this beats predicting it: it assumes nothing about the room or the
    // microphone, and it is what keeps the top of the picture dark, where the
    // tilt multiplies whatever the room leaves behind by thirty-odd dB.
    if (n >= 8) {
      for (let j = 0; j < n; j++) {
        const snap = snaps[j];
        for (let i = 0; i < binCount; i++) {
          const p = snap[i] - noiseSub[i];
          resid[i] = p > 0 ? p : 0;
        }
        smoothLinearInto(resid, powerWide);
        for (let k = 0; k < SPEC_BANDS; k++) {
          dispSamples[k * n + j] = 10 * Math.log10(bandMean(powerWide, k) + EPS);
        }
      }
      const idx = Math.min(n - 1, Math.floor(0.97 * (n - 1)));
      const slice = pick.subarray(0, n);
      for (let k = 0; k < SPEC_BANDS; k++) {
        for (let j = 0; j < n; j++) slice[j] = dispSamples[k * n + j];
        slice.sort();
        noiseDispDb[k] = slice[idx];
      }
    } else {
      noiseDispDb.fill(-300);
    }

    dispPeakDb = noiseSpecDb + 12;
  }

  /**
   * Pin the display scale to the level now in front of us. Afterwards a weaker
   * production renders visibly dimmer than the reference instead of being
   * normalised back up to full brightness, which is what makes an interdental
   * th look as weak on screen as it sounds.
   */
  function lockDisplayTop() { lockedTopDb = dispPeakDb; }
  function unlockDisplayTop() { lockedTopDb = null; }
  function isDisplayLocked() { return lockedTopDb !== null; }

  function dbToPower(db) {
    return db <= -175 || !Number.isFinite(db) ? 0 : Math.pow(10, db / 10);
  }

  function bandSum(arr, lo, hi) {
    let s = 0;
    for (let i = lo; i <= hi; i++) s += arr[i];
    return s;
  }

  function bandMean(arr, k) {
    const lo = specEdges[k];
    const hi = Math.max(lo, specEdges[k + 1] - 1);
    let s = 0;
    for (let i = lo; i <= hi; i++) s += arr[i];
    return s / (hi - lo + 1);
  }

  /**
   * Deepest valley flanked by higher ground on both sides, searched over the
   * region where a lateral side-channel antiresonance would plausibly fall.
   * Run on the unsmoothed bands on purpose: the display smoothing that keeps
   * the picture legible would erase exactly this feature, which is the reason
   * it is detected here and drawn as a marker rather than left to survive to
   * the screen on its own.
   */
  function findNotch() {
    const W = 10;
    // The flanks have to be real energy, and the valley has to still contain
    // something. Without the second test, any gap that simply falls to the
    // room floor reads as an infinitely deep notch.
    const flankMin = noiseRawDb + 15;
    const valleyMin = noiseRawDb + 6;

    let bestDepth = 0, bestIdx = -1;
    for (let i = notchFrom; i <= notchTo; i++) {
      if (bandDbRaw[i] < valleyMin) continue;
      let left = -300, right = -300;
      for (let j = Math.max(0, i - W); j <= i - 3; j++) if (bandDbRaw[j] > left) left = bandDbRaw[j];
      for (let j = i + 3; j <= Math.min(SPEC_BANDS - 1, i + W); j++) if (bandDbRaw[j] > right) right = bandDbRaw[j];
      if (left < flankMin || right < flankMin) continue;
      const depth = Math.min(left, right) - bandDbRaw[i];
      if (depth > bestDepth) { bestDepth = depth; bestIdx = i; }
    }
    return bestDepth >= NOTCH_MIN_DB
      ? { hz: bandHz(bestIdx), depthDb: bestDepth, band: bestIdx }
      : null;
  }

  /**
   * @param {Float32Array} db  frequency-domain magnitudes in dB
   * @param {{gateDb?:number, periodicity?:number}} opts
   */
  function analyze(db, opts) {
    const gateDb = (opts && opts.gateDb) != null ? opts.gateDb : 9;
    const per = (opts && opts.periodicity) || 0;

    for (let i = 0; i < binCount; i++) power[i] = dbToPower(db[i]);

    if (learningNoise > 0) {
      for (let i = 0; i < binCount; i++) noise[i] += power[i];
      noiseFrames++;
      if (snaps.length < NOISE_SNAPSHOTS) {
        snaps.push(Float32Array.from(power));
      } else {
        // Keep the most recent window rather than the first.
        snaps[snapWrite].set(power);
        snapWrite = (snapWrite + 1) % NOISE_SNAPSHOTS;
      }
      if (!holdingNoise) {
        learningNoise--;
        if (learningNoise === 0 && noiseFrames > 0) finishNoiseLearn();
      }
      return { ready: false, learningNoise: true, active: false, spectrum };
    }

    // Band energies for the gate, taken BEFORE subtraction. The floor these
    // are compared against is the raw measured room, so the signal has to be
    // raw too. Testing subtracted energy against an unsubtracted floor -- as
    // this did -- understates the margin by roughly the whole noise level, and
    // with 1.6x over-subtraction on top it understated it badly enough to keep
    // ordinary speech below the gate.
    const rawAll = bandSum(power, B.allLo, B.allHi);
    const rawVoice = bandSum(power, B.voiceLo, B.voiceHi);
    const rawAllDb = 10 * Math.log10(rawAll + EPS);
    const rawVoiceDb = 10 * Math.log10(rawVoice + EPS);
    const aboveFloorDb = rawAllDb - noiseAllDb;

    // Spectral subtraction, so room hiss does not drag the centre of gravity
    // around while the child is quiet.
    for (let i = 0; i < binCount; i++) {
      const p = power[i] - noiseSub[i];
      power[i] = p > 0 ? p : 0;
    }

    const eVoice = bandSum(power, B.voiceLo, B.voiceHi);
    const eFmt = bandSum(power, B.fmtLo, B.fmtHi);
    const eBand = bandSum(power, B.anaLo, B.anaHi);
    const eLowMid = bandSum(power, B.lowMidLo, B.lowMidHi);
    const eMid = bandSum(power, B.midLo, B.midHi);
    const eHi = bandSum(power, B.hiLo, B.hiHi);
    const eAll = bandSum(power, B.allLo, B.allHi);

    const levelDb = 10 * Math.log10(eBand + EPS);
    const hiDb = 10 * Math.log10(eHi + EPS);
    const lowRatio = eVoice / (eBand + EPS);

    // Gate, routed on periodicity, because voiced and voiceless sounds have to
    // be judged on different evidence. Voiceless: a fricative puts almost
    // nothing in the vowel formant region. Voiced: for /z/ the voice bar
    // legitimately dominates, so demand real frication at 4.5-12 kHz instead,
    // which is also what rejects a child's "ee".
    const fricScore = eBand / (eBand + eFmt + EPS);

    // "Is there sound" has to be asked of the whole spectrum. Asking it of the
    // 1.2-12 kHz analysis band instead makes it a sibilant test by the back
    // door: a vowel puts nearly all its energy below 1.2 kHz and would never
    // clear it, so the measurements stayed hidden on exactly the sounds that
    // ungating them was meant to reveal.
    const levelAllDb = rawAllDb;
    const loud = aboveFloorDb > gateDb;
    const periodic = per > 0.40 && lowRatio > 0.12;
    const hiLoud = hiDb > noiseHiDb + gateDb + 2;
    const active = loud && (periodic
      ? hiLoud && eHi / (eHi + eFmt + EPS) > 0.12
      : fricScore > 0.45);

    // --- display spectrum, drawn whatever the gate decides ---
    // Smooth in linear frequency first, so harmonics are gone before anything
    // is binned, then tilt. The raw bands are kept alongside for the notch.
    smoothLinearInto(power, powerWide);

    let maxBandDb = -300;
    for (let k = 0; k < SPEC_BANDS; k++) {
      bandDbRaw[k] = 10 * Math.log10(bandMean(power, k) + EPS);
      const d = 10 * Math.log10(bandMean(powerWide, k) + EPS) + tiltDb[k];
      bandDb[k] = d;
      if (d > maxBandDb) maxBandDb = d;
    }

    if (maxBandDb > dispPeakDb) dispPeakDb = maxBandDb;
    else dispPeakDb = Math.max(noiseSpecDb + 12, dispPeakDb - 0.6);

    // refLo sets the brightness scale and nothing else. What is drawn at all
    // is decided per band, by fading each one out as it nears its own measured
    // room floor. The scalar could never do that job: it is pinned to the
    // loudest band of the tilted room, which with any tilt is the topmost band,
    // so an upward flicker up there drew brightly -- brighter still once the
    // brightness slider was turned up -- while the same flicker in the middle
    // drew black. That is why the top of the picture stayed lit however
    // carefully the room was recorded.
    const refSpan = 46;
    const top = lockedTopDb !== null ? lockedTopDb : dispPeakDb;
    const refLo = Math.max(noiseSpecDb + 2, top - refSpan);
    for (let k = 0; k < SPEC_BANDS; k++) {
      const v = clamp01((bandDb[k] + displayGainDb - refLo) / refSpan);
      if (noiseDispDb[k] <= -299) { spectrum[k] = v; continue; }
      // bandDb carries the tilt and the stored floor does not, so take it off.
      const clear = bandDb[k] - tiltDb[k] - noiseDispDb[k];
      spectrum[k] = v * clamp01(clear / ROOM_FADE_DB);
    }

    const levelRel = clamp01((levelDb - noiseBandDb) / 55);

    // Voicing is computed before the sibilant gate, not after it: that gate
    // decides whether the sibilant measures are meaningful and has no business
    // deciding whether the larynx is running, since the F0 line has to be
    // drawable on a vowel.
    //
    // It does need a gate of its own, though. The temporal path measures
    // periodicity on the raw waveform with no level test at all, and the
    // autocorrelation of quiet room noise drifts well past 0.35 -- which drew
    // an F0 line over silence. So require the voice band itself to be properly
    // above the room before believing any of it.
    //
    // Detection is deliberately generous; the display does the discriminating
    // by drawing weak voicing faintly. An earlier pass raised this threshold
    // AND added the level gate AND steepened the drawing curve all at once,
    // which compounded into something that barely registered real speech. The
    // level gate is what actually keeps room noise out, so it stays; the
    // thresholds around it do not need to be stingy as well.
    const voiceLoud = rawVoiceDb - noiseVoiceDb > gateDb;
    const voicing = voiceLoud
      ? clamp01((per - 0.38) / 0.32) * clamp01(lowRatio / 0.08)
      : 0;

    // Measures are computed whenever there is sound at all, not only when the
    // sibilant gate opens. `active` is still reported, because grain has to
    // stay off non-fricatives -- a vowel's envelope is modulated at the
    // voicing rate, which is not raggedness -- but nothing else is withheld.
    if (!loud) {
      histN = 0; histW = 0;
      return {
        ready: true, active: false, loud: false, levelDb, levelAllDb,
        aboveFloorDb, levelRel,
        noiseBandDb, fricScore, lowRatio, spectrum, cogHz: 0, peakHz: 0,
        spreadOct: 0, focus: 0, hfRatio: 0, bimodality: 0, lowMidRatio: 0,
        voicing, steadiness: 0, notch: null,
        displayLocked: lockedTopDb !== null,
      };
    }

    // --- moments in log2(Hz) ---
    let sP = 0, sPL = 0;
    for (let i = B.anaLo; i <= B.anaHi; i++) {
      const p = power[i];
      if (p <= 0) continue;
      sP += p; sPL += p * log2f[i];
    }
    const cogLog = sP > 0 ? sPL / sP : Math.log2(4000);
    let sVar = 0;
    for (let i = B.anaLo; i <= B.anaHi; i++) {
      const p = power[i];
      if (p <= 0) continue;
      const d = log2f[i] - cogLog;
      sVar += p * d * d;
    }
    const spreadOct = Math.sqrt(sP > 0 ? sVar / sP : 1);
    const cogHz = Math.pow(2, cogLog);

    // --- peak and bimodality ---
    for (let i = B.anaLo; i <= B.anaHi; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(B.anaLo, i - 2); j <= Math.min(B.anaHi, i + 2); j++) { s += power[j]; n++; }
      smooth[i] = s / n;
    }
    let peakI = B.anaLo, peakV = -1;
    for (let i = B.anaLo; i <= B.anaHi; i++) {
      if (smooth[i] > peakV) { peakV = smooth[i]; peakI = i; }
    }
    const peakHz = freq[peakI];

    let bimodality = 0;
    {
      const minGap = Math.max(1, Math.round(peakI * 0.45));
      let p2i = -1, p2v = -1;
      for (let i = B.anaLo; i <= B.anaHi; i++) {
        if (Math.abs(i - peakI) < minGap) continue;
        if (smooth[i] > p2v) { p2v = smooth[i]; p2i = i; }
      }
      if (p2i > 0 && p2v > 0) {
        const a = Math.min(peakI, p2i), b = Math.max(peakI, p2i);
        let valley = Infinity;
        for (let i = a; i <= b; i++) if (smooth[i] < valley) valley = smooth[i];
        const lo = Math.min(peakV, p2v);
        bimodality = clamp01(((lo - valley) / (lo + EPS)) * 1.6);
      }
    }

    const focus = clamp01((1.05 - spreadOct) / 0.75);
    const hfRatio = eHi / (eHi + eMid + EPS);
    const lowMidRatio = eLowMid / (eBand + EPS);

    cogHist[histW] = cogLog;
    histW = (histW + 1) % HIST;
    histN = Math.min(HIST, histN + 1);
    let steadiness = 0;
    if (histN >= 4) {
      let m = 0;
      for (let i = 0; i < histN; i++) m += cogHist[i];
      m /= histN;
      let v = 0;
      for (let i = 0; i < histN; i++) { const d = cogHist[i] - m; v += d * d; }
      steadiness = clamp01(1 - Math.sqrt(v / histN) / 0.30);
    }

    return {
      ready: true, active, loud: true,
      cogHz, peakHz, spreadOct, focus, hfRatio, bimodality, lowMidRatio,
      voicing, steadiness, levelDb, levelAllDb, aboveFloorDb, levelRel,
      noiseBandDb, fricScore, lowRatio,
      spectrum,
      // Only hunt for a notch on voiceless productions. In a voiced sibilant
      // the gap between the voice bar and the frication is a real, deep valley
      // that has nothing to do with a side-channel antiresonance, and it would
      // otherwise be reported on every single /z/.
      notch: voicing < 0.4 ? findNotch() : null,
      displayLocked: lockedTopDb !== null,
    };
  }

  return {
    analyze, startNoiseLearn, beginNoiseHold, endNoiseHold, setDisplay,
    lockDisplayTop, unlockDisplayTop, isDisplayLocked,
  };
}
