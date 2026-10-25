// Bots: AI that wanders, spots the player, and shoots the SAME guns the player has (grenade, heavy shell, lava gun).
// When killed they turn into a ragdoll.
//
// No DOM / WebGL in here. Voxel units + seconds (1 m = M2V voxels), fixed 60 Hz tick like projectiles.js.
//
// How a bot is drawn: a 15-point skeleton (see POSE) turned into small voxel cubes, handed to
// Particles.pack(extras) by main.js (the same path the shells use). Alive = the skeleton is posed by code (walk cycle,
// aiming arm). Dead = the same 15 points become Verlet particles joined by distance constraints, colliding with the voxel
// world: that is the ragdoll.
//
// STAGE 1 (this file): wander, see player, shoot, take blast damage, ragdoll, respawn.
// Later: player health, bots vs bots, smarter navigation, hit sounds.

import { raycastVoxels, voxelAt } from '../destruction.js';
import { M2V, TILE_M, mToVoxY } from '../physics.js';
import { SHOTS, BLAST_PUSH } from '../config.js';

const m = (v) => v * M2V;                       // metres -> voxels
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const LAVA = 8;                                 // voxel id of lava

// ---------------------------------------------------------------- tuning
const MAX_BOTS = 10;                            // each bot is ~30 cubes of the particle budget
const MAX_RAGDOLLS = 8;
const RAG_LIFE = 25;                            // seconds a corpse lasts (the last 3 s it dissolves)
const BOT_HP = 100;
const BOT_VS_BOT = 0.3;                         // damage multiplier for a bot's shell hitting a bot
const BLAST_DMG = 160;                          // damage at the centre of a blast (falls off to 0 at the reach)
const WALK_SPEED = m(3.2), CHASE_SPEED = m(3.8);
const SIGHT_M = 75;                             // sight range (m)
const FIRE_SLOWDOWN = [2.0, 3.5];               // bots fire slower than the player: cooldown x this
const GRAV = m(20), JUMP = Math.sqrt(2 * 20 * 1.1) * M2V;
const BODY_R = m(0.3), BODY_H = m(1.7), STEP = m(0.4);
const HEIGHTS = [0.5, m(0.6), m(1.2), BODY_H - 1];     // heights collision is sampled at
const HIT_SPHERES = [m(0.4), m(0.95), m(1.45)];        // shells hit 3 spheres stacked up the body
const HIT_R = m(0.42);

const PALETTES = [[0.62, 0.20, 0.14], [0.16, 0.42, 0.55], [0.58, 0.46, 0.12], [0.30, 0.50, 0.20]];
const SKIN = [0.78, 0.62, 0.50];

// ---------------------------------------------------------------- skeleton
const [HEAD, NECK, SHL, SHR, PELV, HIPL, HIPR, ELL, HNL, ELR, HNR, KNL, FTL, KNR, FTR] = Array.from({ length: 15 }, (_, i) => i);
const N = 15;
const LINKS = [                                   // distance constraints (the ragdoll "bones" + braces that keep the torso rigid)
  [HEAD, NECK], [NECK, SHL], [NECK, SHR], [SHL, SHR], [SHL, ELL], [ELL, HNL], [SHR, ELR], [ELR, HNR],
  [NECK, PELV], [SHL, PELV], [SHR, PELV], [PELV, HIPL], [PELV, HIPR], [HIPL, HIPR],
  [HIPL, KNL], [KNL, FTL], [HIPR, KNR], [KNR, FTR],
  [SHL, HIPL], [SHR, HIPR], [SHL, HIPR], [SHR, HIPL], [HEAD, SHL], [HEAD, SHR],
];
const DRAW = [                                    // [from, to, cube edge (voxels), shade]
  [NECK, PELV, 4, 1.0], [SHL, SHR, 3, 1.0], [HIPL, HIPR, 3, 0.8],
  [SHL, ELL, 2, 0.85], [ELL, HNL, 2, 0.85], [SHR, ELR, 2, 0.85], [ELR, HNR, 2, 0.85],
  [HIPL, KNL, 3, 0.7], [KNL, FTL, 2, 0.7], [HIPR, KNR, 3, 0.7], [KNR, FTR, 2, 0.7],
];

