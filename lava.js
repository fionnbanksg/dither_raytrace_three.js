// Lava: a volume-based fluid solver on the voxel grid. No DOM / WebGL in here (like physics.js / destruction.js),
// so it could run on a server too.
//
// STAGE 1 (this file): replaces the old 0/1 cellular automaton with a conserving "virtual pipe" fluid.
//
//   * every lava cell holds a VOLUME (0..~1.25), not a yes/no. Volume is only ever moved between cells, never
//     created or destroyed, so a pool really has the same amount of lava however it spreads.
//   * every face between two cells carries a FLUX that persists from tick to tick (momentum). Each tick the flux
//     is accelerated by the pressure (hydrostatic head) difference across the face, gravity pulls it down, and
//     damping makes it thick like lava. Lava is also a Bingham fluid: it only flows sideways when the head
//     difference beats a yield threshold, so it piles into mounds and stops at a finite thickness instead of
//     spreading to a hair-thin film.
//   * outgoing flux is scaled so a cell can't give away more than it has, incoming so it can't take more than
//     it has room for (slightly compressible, so U-tubes and filled pits push back up).
//   * cells that nothing is happening around fall asleep, so a settled lake costs nothing.
//
// HOW IT STILL FITS THE RENDERER (unchanged contract, so shader.js / lavaglow.js / main.js keep working):
//   lava is still voxel material id 8 written into world.data. A cell is C voxels tall, so a partly filled cell
//   writes only its bottom `shown` layers (surface cells get a finer, level surface than whole cubes did).
//   `all` (Set of visible cells), `isFree()`, `gx/gy/gz`, `C`, `rev`, `count`, `flush()`, `splat()`,
//   `notifyCarved()`, `clear()` and `addSource()` all behave as before. lavaglow.js additionally asks
//   `glowWeight(i)` so a thin film glows less than a full cell.
//
// LATER STAGES: droplets carry momentum into the grid (stage 2), airborne cohesion / splashing (stage 3),
// cooling + crust (stage 4). Everything fluid-specific stays behind step().

import { refreshCoarse } from './destruction.js';

export const LAVA_ID = 8;
export const Y0 = 1;                                 // voxel row 0 is the floor slab; air starts at y = 1 (same as physics.js)

const SHOW = 0.15;                                   // volume below this draws nothing
const EPS = 1e-4;                                    // volume below this is float dust and is deleted
const FLUX_EPS = 2e-4;                               // flux below this is zeroed so nothing creeps forever

export class LavaSim {
  constructor(world, {
    cell = 2,            // voxels per lava cell edge
    width = 1,           // nozzle half-width in cells for addSource() (1 => 3x3)
    gravity = 0.07,      // flux added per tick on a vertical face that has lava above it (cell-volumes / tick)
    flow = 0.09,         // lateral acceleration per unit of head difference (higher = runnier)
    pressure = 0.35,     // acceleration from compression / vertical head difference
    yieldH = 0.12,       // Bingham yield: head difference (in cells) that must be beaten before lava flows sideways
    damp = 0.80,         // fraction of a face's flux kept each tick (lower = thicker, more syrupy)
    cap = 1.25,          // max volume of a cell (>1 = compressible)
    dropVol = 1.0,       // volume one gun droplet adds when it lands
    sourceRate = 0.5,    // volume per tick per nozzle column for addSource()
  } = {}) {
    this.world = world;
    this.C = cell; this.width = width;
    this.g = gravity; this.kL = flow; this.kP = pressure; this.yieldH = yieldH; this.damp = damp; this.cap = cap;
    this.dropVol = dropVol; this.sourceRate = sourceRate;

    const { x, y, z } = world.size;
    this.gx = Math.floor(x / cell);
    this.gy = Math.floor((y - Y0) / cell);
    this.gz = Math.floor(z / cell);
    const n = this.n = this.gx * this.gy * this.gz;
    this.gxy = this.gx * this.gy;

    this.vol = new Float32Array(n);              // lava volume per cell (the real state)
    this.fl = new Uint8Array(n);                 // voxel layers currently drawn in the cell (0 = none .. C = full)
    this.solid = new Uint8Array(n);              // 1 = cell contains a non-lava voxel (cached; refreshed by notifyCarved)
    this.F = new Float32Array(3 * n);            // flux through the +x / +y / +z face of each cell (persists = momentum)
    this.S = new Uint32Array(3 * n);             // tick a face was last updated (stale flux is discarded)
    this.mark = new Uint32Array(3 * n);          // per-tick face de-duplication
    this.out = new Float32Array(n);              // scratch: summed outflow / inflow per cell
    this.inn = new Float32Array(n);
    this.head = new Float32Array(n);             // scratch: cached hydrostatic head
    this.headT = new Uint32Array(n);
    this.tick = 0;

    this.all = new Set();                        // cells that draw at least one lava layer (lavaglow.js reads this)
    this.awake = new Set();                      // cells that may still move
    this.next = new Set();
    this.sources = [];
    this.rev = 0;                                // bumps whenever the drawn lava changes (lavaglow.js rebuilds when it changes)
    this.dirty = null;
    this._faces = []; this._touched = [];
    this.computeSolidAll();
  }

