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

  // The amplitude envelope is computed in a worklet rather than from the
  // analyser's frames. The analyser hands out the most recent 2048 samples on
  // request, so consecutive reads overlap by an unknown amount and each frame
  // has to be analysed alone -- 43 ms, which cannot resolve modulation rate
  // better than about 55 Hz. That is coarser than the distinction being
  // measured: a uvular trill pulses near 30 Hz and a wet fricative nearer 70.
  // A worklet sees every sample once, so a third of a second of envelope can
  // be gathered and the two told apart.
  let worklet = { node: null, ok: false, error: null };
  try {
    if (!audioCtx.audioWorklet) throw new Error('AudioWorklet is not available');
    await audioCtx.audioWorklet.addModule(
      new URL('./envelope-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(audioCtx, 'envelope-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    source.connect(node);
    // A node has to reach the destination to be pulled by the graph at all.
    // It writes nothing, and the gain is zero as well, so no path to the
    // speakers can carry the microphone back into the room.
    const silent = audioCtx.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(audioCtx.destination);
    worklet = { node, ok: true, error: null };
  } catch (err) {
    worklet = { node: null, ok: false, error: (err && err.message) || String(err) };
  }

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
    worklet,
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
