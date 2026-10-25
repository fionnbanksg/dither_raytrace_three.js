// Loading screen: drawn into the UI overlay (ui/overlay.js), so it is dithered and pixel-scaled like the game.
// main.js calls loading.set('LABEL', 0..1) between start-up stages; the ember backdrop is drawn by the overlay shader.

import { theme } from './theme.js';

export function createLoading(overlay) {
  const state = { label: 'STARTING', frac: 0, note: '' };

  function draw() {
    const { gfx, w, h, scale: s } = overlay;
    gfx.clear();

    const title = 'DITHER-VOX';
    const ts = s * 3;
    gfx.textCentre(title, w / 2 + ts, h * 0.30 + ts, ts, theme.black);      // hard shadow
    gfx.textCentre(title, w / 2, h * 0.30, ts, theme.flame);

    // progress bar in the minimap's frame style
    const bw = Math.min(Math.round(w * 0.5), 190 * s), bh = 9 * s;
    const bx = Math.round((w - bw) / 2), by = Math.round(h * 0.52);
    gfx.frame(bx, by, bw, bh, s, theme, theme.track);
    const iw = bw - 4 * s;                                   // inner width inside the frame body
    const fw = Math.round(iw * Math.max(0, Math.min(1, state.frac)));
    if (fw > 0) {
      gfx.rect(bx + 2 * s, by + 2 * s, fw, bh - 4 * s, theme.lava);
      gfx.dither(bx + 2 * s, by + 2 * s, fw, Math.max(1, (bh - 4 * s) >> 1), theme.flame, theme.lava, 0.5);   // lit top half
    }

    gfx.textCentre(state.label, w / 2, by + bh + 6 * s, s, theme.text);
    gfx.textRight(Math.round(state.frac * 100) + '%', bx + bw, by - 9 * s, s, theme.dim);
    if (state.note) gfx.textCentre(state.note, w / 2, h - 12 * s, s, theme.dim);
    overlay.dirty = true;
  }

  return {
    set(label, frac, note = state.note) { Object.assign(state, { label, frac, note }); draw(); },
    draw,
    begin() { overlay.loading = true; overlay.dim = 0; overlay.onResize = draw; draw(); },
    end() { overlay.loading = false; overlay.onResize = null; overlay.gfx.clear(); overlay.dirty = true; },
  };
}