  // ---- addressing
  idx(cx, cy, cz) { return cx + this.gx * (cy + this.gy * cz); }
  inGrid(cx, cy, cz) { return cx >= 0 && cy >= 0 && cz >= 0 && cx < this.gx && cy < this.gy && cz < this.gz; }
  voxBase(cx, cy, cz) { const { size } = this.world; return cx * this.C + size.x * (Y0 + cy * this.C + size.y * cz * this.C); }
  get count() { return this.all.size; }
  get totalVolume() { let s = 0; for (let i = 0; i < this.n; i++) s += this.vol[i]; return s; }
  cellOfVoxel(x, y, z) { return [Math.floor(x / this.C), Math.floor((y - Y0) / this.C), Math.floor(z / this.C)]; }

  // ---- solid cache: a cell is solid if any voxel in it is non-air and not lava
  cellSolid(cx, cy, cz) {
    const { data, size } = this.world, C = this.C;
    const x0 = cx * C, y0 = Y0 + cy * C, z0 = cz * C;
    for (let z = z0; z < z0 + C; z++) for (let y = y0; y < y0 + C; y++) {
      let i = x0 + size.x * (y + size.y * z);
      for (let x = 0; x < C; x++, i++) { const id = data[i]; if (id !== 0 && id !== LAVA_ID) return 1; }
    }
    return 0;
  }
  computeSolidAll() {
    for (let cz = 0; cz < this.gz; cz++) for (let cy = 0; cy < this.gy; cy++) for (let cx = 0; cx < this.gx; cx++)
      this.solid[this.idx(cx, cy, cz)] = this.cellSolid(cx, cy, cz);
  }

  // ---- queries (same meaning as before: "is there nothing drawn / solid here")
  isFree(cx, cy, cz) {
    if (!this.inGrid(cx, cy, cz)) return false;
    const i = this.idx(cx, cy, cz);
    return !this.solid[i] && this.fl[i] === 0;
  }
  glowWeight(i) { return Math.min(1, this.vol[i]); }   // how much a resting cell lights its surroundings

