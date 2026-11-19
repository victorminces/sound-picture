/**
 * envelope-worklet.js -- the amplitude envelope, computed on every sample.
 *
 * This exists because of a resolution limit that cannot be worked around on
 * the main thread. An AnalyserNode hands out the most recent 2048 samples
 * whenever it is asked, so consecutive reads overlap by an unknown amount.
 * Filter state cannot be carried across them without smearing, which leaves
 * each frame to be analysed on its own: 43 ms, and a 43 ms window cannot
 * resolve modulation rate better than about 55 Hz.
 *
 * That is not a detail. A uvular /R/ pulses at 25-35 Hz and a wet, gurgly
 * fricative modulates nearer 70 Hz. Those are different things a listener
 * hears differently, and at 55 Hz resolution they are the same measurement.
 * The trill simply disappeared -- a French R gated nearly to silence read
 * 0.04 out of 1.
 *
 * A worklet sees every sample exactly once, in order. So the envelope is
 * computed here, continuously, decimated, and handed over in blocks. The main
 * thread can then analyse a third of a second of it and resolve modulation to
 * a few Hz, which separates a trill from slush with room to spare.
 *
 * Only the envelope crosses the thread boundary, at 1.5 kHz rather than 48 --
 * about 3% of the data, and nothing here blocks the audio thread.
 */

/** Carrier isolation: the frication's own modulation, not the glottis. */
const HP_HZ = 2000;
/** Envelope smoothing. Must pass the whole modulation range of interest. */
const ENV_HZ = 400;
/** Envelope sample rate after decimation. Nyquist well above any rate used. */
const ENV_RATE = 1500;

class EnvelopeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;              // global, provided to the worklet
    this.hpK = Math.exp(-2 * Math.PI * HP_HZ / sr);
    this.envK = 1 - Math.exp(-2 * Math.PI * ENV_HZ / sr);
    this.decim = Math.max(1, Math.round(sr / ENV_RATE));
    this.envRate = sr / this.decim;

    this.h1 = 0; this.h2 = 0; this.p1 = 0; this.p2 = 0;
    this.env = 0;
    this.count = 0;
    this.acc = 0;

    // Posted in blocks rather than per sample; one message per ~43 ms.
    this.out = new Float32Array(64);
    this.outLen = 0;

    this.port.postMessage({ type: 'ready', envRate: this.envRate });
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      // Two cascaded one-pole high passes, then rectify and smooth.
      this.h1 = this.hpK * (this.h1 + x - this.p1); this.p1 = x;
      this.h2 = this.hpK * (this.h2 + this.h1 - this.p2); this.p2 = this.h1;
      const rect = this.h2 < 0 ? -this.h2 : this.h2;
      this.env += (rect - this.env) * this.envK;

      // Decimate by averaging rather than by picking every nth sample, so
      // nothing above the envelope rate folds back down into the modulation
      // range we are about to measure.
      this.acc += this.env;
      if (++this.count >= this.decim) {
        this.out[this.outLen++] = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        if (this.outLen === this.out.length) {
          this.port.postMessage({ type: 'env', data: this.out.slice(0, this.outLen) });
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('envelope-processor', EnvelopeProcessor);
