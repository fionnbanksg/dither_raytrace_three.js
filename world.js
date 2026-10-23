// Voxel world generation. The game logic is tile-based (like Eye of the Beholder /
// Dungeon Master); each tile is T x T voxels so the walls can be rough and chunky.

export const T = 4;          // voxels per tile edge
export const WORLD_H = 8;    // voxel height of the world (floor y=0, ceiling y>=5)
export const OPEN_H = 4;     // open air voxels above the floor (y = 1..4)
export const EYE_Y = 2.5;    // camera height in voxels

// Voxel material ids -> base colours (0 = air, never drawn)
export const PALETTE = [
  [0.00, 0.00, 0.00], // 0 air
  [0.66, 0.66, 0.68], // 1 stone
  [0.38, 0.52, 0.10], // 2 grass
  [0.42, 0.42, 0.44], // 3 dungeon floor
  [0.45, 0.22, 0.08], // 4 wood
  [0.55, 0.14, 0.10], // 5 brick
  [0.70, 0.55, 0.20], // 6 (spare)
  [0.30, 0.30, 0.50], // 7 (spare)
];

// '#': wall   '.': floor   'g': grass floor   'S': start   'B': timber doorway
export const MAP = [
  '################',
  '#S..B..#.......#',
  '#.####.#.#####.#',
  '#.#..#.#.#...#.#',
  '#.#..#...#.#.#.#',
  '#.####.###.#.#.#',
  '#......#...#...#',
  '######.#.#######',
  '#gggg..#.......#',
  '#gggg.##.#####.#',
  '#gggg....#...#.#',
  '######.###.#.#.#',
  '#......#...#...#',
  '################',
];

export function isWalkable(tx, tz) {
  const row = MAP[tz];
  return !!row && row[tx] !== undefined && row[tx] !== '#';
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildWorld(seed = 1337) {
  const rnd = mulberry32(seed);
  const MW = MAP[0].length, MH = MAP.length;
  const sx = MW * T, sy = WORLD_H, sz = MH * T;
  const idx = (x, y, z) => x + sx * (y + sy * z);   // x fastest, matches Data3DTexture
  let data = new Uint8Array(sx * sy * sz).fill(1);   // start solid stone
  let start = { tx: 1, tz: 1, dir: 1 };

  // 1. carve tiles
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    const ch = MAP[tz][tx];
    if (ch === '#') continue;
    if (ch === 'S') start = { tx, tz, dir: 1 };
    for (let lz = 0; lz < T; lz++) for (let lx = 0; lx < T; lx++) {
      const x = tx * T + lx, z = tz * T + lz;
      data[idx(x, 0, z)] = ch === 'g' ? 2 : 3;
      for (let y = 1; y <= OPEN_H; y++) data[idx(x, y, z)] = 0;
    }
  }

  // 2. roughen: erode wall surfaces, then add some rubble
  const N = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const get = (d, x, y, z) => (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) ? 1 : d[idx(x, y, z)];
  const roughen = (carve, p) => {
    const src = data, out = data.slice();
    for (let z = 1; z < sz - 1; z++) for (let y = 1; y < sy - 1; y++) for (let x = 1; x < sx - 1; x++) {
      const i = idx(x, y, z);
      if (carve) {
        if (src[i] !== 1) continue;
        if (N.some(([a, b, c]) => get(src, x + a, y + b, z + c) === 0) && rnd() < p) out[i] = 0;
      } else {
        if (src[i] !== 0) continue;
        if (N.some(([a, b, c]) => get(src, x + a, y + b, z + c) === 1) && rnd() < p) out[i] = 1;
      }
    }
    data = out;
  };
  roughen(true, 0.4);
  roughen(false, 0.08);

  // 3. grass tufts on grass tiles
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    if (MAP[tz][tx] !== 'g') continue;
    for (let lz = 0; lz < T; lz++) for (let lx = 0; lx < T; lx++) {
      if (rnd() < 0.35) data[idx(tx * T + lx, 1, tz * T + lz)] = 2;
    }
  }

  // 4. timber doorways
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    if (MAP[tz][tx] !== 'B') continue;
    const x0 = tx * T, z0 = tz * T;
    const alongZ = MAP[tz][tx - 1] === '#' && MAP[tz][tx + 1] === '#';
    for (let i = 0; i < T; i++) {
      // horizontal beam
      const bx = alongZ ? x0 + i : x0 + 1, bz = alongZ ? z0 + 1 : z0 + i;
      data[idx(bx, OPEN_H, bz)] = 4;
    }
    for (const e of [0, T - 1]) for (let y = 1; y < OPEN_H; y++) {
      const px = alongZ ? x0 + e : x0 + 1, pz = alongZ ? z0 + 1 : z0 + e;
      data[idx(px, y, pz)] = 4;
    }
  }

  return { data, size: { x: sx, y: sy, z: sz }, start };
}
