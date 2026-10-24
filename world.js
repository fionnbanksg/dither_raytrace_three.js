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
  [0.13, 0.115, 0.105], // 7 scorched stone (explosion soot)
  [1.00, 0.34, 0.06], // 8 lava (emissive, animated in shader.js; simulated in lava.js)
  [0.16, 0.36, 0.08], // 9 leaves
  [0.40, 0.39, 0.37], // 10 boulder rock
];

// ---------------------------------------------------------------- procedural layout
// Tile legend:  '#' wall   '.' floor   'g' grass floor   'o' open-air grass (no roof, sky above)   'B' timber doorway   'L' brazier
//               'x' outdoor terrain (the margin around the dungeon)   'C' cave-mouth tile (solid rock the tunnel is cut through)
//
// The layout is a pure function of the seed, so every multiplayer client that is given the same
// seed builds exactly the same level (the server only has to send one integer).
export const MAP_W = 16, MAP_H = 12;     // dungeon size in tiles (the hills sit on top of it)
export const MARGIN = 4;                 // tiles of outdoor terrain around the dungeon. World = (MAP_W+2*MARGIN) x (MAP_H+2*MARGIN) tiles;
                                         // memory grows with that area * T^2 * WORLD_H (24x20 tiles ~ 173MB)
const MAX_BRAZIERS = 4;                  // light slots are shared with the torch and explosion flashes
const SPAWN_COUNT = 8;

export let MAP = [];                     // set by buildWorld(); rows of tile chars

export function isWalkable(tx, tz) {
  const row = MAP[tz];
  return !!row && row[tx] !== undefined && row[tx] !== '#' && row[tx] !== 'L' && row[tx] !== 'C';
}
export const isOutdoor = (tx, tz) => !!MAP[tz] && (MAP[tz][tx] === 'o' || MAP[tz][tx] === 'x');
// open = carved by the dungeon pass. Margin ('x') and cave-mouth ('C') tiles are shaped by the terrain pass instead.
const openTile = (tx, tz) => !!MAP[tz] && MAP[tz][tx] !== undefined && MAP[tz][tx] !== '#' && MAP[tz][tx] !== 'x' && MAP[tz][tx] !== 'C';

