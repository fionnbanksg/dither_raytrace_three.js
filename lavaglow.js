// Lava glow: the light that resting lava throws onto the world around it. No DOM / WebGL in here.
//
// The old lighting was ONE point light parked above the centroid of every lava cell. That could not light
// a wall next to a small puddle on the far side of the room, ignored walls entirely, and two pools blended
// into one lamp in the middle. This replaces it:
//
//   1. EMITTERS   a lava cell only glows while it is RESTING (something solid or more lava directly under it).
//                 Falling cells, i.e. the stream, don't count; they are drawn as particles and have their own light.
//   2. BLOBS      emitters that touch are one blob; a bigger blob is a hotter, brighter lamp (log scale).
//   3. SPREAD     the light is spread through OPEN space only (Dijkstra, best-first, 26 neighbours), losing a
//                 fraction + a constant per step. Walls take a value on their face but pass nothing on, so glow
//                 does not leak through a wall into the next room, and it flows round corners and doorways.
//   4. TEXTURE    the result is a coarse R8 3D texture (one texel = GLOW_CELL voxels). shader.js samples it
//                 trilinearly at every lit surface point, and uses its gradient to tell which way the glow is
//                 coming from, so a wall facing the pool glows more than the back of a pillar.
//
// Cost scales with the number of lit texels, not with the world: a rebuild runs at most every `interval` seconds
// and only when lava.rev changed, and only the changed box is re-uploaded.

import { LavaSim, LAVA_ID, Y0 } from './lava.js';

const NB = 128;   // priority buckets (value is quantised into these for the best-first search)