// Pose the skeleton for a living bot. b: { x, y, z (feet), fx, fz (facing), phase, walk (0..1), aiming }
function pose(b, o) {
  const fx = b.fx, fz = b.fz, rx = -fz, rz = fx;            // right = forward x up
  const P = (i, r, u, f) => { o[i * 3] = b.x + rx * m(r) + fx * m(f); o[i * 3 + 1] = b.y + m(u); o[i * 3 + 2] = b.z + rz * m(r) + fz * m(f); };
  const w = b.walk;
  const sL = Math.sin(b.phase) * 0.3 * w, sR = -sL;
  const lL = Math.max(0, Math.cos(b.phase)) * 0.14 * w, lR = Math.max(0, -Math.cos(b.phase)) * 0.14 * w;
  P(HEAD, 0, 1.62, 0.03); P(NECK, 0, 1.42, 0.01); P(SHL, -0.2, 1.38, 0); P(SHR, 0.2, 1.38, 0);
  P(PELV, 0, 0.95, 0); P(HIPL, -0.1, 0.9, 0); P(HIPR, 0.1, 0.9, 0);
  P(ELL, -0.26, 1.1, sR * 0.6); P(HNL, -0.27, 0.86, sR + 0.08);
  if (b.aiming) { P(ELR, 0.27, 1.2, 0.28); P(HNR, 0.2, 1.3, 0.58); }          // gun arm out front
  else { P(ELR, 0.26, 1.1, sL * 0.6); P(HNR, 0.27, 0.86, sL + 0.08); }
  P(KNL, -0.1, 0.48 + lL, sL * 0.5 + 0.04); P(FTL, -0.1, 0.04 + lL * 1.6, sL);
  P(KNR, 0.1, 0.48 + lR, sR * 0.5 + 0.04); P(FTR, 0.1, 0.04 + lR * 1.6, sR);
}

// constraint rest lengths come from the standing pose
const REST = (() => {
  const o = new Float32Array(N * 3);
  pose({ x: 0, y: 0, z: 0, fx: 0, fz: -1, phase: 0, walk: 0, aiming: false }, o);
  return LINKS.map(([a, b]) => Math.hypot(o[a * 3] - o[b * 3], o[a * 3 + 1] - o[b * 3 + 1], o[a * 3 + 2] - o[b * 3 + 2]));
})();

function cube(out, cx, cy, cz, edge, col, shade, alpha, emis, seed) {
  const half = edge / 2;
  out.push({
    x: Math.round(cx - half) + half, y: Math.round(cy - half) + half, z: Math.round(cz - half) + half, half,   // on the voxel lattice
    ar: col[0] * shade, ag: col[1] * shade, ab: col[2] * shade, alpha,
    er: emis[0], eg: emis[1], eb: emis[2], seed,
  });
}

// skeleton points -> cubes (works for both the live pose and the ragdoll)
function emitBody(out, P, col, alpha, flash, seed) {
  const emis = [flash, flash * 0.4, flash * 0.15];
  cube(out, P[HEAD * 3], P[HEAD * 3 + 1], P[HEAD * 3 + 2], 4, SKIN, 1, alpha, emis, seed);
  let k = 0;
  for (const [a, b, edge, shade] of DRAW) {
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2], bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay, bz - az) / (edge * 0.9)));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      cube(out, ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t, edge, col, shade, alpha, emis, (seed + 0.137 * k++) % 1);
    }
  }
}

// ---------------------------------------------------------------- the manager
export class Bots {
  // solid(x, y, z): voxel-space solid test. player: the Player (metres). projectiles / lavaGun: the SAME instances the player fires.
  constructor({ world, solid, projectiles, lavaGun, player, count = 3 }) {
    this.world = world;
    this.solid = solid;
    this.projectiles = projectiles;
    this.lavaGun = lavaGun;
    this.player = player;
    this.count = Math.min(MAX_BOTS, Math.max(0, count));   // how many should be alive (dead ones respawn)
    this.bots = [];
    this.ragdolls = [];
    this.pending = [];             // respawn timers
    this.kills = 0;
    this._p = new Float32Array(N * 3);
    this._out = [];
    this.nextCol = 0;
    for (let i = 0; i < this.count; i++) this.spawnRandom();
  }

