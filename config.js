// Tunable settings for the game: render quality, camera, blasts, guns.
// Edit values here; nothing else in the project needs to change.
// (Shader performance knobs are separate: see shader/constants.js)

export const INTERNAL_HEIGHT = 500;   // render resolution (width follows aspect ratio)
export const HALF_RES_LIGHT  = true;  // shadow / light rays run at half resolution and neighbouring pixels reuse them (false = per-pixel rays, slower)
export const LIGHT_DIV       = 2;     // light pass resolution divisor (2 = half; the full-res pass still traces, AOs and dithers every pixel)
export const DITHER_LEVELS   = 14;    // colour levels per channel (lower = grittier)
export const DITHER_STRENGTH = 0.7;   // 0 = flat banding, 1 = full Bayer pattern
export const FOV_DEG         = 70;    // vertical FOV
export const MINIMAP_FOG    = false; // true = the map is only revealed around where you have walked
export const SHOW_DEBUG      = false; // start with the F3 debug overlay open
export const MAX_FRAME_DT    = 0.1;   // clamp to avoid a spiral of death after a tab switch
export const BLAST_RADIUS_M  = 2.0;   // left click: crater radius in metres (a tile is 4 m wide)
export const BIG_BLAST_MUL   = 1.8;   // right click: bigger blast
export const BLAST_PUSH      = 13;    // m/s of knockback at point-blank range
export const FLASH_LIFE      = 1.4;   // seconds the explosion light lasts (it lingers while the fire burns)
export const FLASH_PEAK      = 14;    // explosion light intensity (braziers are 3, torch 2.2)
export const SHAKE_AMOUNT    = 1.0;   // camera shake strength for a nearby blast (0 = off)
export const DEBRIS_PER_BLAST = 56;   // chunks of the destroyed material thrown out (max)

// gun: left click = grenade, right click = heavy shell (slower, bigger, drops more). Hold to keep firing.
export const SHOTS = {
  small: { speed: 34, gravity: 6.0, radiusM: BLAST_RADIUS_M,                 cooldown: 0.32, kick: 1.0, big: false },
  big:   { speed: 22, gravity: 6.0, radiusM: BLAST_RADIUS_M * BIG_BLAST_MUL, cooldown: 0.90, kick: 1.8, big: true  },
};
export const INHERIT_VELOCITY = 1.0;  // fraction of the player's own velocity added to the shot
export const AIM_CONVERGE_M   = 40;   // the barrel is off-centre, so shots are aimed at what the crosshair sees (up to this far)
export const GUN_TIP = [4.8, -4.2, 24];   // muzzle position in camera space (voxels): x right, y up, z forward
