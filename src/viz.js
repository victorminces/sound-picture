/**
 * viz.js -- the display.
 *
 * This is a representation of the sound, not a verdict on it. Nothing here
 * scores, rewards or corrects.
 *
 * Each quantity gets a visual channel suited to it, and the channels are kept
 * separate so that adding one does not muddy another:
 *
 *   vertical position   frequency
 *   hue                 frequency again, fixed. The same sound always draws
 *                       the same colours, which is what lets a child recognise
 *                       their own /s/ by sight. Colour never encodes quality.
 *   brightness          energy in that band
 *   grain               roughness. A ragged airstream renders rough, a clean one
 *                       glassy. This is an iconic mapping rather than an
 *                       arbitrary one: slushy looks slushy, and nobody has to
 *                       be taught what it means. The grain is driven entirely
 *                       by the measured modulation -- it is data, not texture
 *                       added for decoration.
 *   the F0 line         voicing and pitch together, drawn on the field's own
 *                       axis. Weight and brightness scale with how voiced the
 *                       moment is, so presence and pitch arrive as one mark.
 *   marker              an antiresonance notch, detected at full resolution in
 *                       the analysis path and drawn as a symbol, because the
 *                       smoothing that keeps the envelope legible would
 *                       otherwise erase it.
 *
 * The spectral measures -- centre of gravity, spread, high-frequency ratio,
 * bimodality -- need no channel of their own. They are summaries of the
 * envelope's shape, so drawing the envelope well already shows them.
 */

import { SPEC_BANDS, specPos } from './spectral.js';

const FONT = '"Nunito", "Segoe UI Variable", "Segoe UI", system-ui, sans-serif';

const HIST = 420;
/** 420 columns at 70 a second is six seconds of history, as in the perceptual app. */
const COLS_PER_SEC = 70;

/**
 * Frequency -> colour.
 *
 * Luminance rises gently from violet to cream rather than starting near black.
 * An earlier ramp opened at a deep indigo, which on a dark field meant that
 * everything below about 4 kHz was drawn in a colour with almost no light in
 * it, and the whole history read as too dark regardless of how the energy
 * curve was tuned. Energy is carried by brightness; the hue should not be
 * fighting it.
 */
const RAMP = [
  [0.00, [142, 124, 255]],
  [0.20, [109, 155, 255]],
  [0.40, [ 57, 197, 243]],
  [0.58, [ 47, 224, 192]],
  [0.74, [107, 239, 122]],
  [0.88, [232, 230,  92]],
  [1.00, [255, 233, 168]],
];

/**
 * Energy -> ink. The knee pushes quiet bands out of sight so that what is left
 * on screen is the shape of the sound rather than a solid block of hue.
 */
const KNEE = 0.09;
function ink(e) {
  return e <= KNEE ? 0 : (e - KNEE) / (1 - KNEE);
}

const TICKS = [100, 200, 500, 1000, 2000, 4000, 8000, 12000];

