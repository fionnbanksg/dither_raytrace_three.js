// Voxel world generation. Game logic is tile-based (like Eye of the Beholder / Dungeon Master);
// each tile is T x T voxels. T must be a multiple of 8 (16, 24, 32, 48, 64...).
// Memory/time grow with T^3: T=16 ~1M voxels, T=32 ~10M, T=64 ~80M.

export const T = 64;                                   // voxels per tile edge
const S = T / 16;                                      // scale relative to the original 16-voxel tiles
export const BRICK = 8;                                // coarse occupancy brick size (voxels)
export const OPEN_H = 12 * S;                          // open air voxels above the floor (y = 1..OPEN_H)
export const WORLD_H = Math.ceil((22 * S) / BRICK) * BRICK;
export const EYE_Y = 5.5 * S;                          // camera height in voxels

const PROTECT_Y = 9 * S;      // below this height the walking lanes never get rubble
const LANE_HALF = 3.5 * S;    // half-width of the protected walking lane

// Voxel material ids -> base colours (0 = air, never drawn)
export const PALETTE = [
  [0.00, 0.00, 0.00], // 0 air
  [0.66, 0.66, 0.68], // 1 stone
  [0.38, 0.52, 0.10], // 2 grass
  [0.42, 0.42, 0.44], // 3 dungeon floor
  [0.45, 0.22, 0.08], // 4 wood
  [0.55, 0.14, 0.10], // 5 brick
  [1.00, 0.60, 0.20], // 6 emissive flame
  [0.30, 0.30, 0.50], // 7 (spare)
];

// '#': wall   '.': floor   'g': grass floor   'S': start   'B': timber doorway   'L': brazier
export const MAP = [
  '################',
  '#S..B..#.......#',
  '#.####.#.#####.#',
  '#.#..#.#.#...#.#',
  '#.#..#...#.#.#.#',
  '#.####.###.#.#.#',
  '#......#...#...#',
  '######.#.#######',
  '#Lggg..#.......#',
  '#gggg.##.#####.#',
  '#gggg....#...#.#',
  '######.###.#.#.#',
  '#......#L..#...#',
  '################',
];

export function isWalkable(tx, tz) {
  const row = MAP[tz];
  return !!row && row[tx] !== undefined && row[tx] !== '#' && row[tx] !== 'L';
}
const openTile = (tx, tz) => !!MAP[tz] && MAP[tz][tx] !== undefined && MAP[tz][tx] !== '#';

// ---------------------------------------------------------------- noise
function hash3(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, z, s) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz, s);
  return l(
    l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v),
    w
  );
}
const fbm = (x, y, z, s) =>
  0.55 * vnoise(x, y, z, s) + 0.30 * vnoise(x * 2.1, y * 2.1, z * 2.1, s + 7) + 0.15 * vnoise(x * 4.3, y * 4.3, z * 4.3, s + 13);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ---------------------------------------------------------------- world
