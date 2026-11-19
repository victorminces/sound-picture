/**
 * viz.js -- one object, several properties.
 *
 * The thing being drawn is a ribbon flowing right to left. Its HEIGHT on the
 * screen is sharpness, and that is the only dimension given a spatial axis,
 * because position is the channel a child reads best and sharpness is the
 * dimension that carries the most. Everything else rides on the ribbon as a
 * property of it rather than as a separate plot:
 *
 *   thickness  loudness, relative to this child's own recent speech
 *   softness   spread -- a focused hiss has a crisp edge, a diffuse one
 *              feathers out
 *   grain      roughness, fast speckle, the wet or gurgly quality
 *   ripple     fluctuation, a slow waver in the edge, an unsteady gesture
 *   core       voicing, a bright filament down the middle
 *
 * There is no target, no correct region, no score, and no colour that means
 * good. The ramp runs with sharpness so that position and hue say the same
 * thing twice, which is what makes it readable at a glance rather than a
 * puzzle to decode.
 */

/**
 * How much time the history holds, edge to edge. The strip is sized in DEVICE
 * pixels so nothing is resampled, and the scroll rate follows from this rather
 * than being a fixed number of columns per second.
 *
 * It used to be a fixed 90 columns a second, which on a 2x screen is 45
 * visible pixels a second and about thirty seconds of history across a laptop
 * window. Speech is faster than that: a spoken R lasts a fifth of a second
 * and got about 7 pixels, under two grain cells, so its texture never showed
 * in the history even while the live orb was plainly grainy. Six seconds is
 * a short phrase, as in the spectrogram app, and gives that R about 40.
 */
const HISTORY_SECONDS = 6;

/** Cool to warm, deep to bright. Violet at the bottom, cream at the top. */
const RAMP = [
  [0.00, [136, 118, 255]],
  [0.18, [104, 152, 255]],
  [0.38, [56, 196, 242]],
  [0.56, [46, 222, 190]],
  [0.73, [122, 238, 124]],
  [0.88, [231, 229, 96]],
  [1.00, [255, 236, 178]],
];