const BG = '#090d1a';
const PANEL_BG = '#0b1120';
const INK = 'rgba(228, 240, 250, .92)';
const INK_DIM = 'rgba(176, 200, 218, .6)';
const INK_FAINT = 'rgba(150, 180, 200, .18)';
const VOICE = [142, 124, 255];
const NOTCH = '#ffb44d';

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  let field = { x: 0, y: 0, w: 0, h: 0 };
  let shape = { x: 0, y: 0, w: 0, h: 0 };

  const strip = document.createElement('canvas');
  strip.width = HIST;
  strip.height = SPEC_BANDS;
  const sctx = strip.getContext('2d');
  const col = sctx.createImageData(1, SPEC_BANDS);

  const cogHist = new Float32Array(HIST).fill(-1);
  const voiceHist = new Float32Array(HIST);
  const f0Hist = new Float32Array(HIST);
  let w = 0;

  const smoothed = new Float32Array(SPEC_BANDS);
  const refSmoothed = new Float32Array(SPEC_BANDS);

  function resize() {
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    W = Math.max(360, rect.width);
    H = Math.max(260, rect.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function layout() {
    const gutter = 52, padT = 18, padB = 28, padR = 18, gap = 16;
    const shapeW = Math.max(130, Math.min(260, W * 0.22));
    const fieldH = Math.max(80, H - padT - padB);

    field = { x: gutter, y: padT, w: Math.max(80, W - gutter - shapeW - gap - padR), h: fieldH };
    shape = { x: field.x + field.w + gap, y: padT, w: shapeW, h: fieldH };
  }

  /**
   * Grain, drawn the way the perceptual app draws it (perceptual/src/viz.js),
   * so the two look the same: light flecks three quarters of the way to white
   * and dark pits of the background colour, about 4 CSS pixels square, plainly
   * visible from the first hint of raggedness, with more and stronger flecks
   * as it rises. Same constants, same rule.
   *
   * It lives in a layer of its own, the same size as the history strip and
   * scrolled with it, and is drawn without image smoothing. The history strip
   * is 420 x 128 and is smoothed as it is stretched to the field, which is
   * right for the spectrogram but blurred flecks drawn into it into soft
   * smudges. And flecks go wherever the column is drawn, at full strength
   * however loud the sound is -- as the perceptual app puts them across its
   * whole ribbon -- rather than only where the spectrogram is bright, which
   * left a quieter R almost bare.
   */
  const GRAIN_CSS_PX = 4;
  const GRAIN_MIN = 0.02;
  const FLECK_WHITE = 0.75;
  const BG_RGB = [11, 17, 32];          // PANEL_BG
  const grainStrength = (rg) => Math.min(1, 0.25 + 0.7 * Math.min(1, rg * 0.8));
  const grainCoverage = (rg) => 1 - Math.exp(-(0.9 + 2.2 * rg) / Math.PI);

  const grainStrip = document.createElement('canvas');
  grainStrip.width = HIST;
  grainStrip.height = SPEC_BANDS;
  const gctx = grainStrip.getContext('2d');
  const gcol = gctx.createImageData(1, SPEC_BANDS);
  const colInk = new Float32Array(SPEC_BANDS);
  const grainU = new Float32Array(SPEC_BANDS), grainS = new Int8Array(SPEC_BANDS);
  let grainCol = 0;

  /** Push one moment into the scrolling history. */
  function pushColumn(spectrum, cogPos, rough, voicing, f0Hz) {
    for (const [c, k] of [[sctx, strip], [gctx, grainStrip]]) {
      c.globalCompositeOperation = 'copy';
      c.drawImage(k, -1, 0);
      c.globalCompositeOperation = 'source-over';
    }

    // The spectrogram column, exactly as before the grain existed.
    const d = col.data;
    let inkMax = 0;
    for (let r = 0; r < SPEC_BANDS; r++) {
      const band = SPEC_BANDS - 1 - r;
      const v = ink(spectrum[band]);
      colInk[r] = v;
      if (v > inkMax) inkMax = v;
      const [cr, cg, cb] = rampAt(band / (SPEC_BANDS - 1));
      const glow = v * v * v * v * 0.5;
      const o = r * 4;
      d[o]     = cr + (255 - cr) * glow;
      d[o + 1] = cg + (255 - cg) * glow;
      d[o + 2] = cb + (255 - cb) * glow;
      d[o + 3] = Math.round(Math.pow(v, 1.1) * 255);
    }
    sctx.putImageData(col, HIST - 1, 0);

    // The grain column.
    const g = gcol.data;
    g.fill(0);
    const rg = Math.max(0, Math.min(1, rough || 0));
    if (rg > GRAIN_MIN && inkMax > 0.02) {
      const strength = grainStrength(rg), coverage = grainCoverage(rg);
      const colPx = field.w > 0 ? field.w / HIST : 2.4;
      const rowPx = field.h > 0 ? field.h / SPEC_BANDS : 2.8;
      const cellC = Math.max(1, Math.round(GRAIN_CSS_PX / colPx));
      const cellR = Math.max(1, Math.round(GRAIN_CSS_PX / rowPx));
      if (grainCol % cellC === 0) {
        for (let i = 0; i < SPEC_BANDS; i++) {
          grainU[i] = Math.random();
          grainS[i] = Math.random() < 0.5 ? -1 : 1;
        }
      }
      for (let r = 0; r < SPEC_BANDS; r++) {
        // Where this column is drawn, relative to its own brightest band --
        // the counterpart of the ribbon's profile in the perceptual app.
        const rel = colInk[r] / inkMax;
        if (rel < 0.1) continue;
        const ci = (r / cellR) | 0;
        if (grainU[ci] >= coverage) continue;
        const a = strength * Math.min(1, (rel - 0.1) / 0.3);
        const o = r * 4;
        if (grainS[ci] > 0) {
          const [cr, cg, cb] = rampAt((SPEC_BANDS - 1 - r) / (SPEC_BANDS - 1));
          g[o] = cr + (255 - cr) * FLECK_WHITE;
          g[o + 1] = cg + (255 - cg) * FLECK_WHITE;
          g[o + 2] = cb + (255 - cb) * FLECK_WHITE;
        } else {
          g[o] = BG_RGB[0]; g[o + 1] = BG_RGB[1]; g[o + 2] = BG_RGB[2];
        }
        g[o + 3] = Math.round(a * 255);
      }
    }
    grainCol++;
    gctx.putImageData(gcol, HIST - 1, 0);

    cogHist[w] = cogPos;
    voiceHist[w] = voicing || 0;
    f0Hist[w] = f0Hz || 0;
    w = (w + 1) % HIST;
  }

  /* ---------------- field ---------------- */

  function drawField(showCog) {
    ctx.save();
    roundRect(ctx, field.x, field.y, field.w, field.h, 14);
    ctx.clip();

    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(field.x, field.y, field.w, field.h);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(strip, field.x, field.y, field.w, field.h);

    // Bloom: the strip drawn again slightly oversized and added. Upscaling
    // from 420x128 is already doing the smoothing, so this costs two draws.
    ctx.globalCompositeOperation = 'lighter';
    for (const [spread, alpha] of [[7, 0.075], [18, 0.05]]) {
      ctx.globalAlpha = alpha;
      ctx.drawImage(strip, field.x - spread, field.y - spread,
        field.w + spread * 2, field.h + spread * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Grain on top, unsmoothed, so the flecks stay crisp.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(grainStrip, field.x, field.y, field.w, field.h);
    ctx.imageSmoothingEnabled = true;

    drawF0Trace();
    if (showCog) drawCogTrace();
    ctx.restore();

    frame(field);
  }

  /**
   * F0 drawn in the field itself, on the field's own frequency axis, with both
   * weight and brightness scaled by how voiced the moment is. A faint thin
   * line is a weakly voiced moment; a bright thick one is full voicing. That
   * carries the presence and the pitch in one mark, which is why the separate
   * lane is gone.
   */
  function drawF0Trace() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < HIST; i++) {
      const a = (w + i - 1) % HIST, b = (w + i) % HIST;
      const va = voiceHist[a], vb = voiceHist[b];
      if (va < 0.12 || vb < 0.12) continue;
      const fa = f0Hist[a], fb = f0Hist[b];
      if (!(fa > 0) || !(fb > 0)) continue;

      // Visibility rises faster than voicing, so a marginal moment stays
      // discreet and a fully voiced one is bold -- but not so fast that
      // ordinary speech disappears. Squared turned out to be too harsh.
      const v = (va + vb) * 0.5;
      const vis = Math.pow(v, 1.5);
      ctx.strokeStyle = `rgba(236,232,255,${0.12 + vis * 0.78})`;
      ctx.lineWidth = 0.9 + vis * 3.4;
      ctx.beginPath();
      ctx.moveTo(field.x + ((i - 1) / (HIST - 1)) * field.w,
        field.y + (1 - specPos(fa)) * field.h);
      ctx.lineTo(field.x + (i / (HIST - 1)) * field.w,
        field.y + (1 - specPos(fb)) * field.h);
      ctx.stroke();
    }
  }

  function drawCogTrace() {
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.shadowColor = 'rgba(255,255,255,.5)';
    ctx.shadowBlur = 7;

    let drawing = false;
    ctx.beginPath();
    for (let i = 0; i < HIST; i++) {
      const v = cogHist[(w + i) % HIST];
      if (v < 0) { drawing = false; continue; }
      const x = field.x + (i / (HIST - 1)) * field.w;
      const y = field.y + (1 - v) * field.h;
      if (!drawing) { ctx.moveTo(x, y); drawing = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /* ---------------- axis ---------------- */

  function drawAxis() {
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const hz of TICKS) {
      const p = specPos(hz);
      if (p <= 0.001 || p >= 0.999) continue;
      const y = field.y + (1 - p) * field.h;
      ctx.strokeStyle = INK_FAINT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(field.x, y);
      ctx.lineTo(shape.x + shape.w, y);
      ctx.stroke();
      ctx.fillStyle = INK_DIM;
      ctx.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), field.x - 9, y);
    }

    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 11px ${FONT}`;
    ctx.fillStyle = INK_DIM;
    ctx.textAlign = 'left';
    ctx.fillText(Math.round(HIST / COLS_PER_SEC) + ' seconds ago', field.x + 2, field.y + field.h + 17);
    ctx.textAlign = 'right';
    ctx.fillText('now', field.x + field.w - 2, field.y + field.h + 17);
    ctx.textAlign = 'center';
    ctx.fillText('the sound itself', shape.x + shape.w / 2, shape.y + shape.h + 17);
  }

  /* ---------------- shape ---------------- */

  function smoothBands(src, dst, radius) {
    for (let i = 0; i < SPEC_BANDS; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(SPEC_BANDS - 1, i + radius); j++) {
        s += src[j]; n++;
      }
      const e = s / n;
      dst[i] = e <= 0.07 ? 0 : Math.pow((e - 0.07) / 0.93, 1.15);
    }
  }

  function shapePath(bands, cx, halfMax) {
    ctx.beginPath();
    for (let i = 0; i < SPEC_BANDS; i++) {
      const y = shape.y + (1 - i / (SPEC_BANDS - 1)) * shape.h;
      const x = cx + bands[i] * halfMax;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    for (let i = SPEC_BANDS - 1; i >= 0; i--) {
      const y = shape.y + (1 - i / (SPEC_BANDS - 1)) * shape.h;
      ctx.lineTo(cx - bands[i] * halfMax, y);
    }
    ctx.closePath();
  }

  function drawShape(spectrum, reference, notch, rough) {
    const cx = shape.x + shape.w / 2;
    const halfMax = shape.w * 0.46;

    ctx.save();
    roundRect(ctx, shape.x, shape.y, shape.w, shape.h, 14);
    ctx.clip();
    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(shape.x, shape.y, shape.w, shape.h);

    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, shape.y);
    ctx.lineTo(cx, shape.y + shape.h);
    ctx.stroke();

    // The frozen reference goes through exactly the same transform as the live
    // shape, or the two would not be comparable, which is the point of it.
    if (reference) {
      smoothBands(reference, refSmoothed, 2);
      shapePath(refSmoothed, cx, halfMax);
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fill();
    }

    smoothBands(spectrum, smoothed, 2);

    const g = ctx.createLinearGradient(0, shape.y + shape.h, 0, shape.y);
    for (const [pos, rgb] of RAMP) g.addColorStop(pos, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);

    shapePath(smoothed, cx, halfMax);
    ctx.shadowColor = 'rgba(120, 200, 255, .3)';
    ctx.shadowBlur = 20;
    ctx.fillStyle = g;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.4)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // The live sound's grain, drawn as the perceptual app's orb draws it:
    // flecks re-scattered every frame, light ones and dark pits, at the same
    // density per area and strength as the history's, inside the shape.
    const rg = Math.max(0, Math.min(1, rough || 0));
    if (rg > GRAIN_MIN) {
      ctx.save();
      shapePath(smoothed, cx, halfMax);
      ctx.clip();
      const sz = GRAIN_CSS_PX, a = grainStrength(rg);
      const n = Math.min(1500, Math.round((shape.w * shape.h) / (sz * sz) * (0.9 + 2.2 * rg) / Math.PI));
      for (let i = 0; i < n; i++) {
        const x = shape.x + Math.random() * shape.w;
        const y = shape.y + Math.random() * shape.h;
        if (i & 1) {
          const [cr, cg, cb] = rampAt((shape.y + shape.h - y) / shape.h);
          ctx.fillStyle = `rgba(${Math.round(cr + (255 - cr) * FLECK_WHITE)},${Math.round(cg + (255 - cg) * FLECK_WHITE)},${Math.round(cb + (255 - cb) * FLECK_WHITE)},${a})`;
        } else {
          ctx.fillStyle = `rgba(${BG_RGB[0]},${BG_RGB[1]},${BG_RGB[2]},${a})`;
        }
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      ctx.restore();
    }

    // Notch marker: detected unsmoothed, drawn as a symbol.
    if (notch) {
      const y = shape.y + (1 - specPos(notch.hz)) * shape.h;
      ctx.strokeStyle = NOTCH;
      ctx.fillStyle = NOTCH;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(shape.x + 6, y);
      ctx.lineTo(shape.x + shape.w - 6, y);
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(shape.x + shape.w - 11, y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
    frame(shape);

    if (notch) {
      ctx.font = `700 10px ${FONT}`;
      ctx.fillStyle = NOTCH;
      ctx.textAlign = 'right';
      ctx.fillText('notch ' + Math.round(notch.hz) + ' Hz', shape.x + shape.w, shape.y - 5);
    }
  }

  /* ---------------- frame ---------------- */

  function frame(r) {
    ctx.strokeStyle = 'rgba(255,255,255,.07)';
    ctx.lineWidth = 1;
    roundRect(ctx, r.x, r.y, r.w, r.h, 14);
    ctx.stroke();
  }

  function draw(s) {
    layout();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    drawField(s.opts.showCog);
    drawAxis();
    drawShape(s.spectrum, s.reference, s.notch, s.rough);

    if (s.referenceLabel) {
      ctx.font = `700 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = INK;
      ctx.fillText(s.referenceLabel, shape.x, shape.y - 5);
    }
  }

  function clearHistory() {
    sctx.clearRect(0, 0, HIST, SPEC_BANDS);
    gctx.clearRect(0, 0, HIST, SPEC_BANDS);
    cogHist.fill(-1);
    voiceHist.fill(0);
    f0Hist.fill(0);
  }

  return { resize, draw, pushColumn, clearHistory, colsPerSec: COLS_PER_SEC, histCols: HIST };
}

/* ---------------- helpers ---------------- */

function rampAt(p) {
  const t = p < 0 ? 0 : p > 1 ? 1 : p;
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [p0, c0] = RAMP[i - 1];
      const [p1, c1] = RAMP[i];
      const k = (t - p0) / (p1 - p0 || 1);
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
