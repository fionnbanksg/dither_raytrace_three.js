// Ballistic projectiles: gravity (bullet drop), swept collision against the voxel grid, detonation on impact.
//
// No DOM / WebGL in here. Everything is in voxel units and seconds. The caller supplies:
//   onImpact({ point, normal, radiusM, big })   called when a projectile hits something (or times out)
//   onTrail(x, y, z, big)                       called every few voxels along the flight path
// Rendering is done by main.js: cubes() hands back the projectiles as glowing voxel cubes.

import { raycastVoxels } from './destruction.js';

const TRAIL_SPACING = 4;     // voxels between trail puffs
const MAX_LIFE = 6;          // seconds before an airburst

export class Projectiles {
  constructor(world, { onImpact, onTrail }) {
    this.world = world;
    this.onImpact = onImpact;
    this.onTrail = onTrail;
    this.list = [];
  }

  // pos: voxels. vel: voxels/s. gravity: voxels/s^2 (positive = down)
  spawn(pos, vel, { gravity, radiusM, big = false }) {
    this.list.push({
      x: pos[0], y: pos[1], z: pos[2], px: pos[0], py: pos[1], pz: pos[2],
      vx: vel[0], vy: vel[1], vz: vel[2], g: gravity, radiusM, big,
      age: 0, trailAcc: 0, seed: Math.random(),
    });
  }

  update(dt) {
    const { world, list } = this;
    const sx = world.size.x, sy = world.size.y, sz = world.size.z;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.vy -= p.g * dt;                                    // bullet drop

      const dx = p.vx * dt, dy = p.vy * dt, dz = p.vz * dt;
      const len = Math.hypot(dx, dy, dz);
      const dir = [dx / len, dy / len, dz / len];

      // swept test: the whole step is cast as a ray, so fast shots can't tunnel through thin walls
      const hit = raycastVoxels(world, [p.x, p.y, p.z], dir, len);
      const travel = hit ? hit.t : len;

      // flame / smoke trail along the path actually flown
      p.trailAcc += travel;
      while (p.trailAcc >= TRAIL_SPACING) {
        p.trailAcc -= TRAIL_SPACING;
        const back = p.trailAcc;                           // puffs sit on the path, newest nearest the head
        this.onTrail(p.x + dir[0] * (travel - back), p.y + dir[1] * (travel - back), p.z + dir[2] * (travel - back), p.big);
      }

      if (hit) {
        let n = hit.normal;
        if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = [-dir[0], -dir[1], -dir[2]];   // started inside stone: face back along the shot
        list.splice(i, 1);
        this.onImpact({ point: hit.point, normal: n, radiusM: p.radiusM, big: p.big });
        continue;
      }

      p.x += dx; p.y += dy; p.z += dz;

      const outside = p.x < 0 || p.y < 0 || p.z < 0 || p.x >= sx || p.z >= sz;
      if (outside) { list.splice(i, 1); continue; }
      if (p.age > MAX_LIFE) {                              // never hit anything: airburst
        list.splice(i, 1);
        this.onImpact({ point: [p.x, p.y, p.z], normal: [0, 0, 0], radiusM: p.radiusM, big: p.big });
      }
    }
  }

  // projectiles as particle cubes (interpolated between physics ticks), for Particles.pack(extras)
  cubes(alpha, out = []) {
    out.length = 0;
    for (const p of this.list) {
      const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha, z = p.pz + (p.z - p.pz) * alpha;
      const edge = p.big ? 3 : 2, half = edge / 2;
      out.push({
        x: Math.round(x - half) + half, y: Math.round(y - half) + half, z: Math.round(z - half) + half, half,
        ar: 0.12, ag: 0.11, ab: 0.10, alpha: 1,
        er: 2.2, eg: 1.5, eb: 0.55, seed: p.seed,          // white-hot core
      });
    }
    return out;
  }

  // positions for the projectile glow lights
  interpolated(alpha, i) {
    const p = this.list[i];
    return [p.px + (p.x - p.px) * alpha, p.py + (p.y - p.py) * alpha, p.pz + (p.z - p.pz) * alpha];
  }
}