function rampAt(t) {
  const v = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < RAMP.length; i++) {
    if (v <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      const f = (v - t0) / (t1 - t0 || 1);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/**
 * Grain is drawn as flecks: light ones laid over the ribbon, three quarters
 * of the way to white, and dark pits where the background shows through. Both
 * views -- the live orb and the history -- use the same rule.
 *
 * Two earlier versions failed in instructive ways. Scaling opacity up and down
 * clipped every brighter cell back to 1.0 in the ribbon's opaque core, so half
 * the texture vanished where the eye goes first. Shading lightness in
 * proportion to raggedness was linear from zero, so the moderate raggedness of
 * real speech drew a quarter to a half as much grain in the history as the orb
 * showed at the same moment.
 */
/** Raggedness above which grain is drawn at all, in both views. */
const ORB_GRAIN_MIN = 0.02;
/** How far toward white a light fleck goes, in both views. */
const FLECK_WHITE = 0.75;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });

  /** Display range of the sharpness axis. Fixed on purpose: an axis that
   *  rescales itself destroys the one thing this display is for, which is
   *  comparing one production with another. */
  let sharpLo = 0.5, sharpHi = 5.0;

  let W = 0, H = 0, dpr = 1;
  let stripW = 0, stripH = 0;
  let ribW = 0, orbW = 0;
  let strip = null, stripCtx = null;

  /** Live orb panel occupies the right-hand slice. */
  const ORB_FRAC = 0.26;
  let ripplePhase = 0;

  /**
   * Grain cell, in CSS pixels. It must be expressed in CSS pixels and
   * converted, not written as a count of rows: the strip is sized in DEVICE
   * pixels so that nothing is resampled, and a cell of "3 rows" on a 2x
   * display is a cell of 1.5 CSS pixels -- which the browser averages away
   * before it reaches anybody's eye. That is exactly how the roughness
   * texture came to be invisible on a retina screen while looking correct in
   * the code.
   */
  let grainPx = 4;
  /** 0..1, how far toward white or black a cell goes at full raggedness. */
  let grainContrast = 0.8;
  /**
   * Raggedness below this draws no grain at all. A clean vowel is not
   * perfectly smooth to the measurement -- a low voice's own pulse leaves a
   * small residue -- and once the grain was drawn at full contrast that
   * residue became visible. Where vowels sit depends on the voice, so it is a
   * control rather than a constant.
   */
  let grainThreshold = 0;

  /** Raggedness as the display should draw it: zero up to the threshold. */
  function grainOf(rough) {
    return clamp01((rough - grainThreshold) / (1 - grainThreshold));
  }
  let grainCells = null;
  let grainSigns = null;
  let grainCol = 0;

  /**
   * The orb's grain rule, shared by both views. Once there is any raggedness
   * at all the texture is plainly visible -- each fleck starts at a quarter
   * opacity -- and more raggedness means more flecks and stronger ones. The
   * history used to fade its grain in linearly from zero instead, so at the
   * raggedness a spoken R actually reaches (0.4-0.65) it showed a quarter to a
   * half of what the orb showed, measured.
   */
  function grainStrength(rough) { return clamp01(0.25 + 0.7 * clamp01(rough * grainContrast)); }
  /** Share of cells that carry a fleck: what the orb's fleck count covers. */
  function grainCoverage(rough) { return 1 - Math.exp(-(0.9 + 2.2 * rough) / Math.PI); }

  /** Recent productions, for the optional map. */
  const cloud = [];
  const CLOUD_MAX = 300;
  let showMap = false;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = canvas.getBoundingClientRect();
    W = Math.max(320, Math.round(r.width));
    H = Math.max(220, Math.round(r.height));
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    orbW = Math.round(W * ORB_FRAC);
    ribW = W - orbW;
    stripW = Math.max(240, Math.round((ribW - 8) * dpr));
    stripH = Math.max(120, Math.round(H * dpr));
    if (!strip) {
      strip = document.createElement('canvas');
      stripCtx = strip.getContext('2d');
    }
    if (strip.width !== stripW || strip.height !== stripH) {
      const keep = strip.width ? stripCtx.getImageData(0, 0, strip.width, strip.height) : null;
      strip.width = stripW;
      strip.height = stripH;
      stripCtx.fillStyle = '#080b16';
      stripCtx.fillRect(0, 0, stripW, stripH);
      if (keep) try { stripCtx.putImageData(keep, 0, 0); } catch (_) {}
    }
  }

  /** Position on the strip, in its own device pixels. */
  function yStrip(s) {
    const t = (s - sharpLo) / (sharpHi - sharpLo);
    return stripH - clamp01(t) * stripH;
  }

  /** The same height in CSS pixels, for everything drawn over the strip. */
  function yCss(s) {
    const t = (s - sharpLo) / (sharpHi - sharpLo);
    return H - clamp01(t) * H;
  }

  let colImg = null;

  /**
   * Advance the history by `k` columns. The offscreen strip is shifted once by
   * the whole amount and the new columns are written at its right-hand edge.
   * Shifting once per column, as this used to, copies the entire strip for
   * every column -- affordable at 90 a second, not at the several hundred a
   * second a six-second window needs on a wide, dense screen.
   */
  function pushColumns(f, dt, k) {
    if (!strip || k <= 0) return;
    k = Math.min(k, stripW);
    stripCtx.globalCompositeOperation = 'copy';
    stripCtx.drawImage(strip, -k, 0);
    stripCtx.globalCompositeOperation = 'source-over';
    stripCtx.fillStyle = '#080b16';
    stripCtx.fillRect(stripW - k, 0, k, stripH);

    if (!f.active || f.level <= 0.004) { grainCol += k; return; }

    ripplePhase += (dt || 0.016) * 2 * Math.PI * 4;   // the 4 Hz it measures

    const t = clamp01((f.sharpness - sharpLo) / (sharpHi - sharpLo));
    const yc = yStrip(f.sharpness);
    const [r, g, b] = rampAt(t);

    // Thickness from loudness, softness from spread, waver from fluctuation.
    const half = (0.015 + 0.10 * f.level) * stripH
      * (1 + 0.28 * f.fluct * Math.sin(ripplePhase));
    const soft = 0.30 + 1.5 * f.spread;        // in units of `half`
    const sigma = Math.max(1.2, half * soft);

    // Grain cells are square and held across as many columns as they are
    // tall, so the texture reads as a weave rather than as vertical streaks.
    const cell = Math.max(1, Math.round(grainPx * dpr));
    const rough = grainOf(f.rough);
    const n = Math.ceil(stripH / cell) + 1;
    let fresh = false;
    if (rough > 0 && (!grainCells || grainCells.length !== n)) {
      grainCells = new Float32Array(n);
      grainSigns = new Int8Array(n);
      fresh = true;
    }

    // The history's grain follows exactly the orb's rule, so that whatever
    // the orb shows the history keeps (tools/grain-check.html measures this).
    const on = rough > ORB_GRAIN_MIN;
    const strength = on ? grainStrength(rough) : 0;
    const coverage = on ? grainCoverage(rough) : 0;
    const lr = r + (255 - r) * FLECK_WHITE, lg = g + (255 - g) * FLECK_WHITE, lb = b + (255 - b) * FLECK_WHITE;

    if (!colImg || colImg.height !== stripH) colImg = stripCtx.createImageData(1, stripH);
    const d = colImg.data;

    /** Fill the column image. Re-run only when the grain cells change. */
    function buildColumn() {
      d.fill(0);
      for (let y = 0; y < stripH; y++) {
        const dy = (y - yc) / sigma;
        const shape = Math.exp(-0.5 * dy * dy);
        if (shape < 0.004) continue;
        let A = clamp01(shape) * (0.35 + 0.65 * f.level);
        let cr = r, cg = g, cb = b;
        const ci = (y / cell) | 0;
        if (on && grainCells[ci] < coverage) {
          // Flecks live inside the visible body of the ribbon, as the orb's
          // live inside its disc, not out in the faint feathered edge.
          const s = strength * clamp01((shape - 0.1) / 0.3);
          if (grainSigns[ci] > 0) {
            // A light fleck laid over the ribbon at opacity s -- the same
            // compositing the orb gets from drawing a fleck over its disc.
            const A2 = A + (1 - A) * s;
            cr = (r * A * (1 - s) + lr * s) / A2;
            cg = (g * A * (1 - s) + lg * s) / A2;
            cb = (b * A * (1 - s) + lb * s) / A2;
            A = A2;
          } else {
            // A dark pit: the background showing through.
            A *= 1 - s;
          }
        }
        const o = y * 4;
        d[o] = cr | 0; d[o + 1] = cg | 0; d[o + 2] = cb | 0;
        d[o + 3] = Math.round(A * 255);
      }
    }

    // Voicing filament: a bright core, visible in proportion to how clearly
    // the larynx is running. Drawn into the field itself rather than into a
    // lane of its own, so there is still only one object to watch.
    const vis = f.voicing > 0.12 ? Math.pow(f.voicing, 1.4) : 0;
    const th = Math.max(1, Math.round(half * 0.22));
    if (vis) stripCtx.fillStyle = `rgba(238,236,255,${0.10 + vis * 0.75})`;

    let built = false;
    for (let c = 0; c < k; c++) {
      // Grain cells are square and held across as many columns as they are
      // tall, so the texture reads as a weave rather than as vertical streaks.
      if (rough > 0 && (fresh || grainCol % cell === 0)) {
        for (let i = 0; i < n; i++) {
          grainCells[i] = Math.random();
          grainSigns[i] = Math.random() < 0.5 ? -1 : 1;
        }
        fresh = false;
        built = false;
      }
      grainCol++;
      if (!built) { buildColumn(); built = true; }
      const x = stripW - k + c;
      stripCtx.putImageData(colImg, x, 0);
      if (vis) stripCtx.fillRect(x, Math.round(yc - th / 2), 1, th);
    }

    if (f.level > 0.25) {
      cloud.push({ s: f.sharpness, r: f.rough, l: f.level });
      if (cloud.length > CLOUD_MAX) cloud.shift();
    }
  }

  function drawAxis(x0, w) {
    ctx.save();
    ctx.strokeStyle = 'rgba(150,170,210,0.10)';
    ctx.fillStyle = 'rgba(165,185,225,0.55)';
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let s = 1; s <= Math.floor(sharpHi); s++) {
      const y = Math.round(yCss(s)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
      ctx.fillText(String(s), x0 + 4, y - 3);
    }
    ctx.fillStyle = 'rgba(175,195,235,0.75)';
    ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('bright', x0 + 4, 16);
    ctx.fillText('deep', x0 + 4, H - 8);
    ctx.restore();
  }

  /** The live sound, as one object. Same vertical axis as the ribbon. */
  function drawOrb(x0, w, f) {
    const cx = x0 + w / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x0 + 6, 6, w - 12, H - 12, 14)
                  : ctx.rect(x0 + 6, 6, w - 12, H - 12);
    ctx.fillStyle = 'rgba(12,16,30,0.75)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,190,0.16)';
    ctx.stroke();
    ctx.clip();

    if (f.active && f.level > 0.004) {
      const t = clamp01((f.sharpness - sharpLo) / (sharpHi - sharpLo));
      const cy = yCss(f.sharpness);
      const [r, g, b] = rampAt(t);
      const base = Math.min(w, H) * 0.5;
      const rad = base * (0.10 + 0.42 * f.level)
        * (1 + 0.22 * f.fluct * Math.sin(ripplePhase));
      // Spread feathers the edge: a focused hiss is a disc, a diffuse one is
      // a cloud with no edge to speak of.
      const inner = Math.max(0.02, 1 - f.spread * 0.85);
      const grad = ctx.createRadialGradient(cx, cy, rad * inner * 0.3, cx, cy, rad);
      grad.addColorStop(0, `rgba(${r},${g},${b},${0.92})`);
      grad.addColorStop(inner, `rgba(${r},${g},${b},${0.55})`);
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();

      const rg = grainOf(f.rough);
      if (rg > ORB_GRAIN_MIN) {
        // Speckle sized from the same control as the ribbon's grain, and
        // counted from the area it has to cover so the density stays put as
        // the orb grows with loudness. Two tones: light flecks and dark pits
        // of the disc's own hue. Same rule as the history -- grainStrength and
        // the coverage the count works out to -- so the two always agree.
        const sz = Math.max(2, grainPx);
        const n = Math.min(500, Math.round((rad * rad) / (sz * sz) * (0.9 + 2.2 * rg)));
        const s = grainStrength(rg);
        const lr = Math.round(r + (255 - r) * FLECK_WHITE);
        const lg = Math.round(g + (255 - g) * FLECK_WHITE);
        const lb = Math.round(b + (255 - b) * FLECK_WHITE);
        const light = `rgba(${lr},${lg},${lb},${s})`;
        const dark = `rgba(8,11,22,${s})`;
        for (let i = 0; i < n; i++) {
          const ang = Math.random() * Math.PI * 2;
          const rr = rad * Math.sqrt(Math.random());
          ctx.fillStyle = (i & 1) ? light : dark;
          ctx.fillRect(cx + Math.cos(ang) * rr - sz / 2,
                       cy + Math.sin(ang) * rr - sz / 2, sz, sz);
        }
      }

      if (f.voicing > 0.12) {
        const vis = Math.pow(f.voicing, 1.4);
        ctx.strokeStyle = `rgba(240,238,255,${0.12 + vis * 0.7})`;
        ctx.lineWidth = 1 + vis * 2.6;
        ctx.beginPath();
        ctx.moveTo(cx - rad * 0.55, cy);
        ctx.lineTo(cx + rad * 0.55, cy);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Therapist view: where productions have landed, without judging any. */
  function drawMap(x0, y0, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, h);
    ctx.fillStyle = 'rgba(10,14,27,0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,190,0.18)';
    ctx.stroke();
    ctx.clip();
    ctx.fillStyle = 'rgba(165,185,225,0.6)';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('sharpness', x0 + 5, y0 + 12);
    ctx.fillText('roughness →', x0 + 5, y0 + h - 5);
    for (let i = 0; i < cloud.length; i++) {
      const p = cloud[i];
      const age = i / cloud.length;
      const px = x0 + 6 + clamp01(p.r) * (w - 12);
      const py = y0 + h - 16 - clamp01((p.s - sharpLo) / (sharpHi - sharpLo)) * (h - 28);
      const [r, g, b] = rampAt(clamp01((p.s - sharpLo) / (sharpHi - sharpLo)));
      ctx.fillStyle = `rgba(${r},${g},${b},${0.08 + age * 0.55})`;
      ctx.beginPath();
      ctx.arc(px, py, 1 + age * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  return {
    resize,
    clear() {
      if (stripCtx) {
        stripCtx.fillStyle = '#080b16';
        stripCtx.fillRect(0, 0, stripW, stripH);
      }
      cloud.length = 0;
    },
    setRange(lo, hi) { sharpLo = lo; sharpHi = hi; },
    /**
     * Where things are drawn for a given frame, for tools/grain-check.html,
     * which measures the grain in the orb and in the history and needs to know
     * where to look. Read-only; nothing in the app uses it.
     */
    geometry(f) {
      const base = Math.min(orbW, H) * 0.5;
      return {
        dpr, W, H, ribW, orbW, stripW, stripH,
        colsPerSec: Math.max(30, stripW / HISTORY_SECONDS),
        ribbonRightDev: (ribW - 8) * dpr,
        ribbonYDev: yStrip(f.sharpness),
        ribbonHalfDev: (0.015 + 0.10 * f.level) * stripH,
        orbCx: ribW + orbW / 2,
        orbCy: yCss(f.sharpness),
        orbRad: base * (0.10 + 0.42 * f.level),
      };
    },
    setGrain(px) { grainPx = Math.max(1, px); grainCells = null; },
    setGrainContrast(v) { grainContrast = clamp01(v); },
    setGrainThreshold(v) { grainThreshold = Math.min(0.9, Math.max(0, v)); },
    /** Advance the history by one column. Kept apart from draw() so that the
     *  ribbon scrolls at a rate set by the clock rather than by however often
     *  the machine happens to repaint. */
    advance(f, dt, k = 1) { pushColumns(f, dt, k); },
    setMap(on) { showMap = on; },
    /** Device columns per second that make the strip span HISTORY_SECONDS. */
    get colsPerSec() { return Math.max(30, stripW / HISTORY_SECONDS); },

    draw(f, dt) {
      if (!W || !H) resize();
      ctx.fillStyle = '#080b16';
      ctx.fillRect(0, 0, W, H);

      if (strip) {
        ctx.save();
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(0, 6, ribW - 8, H - 12, 14)
                      : ctx.rect(0, 6, ribW - 8, H - 12);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(strip, 0, 0, stripW, stripH, 0, 0, ribW - 8, H);
        ctx.restore();
      }

      drawAxis(0, ribW - 8);
      drawOrb(ribW, orbW, f);

      if (showMap) {
        const mw = Math.min(190, ribW * 0.4), mh = Math.min(150, H * 0.45);
        // Pinned to the oldest end of the ribbon. The right-hand edge is
        // where the live sound is being written and must never be covered.
        drawMap(14, H - 16 - mh, mw, mh);
      }
    },
  };
}
