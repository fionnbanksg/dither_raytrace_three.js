// Clipmap LOD for the voxel world. The world is a pure function F(level, x, y, z); only a window around the
// player is materialised per level. Level L has voxels of 2^L level-0 voxels, every level has the same cell
// dimensions, so memory is constant however big the world is.  Windows are toroidal: scrolling only generates
// the newly exposed slabs. Edits (level 0) live in a sparse brick map and are re-applied when terrain streams in.
//
// Coordinates: "world voxels" = level-0 voxel units. "cells" = units of one level's own voxels.
import { vnoise } from './world.js';

export const BRICK_E = 8;                        // edit-map brick edge (level-0 voxels)

// ---------------------------------------------------------------- generator (placeholder terrain, replace in stage 3)
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fbm2 = (x, z, s) => 0.6 * vnoise(x, 0, z, s) + 0.3 * vnoise(x * 2.3, 0, z * 2.3, s + 7) + 0.1 * vnoise(x * 5.1, 0, z * 5.1, s + 13);

export function makeGenerator(seed = 1337) {
  // ground height in level-0 voxels at a world position
  const groundH = (x, z) => {
    const plains = 6 + 14 * fbm2(x / 260, z / 260, seed);
    const ridge = 1 - Math.abs(2 * vnoise(x / 700, 0, z / 700, seed + 1) - 1);          // ridged noise: sharp crests
    const mask = smooth(0.42, 0.72, vnoise(x / 1500, 0, z / 1500, seed + 2));          // where mountains exist
    const peaks = Math.pow(ridge, 2.2) * (260 + 90 * vnoise(x / 300, 0, z / 300, seed + 3));
    return plains + mask * peaks;
  };
  return {
    groundH,
    // per-column terrain: out.hc = top solid cell (of `level`), out.top = material of that top cell, below it is stone (1).
    // Stage 3 adds a sparse 3D override pass (tunnels / dungeon / props) on top of this fast path.
    column(level, x, z, out) {
      const s = 1 << level, h = groundH((x + 0.5) * s, (z + 0.5) * s);
      out.hc = Math.floor(h / s);
      out.top = h > 150 ? 1 : 2;                                                      // bare rock up high, grass below
    },
  };
}

// ---------------------------------------------------------------- one level window
const mod = (a, n) => ((a % n) + n) % n;
const snap = (v, c) => Math.floor(v / c) * c;

export class ClipLevel {
  constructor(level, dims, chunk, gen, edits) {
    this.level = level; this.s = 1 << level;
    this.NX = dims.x; this.NY = dims.y; this.NZ = dims.z; this.chunk = chunk;
    this.gen = gen; this.edits = edits;
    this.data = new Uint8Array(dims.x * dims.y * dims.z);
    this.o = null;                                   // window origin in cells (multiple of chunk)
    const cols = dims.x * dims.z;                    // per-column terrain cache, validated by its (x,z) key
    this.kx = new Int32Array(cols).fill(0x7fffffff); this.kz = new Int32Array(cols); this.hcs = new Int32Array(cols); this.tps = new Uint8Array(cols);
  }
  idx(x, y, z) { return mod(x, this.NX) + this.NX * (mod(y, this.NY) + this.NY * mod(z, this.NZ)); }
  inside(x, y, z) {
    const o = this.o;
    return x >= o.x && y >= o.y && z >= o.z && x < o.x + this.NX && y < o.y + this.NY && z < o.z + this.NZ;
  }
  get(x, y, z) { return this.inside(x, y, z) ? this.data[this.idx(x, y, z)] : 0; }

