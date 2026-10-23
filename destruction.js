// Terrain destruction: carve craters out of the voxel grid, char the surviving surface,
// scatter a little rubble, and keep the coarse occupancy grid in sync.
//
// Like physics.js and player.js this has no DOM / WebGL in it, so the same code can run on a
// server. Everything here works in *voxel* units. The caller is responsible for pushing the
// returned box to the GPU (main.js) and to the collision world (physics.updateRegion).

import { T, BRICK, vnoise } from './world.js';

const S = T / 16;
const SCORCH_ID = 7;
// scorchable ids: 1..5 = stone, grass, floor, wood, brick (not 6 flame, not 7 soot)
const MARGIN = 6;                              // voxels at the world edge that can never be destroyed

// ---------------------------------------------------------------- CPU voxel raycast
// Amanatides & Woo DDA. dir must be normalised. Returns null or { t, cell, normal, point }.
export function raycastVoxels(world, origin, dir, maxDist = 400) {
  const { data, size } = world;
  const sx = size.x, sy = size.y, sz = size.z;
  let x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
  const stepX = Math.sign(dir[0]) || 1, stepY = Math.sign(dir[1]) || 1, stepZ = Math.sign(dir[2]) || 1;
  const inv = (d) => (Math.abs(d) < 1e-9 ? Infinity : 1 / Math.abs(d));
  const dX = inv(dir[0]), dY = inv(dir[1]), dZ = inv(dir[2]);
  const first = (o, c, s, d) => (d === Infinity ? Infinity : ((s > 0 ? c + 1 - o : o - c) * d));
  let tX = first(origin[0], x, stepX, dX), tY = first(origin[1], y, stepY, dY), tZ = first(origin[2], z, stepZ, dZ);
  let t = 0, nx = 0, ny = 0, nz = 0;

  while (t <= maxDist) {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null;
    if (data[x + sx * (y + sy * z)] !== 0) {
      return {
        t, cell: [x, y, z], normal: [nx, ny, nz],
        point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      };
    }
    if (tX <= tY && tX <= tZ) { x += stepX; t = tX; tX += dX; nx = -stepX; ny = 0; nz = 0; }
    else if (tY <= tZ)        { y += stepY; t = tY; tY += dY; nx = 0; ny = -stepY; nz = 0; }
    else                      { z += stepZ; t = tZ; tZ += dZ; nx = 0; ny = 0; nz = -stepZ; }
  }
  return null;
}

// ---------------------------------------------------------------- coarse occupancy
// Recompute the 8^3 bricks overlapping a voxel box (same rule as world.js step 6).
export function refreshCoarse(world, box) {
  const { data, size, coarse, coarseSize } = world;
  const sx = size.x, sy = size.y;
  const b0x = Math.max(0, Math.floor(box.x0 / BRICK)), b1x = Math.min(coarseSize.x - 1, Math.floor((box.x1 - 1) / BRICK));
  const b0y = Math.max(0, Math.floor(box.y0 / BRICK)), b1y = Math.min(coarseSize.y - 1, Math.floor((box.y1 - 1) / BRICK));
  const b0z = Math.max(0, Math.floor(box.z0 / BRICK)), b1z = Math.min(coarseSize.z - 1, Math.floor((box.z1 - 1) / BRICK));
  for (let bz = b0z; bz <= b1z; bz++) for (let by = b0y; by <= b1y; by++) for (let bx = b0x; bx <= b1x; bx++) {
    let any = 0;
    for (let z = bz * BRICK; z < bz * BRICK + BRICK && !any; z++)
      for (let y = by * BRICK; y < by * BRICK + BRICK && !any; y++) {
        let i = bx * BRICK + sx * (y + sy * z);
        for (let x = 0; x < BRICK; x++, i++) if (data[i] !== 0) { any = 1; break; }
      }
    coarse[bx + coarseSize.x * (by + coarseSize.y * bz)] = any;
  }
}

