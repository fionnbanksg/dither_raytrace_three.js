// Title / pause menu with the settings page, drawn into the dithered UI overlay (ui/overlay.js).
//
// Opens whenever the mouse is NOT captured (title screen, Esc, alt-tab) and closes when the pointer lock is regained.
// Mouse: hover, click, drag sliders. Keyboard: Up/Down select, Left/Right change, Enter activate, Esc back.
// To add a setting: add it to settings.js DEFAULTS, add a row to settingsRows() below, react to it in main.js.

import { theme } from './theme.js';
import { settings, setSetting, resetSettings, internalSize } from '../settings.js';

const RESOLUTIONS = [180, 240, 360, 500, 720, 1080, 0];   // internal heights; 0 = native
const pct = (v) => Math.round(v * 100) + '%';

const CURSOR = [
  'X.......', 'XX......', 'XWX.....', 'XWWX....', 'XWWWX...', 'XWWWWX..',
  'XWWWWWX.', 'XWWWXXXX', 'XWXWX...', 'XX.XWX..', 'X..XWX..', '....XX..',
];

const CONTROLS = [
  ['WASD', 'MOVE'], ['SHIFT', 'SPRINT'], ['SPACE', 'JUMP'], ['F', 'FLY (SPACE UP, C DOWN)'],
  ['MOUSE', 'LOOK'], ['LEFT CLICK', 'GRENADE (HOLD)'], ['RIGHT CLICK', 'HEAVY SHELL (HOLD)'],
  ['WHEEL / G', 'SWAP GRENADES / LAVA GUN'], ['SHIFT+L', 'CLEAR LAVA'], ['M', 'MAP'],
  ['T', 'TIME OF DAY'], ['F3', 'DEBUG OVERLAY'], ['ESC', 'THIS MENU'],
];