function mulberry32(a) {
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function buildLayout(seed, W, H) {
  const rnd = mulberry32(seed >>> 0);
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  const g = Array.from({ length: H }, () => Array(W).fill('#'));
  const inb = (x, z) => x >= 1 && z >= 1 && x < W - 1 && z < H - 1;           // the outer ring stays wall
  const open = (x, z) => x >= 0 && z >= 0 && x < W && z < H && g[z][x] !== '#';
  const degree = (x, z) => N4.reduce((n, [dx, dz]) => n + (open(x + dx, z + dz) ? 1 : 0), 0);
  const dig = (x, z) => { if (inb(x, z) && g[z][x] === '#') g[z][x] = '.'; };

  // 1. rooms: a couple of big arenas, some mid-size rooms, a few closets. Always >= 1 wall tile apart.
  const rooms = [];
  const fits = (r) => rooms.every((o) => r.x > o.x + o.w || o.x > r.x + r.w || r.z > o.z + o.h || o.z > r.z + r.h);
  const place = (kind, wMin, wMax, hMin, hMax) => {
    for (let i = 0; i < 80; i++) {
      const w = ri(wMin, wMax), h = ri(hMin, hMax);
      const r = { x: ri(1, W - 1 - w), z: ri(1, H - 1 - h), w, h, kind };
      if (fits(r)) { rooms.push(r); return r; }
    }
    return null;
  };
  for (let i = 0; i < 2; i++) place('big', 4, 6, 3, 5);
  for (let i = ri(3, 4); i > 0; i--) place('mid', 3, 4, 2, 3);
  for (let i = ri(2, 3); i > 0; i--) place('small', 2, 2, 2, 2);
  if (rooms.filter((r) => r.kind === 'big').length < 1 || rooms.length < 5) return null;

  for (const r of rooms) for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) g[z][x] = '.';
  const inRoom = (x, z) => rooms.some((r) => x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.h);
  const centre = (r) => ({ x: r.x + (r.w >> 1), z: r.z + (r.h >> 1) });

  // 2. tunnels: a minimum spanning tree (everything reachable) + extra edges (loops, so there are
  //    always at least two ways between places). Each link bends through a random waypoint.
  // Links are routed with a cheapest-path search: walking through open tiles is nearly free, while
  // digging a new wall tile costs more the more open space it touches. That keeps tunnels one tile
  // wide and apart from each other (no wide blobs), and lets them reuse existing tunnels and rooms.
  const link = (ra, rb, fresh = false) => {   // fresh: avoid existing tunnels so the link makes a real loop
    const a = centre(ra), b = centre(rb);
    const noise = new Float32Array(W * H).map(() => rnd() * 2.5);
    const cost = (x, z) => {
      if (!inb(x, z)) return Infinity;
      if (open(x, z)) return fresh && !inRoom(x, z) ? 7 : 1;
      let adj = 0;
      for (const [dx, dz] of N4) if (open(x + dx, z + dz)) adj++;
      return 3 + noise[x + W * z] + 7 * adj;
    };
    const dist = new Float32Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1), done = new Uint8Array(W * H);
    dist[a.x + W * a.z] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let i = 0; i < dist.length; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0 || u === b.x + W * b.z) break;
      done[u] = 1;
      const ux = u % W, uz = (u / W) | 0;
      for (const [dx, dz] of N4) {
        const nx = ux + dx, nz = uz + dz, c = cost(nx, nz);
        if (c === Infinity) continue;
        const v = nx + W * nz;
        if (dist[u] + c < dist[v]) { dist[v] = dist[u] + c; prev[v] = u; }
      }
    }
    for (let v = b.x + W * b.z; v >= 0; v = prev[v]) dig(v % W, (v / W) | 0);
  };
  const dist = (i, j) => { const a = centre(rooms[i]), b = centre(rooms[j]); return Math.abs(a.x - b.x) + Math.abs(a.z - b.z); };
  const inTree = new Set([0]);
  const treeEdges = new Set();
  while (inTree.size < rooms.length) {
    let best = null;
    for (const i of inTree) for (let j = 0; j < rooms.length; j++) {
      if (inTree.has(j)) continue;
      const d = dist(i, j) + rnd() * 2;
      if (!best || d < best.d) best = { i, j, d };
    }
    inTree.add(best.j);
    treeEdges.add(best.i + ',' + best.j);
    link(rooms[best.i], rooms[best.j]);
  }
  const extra = [];
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    if (!treeEdges.has(i + ',' + j) && !treeEdges.has(j + ',' + i)) extra.push([i, j]);
  }
  shuffle(extra).slice(0, ri(3, 4)).forEach(([i, j]) => link(rooms[i], rooms[j], true));

  // 3. no dead ends: each stub either punches through to the nearest open tile or is filled back in
  for (let pass = 0; pass < 60; pass++) {
    let changed = false;
    for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
      if (!open(x, z) || inRoom(x, z) || degree(x, z) !== 1) continue;
      changed = true;
      const back = N4.find(([dx, dz]) => open(x + dx, z + dz));
      let linked = false;
      if (rnd() < 0.7) {
        for (const d of shuffle(N4.filter((n) => n !== back))) {
          const [dx, dz] = d;
          let k = 1;
          while (k <= 8 && inb(x + dx * k, z + dz * k) && !open(x + dx * k, z + dz * k)) k++;
          if (k >= 2 && k <= 8 && open(x + dx * k, z + dz * k)) {
            for (let j = 1; j < k; j++) dig(x + dx * j, z + dz * j);
            linked = true; break;
          }
        }
      }
      if (!linked) g[z][x] = '#';
    }
    if (!changed) break;
  }

  // 4. cover: pillars inside the big rooms (outer ring of the room stays clear, no two touch)
  for (const r of rooms) {
    if (r.kind !== 'big') continue;
    for (let z = r.z + 1; z < r.z + r.h - 1; z++) for (let x = r.x + 1; x < r.x + r.w - 1; x++) {
      if (g[z][x] !== '.' || rnd() > 0.3) continue;
      let touching = false;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (g[z + dz][x + dx] === '#') touching = true;
      if (!touching) g[z][x] = '#';
    }
  }

  // 5. timber doorways where a straight corridor tile meets a room
  for (let z = 1; z < H - 1; z++) for (let x = 1; x < W - 1; x++) {
    if (g[z][x] !== '.' || inRoom(x, z) || rnd() > 0.6) continue;
    const lr = open(x - 1, z) && open(x + 1, z) && !open(x, z - 1) && !open(x, z + 1);
    const ud = open(x, z - 1) && open(x, z + 1) && !open(x - 1, z) && !open(x + 1, z);
    if (!lr && !ud) continue;
    const touchesRoom = lr ? (inRoom(x - 1, z) || inRoom(x + 1, z)) : (inRoom(x, z - 1) || inRoom(x, z + 1));
    if (touchesRoom && N4.every(([dx, dz]) => g[z + dz][x + dx] !== 'B')) g[z][x] = 'B';
  }

  // 6. grass in one or two of the bigger rooms
  const green = shuffle(rooms.filter((r) => r.kind !== 'small'));
  green.slice(0, rnd() < 0.5 ? 2 : 1).forEach((r) => {
    for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) if (g[z][x] === '.') g[z][x] = 'g';
  });

  // 6b. open-air courtyards: one big room (and maybe a mid one) lose their roof. Uses its own rng so the
  //     rest of the layout stays the same for a given seed.
  const orng = mulberry32((seed ^ 0x51ED270B) >>> 0);
  const bigs = rooms.filter((r) => r.kind === 'big'), mids = rooms.filter((r) => r.kind === 'mid');
  const outdoor = [bigs[Math.floor(orng() * bigs.length)]];
  if (mids.length && orng() < 0.5) outdoor.push(mids[Math.floor(orng() * mids.length)]);
  for (const r of outdoor) {
    for (let z = r.z; z < r.z + r.h; z++) for (let x = r.x; x < r.x + r.w; x++) if (g[z][x] === '.' || g[z][x] === 'g') g[z][x] = 'o';
  }

  // 7. braziers in room corners (big rooms first)
  const corners = (r) => shuffle([[r.x, r.z], [r.x + r.w - 1, r.z], [r.x, r.z + r.h - 1], [r.x + r.w - 1, r.z + r.h - 1]]);
  const lamps = [];
  for (const r of rooms.filter((q) => q.kind === 'big')) lamps.push(...corners(r).slice(0, 2));
  for (const r of shuffle(rooms.filter((q) => q.kind === 'mid'))) if (rnd() < 0.6) lamps.push(corners(r)[0]);
  let nLamps = 0;
  for (const [x, z] of lamps) {
    if (nLamps >= MAX_BRAZIERS) break;
    if (g[z][x] === '.' || g[z][x] === 'g') { g[z][x] = 'L'; nLamps++; }
  }

  // 8. sanity: every open tile must be reachable from every other
  let total = 0, first = null;
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (open(x, z)) { total++; first ??= [x, z]; }
  const seen = new Set([first.join()]), stack = [first];
  while (stack.length) {
    const [x, z] = stack.pop();
    for (const [dx, dz] of N4) {
      const nx = x + dx, nz = z + dz;
      if (open(nx, nz) && !seen.has(nx + ',' + nz)) { seen.add(nx + ',' + nz); stack.push([nx, nz]); }
    }
  }
  if (seen.size !== total || total < W * H * 0.3) return null;

  // 9. spawn points: farthest-point sampling over plain floor tiles so players start well apart
  const floor = [];
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (g[z][x] === '.' || g[z][x] === 'g' || g[z][x] === 'o') floor.push([x, z]);
  const picks = [floor[Math.floor(rnd() * floor.length)]];
  while (picks.length < Math.min(SPAWN_COUNT, floor.length)) {
    let best = null;
    for (const [x, z] of floor) {
      const d = Math.min(...picks.map(([px, pz]) => Math.hypot(px - x, pz - z)));
      if (!best || d > best.d) best = { x, z, d };
    }
    picks.push([best.x, best.z]);
  }
  const spawns = picks.map(([x, z]) => {
    // face along the longest open run so nobody spawns staring at a wall
    let bestDir = N4[0], bestRun = -1;
    for (const d of shuffle([...N4])) {
      let run = 0;
      while (open(x + d[0] * (run + 1), z + d[1] * (run + 1))) run++;
      if (run > bestRun) { bestRun = run; bestDir = d; }
    }
    return { tx: x, tz: z, yaw: Math.atan2(bestDir[0], -bestDir[1]) };   // yaw 0 = -Z, pi/2 = +X
  });

  return { map: g.map((row) => row.join('')), spawns };
}

