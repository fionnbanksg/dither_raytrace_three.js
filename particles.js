// Explosion particles as voxel cubes: fireball, embers, smoke and stone debris.
//
// CPU side only (no DOM / WebGL). Everything is in voxel units. Every particle is an axis-aligned
// cube whose edges are snapped to the world's voxel lattice, so it looks like part of the world.
// Each frame `pack()` writes the live cubes into a Float32Array that main.js uploads as a
// 3 x MAX_PARTICLES RGBA32F texture; the raytracer shader intersects them as boxes.
//
// Texel layout per particle (3 texels, RGBA each):
//   0: x, y, z (cube centre), half-size
//   1: albedo r, g, b, opacity   (opacity is applied per voxel cell: cells dissolve one by one)
//   2: emissive r, g, b, seed    (emissive = fire colour from temperature; seed = per-particle random)

import { PALETTE } from './world.js';

export const MAX_PARTICLES = 768;
export const TEXELS = 3;

const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
function unit(out) {            // uniform random direction
  const z = rnd(-1, 1), t = rnd(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
  out[0] = r * Math.cos(t); out[1] = z; out[2] = r * Math.sin(t);
  return out;
}

// temperature (0..1) -> emissive colour: dark ember -> red -> orange -> yellow-white core
const EMBER = [0.22, 0.035, 0.01], RED = [0.85, 0.14, 0.03], ORANGE = [1.0, 0.45, 0.08], HOT = [1.0, 0.92, 0.62];
function fireColour(h, out) {
  if (h <= 0.02) { out[0] = out[1] = out[2] = 0; return out; }
  const a = sstep(0.1, 0.45, h), b = sstep(0.45, 0.8, h), c = sstep(0.8, 1.0, h);
  const k = 0.2 + 1.9 * Math.pow(h, 1.15);
  for (let i = 0; i < 3; i++) {
    let v = mix(EMBER[i], RED[i], a);
    v = mix(v, ORANGE[i], b);
    v = mix(v, HOT[i], c);
    out[i] = v * k;
  }
  return out;
}

const SMOKE = [0.11, 0.10, 0.095];

export class Particles {
  // solid(x, y, z) -> bool in voxel space; m2v = voxels per metre
  constructor(solid, m2v) {
    this.solid = solid;
    this.m2v = m2v;
    this.list = [];
    this.data = new Float32Array(MAX_PARTICLES * TEXELS * 4);
    this.packed = 0;                         // cubes written by the last pack()
    this.bound = [0, 0, 0, 0];               // bounding sphere (x, y, z, r) of the packed cubes
    this._v = [0, 0, 0];
    this._c = [0, 0, 0];
    this._pending = [];
  }

  get count() { return this.list.length; }

  _add(p) {
    if (this.list.length >= MAX_PARTICLES) this.list.shift();   // drop the oldest
    this.list.push(p);
  }

  // center: voxels, normal: surface normal the blast opened out of (biases the spray),
  // scale: 1 = normal blast, bigger for the right-click one, debris: [{x,y,z,id}] carved voxel samples
  burst(center, normal, scale, debris = []) {
    const M = this.m2v, v = this._v;
    const [cx, cy, cz] = center;
    const sq = Math.sqrt(scale);
    const F = 1.2 * M * scale;                // fireball radius, voxels
    const bias = (dir, k) => {                // lean a random direction toward the wall normal
      dir[0] += normal[0] * k; dir[1] += normal[1] * k; dir[2] += normal[2] * k;
      const l = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      dir[0] /= l; dir[1] /= l; dir[2] /= l;
      return dir;
    };

    // fireball: a swarm of hot cubes thrown outward that rise, cool and shrink
    const nFire = Math.round(55 + 45 * scale);
    for (let i = 0; i < nFire; i++) {
      unit(v); bias(v, 0.45);
      const near = Math.random();             // cubes spawned near the middle start hotter
      const o = F * 0.35 * near;
      const sp = F * rnd(0.6, 3.0);
      const fl = rnd(0.45, 0.95);
      this._add({
        kind: 'fire', x: cx + v[0] * o, y: cy + v[1] * o, z: cz + v[2] * o,
        vx: v[0] * sp, vy: v[1] * sp + 0.25 * M, vz: v[2] * sp,
        size0: rnd(3, 7) * sq, grow: 0.4,
        fl, life: fl + rnd(0.5, 1.1), age: 0, heat0: mix(0.75, 1.0, 1 - near * 0.6) * rnd(0.9, 1),
        drag: 2.5, grav: -3.0 * M, bounce: 0, shade: rnd(0.7, 1.2), seed: Math.random(),
      });
    }

    // embers: single hot voxels that arc, bounce and glow out
    const nSpark = Math.round(30 + 22 * scale);
    for (let i = 0; i < nSpark; i++) {
      unit(v); bias(v, 0.7);
      const sp = rnd(3, 11) * M * sq;
      const fl = rnd(0.5, 1.4);
      this._add({
        kind: 'spark', x: cx, y: cy, z: cz,
        vx: v[0] * sp, vy: v[1] * sp, vz: v[2] * sp,
        size0: 1, grow: 0, fl, life: fl + 0.25, age: 0, heat0: 1,
        drag: 0.5, grav: 9.8 * M, bounce: 0.45, shade: 1, seed: Math.random(),
      });
    }

    // smoke: a drifting cloud of many small dark cubes that rise fast, swirl, spread and dissolve
    const nSmoke = Math.round(34 + 22 * scale);
    for (let i = 0; i < nSmoke; i++) {
      unit(v); bias(v, 0.5);
      const sp = F * rnd(0.7, 2.6);
      this._add({
        kind: 'smoke', x: cx + v[0] * F * 0.3, y: cy + v[1] * F * 0.3, z: cz + v[2] * F * 0.3,
        vx: v[0] * sp, vy: v[1] * sp + 0.5 * M, vz: v[2] * sp,
        size0: rnd(2, 6) * sq, grow: rnd(0.6, 1.4), fl: 0, life: rnd(1.3, 2.6), age: 0, heat0: 0, alpha0: 0.38,
        drag: 0.9, grav: -2.6 * M, turb: 9 * M, bounce: 0, shade: rnd(0.7, 1.3), seed: Math.random(),
      });
    }

    // debris: chunks cut from the actual crater, coloured by material; some burn and leave a trail
    for (const d of debris) {
      unit(v); bias(v, 0.6);
      const sp = rnd(2.5, 8) * M * sq;
      const fl = rnd(0.5, 1.6);
      this._add({
        kind: 'debris', x: d.x, y: d.y, z: d.z,
        vx: v[0] * sp, vy: v[1] * sp + 1.5 * M, vz: v[2] * sp,
        size0: Math.random() < 0.3 ? 3 : (Math.random() < 0.5 ? 2 : 1), grow: 0,
        fl, life: rnd(2.0, 3.6), age: 0, heat0: rnd(0.6, 1.0),
        drag: 0.15, grav: 9.8 * M, bounce: 0.35, shade: 0.8, col: PALETTE[d.id] ?? [0.5, 0.5, 0.5],
        trail: Math.random() < 0.4, trailT: 0, seed: Math.random(),
      });
    }
  }

  update(dt) {
    const solid = this.solid;
    const L = this.list;
    const pending = this._pending;
    pending.length = 0;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.age += dt;
      if (p.age >= p.life) { L.splice(i, 1); continue; }

      // integrate with per-axis collision against the voxel grid
      const dr = Math.exp(-p.drag * dt);
      if (p.turb) { p.vx += rnd(-1, 1) * p.turb * dt; p.vy += rnd(-0.5, 1) * p.turb * dt; p.vz += rnd(-1, 1) * p.turb * dt; }
      p.vx *= dr; p.vz *= dr; p.vy = p.vy * dr - p.grav * dt;
      const sub = 2, h = dt / sub;               // two sub-steps so fast embers don't tunnel thin walls
      for (let s = 0; s < sub; s++) {
        let nx = p.x + p.vx * h;
        if (solid(nx, p.y, p.z)) { p.vx *= -p.bounce; nx = p.x; }
        p.x = nx;
        let ny = p.y + p.vy * h;
        if (solid(p.x, ny, p.z)) { p.vy *= -p.bounce; ny = p.y; p.vx *= 0.8; p.vz *= 0.8; }
        p.y = ny;
        let nz = p.z + p.vz * h;
        if (solid(p.x, p.y, nz)) { p.vz *= -p.bounce; nz = p.z; }
        p.z = nz;
      }

      // burning debris sheds little flames
      if (p.trail && p.age < p.fl) {
        p.trailT -= dt;
        if (p.trailT <= 0) {
          p.trailT = rnd(0.03, 0.06);
          const fl = rnd(0.18, 0.32);
          pending.push({
            kind: 'fire', x: p.x, y: p.y, z: p.z, vx: p.vx * 0.1, vy: 10 + Math.random() * 14, vz: p.vz * 0.1,
            size0: rnd(1.5, 3), grow: 0, fl, life: fl + rnd(0.2, 0.5), age: 0, heat0: 0.85 * (1 - p.age / p.fl),
            drag: 2, grav: -2.5 * this.m2v, bounce: 0, shade: 1, seed: Math.random(),
          });
        }
      }
    }
    for (const q of pending) this._add(q);
  }

  // write live cubes into this.data (snapped to the voxel lattice) and compute the bounding sphere
  pack() {
    const D = this.data, em = this._c;
    let n = 0;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;

    for (const p of this.list) {
      const t = p.age / p.life;
      const heat = p.fl > 0 ? p.heat0 * Math.pow(Math.max(0, 1 - p.age / p.fl), 1.3) : 0;

      let size, alpha, ar, ag, ab;
      switch (p.kind) {
        case 'fire': {
          size = p.size0 * (0.45 + 0.55 * heat) * (1 + p.grow * t);
          if (p.age < p.fl) alpha = 0.42 + 0.58 * heat;
          else alpha = 0.42 * (1 - Math.pow((p.age - p.fl) / (p.life - p.fl), 1.4));   // burnt out: fades like smoke
          ar = ag = ab = SMOKE[0] * 0.5 * p.shade;
          break;
        }
        case 'smoke': {
          size = p.size0 * (1 + p.grow * t);
          alpha = p.alpha0 * Math.min(1, p.age * 8) * (1 - Math.pow(t, 1.4));
          ar = SMOKE[0] * p.shade; ag = SMOKE[1] * p.shade; ab = SMOKE[2] * p.shade;
          break;
        }
        case 'spark': {
          size = 1;
          alpha = 1 - sstep(0.8, 1, t);
          ar = ag = ab = 0.02;
          break;
        }
        default: {   // debris
          size = p.size0;
          alpha = 1 - sstep(0.85, 1, t);
          ar = p.col[0] * p.shade; ag = p.col[1] * p.shade; ab = p.col[2] * p.shade;
        }
      }
      if (alpha <= 0.01) continue;

      const edge = Math.max(1, Math.round(size));             // whole voxels only
      const half = edge / 2;
      const mx = Math.round(p.x - half), my = Math.round(p.y - half), mz = Math.round(p.z - half);   // lattice-snapped min corner
      fireColour(heat, em);

      const o = n * TEXELS * 4;
      D[o] = mx + half; D[o + 1] = my + half; D[o + 2] = mz + half; D[o + 3] = half;
      D[o + 4] = ar; D[o + 5] = ag; D[o + 6] = ab; D[o + 7] = alpha;
      D[o + 8] = em[0]; D[o + 9] = em[1]; D[o + 10] = em[2]; D[o + 11] = p.seed;
      n++;

      if (mx < x0) x0 = mx; if (my < y0) y0 = my; if (mz < z0) z0 = mz;
      if (mx + edge > x1) x1 = mx + edge; if (my + edge > y1) y1 = my + edge; if (mz + edge > z1) z1 = mz + edge;
    }
    this.packed = n;
    if (n === 0) { this.bound[3] = 0; return; }
    this.bound[0] = (x0 + x1) / 2; this.bound[1] = (y0 + y1) / 2; this.bound[2] = (z0 + z1) / 2;
    this.bound[3] = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 1;
  }
}
