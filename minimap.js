// Voxel-style minimap: a top-down slice of the real voxel grid, one map pixel per 8x8 voxel column.
//
// - Sampled from world.data at roughly waist height, so eroded walls, rubble, pillars, doorways and
//   brazier flames all show up exactly as they are in the level.
// - Walls are rim-lit (only the stone touching open space is bright), colours come from the world
//   PALETTE and are Bayer-dithered to a few levels, like the main view.
// - Explosions call refresh(box), so craters appear on the map as they are carved.
// - Heading-up: a square window (VIEW map pixels across, ~10 tiles) rotates around the player so
//   forward is always up. A red N on the frame rim shows where north is.
// - Multiplayer: call setMarkers([{ x, z, color, yaw }]) with other players (voxel coords);
//   off-window players are clamped to the frame edge.
// - Optional fog of war (fog: true): the map is revealed around the player as they explore.

import { PALETTE, T } from './world.js';

const CELL = 8;          // voxels per map pixel
const VIEW = 80;         // map pixels across the rotating window (80 = 10 tiles at T = 64)
const K = 3;             // canvas pixels per window pixel (room for crisp markers)
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
    canvas.width = VIEW * K;
    canvas.height = VIEW * K;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.view = document.createElement('canvas');   // the rotated window, VIEW x VIEW
    this.view.width = VIEW;
    this.view.height = VIEW;
    this.vctx = this.view.getContext('2d');
    this.vimg = this.vctx.createImageData(VIEW, VIEW);

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

    this.explored = fog ? new Uint8Array(this.W * this.H) : null;

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
      const z = pz + dz;
      if (z < 0 || z >= this.H) continue;
      const dx = Math.floor(Math.sqrt(r * r - dz * dz));
      for (let x = Math.max(0, px - dx); x <= Math.min(this.W - 1, px + dx); x++) this.explored[x + this.W * z] = 1;
    }
  }

  // Rotate the base map into the VIEW x VIEW window (nearest-neighbour, so pixels stay crisp).
  // Screen x = player's right, screen up = player's forward.
  renderView(cx, cz, yaw) {
    const { W, H, explored } = this;
    const src = this.img.data, dst = this.vimg.data;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const half = VIEW / 2;
    for (let oy = 0; oy < VIEW; oy++) for (let ox = 0; ox < VIEW; ox++) {
      const dx = ox + 0.5 - half, dy = oy + 0.5 - half;
      const wx = Math.floor(cx + c * dx - sn * dy);
      const wz = Math.floor(cz + sn * dx + c * dy);
      const o = (ox + VIEW * oy) * 4;
      if (wx < 0 || wz < 0 || wx >= W || wz >= H || (explored && !explored[wx + W * wz])) {
        dst[o] = 6; dst[o + 1] = 6; dst[o + 2] = 8; dst[o + 3] = 255;     // outside the map / unexplored
      } else {
        const i = (wx + W * wz) * 4;
        dst[o] = src[i]; dst[o + 1] = src[i + 1]; dst[o + 2] = src[i + 2]; dst[o + 3] = 255;
      }
    }
    this.vctx.putImageData(this.vimg, 0, 0);
  }

  // Draw a dot at a window position (window pixels, centre = VIEW/2). rel = facing relative to the viewer.
  dot(sx, sy, rel, color) {
    const ctx = this.ctx, half = VIEW / 2;
    const m = half - 2;
    let x = sx, y = sy, edge = false;
    if (Math.abs(x) > m || Math.abs(y) > m) {                        // off the window: pin to the frame
      const k = m / Math.max(Math.abs(x), Math.abs(y));
      x *= k; y *= k; edge = true;
    }
    const mx = Math.round((half + x) * K), my = Math.round((half + y) * K);
    ctx.globalAlpha = edge ? 0.6 : 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(mx - 4, my - 4, 8, 8);
    ctx.fillStyle = color;
    ctx.fillRect(mx - 3, my - 3, 6, 6);
    if (rel !== undefined && !edge) {                                // facing: a 3x3 "nose" ahead of the dot
      ctx.fillStyle = '#fff';
      ctx.fillRect(mx + Math.round(Math.sin(rel) * 7) - 1, my + Math.round(-Math.cos(rel) * 7) - 1, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  // self = { x, z, yaw } in voxel coordinates (yaw 0 faces -Z, pi/2 faces +X, like the player).
  draw(self, time = 0) {
    const cx = self.x / CELL, cz = self.z / CELL;
    this.reveal(Math.floor(cx), Math.floor(cz));
    this.renderView(cx, cz, self.yaw);

    const { ctx } = this;
    const size = VIEW * K, half = VIEW / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.view, 0, 0, size, size);

    // other players, rotated into the window
    const c = Math.cos(self.yaw), sn = Math.sin(self.yaw);
    for (const m of this.markers) {
      const rx = m.x / CELL - cx, rz = m.z / CELL - cz;
      this.dot(c * rx + sn * rz, -(sn * rx - c * rz), m.yaw === undefined ? undefined : m.yaw - self.yaw, m.color ?? '#ff4a4a');
    }
    this.dot(0, 0, 0, time % 1 < 0.5 ? '#ffd24a' : '#ff9a2a');       // you: always at the centre, facing up

    // north marker on the frame rim: north is world -Z
    const nx = -sn, ny = -c;
    const r = half - 5;
    const k = r / Math.max(Math.abs(nx), Math.abs(ny));
    const tx = (half + nx * k) * K, ty = (half + ny * k) * K;
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000'; ctx.fillText('N', tx + 1, ty + 1);
    ctx.fillStyle = '#ff6a5a'; ctx.fillText('N', tx, ty);
  }
}