  // (re)generate one box of cells: every cell is written once (air above the column top), then edits are re-applied.
  // Column heights are cached per (x,z) so sliding the window vertically never re-runs the terrain noise.
  fillBox(b) {
    const { data, NX, NY, NZ, kx, kz, hcs, tps } = this, out = { hc: 0, top: 0 }, y0m = mod(b.y0, NY);
    for (let z = b.z0; z < b.z1; z++) for (let x = b.x0; x < b.x1; x++) {
      const mx = mod(x, NX), mz = mod(z, NZ), ci = mx + NX * mz;
      if (kx[ci] !== x || kz[ci] !== z) { this.gen.column(this.level, x, z, out); kx[ci] = x; kz[ci] = z; hcs[ci] = out.hc; tps[ci] = out.top; }
      const hc = hcs[ci], top = tps[ci], base = mx + NX * NY * mz;
      let iy = y0m;
      for (let y = b.y0; y < b.y1; y++) { data[base + NX * iy] = y > hc ? 0 : y === hc ? top : 1; if (++iy === NY) iy = 0; }
    }
    if (this.level === 0 && this.edits.size) this.applyEdits(b);
  }
  applyEdits(b) {
    const E = BRICK_E;
    for (const [key, arr] of this.edits) {
      const [bx, by, bz] = key.split(',').map(Number);
      const x0 = bx * E, y0 = by * E, z0 = bz * E;
      if (x0 + E <= b.x0 || x0 >= b.x1 || y0 + E <= b.y0 || y0 >= b.y1 || z0 + E <= b.z0 || z0 >= b.z1) continue;
      for (let i = 0; i < E * E * E; i++) {
        const v = arr[i]; if (!v) continue;
        const x = x0 + (i & 7), y = y0 + ((i >> 3) & 7), z = z0 + (i >> 6);
        if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && z >= b.z0 && z < b.z1) this.data[this.idx(x, y, z)] = v - 1;
      }
    }
  }

  // centre in world voxels. Returns the list of cell boxes that were regenerated (for GPU upload).
  update(cx, cy, cz) {
    const s = this.s, c = this.chunk;
    const n = {
      x: snap(Math.floor(cx / s) - (this.NX >> 1), c),
      y: snap(Math.floor(cy / s) - (this.NY >> 1), c),
      z: snap(Math.floor(cz / s) - (this.NZ >> 1), c),
    };
    const full = { x0: n.x, x1: n.x + this.NX, y0: n.y, y1: n.y + this.NY, z0: n.z, z1: n.z + this.NZ };
    if (!this.o) { this.o = n; this.fillBox(full); return [full]; }
    const o = this.o;
    if (n.x === o.x && n.y === o.y && n.z === o.z) return [];
    const dx = n.x - o.x, dy = n.y - o.y, dz = n.z - o.z;
    this.o = n;
    if (Math.abs(dx) >= this.NX || Math.abs(dy) >= this.NY || Math.abs(dz) >= this.NZ) { this.fillBox(full); return [full]; }
    const boxes = [];
    const cur = { ...full };                          // shrinks to the overlap after each axis slab is taken out
    const slab = (ax, d, N, oAx) => {                 // newly exposed range along one axis
      if (!d) return;
      const lo = d > 0 ? oAx + N : n[ax], hi = d > 0 ? n[ax] + N : oAx;
      const b = { ...cur }; b[ax + '0'] = lo; b[ax + '1'] = hi;
      this.fillBox(b); boxes.push(b);
      cur[ax + '0'] = Math.max(n[ax], oAx); cur[ax + '1'] = Math.min(n[ax], oAx) + N;
    };
    slab('x', dx, this.NX, o.x); slab('y', dy, this.NY, o.y); slab('z', dz, this.NZ, o.z);
    return boxes;
  }

  // split a cell box into up to 8 contiguous storage boxes (for partial GPU uploads of the wrapped texture)
  storageBoxes(b) {
    const cut = (lo, hi, N) => {
      const a = mod(lo, N), len = hi - lo;
      return a + len <= N ? [[a, len, lo]] : [[a, N - a, lo], [0, len - (N - a), lo + (N - a)]];
    };
    const out = [];
    for (const X of cut(b.x0, b.x1, this.NX)) for (const Y of cut(b.y0, b.y1, this.NY)) for (const Z of cut(b.z0, b.z1, this.NZ))
      out.push({ sx: X[0], sy: Y[0], sz: Z[0], w: X[1], h: Y[1], d: Z[1], cx: X[2], cy: Y[2], cz: Z[2] });
    return out;
  }
}

// ---------------------------------------------------------------- the whole clipmap
export class Clipmap {
  constructor({ levels = 5, dims = { x: 384, y: 96, z: 384 }, chunk = 16, seed = 1337 } = {}) {
    this.gen = makeGenerator(seed);
    this.edits = new Map();                           // "bx,by,bz" -> Uint8Array(512), 0 = untouched, else id + 1
    this.levels = Array.from({ length: levels }, (_, l) => new ClipLevel(l, dims, chunk, this.gen, this.edits));
    this.bytes = levels * dims.x * dims.y * dims.z;
  }
  // returns [{level, boxes}] for every level that changed (empty array when nothing scrolled)
  update(px, py, pz) {
    const out = [];
    for (const L of this.levels) { const boxes = L.update(px, py, pz); if (boxes.length) out.push({ level: L.level, boxes }); }
    return out;
  }
  getVoxel(x, y, z) { return this.levels[0].get(x, y, z); }
  // world-voxel edit: lands in the level-0 window and the persistent edit map. Returns the 1x1x1 dirty box or null.
  setVoxel(x, y, z, id) {
    const L0 = this.levels[0];
    const E = BRICK_E, key = `${Math.floor(x / E)},${Math.floor(y / E)},${Math.floor(z / E)}`;
    let arr = this.edits.get(key);
    if (!arr) this.edits.set(key, arr = new Uint8Array(E * E * E));
    arr[mod(x, E) + E * (mod(y, E) + E * mod(z, E))] = id + 1;
    if (!L0.inside(x, y, z)) return null;
    L0.data[L0.idx(x, y, z)] = id;
    return { x0: x, x1: x + 1, y0: y, y1: y + 1, z0: z, z1: z + 1 };
  }
}