  // ---- the only code that writes voxels: bottom `h` layers of the cell become lava, the rest air
  writeCell(cx, cy, cz, h) {
    const { data, size } = this.world, C = this.C;
    const x0 = cx * C, y0 = Y0 + cy * C, z0 = cz * C;
    for (let z = z0; z < z0 + C; z++) for (let y = y0; y < y0 + C; y++) {
      const id = (y - y0) < h ? LAVA_ID : 0;
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

  // how many layers should cell i draw right now?
  layers(i) {
    const v = this.vol[i];
    if (v < SHOW) return 0;
    if (v >= 1) return this.C;
    const up = i + this.gx;
    if (((i / this.gx) | 0) % this.gy + 1 < this.gy && !this.solid[up] && this.vol[up] >= SHOW) return this.C;   // capped by lava: full cube
    return Math.min(this.C, Math.ceil(v * this.C - 0.3));
  }
  // bring the drawn voxels of cell i in line with its volume
  refresh(i) {
    const h = this.layers(i);
    if (h === this.fl[i]) return;
    const cx = i % this.gx, r = (i / this.gx) | 0, cy = r % this.gy, cz = (r / this.gy) | 0;
    this.fl[i] = h;
    if (h) this.all.add(i); else this.all.delete(i);
    this.rev++;
    this.writeCell(cx, cy, cz, h);
  }

  refreshWithBelow(i) {
    this.refresh(i);
    if (((i / this.gx) | 0) % this.gy > 0) this.refresh(i - this.gx);
  }

  wakeAround(i) {
    const { gx, gxy, n } = this;
    const cx = i % gx, cy = ((i / gx) | 0) % this.gy, cz = (i / gxy) | 0;
    const nx = this.next;
    nx.add(i);
    if (cx > 0) nx.add(i - 1);
    if (cx < gx - 1) nx.add(i + 1);
    if (cy > 0) nx.add(i - gx);
    if (cy < this.gy - 1) nx.add(i + gx);
    if (cz > 0) nx.add(i - gxy);
    if (cz < this.gz - 1) nx.add(i + gxy);
  }

  // ---- public controls
  addVolume(i, v) {
    this.vol[i] += v;
    this.wakeAround(i);
    this.refreshWithBelow(i);
  }
  addSource(vx, vy, vz) {                       // voxel position
    const [cx, cy, cz] = this.cellOfVoxel(vx, vy, vz);
    if (this.inGrid(cx, cy, cz)) this.sources.push({ cx, cy, cz });
  }
  // A droplet landed at `point` (voxels) on a surface with `normal`: pour its volume into the free cell just off
  // the surface; if that one is full (the pile is already there) climb, then try the neighbours, so a steady
  // stream builds a heap that the solver then slumps into a pool.
  splat(point, normal, vol = this.dropVol) {
    const C = this.C;
    const px = point[0] + normal[0] * C * 0.5, py = point[1] + normal[1] * C * 0.5, pz = point[2] + normal[2] * C * 0.5;
    const [cx, cy, cz] = this.cellOfVoxel(px, py, pz);
    const tries = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];
    for (let up = 0; up <= 8; up++) {
      for (const [dx, , dz] of tries) {
        const x = cx + dx, y = cy + up, z = cz + dz;
        if (!this.inGrid(x, y, z)) continue;
        const i = this.idx(x, y, z);
        if (this.solid[i] || this.vol[i] + vol > this.cap) continue;
        this.addVolume(i, vol);
        return true;
      }
    }
    return false;
  }
  clear() {
    for (const i of [...this.all]) {
      const cx = i % this.gx, r = (i / this.gx) | 0, cy = r % this.gy, cz = (r / this.gy) | 0;
      this.writeCell(cx, cy, cz, 0);
    }
    this.vol.fill(0); this.fl.fill(0); this.F.fill(0); this.S.fill(0);
    this.all.clear(); this.awake.clear(); this.next.clear();
    this.sources.length = 0;
    this.rev++;
  }
  // call after anything else edits voxels (explosions): re-measures solids, drops lava that was carved away, wakes the rest
  notifyCarved(box) {
    this.rev++;
    const [a, b, c] = this.cellOfVoxel(box.x0, box.y0, box.z0), [d, e, f] = this.cellOfVoxel(box.x1, box.y1, box.z1);
    const { data } = this.world;
    for (let cz = Math.max(0, c - 1); cz <= Math.min(this.gz - 1, f + 1); cz++)
      for (let cy = Math.max(0, b - 1); cy <= Math.min(this.gy - 1, e + 1); cy++)
        for (let cx = Math.max(0, a - 1); cx <= Math.min(this.gx - 1, d + 1); cx++) {
          const i = this.idx(cx, cy, cz);
          this.solid[i] = this.cellSolid(cx, cy, cz);
          if (this.vol[i] > 0 && (this.solid[i] || (this.fl[i] && data[this.voxBase(cx, cy, cz)] !== LAVA_ID))) {
            this.vol[i] = 0;                                   // carved away (or buried in rubble)
            if (this.fl[i]) { this.fl[i] = 0; this.all.delete(i); }
          }
          for (let k = 0; k < 3; k++) { this.F[k * this.n + i] = 0; }
          this.wakeAround(i);
        }
  }

  // ---- hydrostatic head of a cell: the surface height (in cells) of the column it belongs to.
  // A cell with lava above it shares its head, so the pressure at the bottom of a deep pool reaches sideways openings.
  headOf(i, T) {
    if (this.headT[i] === T) return this.head[i];
    const { vol, solid, gx, gy, n } = this;
    let j = i, y = ((i / gx) | 0) % gy;
    while (y + 1 < gy && !solid[j + gx] && vol[j + gx] >= SHOW) { j += gx; y++; }
    const h = y + vol[j];
    this.head[i] = h; this.headT[i] = T;
    return h;
  }

  // ---- one simulation tick
  step() {
    const T = ++this.tick;
    const { vol, solid, F, S, mark, out, inn, gx, gxy, n, cap } = this;
    const stride = [1, gx, gxy];

    // sources: each is a (2w+1)^2 nozzle pouring volume into the first cell with room above it
    for (const s of this.sources) {
      const w = this.width;
      for (let dz = -w; dz <= w; dz++) for (let dx = -w; dx <= w; dx++) {
        for (let up = 0; up <= 8; up++) {
          const x = s.cx + dx, y = s.cy + up, z = s.cz + dz;
          if (!this.inGrid(x, y, z)) break;
          const i = this.idx(x, y, z);
          if (!solid[i] && vol[i] + this.sourceRate <= cap) { this.addVolume(i, this.sourceRate); break; }
        }
      }
    }

    // wake list from last tick (+ anything poured in since)
    const cur = this.awake; this.awake = this.next; this.next = cur; this.next.clear();
    const act = this.awake;
    if (!act.size) return;

    // 1. collect the faces touching awake lava cells (each face once)
    const faces = this._faces; faces.length = 0;
    for (const i of act) {
      if (vol[i] <= EPS) continue;
      const cx = i % gx, cy = ((i / gx) | 0) % this.gy, cz = (i / gxy) | 0;
      for (let d = 0; d < 6; d++) {
        const ax = d >> 1, pos = !(d & 1);
        const c = ax === 0 ? cx : ax === 1 ? cy : cz;
        const lim = ax === 0 ? gx : ax === 1 ? this.gy : this.gz;
        if (pos ? c + 1 >= lim : c - 1 < 0) continue;
        const j = pos ? i + stride[ax] : i - stride[ax];
        if (solid[j]) continue;
        const lo = pos ? i : j, key = ax * n + lo;
        if (mark[key] === T) continue;
        mark[key] = T;
        faces.push(key);
      }
    }

    // 2. accelerate every face's flux
    const nf = faces.length;
    const raw = this._raw || (this._raw = []);
    const touched = this._touched; touched.length = 0;
    for (let k = 0; k < nf; k++) {
      const key = faces[k], ax = (key / n) | 0, lo = key - ax * n, hi = lo + stride[ax];
      let f = S[key] === T - 1 ? F[key] : 0;
      const d = this.headOf(lo, T) - this.headOf(hi, T);    // > 0 pushes lo -> hi
      if (ax === 1) {                                        // vertical: pressure + gravity (lo is the cell below)
        f += this.kP * d;
        if (vol[hi] > EPS && vol[lo] < 1) f -= this.g;        // gravity only while the cell below has room
      } else {                                               // sideways: only beyond the yield threshold
        const m = Math.abs(d) - this.yieldH;
        if (m > 0) f += this.kL * (d > 0 ? m : -m);
      }
      f *= this.damp;
      raw[k] = f;
      if (f > 0) { out[lo] += f; inn[hi] += f; } else if (f < 0) { out[hi] -= f; inn[lo] -= f; }
      touched.push(lo, hi);
    }

    // 3. limit: no cell gives more than it has, none takes more than it has room for
    for (let k = 0; k < nf; k++) {
      const key = faces[k], ax = (key / n) | 0, lo = key - ax * n, hi = lo + stride[ax];
      let f = raw[k];
      if (f > 0) {
        let s = out[lo] > vol[lo] ? vol[lo] / out[lo] : 1;
        const room = Math.max(0, cap - vol[hi]); if (inn[hi] > room) s = Math.min(s, room / inn[hi]);
        f *= s;
      } else if (f < 0) {
        let s = out[hi] > vol[hi] ? vol[hi] / out[hi] : 1;
        const room = Math.max(0, cap - vol[lo]); if (inn[lo] > room) s = Math.min(s, room / inn[lo]);
        f *= s;
      }
      if (f > -FLUX_EPS && f < FLUX_EPS) f = 0;
      raw[k] = f;
    }
    for (let k = 0; k < touched.length; k++) { out[touched[k]] = 0; inn[touched[k]] = 0; }   // reset scratch

    // 4. move the volume
    const changed = this._changed || (this._changed = []);
    changed.length = 0;
    for (let k = 0; k < nf; k++) {
      const key = faces[k], f = raw[k];
      F[key] = f; S[key] = T;
      if (f === 0) continue;
      const ax = (key / n) | 0, lo = key - ax * n, hi = lo + stride[ax];
      vol[lo] -= f; vol[hi] += f;
      changed.push(lo, hi);
    }

    // 5. clean up dust, redraw what changed, wake the neighbourhood of anything that moved
    for (let k = 0; k < changed.length; k++) {
      const i = changed[k];
      if (vol[i] < EPS) vol[i] = 0;
      this.wakeAround(i);
      this.refreshWithBelow(i);                             // the cell below may now be capped by lava (draws full)
    }
  }

  // voxel box changed since the last call (or null). Refreshes coarse bricks; caller uploads to the GPU.
  flush() {
    const d = this.dirty;
    if (!d) return null;
    this.dirty = null;
    refreshCoarse(this.world, d);
    return d;
  }
}