  // ------------------------------------------------------------ spawning
  spawnRandom() {
    const sps = this.world.spawns;
    const P = this.player;
    const px = P.x * M2V, pz = P.z * M2V;
    let best = null;
    for (let i = 0; i < 8; i++) {                       // prefer a spawn point well away from the player
      const sp = sps[(Math.random() * sps.length) | 0];
      const x = (sp.tx + 0.5) * TILE_M * M2V, z = (sp.tz + 0.5) * TILE_M * M2V;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d > best.d) best = { d, x, z, y: mToVoxY(sp.ym ?? 0) + 2 };
      if (d > m(40)) break;
    }
    return this.spawnAt(best.x, best.y, best.z);
  }

  // drop a bot where the player is looking (B key)
  spawnFromView(origin, forward) {
    const hit = raycastVoxels(this.world, origin, forward, m(60));
    if (!hit) return null;
    return this.spawnAt(hit.point[0] + hit.normal[0] * 3, hit.point[1] + hit.normal[1] * 3 + 2, hit.point[2] + hit.normal[2] * 3);
  }

  spawnAt(x, y, z) {
    if (this.bots.length >= MAX_BOTS) return null;
    const b = {
      x, y, z, vx: 0, vy: 0, vz: 0, fx: 0, fz: -1, dfx: 0, dfz: -1, phase: rnd(0, 6), walk: 0,
      hp: BOT_HP, onGround: false, blocked: false, stuck: 0, hit: 0, aiming: false,
      weapon: 'small', swapT: rnd(3, 8), fireCd: rnd(1, 2), burstT: 0,
      heading: rnd(0, Math.PI * 2), wanderT: 0, sense: 0, see: false, cliff: false, strafeT: 0, strafeDir: 1,
      wx: 0, wz: 0, col: PALETTES[this.nextCol++ % PALETTES.length], seed: Math.random(),
    };
    for (let n = 0; n < 60 && this._blocked(b.x, b.y, b.z); n++) b.y += 1;     // spawned inside something: lift out
    this.bots.push(b);
    return b;
  }

  // ------------------------------------------------------------ collision helpers
  _blocked(x, y, z) {
    const s = this.solid, r = BODY_R;
    for (const h of HEIGHTS) {
      const yy = y + h;
      if (s(x - r, yy, z - r) || s(x + r, yy, z - r) || s(x - r, yy, z + r) || s(x + r, yy, z + r)) return true;
    }
    return false;
  }
  _feetSolid(x, y, z) {
    const s = this.solid, r = BODY_R * 0.7;
    return s(x - r, y, z - r) || s(x + r, y, z - r) || s(x - r, y, z + r) || s(x + r, y, z + r);
  }

  // ------------------------------------------------------------ per-tick
  tick(dt) {
    const P = this.player;
    const px = P.x * M2V, py = mToVoxY(P.y), pz = P.z * M2V;       // player centre (voxels)
    for (let i = this.bots.length - 1; i >= 0; i--) {
      const b = this.bots[i];
      this._think(b, dt, px, py, pz);
      this._move(b, dt);
      this._hazards(b, dt, i);
    }
    for (let i = this.ragdolls.length - 1; i >= 0; i--) {
      const r = this.ragdolls[i];
      r.age += dt;
      if (r.age > RAG_LIFE) { this.ragdolls.splice(i, 1); continue; }
      this._stepRagdoll(r, dt);
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i] -= dt;
      if (this.pending[i] <= 0) { this.pending.splice(i, 1); this.spawnRandom(); }
    }
  }

  // ------------------------------------------------------------ AI
  _think(b, dt, px, py, pz) {
    b.hit = Math.max(0, b.hit - dt);
    b.fireCd -= dt; b.swapT -= dt; b.wanderT -= dt; b.sense -= dt; b.strafeT -= dt;

    const ex = b.x, ey = b.y + m(1.5), ez = b.z;
    const dx = px - ex, dy = py - ey, dz = pz - ez;
    const dist = Math.hypot(dx, dy, dz) || 1, horiz = Math.hypot(dx, dz) || 1;

    // sense (a few times a second): line of sight to the player
    const sensed = b.sense <= 0;
    if (sensed) {
      b.sense = rnd(0.12, 0.25);
      const was = b.see;
      b.see = dist < m(SIGHT_M) && !raycastVoxels(this.world, [ex, ey, ez], [dx / dist, dy / dist, dz / dist], dist - m(0.6));
      if (b.see && !was) b.fireCd = Math.max(b.fireCd, 0.6);       // reaction time before the first shot
    }

    // pick a gun now and then (the same three the player has)
    if (b.swapT <= 0) {
      b.swapT = rnd(6, 12);
      const r = Math.random();
      b.weapon = r < 0.45 ? 'small' : r < 0.7 ? 'big' : 'lava';
      b.burstT = 0;
    }

    let wx = 0, wz = 0, speed = WALK_SPEED;
    if (b.see) {
      b.aiming = true;
      b.dfx = dx / horiz; b.dfz = dz / horiz;                      // face the player
      const want = b.weapon === 'lava' ? m(10) : m(20);            // preferred fighting distance
      const mv = horiz > want * 1.3 ? 1 : horiz < want * 0.6 ? -1 : 0;
      if (b.strafeT <= 0) { b.strafeT = rnd(1.2, 3); b.strafeDir = Math.random() < 0.5 ? -1 : 1; }
      wx = b.dfx * mv + -b.dfz * b.strafeDir * 0.6;
      wz = b.dfz * mv + b.dfx * b.strafeDir * 0.6;
      speed = CHASE_SPEED;
      this._shoot(b, dt, px, py, pz, dist);
    } else {
      b.aiming = false;
      b.burstT = 0;
      if (b.wanderT <= 0) {                                         // new heading: sometimes drift toward the player so they find you
        b.wanderT = rnd(3, 7);
        b.heading = Math.random() < 0.4 && dist < m(120) ? Math.atan2(dz, dx) + rnd(-0.6, 0.6) : rnd(0, Math.PI * 2);
      }
      wx = Math.cos(b.heading); wz = Math.sin(b.heading);
      b.dfx = wx; b.dfz = wz;
    }

    // don't walk off a cliff or into lava
    const wl = Math.hypot(wx, wz);
    if (sensed && b.onGround && wl > 0.1) {
      const ax = b.x + (wx / wl) * m(0.9), az = b.z + (wz / wl) * m(0.9);
      let safe = false;
      for (let k = 0; k <= m(2.5); k += 3) {
        const v = voxelAt(this.world, ax, b.y - k - 0.5, az);
        if (v !== 0) { safe = v !== LAVA; break; }
      }
      b.cliff = !safe;
      if (b.cliff && !b.see) { b.heading += Math.PI * rnd(0.5, 1.5); b.wanderT = rnd(1.5, 4); }
    }
    if (b.cliff) { wx = wz = 0; }
    b.wx = wl > 0.01 ? (wx / Math.max(1, wl)) * speed : 0;
    b.wz = wl > 0.01 ? (wz / Math.max(1, wl)) * speed : 0;

    // blocked by a wall for a moment: jump (and wander elsewhere)
    if (b.blocked && b.onGround) {
      b.stuck += dt;
      if (b.stuck > 0.2) { b.vy = JUMP; b.onGround = false; b.stuck = 0; if (!b.see) { b.heading += rnd(-2, 2); b.wanderT = rnd(2, 5); } }
    } else b.stuck = Math.max(0, b.stuck - dt);
  }

  _shoot(b, dt, px, py, pz, dist) {
    const aligned = b.fx * b.dfx + b.fz * b.dfz > 0.96;
    const lava = b.weapon === 'lava';
    if (lava) {
      if (b.burstT <= 0 && b.fireCd <= 0 && dist < m(40) && aligned) { b.burstT = rnd(0.8, 1.6); b.fireCd = b.burstT + rnd(1.5, 3); }
      if (b.burstT <= 0) return;
      b.burstT -= dt;
    } else if (b.fireCd > 0 || !aligned) return;

    const shot = b.weapon === 'big' ? SHOTS.big : SHOTS.small;
    const speed = lava ? this.lavaGun.speed : shot.speed * M2V;
    const grav = lava ? this.lavaGun.gravity : shot.gravity * M2V;

    // muzzle = the gun hand
    pose(b, this._p);
    let mx = this._p[HNR * 3] + b.fx * m(0.35), my = this._p[HNR * 3 + 1] + m(0.05), mz = this._p[HNR * 3 + 2] + b.fz * m(0.35);
    if (this.solid(mx, my, mz)) { mx = b.x; my = b.y + m(1.5); mz = b.z; }

    // lead the player a little and drop the aim to cancel gravity, then add a human-ish error that grows with distance
    const D = Math.hypot(px - mx, py - my, pz - mz) || 1;
    const t = D / speed, P = this.player;
    const err = m(0.5) + D * 0.025;
    const tx = px + P.vx * M2V * t * 0.5 + rnd(-1, 1) * err;
    const ty = py + 0.5 * grav * t * t + rnd(-1, 1) * err * 0.6;
    const tz = pz + P.vz * M2V * t * 0.5 + rnd(-1, 1) * err;
    let dx = tx - mx, dy = ty - my, dz = tz - mz;
    const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;

    if (lava) {
      this.lavaGun.emit(dt, [mx, my, mz], [dx, dy, dz], [b.vx, b.vy, b.vz]);
    } else {
      this.projectiles.spawn([mx, my, mz], [dx * speed + b.vx, dy * speed + b.vy, dz * speed + b.vz],
        { gravity: grav, radiusM: shot.radiusM, big: shot.big, owner: b });
      b.fireCd = shot.cooldown * rnd(FIRE_SLOWDOWN[0], FIRE_SLOWDOWN[1]);
    }
  }

  // ------------------------------------------------------------ movement (own simple voxel physics, not Rapier)
  _move(b, dt) {
    const k = Math.min(1, (b.onGround ? 12 : 3) * dt);
    b.vx += (b.wx - b.vx) * k; b.vz += (b.wz - b.vz) * k;
    b.blocked = false;
    this._slide(b, b.vx * dt, 0);
    this._slide(b, 0, b.vz * dt);

    b.vy -= GRAV * dt * (b.vy < 0 ? 1.5 : 1);
    const ny = b.y + b.vy * dt;
    if (b.vy <= 0 && this._feetSolid(b.x, ny, b.z)) { b.y = Math.floor(ny) + 1; b.vy = 0; b.onGround = true; }
    else if (b.vy > 0 && this._blocked(b.x, ny, b.z)) { b.vy = 0; b.onGround = false; }
    else { b.y = ny; b.onGround = false; }

    // turn toward the wanted facing
    const t = Math.min(1, 9 * dt);
    b.fx += (b.dfx - b.fx) * t; b.fz += (b.dfz - b.fz) * t;
    const fl = Math.hypot(b.fx, b.fz) || 1; b.fx /= fl; b.fz /= fl;

    // walk cycle
    const sp = Math.hypot(b.vx, b.vz);
    b.walk += (Math.min(1, sp / m(3)) - b.walk) * Math.min(1, 8 * dt);
    b.phase += (sp / m(1.4)) * Math.PI * 2 * dt;
  }

  _slide(b, dx, dz) {
    const nx = b.x + dx, nz = b.z + dz;
    if (!this._blocked(nx, b.y, nz)) { b.x = nx; b.z = nz; return; }
    if (b.onGround) {                                               // climb small ledges
      for (let s = 2; s <= STEP; s += 2) {
        if (!this._blocked(nx, b.y + s, nz)) { b.x = nx; b.z = nz; b.y += s; return; }
      }
    }
    b.blocked = true;
    if (dx) b.vx = 0;
    if (dz) b.vz = 0;
  }

  _hazards(b, dt, index) {
    if (b.y < -40 || b.x < 0 || b.z < 0 || b.x >= this.world.size.x || b.z >= this.world.size.z) {   // fell out of the world: just respawn
      this.bots.splice(index, 1); this._queueRespawn(); return;
    }
    if (voxelAt(this.world, b.x, b.y - 0.5, b.z) === LAVA || voxelAt(this.world, b.x, b.y + 1, b.z) === LAVA) {
      b.hp -= 60 * dt; b.hit = 0.15;
      if (b.hp <= 0) this._die(b, null, index);
    }
  }

  _queueRespawn() {
    if (this.bots.length + this.pending.length < this.count) this.pending.push(rnd(4, 7));
  }

  // ------------------------------------------------------------ damage
  // Every explosion calls this (c: centre in voxels, radiusM: blast radius in metres). Hurts / throws bots and corpses.
  blast(c, radiusM, owner = null) {
    const dmgScale = owner ? BOT_VS_BOT : 1;                      // bots' own shells hurt bots much less than yours do
    const reach = m(radiusM * 2.4);
    const push = BLAST_PUSH * M2V * Math.sqrt(radiusM / 2);       // voxels/s at point-blank
    for (let i = this.bots.length - 1; i >= 0; i--) {
      const b = this.bots[i];
      const cx = b.x, cy = b.y + m(0.95), cz = b.z;
      const d = Math.hypot(cx - c[0], cy - c[1], cz - c[2]);
      if (d >= reach) continue;
      const k = 1 - d / reach;
      b.hp -= BLAST_DMG * k * dmgScale; b.hit = 0.3;
      if (b.hp <= 0) { this._die(b, { c, s: push * (0.6 + k) }, i); continue; }
      const l = d || 1;
      b.vx += ((cx - c[0]) / l) * push * k; b.vz += ((cz - c[2]) / l) * push * k;
      b.vy = Math.max(b.vy, 0) + (Math.max((cy - c[1]) / l, 0.35)) * push * k; b.onGround = false;
    }
    for (const r of this.ragdolls) {                              // corpses get thrown around too
      for (let i = 0; i < N; i++) {
        const o = i * 3;
        const dx = r.pts[o] - c[0], dy = r.pts[o + 1] - c[1], dz = r.pts[o + 2] - c[2];
        const d = Math.hypot(dx, dy, dz);
        if (d >= reach) continue;
        const s = push * (1 - d / reach) / 60 / (d || 1);          // per-tick displacement (Verlet velocity)
        r.prev[o] -= dx * s; r.prev[o + 1] -= (dy + d * 0.35) * s; r.prev[o + 2] -= dz * s;
      }
    }
  }

  // Do the shells hit a bot? Ray from (x,y,z) along dir for len voxels -> distance of the first hit or null.
  // Projectiles calls this every step (see projectiles.hitBots). owner = the bot that fired it (can't shoot itself).
  rayHit(x, y, z, dir, len, owner) {
    let best = null;
    for (const b of this.bots) {
      if (b === owner) continue;
      for (const h of HIT_SPHERES) {
        const ox = b.x - x, oy = b.y + h - y, oz = b.z - z;
        const tca = ox * dir[0] + oy * dir[1] + oz * dir[2];
        const d2 = ox * ox + oy * oy + oz * oz - tca * tca;
        if (d2 > HIT_R * HIT_R) continue;
        const thc = Math.sqrt(HIT_R * HIT_R - d2);
        if (tca + thc < 0) continue;
        const t = Math.max(0, tca - thc);
        if (t <= len && (best === null || t < best)) best = t;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ death + ragdoll
  // blast: { c, s } = explosion centre + speed (voxels/s) that threw the body, or null (lava etc: just drops)
  _die(b, blast, index) {
    this.bots.splice(index, 1);
    this.kills++;
    const pts = new Float32Array(N * 3), prev = new Float32Array(N * 3);
    pose(b, pts);
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      let vx = b.vx + rnd(-1, 1) * m(0.3), vy = b.vy + rnd(-1, 1) * m(0.3), vz = b.vz + rnd(-1, 1) * m(0.3);
      if (blast) {
        const dx = pts[o] - blast.c[0], dy = pts[o + 1] - blast.c[1], dz = pts[o + 2] - blast.c[2];
        const l = Math.hypot(dx, dy, dz) || 1, s = blast.s * rnd(0.7, 1.2);
        vx += (dx / l) * s; vy += (dy / l + 0.35) * s; vz += (dz / l) * s;
      }
      prev[o] = pts[o] - vx / 60; prev[o + 1] = pts[o + 1] - vy / 60; prev[o + 2] = pts[o + 2] - vz / 60;
    }
    this.ragdolls.push({ pts, prev, safe: new Float32Array(N * 3), age: 0, col: b.col, seed: b.seed });
    if (this.ragdolls.length > MAX_RAGDOLLS) this.ragdolls.shift();
    this._queueRespawn();
  }

  // Verlet: move every point by its own velocity + gravity, bounce off voxels, then pull the joints back to their rest lengths.
  _stepRagdoll(r, dt) {
    const { pts, prev, safe } = r, s = this.solid;
    const g = GRAV * 1.2 * dt * dt;
    for (let i = 0; i < N; i++) {
      const o = i * 3;
      const x = pts[o], y = pts[o + 1], z = pts[o + 2];
      let vx = (x - prev[o]) * 0.995, vy = (y - prev[o + 1]) * 0.995 - g, vz = (z - prev[o + 2]) * 0.995;
      let nx = x + vx, ny = y + vy, nz = z + vz;
      if (s(nx, y, z)) { vx = -vx * 0.2; nx = x; }
      if (s(nx, ny + (vy < 0 ? -1 : 1), z)) {                      // floor / ceiling (the cube hangs ~1 voxel around its point)
        vy = Math.abs(vy) < 0.2 ? 0 : -vy * 0.2; ny = y; vx *= 0.8; vz *= 0.8;
      }
      if (s(nx, ny, nz)) { vz = -vz * 0.2; nz = z; }
      prev[o] = nx - vx; prev[o + 1] = ny - vy; prev[o + 2] = nz - vz;
      pts[o] = safe[o] = nx; pts[o + 1] = safe[o + 1] = ny; pts[o + 2] = safe[o + 2] = nz;
    }
    for (let it = 0; it < 6; it++) {
      for (let k = 0; k < LINKS.length; k++) {
        const a = LINKS[k][0] * 3, b = LINKS[k][1] * 3;
        const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1], dz = pts[b + 2] - pts[a + 2];
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) continue;
        const f = ((d - REST[k]) / d) * 0.5;
        pts[a] += dx * f; pts[a + 1] += dy * f; pts[a + 2] += dz * f;
        pts[b] -= dx * f; pts[b + 1] -= dy * f; pts[b + 2] -= dz * f;
      }
    }
    for (let i = 0; i < N; i++) {                                  // a joint got shoved into a wall: put it back
      const o = i * 3;
      if (s(pts[o], pts[o + 1], pts[o + 2])) { pts[o] = safe[o]; pts[o + 1] = safe[o + 1]; pts[o + 2] = safe[o + 2]; }
    }
  }

  // ------------------------------------------------------------ drawing: bodies as particle cubes for Particles.pack(extras)
  cubes(alpha, out = this._out) {
    out.length = 0;
    for (const b of this.bots) {
      pose(b, this._p);
      const flash = b.hit > 0 ? 2.0 * Math.min(1, b.hit / 0.15) : 0;     // white-orange flash when hurt
      emitBody(out, this._p, b.col, 1, flash, b.seed);
      const P = this._p, lava = b.weapon === 'lava';                     // the gun in the right hand
      const gem = lava ? [1.4, 0.45, 0.1] : [0, 0, 0];
      for (let i = 0; i < 2; i++) {
        const f = m(0.1 + 0.16 * i);
        cube(out, P[HNR * 3] + b.fx * f, P[HNR * 3 + 1], P[HNR * 3 + 2] + b.fz * f, 2, [0.08, 0.08, 0.09], 1, 1, gem, b.seed);
      }
    }
    for (const r of this.ragdolls) {
      const fade = Math.min(1, (RAG_LIFE - r.age) / 3);
      emitBody(out, r.pts, r.col, fade, 0, r.seed);
    }
    return out;
  }
}