// ---------------------------------------------------------------- explosion
// center: [x, y, z] voxels.  radius: voxels (16 voxels = 1 m at T = 64).
// opts.keepClear: [{ x, y, z, r }] voxel-space spheres that never receive rubble (put the player here
//                 so a new collision cell can't form inside the capsule).
// Returns the voxel box that changed ({x0,y0,z0,x1,y1,z1}, end-exclusive) or null.
export function explode(world, center, radius, opts = {}) {
  const { data, size } = world;
  const sx = size.x, sy = size.y, sz = size.z;
  const seed = opts.seed ?? ((Math.random() * 1e6) | 0);
  const [cx, cy, cz] = center;
  const R = radius;

  const rMax = R * 1.2;                 // crater is a noisy sphere: r in [0.8R, 1.2R]
  const reach = R * 1.5;                // scorch / rubble reach
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(sx, Math.ceil(cx + reach) + 1);
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(sy, Math.ceil(cy + reach) + 1);
  const z0 = Math.max(0, Math.floor(cz - reach)), z1 = Math.min(sz, Math.ceil(cz + reach) + 1);

  const idx = (x, y, z) => x + sx * (y + sy * z);
  const breakable = (x, y, z) =>
    x >= MARGIN && z >= MARGIN && x < sx - MARGIN && z < sz - MARGIN && y >= 1 && y < sy - MARGIN;
  const nf = 0.11;                      // noise frequency (voxels): lumps ~9 voxels across

  // radius field: shared by carve and scorch so the soot hugs the crater wall
  const craterR = (x, y, z) => R * (0.8 + 0.4 * vnoise(x * nf, y * nf, z * nf, seed));

  // 1. carve ------------------------------------------------------------------
  let carved = 0;
  const r2max = rMax * rMax, rIn2 = (R * 0.8) * (R * 0.8);
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2max) continue;
    const i = idx(x, y, z);
    if (data[i] === 0 || !breakable(x, y, z)) continue;
    if (d2 < rIn2) { data[i] = 0; carved++; continue; }      // always inside: skip the noise lookup
    const r = craterR(x, y, z);
    if (d2 < r * r) { data[i] = 0; carved++; }
  }
  if (carved === 0) return null;

  // 2. scorch: surviving surface voxels near the blast turn to soot ----------
  const scorchW = R * 0.3;              // how far past the crater wall the soot reaches
  const reach2 = reach * reach;
  const exposed = (x, y, z) =>
    (x > 0 && data[idx(x - 1, y, z)] === 0) || (x < sx - 1 && data[idx(x + 1, y, z)] === 0) ||
    (y > 0 && data[idx(x, y - 1, z)] === 0) || (y < sy - 1 && data[idx(x, y + 1, z)] === 0) ||
    (z > 0 && data[idx(x, y, z - 1)] === 0) || (z < sz - 1 && data[idx(x, y, z + 1)] === 0);
  for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = idx(x, y, z);
    const id = data[i];
    if (id === 0 || id > 5) continue;                      // air, flame, soot: leave alone
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, dz = z + 0.5 - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > reach2 || !exposed(x, y, z)) continue;        // cheap tests first, noise last
    // 1 at the crater wall, fading to 0 at scorchW beyond it; noise breaks the edge up
    const k = 1 - (Math.sqrt(d2) - craterR(x, y, z)) / scorchW;
    if (k <= 0) continue;
    if (k > 0.25 + 0.75 * vnoise(x * 0.31, y * 0.31, z * 0.31, seed + 3)) data[i] = SCORCH_ID;
  }

  // 3. rubble: loose stone on the floor around the crater --------------------
  const rubbleMax = Math.max(1, Math.round(0.8 * S));
  const keep = opts.keepClear ?? [];
  const rubbleR = R * 1.3;
  if (cy - 1 < R * 2) {                 // only if the floor is near enough to catch debris
    for (let z = Math.max(1, z0); z < Math.min(sz - 1, z1); z++) for (let x = Math.max(1, x0); x < Math.min(sx - 1, x1); x++) {
      const dx = x + 0.5 - cx, dz = z + 0.5 - cz;
      const d = Math.hypot(dx, dz);
      if (d > rubbleR) continue;
      if (data[idx(x, 0, z)] === 0 || data[idx(x, 1, z)] !== 0) continue;   // need bare floor
      let blocked = false;
      for (const s of keep) if (Math.hypot(x + 0.5 - s.x, z + 0.5 - s.z) < s.r) { blocked = true; break; }
      if (blocked) continue;
      const n = vnoise(x * 0.23, 0, z * 0.23, seed + 11);
      const h = Math.round(rubbleMax * (1 - d / rubbleR) * (n * 1.6 - 0.35));
      for (let k = 1; k <= h; k++) {
        if (!breakable(x, k, z) || data[idx(x, k, z)] !== 0) break;
        data[idx(x, k, z)] = 1;
      }
    }
  }

  const box = { x0, y0, z0, x1, y1, z1 };
  refreshCoarse(world, box);
  return box;
}

// Is the (voxel) point inside solid ground? handy for "did the brazier survive" checks
export function voxelAt(world, x, y, z) {
  const { data, size } = world;
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  if (x < 0 || y < 0 || z < 0 || x >= size.x || y >= size.y || z >= size.z) return 1;
  return data[x + size.x * (y + size.y * z)];
}

// Run a few blasts on a scratch grid so the JIT has compiled explode() before the first real one
// (otherwise the first explosion in a session hitches by ~100 ms).
export function warmUp() {
  const n = 72, b = n / 8;
  const scratch = {
    data: new Uint8Array(n * n * n).fill(1), size: { x: n, y: n, z: n },
    coarse: new Uint8Array(b * b * b), coarseSize: { x: b, y: b, z: b },
  };
  for (let i = 0; i < 3; i++) explode(scratch, [36, 12 + i * 8, 36], 20, { seed: i });
}