export function createMenu({ overlay, canvas, input, onPlay, onNewGame, getSeed }) {
  const m = {
    open: false, started: false,       // started = the player has captured the mouse at least once (title -> pause wording)
    page: 'main', sel: 0, drag: null, mx: 0, my: 0, mouseSeen: false, dirty: true,
  };
  let items = [];                       // rebuilt every draw: { type, label, rect, ... }

  const dimTarget = () => (m.open ? 0.5 : 0);

  // ------------------------------------------------------------ rows
  function settingsRows() {
    const stepsRow = (label, key, values, fmt) => ({ type: 'slider', label, key, values, fmt });
    const rangeRow = (label, key, min, max, step, fmt) => ({ type: 'slider', label, key, min, max, step, fmt });
    return [
      stepsRow('RESOLUTION', 'internalHeight', RESOLUTIONS, (v) => (v ? v + 'P' : 'NATIVE')),
      rangeRow('DITHER LEVELS', 'ditherLevels', 2, 32, 1, (v) => String(v)),
      rangeRow('DITHER STRENGTH', 'ditherStrength', 0, 1, 0.05, pct),
      rangeRow('FOV', 'fov', 50, 110, 1, (v) => String(v)),
      rangeRow('MOUSE SENS', 'mouseSens', 0.2, 3, 0.1, (v) => v.toFixed(1) + 'X'),
      rangeRow('SCREEN SHAKE', 'shake', 0, 1, 0.05, pct),
      { type: 'toggle', label: 'DEBUG (F3)', key: 'debug' },
      { type: 'button', label: 'RESET DEFAULTS', action: () => resetSettings() },
      { type: 'button', label: 'BACK', action: () => go('main') },
    ];
  }

  function mainRows() {
    return [
      { type: 'button', label: m.started ? 'RESUME' : 'PLAY', action: () => onPlay() },
      { type: 'button', label: 'NEW GAME', action: () => (m.started ? go('confirm') : onNewGame()) },
      { type: 'button', label: 'SETTINGS', action: () => go('settings') },
      { type: 'button', label: 'CONTROLS', action: () => go('controls') },
    ];
  }

  function go(page) { m.page = page; m.sel = page === 'confirm' ? 1 : 0;   // confirm page starts on CANCEL
    m.dirty = true; }

  // ------------------------------------------------------------ value helpers
  const nearestIdx = (it, v) => {
    let best = 0;
    it.values.forEach((x, i) => { if (Math.abs(x - v) < Math.abs(it.values[best] - v)) best = i; });
    return best;
  };
  const sliderT = (it) => {
    const v = settings[it.key];
    if (it.values) return nearestIdx(it, v) / (it.values.length - 1);
    return (v - it.min) / (it.max - it.min);
  };
  const sliderFromT = (it, t) => {
    t = Math.max(0, Math.min(1, t));
    if (it.values) return it.values[Math.round(t * (it.values.length - 1))];
    const n = Math.round((t * (it.max - it.min)) / it.step);
    return +(it.min + n * it.step).toFixed(4);
  };
  const nudge = (it, dir) => {
    if (it.type === 'toggle') return setSetting(it.key, !settings[it.key]);
    if (it.type !== 'slider') return;
    if (it.values) {
      const i = Math.max(0, Math.min(it.values.length - 1, nearestIdx(it, settings[it.key]) + dir));
      setSetting(it.key, it.values[i]);
    } else {
      setSetting(it.key, Math.max(it.min, Math.min(it.max, +(settings[it.key] + dir * it.step).toFixed(4))));
    }
  };
  const activate = (it) => {
    if (!it) return;
    if (it.type === 'button') it.action();
    else if (it.type === 'toggle') nudge(it, 1);
    m.dirty = true;
  };

  // ------------------------------------------------------------ drawing
  function draw() {
    const { gfx, w, h, scale: s } = overlay;
    gfx.clear();
    items = [];

    const rh = 12 * s;                                        // row height
    const pw = Math.min(250 * s, w - 16 * s);
    const px = Math.round((w - pw) / 2);
    const pad = 8 * s;

    let rows, title, sub = null, info = null;
    if (m.page === 'settings') { rows = settingsRows(); title = 'SETTINGS'; }
    else if (m.page === 'controls') { rows = [{ type: 'button', label: 'BACK', action: () => go('main') }]; title = 'CONTROLS'; }
    else if (m.page === 'confirm') {
      rows = [
        { type: 'button', label: 'START NEW GAME', action: () => onNewGame() },
        { type: 'button', label: 'CANCEL', action: () => go('main') },
      ];
      title = 'NEW GAME?'; sub = 'THIS WORLD WILL BE REPLACED';
    }
    else { rows = mainRows(); title = 'DITHER-VOX'; sub = m.started ? 'PAUSED' : 'CLICK PLAY TO START'; }

    const titleS = m.page === 'main' ? s * 3 : s * 2;
    let bodyH = rows.length * rh + pad;
    if (m.page === 'controls') bodyH += CONTROLS.length * 9 * s + 2 * s;
    if (m.page === 'settings') bodyH += 14 * s;               // info line
    const headH = titleS * 7 + (sub ? 16 * s : 6 * s) + pad;
    const ph = headH + bodyH;
    const py = Math.round((h - ph) / 2);

    gfx.frame(px, py, pw, ph, s, theme);

    // title
    const ty = py + pad;
    if (m.page === 'main') gfx.textCentre(title, w / 2 + titleS, ty + titleS, titleS, theme.black);
    gfx.textCentre(title, w / 2, ty, titleS, m.page === 'main' ? theme.flame : theme.text);
    if (sub) gfx.textCentre(sub, w / 2, ty + titleS * 7 + 5 * s, s, theme.dim);

    let y = py + headH;
    if (m.page === 'controls') {
      for (const [k, d] of CONTROLS) {
        gfx.text(k, px + pad, y, s, theme.flame);
        gfx.text(d, px + pad + 78 * s, y, s, theme.text);
        y += 9 * s;
      }
      y += 2 * s;
    }

    const trackW = 64 * s, valueW = 8 * 6 * s;
    const trackX = px + pw - pad - valueW - 4 * s - trackW;

    rows.forEach((it, i) => {
      it.rect = { x: px + 3 * s, y, w: pw - 6 * s, h: rh };
      const hot = i === m.sel;
      if (hot) gfx.rect(it.rect.x, it.rect.y, it.rect.w, it.rect.h, theme.row);
      const ty2 = y + Math.round((rh - 7 * s) / 2);
      const col = hot ? theme.white : theme.text;

      if (it.type === 'button') {
        const label = hot ? `> ${it.label} <` : it.label;
        gfx.textCentre(label, w / 2, ty2, s, hot ? theme.lava : theme.text);
      } else {
        gfx.text(it.label, px + pad, ty2, s, col);
        if (it.type === 'slider') {
          const t = sliderT(it);
          const th = 5 * s, tyy = y + Math.round((rh - th) / 2);
          it.track = { x: trackX, w: trackW };
          gfx.rect(trackX - s, tyy - s, trackW + 2 * s, th + 2 * s, theme.black);
          gfx.rect(trackX, tyy, trackW, th, theme.track);
          const fw = Math.round(trackW * t);
          if (fw > 0) {
            gfx.rect(trackX, tyy, fw, th, theme.lava);
            gfx.dither(trackX, tyy, fw, th >> 1, theme.flame, theme.lava, 0.5);
          }
          const tx = Math.min(trackX + trackW - 2 * s, trackX + fw - s);
          gfx.rect(tx - s, tyy - 2 * s, 4 * s, th + 4 * s, theme.black);
          gfx.rect(tx, tyy - s, 2 * s, th + 2 * s, hot ? theme.white : theme.text);
          gfx.textRight(it.fmt(settings[it.key]), px + pw - pad, ty2, s, hot ? theme.flame : theme.dim);
        } else {
          const on = !!settings[it.key];
          gfx.textRight(on ? 'ON' : 'OFF', px + pw - pad, ty2, s, on ? theme.lava : theme.dim);
        }
      }
      items.push(it);
      y += rh;
    });

    if (m.page === 'settings') {
      const rect = canvas.getBoundingClientRect();
      const [iw, ih] = internalSize();
      gfx.textCentre(`RENDER ${iw}X${ih}  UPSCALE X${(rect.height / ih).toFixed(2)}`, w / 2, y + 4 * s, s, theme.dim);
    }
    if (m.page === 'main') gfx.textRight(`SEED ${getSeed()}`, px + pw - pad, py + ph - 9 * s, s, theme.dim);

    // pixel cursor (the system cursor is hidden while the menu is open)
    if (m.mouseSeen) {
      for (let r = 0; r < CURSOR.length; r++) for (let c = 0; c < 8; c++) {
        const ch = CURSOR[r][c];
        if (ch !== '.') gfx.rect(m.mx + c * s, m.my + r * s, s, s, ch === 'X' ? theme.black : theme.white);
      }
    }
    overlay.dirty = true;
    m.dirty = false;
  }

  // ------------------------------------------------------------ input
  const toInternal = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * overlay.w, (e.clientY - r.top) / r.height * overlay.h];
  };
  const hit = (x, y) => items.findIndex((it) => it.rect && x >= it.rect.x && x < it.rect.x + it.rect.w && y >= it.rect.y && y < it.rect.y + it.rect.h);
  const dragTo = (it, x) => { setSetting(it.key, sliderFromT(it, (x - it.track.x) / it.track.w)); m.dirty = true; };

  addEventListener('mousemove', (e) => {
    if (!m.open) return;
    [m.mx, m.my] = toInternal(e);
    m.mouseSeen = true;
    if (m.drag) dragTo(m.drag, m.mx);
    else { const i = hit(m.mx, m.my); if (i >= 0) m.sel = i; }
    m.dirty = true;
  });
  addEventListener('mousedown', (e) => {
    if (!m.open || e.button !== 0) return;
    [m.mx, m.my] = toInternal(e);
    m.mouseSeen = true;
    const i = hit(m.mx, m.my);
    if (i < 0) { if (m.page === 'main') onPlay(); return; }    // click on empty space resumes
    m.sel = i;
    const it = items[i];
    if (it.type === 'slider') {
      // anywhere on the row starts a drag; the value follows the pointer along the track
      m.drag = it; dragTo(it, m.mx);
    } else activate(it);
    m.dirty = true;
  });
  addEventListener('mouseup', () => { m.drag = null; });
  addEventListener('keydown', (e) => {
    if (!m.open) return;
    const n = items.length;
    if (e.code === 'ArrowDown') m.sel = (m.sel + 1) % n;
    else if (e.code === 'ArrowUp') m.sel = (m.sel + n - 1) % n;
    else if (e.code === 'ArrowLeft') nudge(items[m.sel], -1);
    else if (e.code === 'ArrowRight') nudge(items[m.sel], 1);
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') activate(items[m.sel]);
    else if (e.code === 'Escape' && m.page !== 'main') go('main');
    else return;
    e.preventDefault();
    m.dirty = true;
  });
  // settings can change from outside (reset, F3): keep the menu in sync
  m.refresh = () => { m.dirty = true; };

  // ------------------------------------------------------------ per frame
  // Call once per frame before overlay.render(). Returns true while anything needs drawing.
  m.update = (dt, enabled = true) => {
    const want = enabled && !input.locked;
    if (want !== m.open) {
      m.open = want;
      if (!want) { m.started = true; m.page = 'main'; m.drag = null; }
      else m.sel = 0;
      m.dirty = true;
      document.body.classList.toggle('menu', want);
      input.uiOpen = want;
      if (!want) { overlay.gfx.clear(); overlay.dirty = true; }
    }
    // ease the dim in / out (Bayer dissolve, see uDim in ui/overlay.js)
    const target = dimTarget();
    overlay.dim += (target - overlay.dim) * Math.min(1, dt * 12);
    if (Math.abs(target - overlay.dim) < 0.01) overlay.dim = target;
    if (m.open && m.dirty) draw();
    return m.open || overlay.dim > 0;
  };

  return m;
}
