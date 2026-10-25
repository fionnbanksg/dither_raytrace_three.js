// Player-adjustable settings (the in-game menu edits these). Defaults come from config.js, so config.js stays the
// place to change what a fresh install starts with. Changes are saved to localStorage and broadcast to listeners.

import { INTERNAL_HEIGHT, DITHER_LEVELS, DITHER_STRENGTH, FOV_DEG, SHAKE_AMOUNT, SHOW_DEBUG } from './config.js';

export const DEFAULTS = {
  internalHeight: INTERNAL_HEIGHT,   // 0 = native (canvas pixel height)
  ditherLevels: DITHER_LEVELS,
  ditherStrength: DITHER_STRENGTH,
  fov: FOV_DEG,
  mouseSens: 1,                      // multiplier on Input's base sensitivity
  shake: SHAKE_AMOUNT,
  debug: SHOW_DEBUG,
};

const KEY = 'dither-vox.settings.v1';

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (typeof raw[k] === typeof DEFAULTS[k]) out[k] = raw[k];
    return out;
  } catch { return {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode etc: just don't persist */ }
}

export const settings = { ...DEFAULTS, ...load() };

const listeners = [];
export function onSettingChange(fn) { listeners.push(fn); }   // fn(key, value)

export function setSetting(key, value) {
  if (settings[key] === value) return;
  settings[key] = value;
  save();
  listeners.forEach((fn) => fn(key, value));
}

export function resetSettings() {
  for (const k of Object.keys(DEFAULTS)) setSetting(k, DEFAULTS[k]);
}

// Internal render size for a canvas rect: height from settings (0 = native), width follows the aspect ratio.
export function internalSize(rect) {
  const h = Math.max(1, settings.internalHeight || Math.round(rect.height));
  const w = Math.max(1, Math.round(h * rect.width / Math.max(1, rect.height)));
  return [w, h];
}
