/**
 * audio.js -- microphone capture.
 *
 * The constraints below matter more than anything else in this file. Browser
 * noise suppression, echo cancellation and auto gain control are all tuned to
 * protect speech intelligibility on calls, and all three of them attack
 * exactly the signal this app measures: steady, high-frequency, low-energy
 * fricative noise. With noise suppression left on, a perfectly good /s/ can be
 * gated away to nothing, or have its spectrum reshaped enough to move the
 * centre of gravity by a kilohertz or more.
 *
 * We ask for them to be off, then read the track settings back and report what
 * we actually got, because support varies by browser and OS, and a clinician
 * needs to know when the measurement is being coloured by processing.
 */

export const FFT_SIZE = 2048;

/** Below this sample rate there is no usable spectrum where /s/ lives. */
export const MIN_USABLE_RATE = 22050;

export async function startMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser does not expose microphone access. Try Chrome, Edge or Safari.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
    video: false,
  });

  const AC = window.AudioContext || window.webkitAudioContext;
  const audioCtx = new AC({ latencyHint: 'interactive' });
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0;   // we do our own, time-aware smoothing
  analyser.minDecibels = -130;
  analyser.maxDecibels = -5;

  // Deliberately NOT connected to audioCtx.destination: routing the mic to the
  // speakers in a therapy room causes immediate howl-round.
  source.connect(analyser);

  const track = stream.getAudioTracks()[0];
  const settings = track && track.getSettings ? track.getSettings() : {};

  const processing = {
    noiseSuppression: settings.noiseSuppression,
    echoCancellation: settings.echoCancellation,
    autoGainControl: settings.autoGainControl,
  };
  const anyProcessingOn = Object.values(processing).some((v) => v === true);

  return {
    audioCtx,
    analyser,
    stream,
    track,
    sampleRate: audioCtx.sampleRate,
    label: (track && track.label) || 'microphone',
    processing,
    anyProcessingOn,
    lowRate: audioCtx.sampleRate < MIN_USABLE_RATE,
    freqData: new Float32Array(analyser.frequencyBinCount),
    timeData: new Float32Array(analyser.fftSize),
    stop() {
      try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      try { audioCtx.close(); } catch (_) {}
    },
  };
}

/** Turn a getUserMedia rejection into something a clinician can act on. */
export function describeMicError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone permission was blocked. Allow it in the padlock menu in the address bar, then reload.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone was found. Plug one in or pick a different input device, then reload.';
  }
  if (name === 'NotReadableError') {
    return 'The microphone is in use by another program. Close it and reload.';
  }
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return 'Microphone access needs https or localhost. Open the app through the dev server rather than the file itself.';
  }
  return (err && err.message) ? err.message : 'Could not open the microphone.';
}
