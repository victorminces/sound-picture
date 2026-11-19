/**
 * smooth.js -- what the display is given, frame by frame.
 *
 * The measurements jump about from one 43 ms frame to the next; the picture
 * should not. Each dimension is smoothed with its own time constant. This
 * lives in a module of its own so that tools/grain-check.html runs exactly
 * the smoothing the app runs, rather than a copy that could drift.
 *
 * Raggedness gets a fast attack and a quick release. With a single 90 ms
 * time constant a spoken R's grain spilled about a fifth of a second into
 * the following vowel -- in the orb and in the history alike -- so the start
 * of every vowel after an R looked rough, and a short R never reached its
 * full grain before it was over.
 */

export const TAU = {
  level: 0.035,
  voicing: 0.035,
  sharpness: 0.090,
  spread: 0.090,
  fluct: 0.090,
  roughUp: 0.025,
  roughDown: 0.050,
};

const step = (dt, tau) => 1 - Math.exp(-dt / tau);

export function createSmoother() {
  const sm = { sharpness: 2.0, spread: 0.5, level: 0, rough: 0, fluct: 0, voicing: 0 };
  return {
    /**
     * @param {number} dt seconds since the last call
     * @param {boolean} loud whether there is sound worth drawing
     * @param {{sharpness:number, spread:number, level:number, rough:number,
     *          fluct:number, voicing:number}} x this frame's raw values
     */
    step(dt, loud, x) {
      // Height holds still through silence, so the next sound starts where
      // the last one left off instead of sliding in from the bottom.
      if (loud) sm.sharpness += (x.sharpness - sm.sharpness) * step(dt, TAU.sharpness);
      sm.spread += (x.spread - sm.spread) * step(dt, TAU.spread);
      sm.level += (x.level - sm.level) * step(dt, TAU.level);
      sm.voicing += (x.voicing - sm.voicing) * step(dt, TAU.voicing);
      sm.fluct += (x.fluct - sm.fluct) * step(dt, TAU.fluct);
      const tauR = x.rough > sm.rough ? TAU.roughUp : TAU.roughDown;
      sm.rough += (x.rough - sm.rough) * step(dt, tauR);
      return {
        active: loud,
        level: sm.level,
        sharpness: sm.sharpness,
        spread: sm.spread,
        rough: sm.rough,
        fluct: sm.fluct,
        voicing: sm.voicing,
      };
    },
  };
}
