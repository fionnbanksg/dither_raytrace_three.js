// Voxel-style minimap: a top-down slice of the real voxel grid, one map pixel per 8x8 voxel column.
//
// - Sampled from world.data at roughly waist height, so eroded walls, rubble, pillars, doorways and
//   brazier flames all show up exactly as they are in the level.
// - Walls are rim-lit (only the stone touching open space is bright), colours come from the world
//   PALETTE and are Bayer-dithered to a few levels, like the main view.
// - Explosions call refresh(box), so craters appear on the map as they are carved.
// - Multiplayer: call setMarkers([{ x, z, color, yaw }]) with other players (voxel coords).
// - Optional fog of war (fog: true): the map is revealed around the player as they explore.

import { PALETTE, T } from './world.js';

const CELL = 8;          // voxels per map pixel
const K = 2;             // canvas pixels per map pixel (room for crisp markers)
const LEVELS = 9;        // colour levels per channel
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const FOG_RADIUS = 13;   // map pixels revealed around the player (fog mode)

const FLAME = 6;
const WOOD = 4;

const hash2 = (x, z) => {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export class Minimap {
  constructor(canvas, world, { fog = false } = {}) {
    this.world = world;
    this.canvas = canvas;
    this.fog = fog;
    this.W = Math.ceil(world.size.x / CELL);
    this.H = Math.ceil(world.size.z / CELL);
    canvas.width = this.W * K;
    canvas.height = this.H * K;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.base = document.createElement('canvas');
    this.base.width = this.W;
    this.base.height = this.H;
    this.bctx = this.base.getContext('2d');
    this.img = this.bctx.createImageData(this.W, this.H);

    this.type = new Uint8Array(this.W * this.H);   // 0 = open, 1 = solid
    this.mat = new Uint8Array(this.W * this.H);    // solid: dominant material, open: floor material
    this.sampleY = Math.round((4 * T) / 16);       // ~waist height: above floor rubble, below the eroded ceiling
    this.markers = [];
    this.lastPx = -1; this.lastPz = -1;

    if (fog) {
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.width = this.W;
      this.fogCanvas.height = this.H;
      this.fctx = this.fogCanvas.getContext('2d');
      this.fctx.fillStyle = '#000';
      this.fctx.fillRect(0, 0, this.W, this.H);
    }

    this.rebuild();
  }

  rebuild() {
    this.sample(0, 0, this.W, this.H);
    this.colorize(0, 0, this.W, this.H);
    this.flush(0, 0, this.W, this.H);
  }

  // Re-sample after an explosion. box = voxel box { x0, z0, x1, z1 } (end-exclusive).
  refresh(box) {
    const g = (v, m) => Math.max(0, Math.min(m, v));
    const x0 = Math.floor(box.x0 / CELL), x1 = Math.floor((box.x1 - 1) / CELL) + 1;
    const z0 = Math.floor(box.z0 / CELL), z1 = Math.floor((box.z1 - 1) / CELL) + 1;
    this.sample(g(x0 - 1, this.W), g(z0 - 1, this.H), g(x1 + 1, this.W), g(z1 + 1, this.H));
    const r = [g(x0 - 2, this.W), g(z0 - 2, this.H), g(x1 + 2, this.W), g(z1 + 2, this.H)];
    this.colorize(...r);
    this.flush(...r);
  }

  sample(px0, pz0, px1, pz1) {
    const { data, size } = this.world;
    const sx = size.x, sy = size.y, y = this.sampleY;
    const at = (x, yy, z) => (x < 0 || z < 0 || x >= sx || z >= size.z || yy >= sy ? 1 : data[x + sx * (yy + sy * z)]);
    const OFF = [2, 6];
    for (let pz = pz0; pz < pz1; pz++) for (let px = px0; px < px1; px++) {
      let solid = 0, flame = false;
      const tally = {};
      for (const oz of OFF) for (const ox of OFF) {
        const id = at(px * CELL + ox, y, pz * CELL + oz);
        if (id === 0) continue;
        solid++;
        if (id === FLAME) flame = true;
        tally[id] = (tally[id] || 0) + 1;
      }
      const i = px + this.W * pz;
      if (solid >= 2) {
        let best = 1, n = 0;
        for (const id in tally) if (tally[id] > n) { n = tally[id]; best = +id; }
        this.type[i] = 1;
        this.mat[i] = flame ? FLAME : best;
      } else {
        this.type[i] = 0;
        this.mat[i] = at(px * CELL + 4, 0, pz * CELL + 4);   // floor material (0 = a hole blasted through the floor)
      }
    }
  }

  colorize(px0, pz0, px1, pz1) {
    const { W, H, type, mat } = this;
    const out = this.img.data;
    const solidAt = (x, z) => (x < 0 || z < 0 || x >= W || z >= H ? 1 : type[x + W * z]);
    for (let pz = pz0; pz < pz1; pz++) for (let px = px0; px < px1; px++) {
      const i = px + W * pz;
      const id = mat[i];
      const v = 0.86 + 0.28 * hash2(px, pz);
      let r, g, b;
      if (type[i]) {
        const rim = !solidAt(px + 1, pz) || !solidAt(px - 1, pz) || !solidAt(px, pz + 1) || !solidAt(px, pz - 1);
        const c = PALETTE[id] ?? PALETTE[1];
        if (id === FLAME) { r = 1.0; g = 0.62; b = 0.2; }
        else if (id === WOOD) { const k = rim ? 1.0 : 0.35; r = c[0] * k; g = c[1] * k; b = c[2] * k; }
        else { const k = (rim ? 0.8 : 0.1) * v; r = c[0] * k; g = c[1] * k; b = c[2] * k; }
      } else if (id === 0) {
        r = 0.02; g = 0.02; b = 0.03;                              // hole in the floor
      } else {
        const c = PALETTE[id] ?? PALETTE[3];
        const k = 0.34 * v;
        r = c[0] * k * 0.95; g = c[1] * k; b = c[2] * k * 1.1;     // slightly cool so open ground reads against warm stone
      }
      const t = (BAYER[(px & 3) + 4 * (pz & 3)] + 0.5) / 16;
      const o = i * 4;
      out[o]     = (Math.floor(Math.min(1, r) * (LEVELS - 1) + t) / (LEVELS - 1)) * 255;
      out[o + 1] = (Math.floor(Math.min(1, g) * (LEVELS - 1) + t) / (LEVELS - 1)) * 255;
      out[o + 2] = (Math.floor(Math.min(1, b) * (LEVELS - 1) + t) / (LEVELS - 1)) * 255;
      out[o + 3] = 255;
    }
  }

  flush(px0, pz0, px1, pz1) {
    if (px1 > px0 && pz1 > pz0) this.bctx.putImageData(this.img, 0, 0, px0, pz0, px1 - px0, pz1 - pz0);
  }

  setMarkers(list) { this.markers = list; }

  toggle() { this.canvas.style.display = this.canvas.style.display === 'none' ? '' : 'none'; }

  reveal(px, pz) {
    if (!this.fog || (px === this.lastPx && pz === this.lastPz)) return;
    this.lastPx = px; this.lastPz = pz;
    const r = FOG_RADIUS;
    for (let dz = -r; dz <= r; dz++) {
      const dx = Math.floor(Math.sqrt(r * r - dz * dz));
      this.fctx.clearRect(px - dx, pz + dz, dx * 2 + 1, 1);
    }
  }

  marker(x, z, yaw, color) {
    const ctx = this.ctx;
    const mx = Math.round((x / CELL) * K), mz = Math.round((z / CELL) * K);
    ctx.fillStyle = '#000';
    ctx.fillRect(mx - 3, mz - 3, 6, 6);
    ctx.fillStyle = color;
    ctx.fillRect(mx - 2, mz - 2, 4, 4);
    if (yaw !== undefined) {                                       // facing: a 2x2 "nose" pixel ahead of the dot
      ctx.fillStyle = '#fff';
      ctx.fillRect(mx + Math.round(Math.sin(yaw) * 5) - 1, mz + Math.round(-Math.cos(yaw) * 5) - 1, 2, 2);
    }
  }

  // self = { x, z, yaw } in voxel coordinates (yaw 0 faces -Z, pi/2 faces +X, like the player).
  draw(self, time = 0) {
    this.reveal(Math.floor(self.x / CELL), Math.floor(self.z / CELL));
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W * K, H * K);
    ctx.drawImage(this.base, 0, 0, W * K, H * K);
    if (this.fog) ctx.drawImage(this.fogCanvas, 0, 0, W * K, H * K);
    for (const m of this.markers) this.marker(m.x, m.z, m.yaw, m.color ?? '#ff4a4a');
    this.marker(self.x, self.z, self.yaw, time % 1 < 0.5 ? '#ffd24a' : '#ff9a2a');
  }
}