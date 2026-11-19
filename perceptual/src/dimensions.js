/**
 * dimensions.js -- the spectral half of the perceptual dimensions.
 *
 * Each of these is a moment of the specific loudness pattern, which is what
 * makes them perceptual rather than physical: they are properties of what the
 * ear receives, not of what the microphone recorded. They are also all RATIOS
 * within the pattern, which is why they survive the fact that a web
 * microphone has no absolute calibration. Loudness is the exception and is
 * treated as a relative quantity everywhere it is used.
 *
 * The clinical words these are meant to carry:
 *
 *   sharpness  "high" / "low", a squeaky hiss against a deep one. The
 *              strongest dimension in the whole of timbre research and the
 *              one that separates /s/ from a palatal production.
 *   spread     "focused" / "diffuse", a clean narrow hiss against a slushy
 *              one smeared across the range.
 *   loudness   "strong" / "weak", relative to the room and to this child's
 *              own recent speech, never to an absolute standard.
 */

const EPS = 1e-30;

/**
 * DIN 45692 weighting. Flat up to 15.8 Bark, then rising steeply, which is
 * what makes sharpness a measure of high-frequency emphasis rather than a
 * plain centroid. For a child's /s/ near 8 kHz -- about 21 Bark -- this
 * region is the whole story.
 */
function sharpWeight(z) {
  return z <= 15.8 ? 1 : 0.15 * Math.exp(0.42 * (z - 15.8)) + 0.85;
}

export function createDimensions(model) {
  const { bandZ, nBands } = model;
  const step = bandZ.length > 1 ? bandZ[1] - bandZ[0] : 0.25;

  const weight = new Float32Array(nBands);
  for (let k = 0; k < nBands; k++) weight[k] = sharpWeight(bandZ[k]);

  return {
    /**
     * @param {Float32Array} specific specific loudness per Bark band
     * @returns {{loudness:number, sharpness:number, spreadBark:number,
     *            peakZ:number, centroidZ:number}}
     */
    measure(specific) {
      let total = 0, weighted = 0, centroid = 0;
      let peak = 0, peakK = 0;
      for (let k = 0; k < nBands; k++) {
        const n = specific[k];
        if (n <= 0) continue;
        total += n;
        centroid += n * bandZ[k];
        weighted += n * weight[k] * bandZ[k];
        if (n > peak) { peak = n; peakK = k; }
      }

      if (total <= 0) {
        return {
          loudness: 0, sharpness: 0, spreadBark: 0,
          peakZ: 0, centroidZ: 0,
        };
      }

      const centroidZ = centroid / total;

      // Second moment about the loudness-weighted centre, in Bark. Bark
      // rather than Hz or octaves on purpose: it is the unit in which the
      // ear's resolution is constant, so a wide sound reads as wide wherever
      // it sits on the axis instead of simply because it sits high.
      let variance = 0;
      for (let k = 0; k < nBands; k++) {
        const n = specific[k];
        if (n <= 0) continue;
        const d = bandZ[k] - centroidZ;
        variance += n * d * d;
      }

      return {
        loudness: total * step,
        // The 0.11 is DIN's nominal constant, which assumes a calibrated
        // reference this app does not have. The number is therefore
        // sharpness-LIKE and comparable within a session, not an acum.
        sharpness: 0.11 * weighted / total,
        spreadBark: Math.sqrt(variance / total),
        peakZ: bandZ[peakK],
        centroidZ,
      };
    },
  };
}