export class LavaGlow {
  constructor(world, lava, {
    cell = 4,         // voxels per glow texel edge (lava cells are 2, so 2x2x2 of them per texel)
    fade = 0.86,      // fraction of the light that survives one texel of travel
    drain = 0.035,    // ...minus this constant per texel, so the glow ends in a finite radius
    perCell = 0.3,    // emitted value per resting lava cell (a texel holds up to 8)
    bigBoost = 2.2,   // cap on the brightness multiplier a huge blob gets
    max = 6,          // field value that maps to byte 255 (also the shader's uGlowScale)
    interval = 0.15,  // minimum seconds between rebuilds
  } = {}) {
    this.world = world; this.lava = lava;
    this.G = cell; this.fade = fade; this.drain = drain; this.perCell = perCell; this.bigBoost = bigBoost;
    this.max = max; this.interval = interval;
    const { x, y, z } = world.size;
    this.nx = Math.ceil(x / cell); this.ny = Math.ceil(y / cell); this.nz = Math.ceil(z / cell);
    this.size = { x: this.nx, y: this.ny, z: this.nz };
    const n = this.nx * this.ny * this.nz;
    this.data = new Uint8Array(n);          // the texture contents (0..255 = 0..max)
    this.L = new Float32Array(n);           // working field, back to all-zero between rebuilds
    this.done = new Uint32Array(n);         // search stamps
    this.open = new Uint8Array(n);          // 0 = unknown, 1 = open air, 2 = blocked by stone (lazy cache)
    this.stamp = 0;
    this.rev = -1;                          // lava.rev we last built for (-1 = rebuild next chance)
    this.clock = interval;
    this.prev = [];                         // texels that were non-zero after the last rebuild
    this.prevBox = null;
    this.stats = { ms: 0, sources: 0, blobs: 0, lit: 0 };

    // 26 neighbour offsets with their travel distance (1, sqrt 2, sqrt 3) -> per-step survival and drain
    this.nb = [];
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      const d = Math.hypot(dx, dy, dz);
      this.nb.push({ dx, dy, dz, off: dx + this.nx * (dy + this.ny * dz), keep: Math.pow(fade, d), cost: drain * d });
    }
  }

  // call after anything carved voxels (explosions): open/blocked texels must be re-measured, glow rebuilt
  carved(box) {
    const G = this.G;
    const x0 = Math.max(0, Math.floor(box.x0 / G) - 1), x1 = Math.min(this.nx - 1, Math.floor((box.x1 - 1) / G) + 1);
    const y0 = Math.max(0, Math.floor(box.y0 / G) - 1), y1 = Math.min(this.ny - 1, Math.floor((box.y1 - 1) / G) + 1);
    const z0 = Math.max(0, Math.floor(box.z0 / G) - 1), z1 = Math.min(this.nz - 1, Math.floor((box.z1 - 1) / G) + 1);
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const row = this.nx * (y + this.ny * z);
      this.open.fill(0, row + x0, row + x1 + 1);
    }
    this.rev = -1;
  }

  // Is this texel open space? Blocked when more than half of its voxels are stone (lava / air / flame count as open).
  isOpen(i, tx, ty, tz) {
    let s = this.open[i];
    if (!s) {
      const { data, size } = this.world, G = this.G;
      let solid = 0;
      const x0 = tx * G, y0 = ty * G, z0 = tz * G;
      for (let z = z0; z < z0 + G; z++) for (let y = y0; y < y0 + G; y++) {
        let v = x0 + size.x * (y + size.y * z);
        for (let x = 0; x < G; x++, v++) { const id = data[v]; if (id !== 0 && id !== LAVA_ID && id !== 6) solid++; }
      }
      s = solid * 2 > G * G * G ? 2 : 1;
      this.open[i] = s;
    }
    return s === 1;
  }

  // returns the changed texel box {x0..z1} (exclusive max) when the texture needs uploading, else null
  update(dt) {
    this.clock += dt;
    // wait at least `interval`, and at least 8x the last rebuild's cost, so a huge pool can't eat the frame budget
    if (this.clock < Math.max(this.interval, this.stats.ms * 0.008) || this.rev === this.lava.rev) return null;
    this.clock = 0;
    return this.rebuild();
  }

  rebuild() {
    const t0 = performance.now();
    const { lava, nx, ny, nz, G, L, data, done, nb, max } = this;
    this.rev = lava.rev;
    const nxy = nx * ny;

    // ---- 1. emitters: one count per glow texel, from lava cells that are resting
    const src = new Map();
    const C = lava.C;
    for (const i of lava.all) {
      const cx = i % lava.gx, r = (i / lava.gx) | 0, cy = r % lava.gy, cz = (r / lava.gy) | 0;
      if (lava.isFree(cx, cy - 1, cz)) continue;                 // falling: no glow
      const tx = ((cx + 0.5) * C / G) | 0, ty = ((Y0 + (cy + 0.5) * C) / G) | 0, tz = ((cz + 0.5) * C / G) | 0;
      if (tx >= nx || ty >= ny || tz >= nz) continue;
      const k = tx + nx * (ty + ny * tz);
      // was: src.set(k, (src.get(k) || 0) + 1);
      src.set(k, (src.get(k) || 0) + (lava.glowWeight ? lava.glowWeight(i) : 1));
    }

    // ---- 2. blobs: touching emitter texels share one size -> brighter when bigger
    const blobOf = new Map(), blobCells = [];
    for (const [k0] of src) {
      if (blobOf.has(k0)) continue;
      const id = blobCells.length; let cells = 0;
      const stack = [k0]; blobOf.set(k0, id);
      while (stack.length) {
        const k = stack.pop(); cells += src.get(k);
        const z = (k / nxy) | 0, rr = k - z * nxy, y = (rr / nx) | 0, x = rr - y * nx;
        for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const j = (x + dx) + nx * ((y + dy) + ny * (z + dz));
          if (x + dx < 0 || x + dx >= nx || y + dy < 0 || y + dy >= ny || z + dz < 0 || z + dz >= nz) continue;
          if (src.has(j) && !blobOf.has(j)) { blobOf.set(j, id); stack.push(j); }
        }
      }
      blobCells.push(cells);
    }

    // ---- 3. spread, best (brightest) first, through open texels only
    this.stamp++;
    const stamp = this.stamp;
    const buckets = Array.from({ length: NB }, () => []);
    const touched = [];
    const bucketOf = (v) => Math.min(NB - 1, (v / max * NB) | 0);
    for (const [k, count] of src) {
      const boost = Math.min(this.bigBoost, 1 + 0.55 * Math.log2(1 + blobCells[blobOf.get(k)] / 12));
      const v = Math.min(max, count * this.perCell * boost);
      if (v > L[k]) { if (L[k] === 0) touched.push(k); L[k] = v; buckets[bucketOf(v)].push(k); }
    }
    for (let b = NB - 1; b >= 0; b--) {
      const q = buckets[b];
      while (q.length) {
        const k = q.pop();
        if (done[k] === stamp) continue;
        done[k] = stamp;
        const v = L[k];
        const z = (k / nxy) | 0, rr = k - z * nxy, y = (rr / nx) | 0, x = rr - y * nx;
        for (let m = 0; m < nb.length; m++) {
          const e = nb[m];
          const X = x + e.dx, Y = y + e.dy, Z = z + e.dz;
          if (X < 0 || X >= nx || Y < 0 || Y >= ny || Z < 0 || Z >= nz) continue;
          const cand = v * e.keep - e.cost;
          if (cand <= 0.004) continue;
          const j = k + e.off;
          if (cand <= L[j]) continue;
          if (L[j] === 0) touched.push(j);
          L[j] = cand;
          // stone faces take the value (so the surface sample is lit) but pass nothing on
          if (this.isOpen(j, X, Y, Z) && done[j] !== stamp) buckets[Math.min(b, bucketOf(cand))].push(j);
        }
      }
    }

    // ---- 4. write the bytes; zero what was lit last time and is dark now
    for (let n = 0; n < this.prev.length; n++) data[this.prev[n]] = 0;
    let bx0 = 1e9, by0 = 1e9, bz0 = 1e9, bx1 = -1, by1 = -1, bz1 = -1;
    for (let n = 0; n < touched.length; n++) {
      const k = touched[n];
      data[k] = Math.min(255, Math.round(L[k] / max * 255));
      L[k] = 0;
      const z = (k / nxy) | 0, rr = k - z * nxy, y = (rr / nx) | 0, x = rr - y * nx;
      if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
      if (y < by0) by0 = y; if (y > by1) by1 = y;
      if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
    }
    this.prev = touched;
    const nowBox = touched.length ? { x0: bx0, y0: by0, z0: bz0, x1: bx1 + 1, y1: by1 + 1, z1: bz1 + 1 } : null;
    const a = this.prevBox, b = nowBox;
    this.prevBox = nowBox;
    this.stats = { ms: performance.now() - t0, sources: src.size, blobs: blobCells.length, lit: touched.length };
    if (!a) return b;
    if (!b) return a;
    return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), z1: Math.max(a.z1, b.z1) };
  }
}

// JIT the solver on a scratch grid so the first real puddle doesn't hitch (same idea as destruction.js warmUp)
export function warmUpGlow() {
  const size = { x: 64, y: 32, z: 64 };
  const world = { data: new Uint8Array(size.x * size.y * size.z), size, coarse: new Uint8Array(1), coarseSize: { x: 1, y: 1, z: 1 } };
  for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) world.data[x + size.x * size.y * z] = 3;
  for (let z = 0; z < size.z; z++) for (let y = 0; y < size.y; y++) world.data[40 + size.x * (y + size.y * z)] = 1;
  const lava = new LavaSim(world, { cell: 2 });
  const glow = new LavaGlow(world, lava);
  for (let cz = 4; cz < 20; cz++) for (let cx = 4; cx < 16; cx++) for (let cy = 0; cy < 2; cy++) lava.addVolume(lava.idx(cx, cy, cz), 1);
  lava.addVolume(lava.idx(5, 8, 5), 1);
  for (let i = 0; i < 60; i++) lava.step();
  for (let i = 0; i < 4; i++) { glow.rev = -1; glow.rebuild(); }
  glow.carved({ x0: 10, y0: 0, z0: 10, x1: 20, y1: 10, z1: 20 });
}