export function buildWorld(seed = 1337) {
  const MW = MAP[0].length, MH = MAP.length;
  const sx = MW * T, sy = WORLD_H, sz = MH * T, layer = sx * sy;
  const idx = (x, y, z) => x + sx * y + layer * z;     // x fastest, matches Data3DTexture
  const data = new Uint8Array(sx * sy * sz).fill(1);   // start as solid stone
  let start = { tx: 1, tz: 1, dir: 1 };

  // 1. carve the tiles
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    const ch = MAP[tz][tx];
    if (ch === '#') continue;
    if (ch === 'S') start = { tx, tz, dir: 1 };
    for (let lz = 0; lz < T; lz++) for (let lx = 0; lx < T; lx++) {
      const b = idx(tx * T + lx, 0, tz * T + lz);
      data[b] = 3;                                      // floor
      for (let y = 1; y <= OPEN_H; y++) data[b + y * sx] = 0;
    }
  }

  // 2. organic surfaces. Each surface (wall / floor / ceiling) is displaced by 2D noise sampled
  //    on the surface: stone is eroded into the walls and rubble grows out of them.
  const isProtected = (x, y, z) => {
    if (y < 1 || y > PROTECT_Y) return false;
    const tx = (x / T) | 0, tz = (z / T) | 0;
    if (!openTile(tx, tz)) return false;
    const dx = (x % T) + 0.5 - T / 2, dz = (z % T) + 0.5 - T / 2;
    const inX = Math.abs(dx) < LANE_HALF, inZ = Math.abs(dz) < LANE_HALF;
    if (inX && inZ) return true;
    if (inZ) return dx < 0 ? openTile(tx - 1, tz) : openTile(tx + 1, tz);
    if (inX) return dz < 0 ? openTile(tx, tz - 1) : openTile(tx, tz + 1);
    return false;
  };

  const F = 0.17 / S, F2 = 0.21 / S;           // noise frequency per voxel (tile-relative feature size)
  const CARVE = 3.9 * S, FILL = 2.6 * S;       // max erosion / rubble depth in voxels
  const carveAmt = (x, y, z) => clamp01((fbm(x * F, y * F, z * F, seed) - 0.22) / 0.5) * CARVE;
  const fillAmt  = (x, y, z) => clamp01((fbm(x * F2 + 40, y * F2, z * F2 + 17, seed + 1) - 0.4) / 0.4) * FILL;
  const setAir = (x, y, z) => {
    if (x > 0 && y > 0 && z > 0 && x < sx - 1 && y < sy - 1 && z < sz - 1) data[idx(x, y, z)] = 0;
  };
  const setStone = (x, y, z) => {
    if (y < 1 || isProtected(x, y, z)) return;
    const i = idx(x, y, z);
    if (data[i] === 0) data[i] = 1;
  };

  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    if (!openTile(tx, tz)) continue;
    const x0 = tx * T, z0 = tz * T;

    // walls
    for (const [dx, dz] of DIRS) {
      if (openTile(tx + dx, tz + dz)) continue;
      for (let a = 0; a < T; a++) for (let y = 1; y <= OPEN_H; y++) {
        const bx = dx > 0 ? x0 + T - 1 : dx < 0 ? x0 : x0 + a;   // boundary voxel inside the open tile
        const bz = dz > 0 ? z0 + T - 1 : dz < 0 ? z0 : z0 + a;
        const c = carveAmt(bx, y, bz);
        for (let k = 1; k <= c; k++) setAir(bx + dx * k, y, bz + dz * k);       // erode into the wall
        const f = fillAmt(bx, y, bz);
        for (let k = 0; k + 1 <= f; k++) setStone(bx - dx * k, y, bz - dz * k); // rubble into the room
      }
    }

    // floor rubble, ceiling erosion + stalactites
    for (let lz = 0; lz < T; lz++) for (let lx = 0; lx < T; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const ff = fillAmt(x, 0, z) * 0.7;
      for (let k = 0; k + 1 <= ff; k++) setStone(x, 1 + k, z);
      const cc = carveAmt(x, OPEN_H + 1, z);
      for (let k = 1; k <= cc; k++) setAir(x, OPEN_H + k, z);
      const cf = fillAmt(x, OPEN_H + 1, z);
      for (let k = 0; k + 1 <= cf; k++) setStone(x, OPEN_H - k, z);
    }
  }

  // 3. grass and moss with tufts (heights vary per old-voxel block, jittered per column)
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const tx = (x / T) | 0, tz = (z / T) | 0;
    if (!openTile(tx, tz) || data[idx(x, 0, z)] === 0) continue;
    const grassy = MAP[tz][tx] === 'g' || vnoise((x * 0.07) / S, 0, (z * 0.07) / S, seed + 5) > 0.68;
    if (!grassy) continue;
    data[idx(x, 0, z)] = 2;
    const r = hash3(Math.floor(x / S), 0, Math.floor(z / S), seed + 9);
    const base = r > 0.93 ? 3 : r > 0.8 ? 2 : r > 0.45 ? 1 : 0;
    const h = Math.round(base * S * (0.6 + 0.4 * hash3(x, 1, z, seed + 3)));
    for (let y = 1; y <= h; y++) if (data[idx(x, y, z)] === 0) data[idx(x, y, z)] = 2;
  }

  // 4. timber doorways ('B')
  const thick = 2 * S, a0 = 3 * S;
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    if (MAP[tz][tx] !== 'B') continue;
    const x0 = tx * T, z0 = tz * T, c = T / 2;
    const alongZ = MAP[tz][tx - 1] === '#' && MAP[tz][tx + 1] === '#';
    const put = (u, v, y) => {
      const x = alongZ ? x0 + u : x0 + v, z = alongZ ? z0 + v : z0 + u;
      data[idx(x, y, z)] = 4;
    };
    for (let v = c - S; v <= c + S - 1; v++) {
      for (let u = a0; u <= T - 1 - a0; u++) for (let y = OPEN_H - thick + 1; y <= OPEN_H; y++) put(u, v, y);   // lintel
      for (const u0 of [a0, T - a0 - thick]) for (let du = 0; du < thick; du++) for (let y = 1; y <= OPEN_H - thick; y++) put(u0 + du, v, y); // posts
    }
  }

  // 5. braziers ('L'): pedestal + emissive flame + point light
  const lights = [];
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    if (MAP[tz][tx] !== 'L') continue;
    const x0 = tx * T, z0 = tz * T, c = T / 2;
    for (let lz = c - 2 * S; lz < c + 2 * S; lz++) for (let lx = c - 2 * S; lx < c + 2 * S; lx++) {
      for (let y = 1; y <= 3 * S; y++) data[idx(x0 + lx, y, z0 + lz)] = 3;                  // pedestal
    }
    for (let lz = c - S; lz < c + S; lz++) for (let lx = c - S; lx < c + S; lx++) {
      for (let y = 3 * S + 1; y <= 5 * S; y++) data[idx(x0 + lx, y, z0 + lz)] = 6;          // flame
    }
    lights.push({ pos: [x0 + c, 7 * S, z0 + c], color: [1.0, 0.5, 0.2], intensity: 3.0 });
  }

  // 6. coarse occupancy grid (1 = brick contains any solid voxel) for empty-space skipping
  const cx = sx / BRICK, cy = sy / BRICK, cz = sz / BRICK;
  const coarse = new Uint8Array(cx * cy * cz);
  for (let bz = 0; bz < cz; bz++) for (let by = 0; by < cy; by++) for (let bx = 0; bx < cx; bx++) {
    let any = 0;
    for (let z = bz * BRICK; z < bz * BRICK + BRICK && !any; z++)
      for (let y = by * BRICK; y < by * BRICK + BRICK && !any; y++) {
        let i = idx(bx * BRICK, y, z);
        for (let x = 0; x < BRICK; x++, i++) if (data[i] !== 0) { any = 1; break; }
      }
    coarse[bx + cx * (by + cy * bz)] = any;
  }

  return { data, size: { x: sx, y: sy, z: sz }, coarse, coarseSize: { x: cx, y: cy, z: cz }, start, lights };
}