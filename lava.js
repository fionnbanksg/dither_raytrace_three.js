// Lava: a voxel cellular-automaton fluid. No DOM / WebGL in here (like physics.js / destruction.js),
// so it could run on a server too.
//
// How it fits the renderer: lava is just another voxel material (id 8). Cells are written into
// world.data, the changed box is re-uploaded with texSubImage3D and the coarse bricks are refreshed,
// so the raytracer, AO, shadows, fog and Bayer dither all treat it like the rest of the world.
// shader.js gives id 8 its emissive animated look; main.js adds a point light over the pool.
//
// SCALING TO A REAL FLUID SIM — everything fluid-specific is behind these methods:
//   isFree()   what may a cell flow into          step()    one simulation tick (budgeted)
//   place()/remove()  the only functions that touch world.data  flush()  dirty box for the GPU
// Swap step() for a pressure/level-based solver (per-cell volume instead of the 0/1 `fl` grid),
// run it in chunks (active set is already sparse), or move it to a worker — the render side
// (id 8 voxels + dirty-box upload) does not change. Render-time smoothing/marching cubes can come later.

import { refreshCoarse } from './destruction.js';

export const LAVA_ID = 8;
const Y0 = 1;                                   // voxel row 0 is the floor slab; air starts at y = 1 (same as physics.js)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export class LavaSim {
  constructor(world, { cell = 2, width = 1, viscosity = 0.6, budget = 4000, reach = 8, period = 15, passes = 15 } = {}) {
    this.reach = reach;                         // how far a cell looks along the surface for an edge to flow to
    this.period = period; this.passes = passes; this.tick = 0;   // sideways settling: a burst of `passes` passes every `period` ticks
    this.world = world;
    this.C = cell;                              // voxels per lava cell edge (2 => chunky, matches the dithered look)
    this.width = width;                         // nozzle half-width in cells: 1 => 3x3 cells per tick per source
    this.viscosity = viscosity;                 // chance a cell tries to move each step (lower = thicker lava)
    this.budget = budget;                       // max cells processed per step
    const { x, y, z } = world.size;
    this.gx = Math.floor(x / cell);
    this.gy = Math.floor((y - Y0) / cell);
    this.gz = Math.floor(z / cell);
    this.fl = new Uint8Array(this.gx * this.gy * this.gz);   // 1 = lava in this cell
    this.all = new Set();                       // every lava cell
    this.active = new Set();                    // cells that may still move
    this.sources = [];
    this.sum = [0, 0, 0];                       // for the centroid (light position)
    this.dirty = null;
  }

  // ---- addressing
  idx(cx, cy, cz) { return cx + this.gx * (cy + this.gy * cz); }
  inGrid(cx, cy, cz) { return cx >= 0 && cy >= 0 && cz >= 0 && cx < this.gx && cy < this.gy && cz < this.gz; }
  voxBase(cx, cy, cz) { const { size } = this.world; return cx * this.C + size.x * (Y0 + cy * this.C + size.y * cz * this.C); }
  get count() { return this.all.size; }

  // ---- queries
  isFree(cx, cy, cz) {
    if (!this.inGrid(cx, cy, cz) || this.fl[this.idx(cx, cy, cz)]) return false;
    const { data, size } = this.world, C = this.C;
    const x0 = cx * C, y0 = Y0 + cy * C, z0 = cz * C;
    for (let z = z0; z < z0 + C; z++) for (let y = y0; y < y0 + C; y++) {
      let i = x0 + size.x * (y + size.y * z);
      for (let x = 0; x < C; x++, i++) if (data[i] !== 0) return false;
    }
    return true;
  }
  cellOfVoxel(x, y, z) { return [Math.floor(x / this.C), Math.floor((y - Y0) / this.C), Math.floor(z / this.C)]; }

  // ---- the only code that writes voxels
  write(cx, cy, cz, id) {
    const { data, size } = this.world, C = this.C;
    const x0 = cx * C, y0 = Y0 + cy * C, z0 = cz * C;
    for (let z = z0; z < z0 + C; z++) for (let y = y0; y < y0 + C; y++) {
      let i = x0 + size.x * (y + size.y * z);
      for (let x = 0; x < C; x++, i++) data[i] = id;
    }
    const d = this.dirty;
    if (!d) this.dirty = { x0, x1: x0 + C, y0, y1: y0 + C, z0, z1: z0 + C };
    else {
      d.x0 = Math.min(d.x0, x0); d.x1 = Math.max(d.x1, x0 + C);
      d.y0 = Math.min(d.y0, y0); d.y1 = Math.max(d.y1, y0 + C);
      d.z0 = Math.min(d.z0, z0); d.z1 = Math.max(d.z1, z0 + C);
    }
  }
  place(cx, cy, cz) {
    const i = this.idx(cx, cy, cz);
    this.fl[i] = 1; this.all.add(i); this.active.add(i);
    this.sum[0] += cx; this.sum[1] += cy; this.sum[2] += cz;
    this.write(cx, cy, cz, LAVA_ID);
  }
  remove(cx, cy, cz, erase = true) {
    const i = this.idx(cx, cy, cz);
    if (!this.fl[i]) return;
    this.fl[i] = 0; this.all.delete(i); this.active.delete(i);
    this.sum[0] -= cx; this.sum[1] -= cy; this.sum[2] -= cz;
    if (erase) this.write(cx, cy, cz, 0);
  }
  wake(cx, cy, cz) {
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy, z = cz + dz;
      if (!this.inGrid(x, y, z)) continue;
      const j = this.idx(x, y, z);
      if (this.fl[j]) this.active.add(j);
    }
  }

  // ---- public controls
  addSource(vx, vy, vz) {                       // voxel position
    const [cx, cy, cz] = this.cellOfVoxel(vx, vy, vz);
    if (this.inGrid(cx, cy, cz)) this.sources.push({ cx, cy, cz });
  }
  clear() {
    for (const i of [...this.all]) {
      const cx = i % this.gx, r = (i / this.gx) | 0, cy = r % this.gy, cz = (r / this.gy) | 0;
      this.remove(cx, cy, cz);
    }
    this.sources.length = 0;
  }
  // call after anything else edits voxels (explosions): drops lava cells that were carved away and wakes the rest
  notifyCarved(box) {
    const C = this.C;
    const [a, b, c] = this.cellOfVoxel(box.x0, box.y0, box.z0), [d, e, f] = this.cellOfVoxel(box.x1, box.y1, box.z1);
    const { data } = this.world;
    for (let cz = c - 1; cz <= f + 1; cz++) for (let cy = b - 1; cy <= e + 1; cy++) for (let cx = a - 1; cx <= d + 1; cx++) {
      if (!this.inGrid(cx, cy, cz) || !this.fl[this.idx(cx, cy, cz)]) continue;
      if (data[this.voxBase(cx, cy, cz)] !== LAVA_ID) this.remove(cx, cy, cz, false);
      else this.active.add(this.idx(cx, cy, cz));
    }
    // cells next to removed ones may now flow
    for (let cz = c - 1; cz <= f + 1; cz++) for (let cy = b - 1; cy <= e + 1; cy++) for (let cx = a - 1; cx <= d + 1; cx++) {
      if (this.inGrid(cx, cy, cz) && this.fl[this.idx(cx, cy, cz)]) this.active.add(this.idx(cx, cy, cz));
    }
  }

  // ---- one simulation tick
  step() {
    for (const s of this.sources) {                              // each source is a (2w+1)^2 nozzle: one cell per column per tick
      const w = this.width;
      for (let dz = -w; dz <= w; dz++) for (let dx = -w; dx <= w; dx++) {
        for (let up = 0; up <= 8; up++) {                      // if the pile under the nozzle reached it, keep feeding on top
          if (this.isFree(s.cx + dx, s.cy + up, s.cz + dz)) { this.place(s.cx + dx, s.cy + up, s.cz + dz); break; }
        }
      }
    }
    // Falling happens every tick (so streams are continuous). Sideways settling happens in bursts every `period`
    // ticks (~0.5 s at 30 Hz): each burst runs several passes so the pool spreads as fast as it did when this ran
    // every tick, but the surface rearranges in one pop instead of cubes hopping around 30 times a second.
    const lateral = (++this.tick % this.period) === 0;
    const passes = lateral ? this.passes : 1;
    for (let pass = 0; pass < passes; pass++) {
      const list = Array.from(this.active);
      if (!list.length) return;
      const off = (Math.random() * list.length) | 0;
      const n = Math.min(list.length, this.budget);
      let moved = false;
      for (let k = 0; k < n; k++) {
        const i = list[(k + off) % list.length];
        if (!this.fl[i]) continue;
        if (this.moveCell(i, lateral)) moved = true;
        else if (lateral) this.active.delete(i);                  // settled: sleep until a neighbour changes
      }
      if (!moved) break;
    }
  }

  moveCell(i, lateral) {
    const cx = i % this.gx, r = (i / this.gx) | 0, cy = r % this.gy, cz = (r / this.gy) | 0;
    let to = null;
    if (this.isFree(cx, cy - 1, cz)) {                            // fall
      if (Math.random() > this.viscosity) return true;            // thick: sometimes hangs for a tick (still counts as busy)
      to = [cx, cy - 1, cz];
    } else if (lateral) {
      const dirs = DIRS.slice().sort(() => Math.random() - 0.5);
      for (const [dx, dz] of dirs) {                              // slide off ledges
        if (this.isFree(cx + dx, cy, cz + dz) && this.isFree(cx + dx, cy - 1, cz + dz)) { to = [cx + dx, cy - 1, cz + dz]; break; }
      }
      // spread only when stacked on more lava: pools settle 1-2 cells deep instead of a hair-thin film
      if (!to && this.inGrid(cx, cy - 1, cz) && this.fl[this.idx(cx, cy - 1, cz)]) {
        for (const [dx, dz] of dirs) {                            // run along the surface to the nearest edge it can drop off
          for (let k = 1; k <= this.reach; k++) {
            if (!this.isFree(cx + dx * k, cy, cz + dz * k)) break;
            if (this.isFree(cx + dx * k, cy - 1, cz + dz * k)) { to = [cx + dx * k, cy, cz + dz * k]; break; }
          }
          if (to) break;
        }
      }
      if (to) while (this.isFree(to[0], to[1] - 1, to[2])) to[1]--;   // land at the bottom at once: nothing hovers
    }
    if (!to) return false;
    this.remove(cx, cy, cz); this.place(to[0], to[1], to[2]); this.wake(cx, cy, cz);
    return true;
  }

  // voxel box changed since the last call (or null). Refreshes coarse bricks; caller uploads to the GPU.
  flush() {
    const d = this.dirty;
    if (!d) return null;
    this.dirty = null;
    refreshCoarse(this.world, d);
    return d;
  }

  // where to put the pool's light (voxels) and how strong it should be
  light() {
    const n = this.count;
    if (!n) return null;
    const C = this.C;
    return {
      pos: [(this.sum[0] / n + 0.5) * C, Y0 + (this.sum[1] / n + 0.5) * C + 14, (this.sum[2] / n + 0.5) * C],
      strength: Math.min(1, 0.25 + Math.sqrt(n) / 40),
    };
  }
}
