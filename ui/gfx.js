// Tiny software framebuffer for the UI, drawn at the game's INTERNAL resolution (one UI pixel = one game pixel,
// so it gets the same chunky upscale). Pixels are opaque RGBA bytes; alpha 0 = "show the game through here".
// ui/overlay.js uploads this buffer as a texture and the overlay shader quantises + Bayer-dithers it like the world.
//
// Colours are [r, g, b] in 0..255. Everything here is integer pixel work: no anti-aliasing, no blending.

import { glyph, GLYPH_W, GLYPH_H } from './font.js';

// 8x8 Bayer matrix, same bit trick as bayer8() in shader/helpers.js, values 0..1
const BAYER = new Float32Array(64);
for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
  const a = x ^ y;
  const v = ((a & 1) << 5) | ((y & 1) << 4) | ((a & 2) << 2) | ((y & 2) << 1) | ((a & 4) >> 1) | ((y & 4) >> 2);
  BAYER[y * 8 + x] = (v + 0.5) / 64;
}
export const bayer = (x, y) => BAYER[((y & 7) << 3) | (x & 7)];

export class Gfx {
  constructor(w, h) { this.resize(w, h); }

  resize(w, h) { this.w = w; this.h = h; this.buf = new Uint8Array(w * h * 4); }
  clear() { this.buf.fill(0); }

  rect(x, y, w, h, c) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    const b = this.buf;
    for (let j = y0; j < y1; j++) {
      let i = (j * this.w + x0) * 4;
      for (let k = x0; k < x1; k++, i += 4) { b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = 255; }
    }
  }

  // Ordered-dither fill: each pixel is colour `a` where bayer < t, else `b`. t = 0..1 (fraction of `a`).
  dither(x, y, w, h, a, b, t) {
    const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0), x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    const d = this.buf;
    for (let j = y0; j < y1; j++) {
      let i = (j * this.w + x0) * 4;
      for (let k = x0; k < x1; k++, i += 4) {
        const c = bayer(k, j) < t ? a : b;
        d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255;
      }
    }
  }

  textWidth(str, s) { return str.length ? str.length * (GLYPH_W + 1) * s - s : 0; }

  // top-left anchored; s = integer pixel scale (1 glyph pixel = s x s UI pixels)
  text(str, x, y, s, c) {
    for (let n = 0; n < str.length; n++) {
      const g = glyph(str[n]);
      const gx = x + n * (GLYPH_W + 1) * s;
      for (let r = 0; r < GLYPH_H; r++) {
        const bits = g[r];
        if (!bits) continue;
        for (let k = 0; k < GLYPH_W; k++) if (bits & (1 << (GLYPH_W - 1 - k))) this.rect(gx + k * s, y + r * s, s, s, c);
      }
    }
  }
  textRight(str, xr, y, s, c) { this.text(str, xr - this.textWidth(str, s), y, s, c); }
  textCentre(str, xc, y, s, c) { this.text(str, Math.round(xc - this.textWidth(str, s) / 2), y, s, c); }

  // Chunky bevelled frame in the minimap's style: black outline, grey rim, dark inner line, hard drop shadow.
  frame(x, y, w, h, s, theme, fill = theme.panel) {
    this.rect(x + 2 * s, y + 2 * s, w, h, theme.shadow);            // drop shadow
    this.rect(x - 2 * s, y - 2 * s, w + 4 * s, h + 4 * s, theme.black);   // outline
    this.rect(x - s, y - s, w + 2 * s, h + 2 * s, theme.rim);       // rim
    this.rect(x + s, y + s, w - 2 * s, h - 2 * s, theme.inner);     // inner line
    this.rect(x + 2 * s, y + 2 * s, w - 4 * s, h - 4 * s, fill);    // body
  }
}
