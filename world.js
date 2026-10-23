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
];

// ---------------------------------------------------------------- procedural layout
// Tile legend:  '#' wall   '.' floor   'g' grass floor   'B' timber doorway   'L' brazier
//
// The layout is a pure function of the seed, so every multiplayer client that is given the same
// seed builds exactly the same level (the server only has to send one integer).
export const MAP_W = 18, MAP_H = 14;     // tiles; world memory grows with MAP_W * MAP_H * T^2 * WORLD_H
const MAX_BRAZIERS = 4;                  // light slots are shared with the torch and explosion flashes
const SPAWN_COUNT = 8;

export let MAP = [];                     // set by buildWorld(); rows of tile chars

export function isWalkable(tx, tz) {
  const row = MAP[tz];
  return !!row && row[tx] !== undefined && row[tx] !== '#' && row[tx] !== 'L';
}
const openTile = (tx, tz) => !!MAP[tz] && MAP[tz][tx] !== undefined && MAP[tz][tx] !== '#';

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
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (g[z][x] === '.' || g[z][x] === 'g') floor.push([x, z]);
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
function hash3(x, y, z, s) {
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
  MAP = layout.map;
  const MW = MAP[0].length, MH = MAP.length;
  const sx = MW * T, sy = WORLD_H, sz = MH * T, layer = sx * sy;
  const idx = (x, y, z) => x + sx * y + layer * z;     // x fastest, matches Data3DTexture
  const data = new Uint8Array(sx * sy * sz).fill(1);   // start as solid stone

  // 1. carve the tiles
  for (let tz = 0; tz < MH; tz++) for (let tx = 0; tx < MW; tx++) {
    const ch = MAP[tz][tx];
    if (ch === '#') continue;
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
    lights.push({ pos: [x0 + c, 7 * S, z0 + c], color: [1.0, 0.5, 0.2], intensity: 3.0,
                  anchor: [x0 + c, 4 * S, z0 + c] });   // a flame voxel: if it's destroyed the light goes out
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
           map: MAP, spawns: layout.spawns, start: layout.spawns[0], lights };
}