export function generateLayout(seed = 1337, W = MAP_W, H = MAP_H) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const layout = buildLayout((seed + Math.imul(attempt, 7919)) ^ 0x9E3779B9, W, H);
    if (layout) return layout;
  }
  throw new Error(`could not generate a valid layout for seed ${seed}`);
}

// ---------------------------------------------------------------- noise
export function hash3(x, y, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1274126177) ^ Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function vnoise(x, y, z, s) {
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
  const layout = generateLayout(seed);
  const inner = layout.map, IW = inner[0].length, IH = inner.length, M = MARGIN;

  // cave mouths: one per side where a plain floor tile touches the outer wall ring (own rng: layout is unchanged)
  const crng = mulberry32((seed ^ 0xCA7E5) >>> 0);
  const entrances = [];
  const sides = [
    { dir: 'W', cells: () => { const c = []; for (let z = 2; z < IH - 2; z++) c.push([1, z]); return c; } },
    { dir: 'E', cells: () => { const c = []; for (let z = 2; z < IH - 2; z++) c.push([IW - 2, z]); return c; } },
    { dir: 'N', cells: () => { const c = []; for (let x = 2; x < IW - 2; x++) c.push([x, 1]); return c; } },
    { dir: 'S', cells: () => { const c = []; for (let x = 2; x < IW - 2; x++) c.push([x, IH - 2]); return c; } },
  ];
  for (const sd of sides) {
    const cand = sd.cells().filter(([x, z]) => inner[z][x] === '.' || inner[z][x] === 'g');
    if (!cand.length) continue;
    const [x, z] = cand[Math.floor(crng() * cand.length)];
    entrances.push({ dir: sd.dir, tx: x + M, tz: z + M });
  }

  // pad the dungeon with outdoor margin tiles
  const grid = Array.from({ length: IH + 2 * M }, (_, z) => Array.from({ length: IW + 2 * M }, (_, x) => {
    const ix = x - M, iz = z - M;
    return ix >= 0 && iz >= 0 && ix < IW && iz < IH ? inner[iz][ix] : 'x';
  }));
  for (const e of entrances) {
    if (e.dir === 'W') grid[e.tz][M] = 'C'; else if (e.dir === 'E') grid[e.tz][M + IW - 1] = 'C';
    else if (e.dir === 'N') grid[M][e.tx] = 'C'; else grid[M + IH - 1][e.tx] = 'C';
  }
  MAP = grid.map((r) => r.join(''));
  const MW = MAP[0].length, MH = MAP.length;
  const spawns = layout.spawns.map((sp) => ({ ...sp, tx: sp.tx + M, tz: sp.tz + M }));
  const sx = MW * T, sy = WORLD_H, sz = MH * T, layer = sx * sy;
  const idx = (x, y, z) => x + sx * y + layer * z;     // x fastest, matches Data3DTexture
  const data = new Uint8Array(sx * sy * sz).fill(1);   // start as solid stone

  // 1. carve the tiles
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    const ch = MAP[tz][tx];
    if (ch === '#' || ch === 'x' || ch === 'C') continue;   // solid / terrain tiles are shaped by the terrain pass
    for (let lz = 0; lz < T; lz++) for (let lx = 0; lx < T; lx++) {
      const b = idx(tx * T + lx, 0, tz * T + lz);
      data[b] = 3;                                      // floor
      const top = ch === 'o' ? sy - 1 : OPEN_H;         // open-air tiles have no roof: air all the way up, so rays escape to the sky
      for (let y = 1; y <= top; y++) data[b + y * sx] = 0;
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

    // walls (outdoors they are cliffs: eroded all the way up)
    const outdoor = MAP[tz][tx] === 'o';
    const wallTop = outdoor ? sy - 2 : OPEN_H;
    for (const [dx, dz] of DIRS) {
      if (openTile(tx + dx, tz + dz)) continue;
      for (let a = 0; a < T; a++) for (let y = 1; y <= wallTop; y++) {
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
      if (outdoor) continue;                                   // no ceiling to erode
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
    const grassy = MAP[tz][tx] === 'g' || (MAP[tz][tx] === 'o' && vnoise((x * 0.05) / S, 3, (z * 0.05) / S, seed + 21) > 0.3) || vnoise((x * 0.07) / S, 0, (z * 0.07) / S, seed + 5) > 0.68;
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
    lights.push({ pos: [x0 + c, 7 * S, z0 + c], color: [1.0, 0.5, 0.2], intensity: 3.0,
                  anchor: [x0 + c, 4 * S, z0 + c] });   // a flame voxel: if it's destroyed the light goes out
  }

  // 5b. outdoor terrain. The dungeon block becomes a hill; the margin is low ground with a ridge round the world
  //     edge. Tunnel mouths are cut through the hillside as arches. Then trees, boulders, logs and bushes go on top.
  const SMOOTH = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const RX0 = M * T, RX1 = (M + IW) * T, RZ0 = M * T, RZ1 = (M + IH) * T;      // dungeon rectangle, in voxels
  const HILL_MIN = 17.25 * S, HILL_VAR = 3 * S;   // hill top height (must clear the highest ceiling erosion)
  const G0 = 0.75 * S, G_VAR = 2.5 * S;           // valley floor height
  const FALL = 1.75 * T;                          // horizontal run of the hillside
  const HW = 5.5 * S;                             // half width of a cave mouth
  const ARCH = OPEN_H - 3;                        // arch height
  const TF = 0.044 / S;                           // terrain noise frequency
  const GR = 4, gw = Math.ceil(sx / GR) + 2, gh = Math.ceil(sz / GR) + 2;
  const tabA = new Float32Array(gw * gh), tabB = new Float32Array(gw * gh), tabC = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {   // noise on a coarse grid, interpolated per column
    const x = i * GR, z = j * GR;
    tabA[i + gw * j] = fbm(x * TF, 0, z * TF, seed + 101);
    tabB[i + gw * j] = fbm(x * TF * 1.7 + 50, 0, z * TF * 1.7, seed + 131);
    tabC[i + gw * j] = vnoise(x * TF * 3, 9, z * TF * 3, seed + 151);
  }
  const samp = (tab, x, z) => {
    const gx = x / GR, gz = z / GR, i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
    const a = tab[i + gw * j], b = tab[i + 1 + gw * j], c = tab[i + gw * (j + 1)], d = tab[i + 1 + gw * (j + 1)];
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  };
  // t = distance outside the dungeon rectangle along the mouth, u = sideways offset from its centre line
  const mouthTU = (e, x, z) => {
    const cx = (e.tx + 0.5) * T, cz = (e.tz + 0.5) * T;
    if (e.dir === 'W') return [RX0 - x, z - cz];
    if (e.dir === 'E') return [x - RX1, z - cz];
    if (e.dir === 'N') return [RZ0 - z, x - cx];
    return [z - RZ1, x - cx];
  };
  const inMouthZone = (x, z, pad) => entrances.some((e) => { const [t, u] = mouthTU(e, x, z); return t > -(T + 4) && t < 190 + pad && Math.abs(u) < HW + 30 + pad; });

  const hTop = new Int16Array(sx * sz);    // top solid voxel of each column (before carving)
  const mFloor = new Int16Array(sx * sz).fill(-1);   // >= 0: column is part of a cave mouth, floor height
  const mArch = new Int16Array(sx * sz);
  const mT = new Int16Array(sx * sz);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const A = samp(tabA, x, z), B = samp(tabB, x, z);
    const hillTop = HILL_MIN + HILL_VAR * clamp01((A - 0.2) / 0.6);
    const ground = G0 + G_VAR * clamp01((B - 0.2) / 0.6);
    const d = Math.hypot(Math.max(RX0 - x, 0, x - (RX1 - 1)), Math.max(RZ0 - z, 0, z - (RZ1 - 1)));
    let f = 1, arch = 0, mt = 0;
    for (const e of entrances) {
      const [t, u] = mouthTU(e, x, z), lat = Math.abs(u);
      if (t < -(T + 4) || t > 170 || lat > HW + 30) continue;
      const lon = t <= 0 ? 0 : SMOOTH(0, 100, t);
      f = Math.min(f, Math.max(SMOOTH(HW * 0.7, HW + 26, lat), lon));    // ground ramps up from the tunnel floor
      if (lat < HW && t < 150) { arch = Math.max(arch, Math.round(ARCH * Math.sqrt(1 - (lat / HW) ** 2))); mt = t; }
    }
    const w = clamp01(d / FALL), sh = 0.5 * SMOOTH(0, 1, w) + 0.5 * w;
    let H = ground * f * sh + hillTop * (1 - sh);
    const edge = Math.min(x, sx - 1 - x, z, sz - 1 - z);
    H += (sy - 3 - H) * (1 - SMOOTH(8, 70, edge));                          // ridge round the edge keeps players in
    const i = x + sx * z;
    hTop[i] = Math.min(sy - 3, Math.floor(H));
    if (arch > 0) { mFloor[i] = Math.floor(ground * f); mArch[i] = arch; mT[i] = mt; }
  }

  // clear everything above the terrain surface (z, y, x order so the writes are sequential)
  for (let z = 0; z < sz; z++) for (let y = 1; y < sy; y++) {
    const row = sx * (y + sy * z);
    for (let x = 0; x < sx; x++) if (y > hTop[x + sx * z]) data[row + x] = 0;
  }
  // cut the cave mouths: arch-shaped, floor follows the ramp
  const surf = Int16Array.from(hTop);
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const i = x + sx * z, a = mArch[i];
    if (!a) continue;
    const fl = mFloor[i];
    for (let y = fl + 1; y <= Math.min(a, hTop[i]); y++) data[idx(x, y, z)] = 0;
    if (hTop[i] > fl) surf[i] = fl;
    if (fl === 0) data[idx(x, 0, z)] = mT[i] < 30 ? 3 : 2;
  }
  // surface material + grass tufts: grass on gentle ground, bare rock on steep slopes and a few outcrops
  for (let z = 1; z < sz - 1; z++) for (let x = 1; x < sx - 1; x++) {
    const i = x + sx * z, y0 = surf[i];
    if (y0 < 0 || data[idx(x, y0, z)] === 0) continue;                       // open-air pits have no terrain surface
    if (mArch[i] && mT[i] < 30) continue;                                   // keep the tunnel floor
    const sl = Math.max(Math.abs(surf[i + 2] - surf[i - 2]), Math.abs(surf[i + 2 * sx] - surf[i - 2 * sx])) / 4;
    const rocky = sl > 0.9 || samp(tabC, x, z) > 0.8;
    const m = rocky ? 1 : 2;
    data[idx(x, y0, z)] = m;
    if (y0 > 0) data[idx(x, y0 - 1, z)] = m;
    if (rocky || y0 + 9 >= sy) continue;
    const r = hash3(Math.floor(x / S), 0, Math.floor(z / S), seed + 19);
    const base = r > 0.95 ? 2 : r > 0.78 ? 1 : 0;
    const h = Math.round(base * S * (0.6 + 0.4 * hash3(x, 1, z, seed + 23)));
    for (let y = y0 + 1; y <= y0 + h; y++) if (data[idx(x, y, z)] === 0) data[idx(x, y, z)] = 2;
  }

  // 5c. props: trees on the low ground, boulders / logs / bushes everywhere (cover for an FPS)
  const prng = mulberry32((seed ^ 0x7EE5A1) >>> 0);
  const pr = () => prng();
  const pri = (a, b) => a + Math.floor(pr() * (b - a + 1));
  const put = (x, y, z, m, force) => {
    if (x < 1 || z < 1 || y < 1 || x >= sx - 1 || z >= sz - 1 || y >= sy - 1) return;
    const i = idx(x, y, z);
    if (force || data[i] === 0) data[i] = m;
  };
  const ellipsoid = (cx, cy, cz, rx, ry, rz, m, rough, seedOff, topMat) => {
    for (let z = Math.floor(cz - rz - 2); z <= cz + rz + 2; z++) for (let y = Math.floor(cy - ry - 2); y <= cy + ry + 2; y++) for (let x = Math.floor(cx - rx - 2); x <= cx + rx + 2; x++) {
      const q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
      if (q > 1.5) continue;
      const lim = 1 + (vnoise(x * 0.16, y * 0.16, z * 0.16, seed + seedOff) - 0.5) * rough;
      if (q > lim) continue;
      put(x, y, z, topMat && y > cy + ry * 0.55 && vnoise(x * 0.2, 0, z * 0.2, seed + 61) > 0.45 ? topMat : m, false);
    }
  };
  const surfAt = (x, z) => surf[Math.max(0, Math.min(sx - 1, Math.round(x))) + sx * Math.max(0, Math.min(sz - 1, Math.round(z)))];
  const slopeAt = (x, z) => Math.max(Math.abs(surfAt(x + 5, z) - surfAt(x - 5, z)), Math.abs(surfAt(x, z + 5) - surfAt(x, z - 5))) / 10;
  const tileCh = (x, z) => (MAP[(z / T) | 0] || '')[(x / T) | 0];
  const nearPit = (x, z, m) => [[0, 0], [m, 0], [-m, 0], [0, m], [0, -m], [m, m], [-m, -m], [m, -m], [-m, m]].some(([dx, dz]) => tileCh(x + dx, z + dz) === 'o');
  const objs = [];
  const room = (x, z, r) => objs.every((o) => Math.hypot(o.x - x, o.z - z) >= o.r + r + 3);
  const add = (x, z, r) => objs.push({ x, z, r });

  const tree = (x, z) => {
    const top = surfAt(x, z), pine = pr() < 0.4, ht = pine ? pri(46, 58) : pri(40, 48), tr = pine ? 2.6 : 3.2;
    for (let y = top - 3; y <= top + ht; y++) {
      const k = (y - top) / ht, flare = y < top + 5 ? 1.6 * (1 - (y - top) / 5) : 0, r = tr * (1 - 0.35 * Math.max(k, 0)) + flare;
      for (let dz = -5; dz <= 5; dz++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dz * dz <= r * r) put(x + dx, y, z + dz, 4, true);
    }
    if (pine) {
      const y0 = top + 14, span = ht - 10;
      for (let y = y0; y <= top + ht + 4; y++) {
        const t = (y - y0) / span, r = 15 * Math.pow(Math.max(0, 1 - t), 0.9) * ((y - top) % 6 < 3 ? 1 : 0.72) + 1;
        for (let dz = -16; dz <= 16; dz++) for (let dx = -16; dx <= 16; dx++) {
          if (dx * dx + dz * dz > r * r || vnoise((x + dx) * 0.35, y * 0.35, (z + dz) * 0.35, seed + 9) < 0.27) continue;
          put(x + dx, y, z + dz, 9, false);
        }
      }
    } else {
      const cy = top + ht - 6, n = pri(3, 5);
      for (let k = 0; k < n; k++) {
        const a = pr() * 6.283, o = k === 0 ? 0 : 7 + pr() * 6;
        ellipsoid(x + Math.cos(a) * o, cy + (k === 0 ? 0 : pr() * 6 - 3), z + Math.sin(a) * o, 12 + pr() * 4, 9 + pr() * 3, 12 + pr() * 4, 9, 0.9, 9);
      }
    }
    add(x, z, 11);
  };
  const boulder = (x, z, r) => {
    const ry = r * (0.6 + pr() * 0.25), rz = r * (0.8 + pr() * 0.35);
    let mn = 1e9;
    for (const [dx, dz] of [[0, 0], [r * 0.7, 0], [-r * 0.7, 0], [0, rz * 0.7], [0, -rz * 0.7]]) mn = Math.min(mn, surfAt(x + dx, z + dz));
    ellipsoid(x, mn + ry * 0.35, z, r, ry, rz, 10, 0.7, 31, 2);
    add(x, z, Math.max(r, rz));
  };
  const bush = (x, z) => {
    const r = pri(8, 12), top = surfAt(x, z);
    ellipsoid(x, top + r * 0.2, z, r, r * 0.65, r, 9, 0.8, 41);
    if (pr() < 0.5) ellipsoid(x + r * 0.8, top + r * 0.1, z + r * 0.3, r * 0.7, r * 0.5, r * 0.7, 9, 0.8, 43);
    add(x, z, r + 2);
  };
  const logAt = (x, z) => {
    const alongX = pr() < 0.5, L = pri(34, 60), rr = 4 + pr() * 1.5, top = surfAt(x, z);
    for (let l = -L / 2; l <= L / 2; l++) for (let a = -6; a <= 6; a++) for (let b = -6; b <= 6; b++) {
      if (a * a + b * b > rr * rr) continue;
      put(Math.round(x + (alongX ? l : a)), Math.round(top + rr * 0.55 + b), Math.round(z + (alongX ? a : l)), 4, false);
    }
    add(x, z, L / 2);
  };

  const CELL = 36;
  for (let cz = 40; cz < sz - 40; cz += CELL) for (let cx = 40; cx < sx - 40; cx += CELL) {
    const x = cx + Math.floor(pr() * CELL), z = cz + Math.floor(pr() * CELL);
    const y0 = surfAt(x, z), edge = Math.min(x, sx - 1 - x, z, sz - 1 - z);
    if (edge < 60 || data[idx(x, y0, z)] === 0 || nearPit(x, z, 18) || inMouthZone(x, z, 10)) continue;
    const sl = slopeAt(x, z), forest = vnoise(x * 0.012, 3.3, z * 0.012, seed + 77), low = y0 <= 6 * S;
    const roll = pr();
    if (low && sl < 0.5 && forest > 0.4 && roll < 0.75) { if (room(x, z, 11)) tree(x, z); }
    else if (roll < (low ? 0.3 : 0.4) && sl < 1.2) {
      const r = pri(10, 22) * (pr() < 0.12 ? 1.5 : 1);
      if (!room(x, z, r)) continue;
      boulder(x, z, r);
      if (pr() < 0.4) for (let k = pri(1, 2); k > 0; k--) {          // satellite rocks make L-shaped cover
        const a = pr() * 6.283, r2 = r * 0.6, sx2 = x + Math.cos(a) * r * 1.1, sz2 = z + Math.sin(a) * r * 1.1;
        if (room(sx2, sz2, r2) && !nearPit(sx2 | 0, sz2 | 0, 18)) boulder(sx2, sz2, r2);
      }
    } else if (roll < 0.58 && sl < 0.8) { if (room(x, z, 12)) bush(x, z); }
    else if (roll < 0.66 && sl < 0.3 && y0 < 12 * S) { if (room(x, z, 30)) logAt(x, z); }
  }

  // outdoor spawn points on open ground in the margin, facing the hill
  const outSpawns = [];
  const clearOf = (x, z) => objs.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + 24);
  const picks = layout.spawns.map((s) => [(s.tx + M + 0.5) * T, (s.tz + M + 0.5) * T]);
  for (let k = 0; k < 3; k++) {
    let best = null;
    for (let n = 0; n < 600; n++) {
      const x = 80 + pr() * (sx - 160), z = 80 + pr() * (sz - 160);
      const d = Math.hypot(Math.max(RX0 - x, 0, x - RX1), Math.max(RZ0 - z, 0, z - RZ1));
      if (d < 40 || d > FALL + 80 || Math.min(x, sx - x, z, sz - z) < 110 || data[idx(x | 0, surf[(x | 0) + sx * (z | 0)] + 1, z | 0)] !== 0) continue;
      if (slopeAt(x, z) > 0.25 || !clearOf(x, z) || inMouthZone(x, z, 0)) continue;
      const dm = Math.min(...picks.map(([px, pz]) => Math.hypot(px - x, pz - z)));
      if (!best || dm > best.dm) best = { x, z, dm };
    }
    if (!best) break;
    picks.push([best.x, best.z]);
    const yaw = Math.atan2((RX0 + RX1) / 2 - best.x, -((RZ0 + RZ1) / 2 - best.z));
    outSpawns.push({ tx: best.x / T - 0.5, tz: best.z / T - 0.5, yaw, ym: (surfAt(best.x, best.z) + 3) * (4 / T) });
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

  return { data, size: { x: sx, y: sy, z: sz }, coarse, coarseSize: { x: cx, y: cy, z: cz }, seed,
           map: MAP, spawns: spawns.concat(outSpawns), start: spawns[0], lights };
}