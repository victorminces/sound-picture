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
 * Columns of history per second. The strip is sized to the ribbon's own
 * width in DEVICE pixels, so a column is a column is a pixel and nothing is
 * resampled on the way to the screen -- a fixed column count stretched across
 * a wide display softens exactly the fine grain that roughness is drawn with.
 * A wider window therefore holds more seconds rather than the same seconds
 * blurrier.
 */
const COLS_PER_SEC = 90;

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
 * How far the grain swings the ribbon's brightness at full roughness. The
 * texture has to survive being looked at across a room by someone who is also
 * watching a child, so it is deliberately strong.
 */
const GRAIN_AMP = 0.85;

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
  let grainCells = null;
  let grainCol = 0;

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

  /**
   * Push one column of history. Drawn into an offscreen strip that is shifted
   * left by a pixel each time, which is far cheaper than redrawing seven
   * seconds of ribbon every frame.
   */
  function pushColumn(f, dt) {
    if (!strip) return;
    stripCtx.globalCompositeOperation = 'copy';
    stripCtx.drawImage(strip, -1, 0);
    stripCtx.globalCompositeOperation = 'source-over';
    stripCtx.fillStyle = '#080b16';
    stripCtx.fillRect(stripW - 1, 0, 1, stripH);

    if (!f.active || f.level <= 0.004) return;

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
    const rough = f.rough;
    if (rough > 0) {
      const n = Math.ceil(stripH / cell) + 1;
      if (!grainCells || grainCells.length !== n) grainCells = new Float32Array(n);
      if (grainCol % cell === 0) {
        for (let i = 0; i < n; i++) grainCells[i] = Math.random();
      }
    }
    grainCol++;

    const img = stripCtx.getImageData(stripW - 1, 0, 1, stripH);
    const d = img.data;
    for (let y = 0; y < stripH; y++) {
      const dy = (y - yc) / sigma;
      let a = Math.exp(-0.5 * dy * dy);
      if (a < 0.004) continue;
      if (rough > 0) {
        a *= 1 + (grainCells[(y / cell) | 0] - 0.5) * 2 * rough * GRAIN_AMP;
      }
      a = clamp01(a) * (0.35 + 0.65 * f.level);
      const o = y * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b;
      d[o + 3] = Math.round(clamp01(a) * 255);
    }
    stripCtx.putImageData(img, stripW - 1, 0);

    // Voicing filament: a bright core, visible in proportion to how clearly
    // the larynx is running. Drawn into the field itself rather than into a
    // lane of its own, so there is still only one object to watch.
    if (f.voicing > 0.12) {
      const vis = Math.pow(f.voicing, 1.4);
      stripCtx.fillStyle = `rgba(238,236,255,${0.10 + vis * 0.75})`;
      const th = Math.max(1, Math.round(half * 0.22));
      stripCtx.fillRect(stripW - 1, Math.round(yc - th / 2), 1, th);
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

      if (f.rough > 0.02) {
        // Speckle sized from the same control as the ribbon's grain, and
        // counted from the area it has to cover so the density stays put as
        // the orb grows with loudness.
        const sz = Math.max(2, grainPx);
        const n = Math.min(500, Math.round((rad * rad) / (sz * sz) * (0.9 + 2.2 * f.rough)));
        ctx.fillStyle = `rgba(${r},${g},${b},${0.14 + 0.46 * f.rough})`;
        for (let i = 0; i < n; i++) {
          const ang = Math.random() * Math.PI * 2;
          const rr = rad * Math.sqrt(Math.random());
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
    setGrain(px) { grainPx = Math.max(1, px); grainCells = null; },
    /** Advance the history by one column. Kept apart from draw() so that the
     *  ribbon scrolls at a rate set by the clock rather than by however often
     *  the machine happens to repaint. */
    advance(f, dt) { pushColumn(f, dt); },
    setMap(on) { showMap = on; },
    get colsPerSec() { return COLS_PER_SEC; },

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
