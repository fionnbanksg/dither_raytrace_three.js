// Lava gun, STAGE 1: a stream of ballistic lava droplets that feed the existing LavaSim.
//
// No DOM / WebGL in here (same rule as projectiles.js / lava.js). Units are voxels and seconds.
//
//   droplets  fly with gravity + a swept voxel raycast (like projectiles.js), drawn as glowing 2-voxel cubes
//   on impact the droplet is handed to lava.splat(), so it becomes a normal lava cell and the
//             existing cellular automaton makes it run, pool and settle
//
// STAGE 2 (later): give droplets cohesion / neighbour pressure so the stream clumps and wobbles like a
// liquid in flight (cheap SPH-lite), and let `splat` carry momentum so streams ride up/down slopes.

import { raycastVoxels } from './destruction.js';

const MAX_DROPLETS = 160;     // also the cap on cubes this adds to the particle texture
const MAX_LAVA_CELLS = 9000;  // stop depositing past this so a held trigger can't bog the sim down
const MAX_LIFE = 3;           // seconds before a droplet that never hit anything is dropped

export class LavaGun {
  constructor(world, lava, { rate = 90, speed = 30, spread = 0.025, gravity = 7 } = {}) {
    this.world = world;
    this.lava = lava;
    this.rate = rate;           // droplets per second while firing
    this.speed = speed;         // voxels/s (caller converts from metres)
    this.spread = spread;       // random cone half-angle (radians)
    this.gravity = gravity;     // voxels/s^2, positive = down
    this.list = [];
    this.acc = 0;
    this._cubes = [];
    this.onSplat = null;        // optional: ({ point }) => void  (sparks / sound later)
  }

  get count() { return this.list.length; }

  // pos: muzzle (voxels), dir: unit aim vector, inherit: [vx,vy,vz] shooter velocity in voxels/s
  emit(dt, pos, dir, inherit = [0, 0, 0]) {
    this.acc += this.rate * dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      if (this.list.length >= MAX_DROPLETS) { this.list.shift(); }
      // jitter the direction inside a small cone around `dir`
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * this.spread;
      const jx = Math.cos(a) * r, jy = Math.sin(a) * r;
      // any two axes perpendicular to dir
      const up = Math.abs(dir[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
      let ux = dir[1] * up[2] - dir[2] * up[1], uy = dir[2] * up[0] - dir[0] * up[2], uz = dir[0] * up[1] - dir[1] * up[0];
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = dir[1] * uz - dir[2] * uy, vy = dir[2] * ux - dir[0] * uz, vz = dir[0] * uy - dir[1] * ux;
      let dx = dir[0] + ux * jx + vx * jy, dy = dir[1] + uy * jx + vy * jy, dz = dir[2] + uz * jx + vz * jy;
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      const sp = this.speed * (0.92 + Math.random() * 0.16);
      // spawn a random fraction of one frame ahead so a 60 fps trigger doesn't make visible "beads"
      const lead = Math.random() * dt * sp;
      this.list.push({
        x: pos[0] + dx * lead, y: pos[1] + dy * lead, z: pos[2] + dz * lead,
        px: pos[0], py: pos[1], pz: pos[2],
        vx: dx * sp + inherit[0], vy: dy * sp + inherit[1], vz: dz * sp + inherit[2],
        age: 0, seed: Math.random(),
      });
    }
  }

  update(dt) {
    const { world, list } = this;
    const sx = world.size.x, sy = world.size.y, sz = world.size.z;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.vy -= this.gravity * dt;

      const dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      const dir = [dx / len, dy / len, dz / len];

      const hit = raycastVoxels(world, [p.x, p.y, p.z], dir, len);
      if (hit) {
        list.splice(i, 1);
        let n = hit.normal;
        if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = [0, 1, 0];       // started inside something: pop upward
        if (this.lava.count < MAX_LAVA_CELLS) this.lava.splat(hit.point, n);
        this.onSplat?.({ point: hit.point, normal: n });
        continue;
      }
      p.x += dx; p.y += dy; p.z += dz;
      if (p.x < 0 || p.y < 0 || p.z < 0 || p.x >= sx || p.z >= sz || p.age > MAX_LIFE) list.splice(i, 1);
    }
  }

  // droplets as particle cubes for Particles.pack(extras), interpolated between physics ticks
  cubes(alpha, out = this._cubes) {
    out.length = 0;
    for (const p of this.list) {
      const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha, z = p.pz + (p.z - p.pz) * alpha;
      const cool = Math.min(1, p.age / 1.4);                 // white-hot at the nozzle, orange by the time it lands
      out.push({
        x: Math.round(x - 1) + 1, y: Math.round(y - 1) + 1, z: Math.round(z - 1) + 1, half: 1,   // 2^3 voxels, on the lattice
        ar: 0.16, ag: 0.05, ab: 0.02, alpha: 1,
        er: 2.0 - 0.5 * cool, eg: 1.15 - 0.45 * cool, eb: 0.40 - 0.28 * cool, seed: p.seed,
      });
    }
    return out;
  }

  // rough centre of the stream, for a travelling glow light (or null)
  centroid(alpha) {
    const n = this.list.length;
    if (!n) return null;
    let x = 0, y = 0, z = 0;
    for (const p of this.list) { x += p.x; y += p.y; z += p.z; }
    return [x / n, y / n, z / n];
  }
}