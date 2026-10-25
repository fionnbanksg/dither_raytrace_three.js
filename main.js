import * as THREE from 'three';
import { buildWorld, PALETTE, T } from './world.js';
import { createWorldTextures, createGlowTexture, createParticleTexture, createTextureUploader } from './render/textures.js';
import { createUniforms, applySkyUniforms } from './render/uniforms.js';
import { createPipeline } from './render/pipeline.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { createPhysics, FIXED_DT, TILE_M, M2V, mToVoxX, mToVoxY, mToVoxZ } from './physics.js';
import { explode, voxelAt, warmUp } from './destruction.js';
import { Particles } from './particles.js';
import { Projectiles } from './projectiles.js';
import { createLights } from './game/lights.js';
import { createWeapons } from './game/weapons.js';
import { createDebugHud } from './game/debugHud.js';
import { Minimap } from './minimap.js';
import { LavaSim } from './lava.js';
import { skyState, SkyClock } from './sky.js';
import { LavaGlow, warmUpGlow } from './lavaglow.js';
import { settings, setSetting, onSettingChange } from './settings.js';
import { createOverlay } from './ui/overlay.js';
import { createLoading } from './ui/loading.js';
import { createMenu } from './ui/menu.js';

// all tunable settings live in config.js
import {
  MINIMAP_FOG,
  MAX_FRAME_DT,
  BLAST_RADIUS_M,
  BLAST_PUSH,
  DEBRIS_PER_BLAST,
  SHOTS,
  INHERIT_VELOCITY,
} from './config.js';

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);

// ---------------------------------------------------------------- UI overlay + loading screen
// The UI is drawn inside the canvas at the internal resolution and dithered like the world (see ui/overlay.js).
const overlay = createOverlay({ renderer, canvas });
const loading = createLoading(overlay);
loading.begin();
// Paint the loading screen before each heavy synchronous step (world generation etc. block the page while they run).
const nextPaint = () => new Promise((res) => requestAnimationFrame(() => { overlay.render(performance.now() / 1000); res(); }))
  .then(() => new Promise((r) => setTimeout(r, 0)));
async function stage(label, frac) { loading.set(label, frac); await nextPaint(); }

await stage('GENERATING WORLD', 0.03);

// Same seed => same level on every client. Multiplayer: have the server send this number.
// Try ?seed=1234 in the URL; with no seed a random one is picked and written to the URL so you can share it.
const params = new URLSearchParams(location.search);
const seed = Number.isFinite(parseInt(params.get('seed'), 10)) ? parseInt(params.get('seed'), 10) : (Math.random() * 1e9) | 0;
if (!params.has('seed')) { params.set('seed', seed); history.replaceState(null, '', '?' + params); }
const world = buildWorld(seed);
loading.set('GENERATING WORLD', 0.03, `SEED ${seed}`);

await stage('UPLOADING VOXELS', 0.3);

const { voxelTex, coarseTex, superTex, refreshSuper } = createWorldTextures(world);

const gl = renderer.getContext();
const maxTex3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
if (Math.max(world.size.x, world.size.y, world.size.z) > maxTex3D) {
  console.warn(`World is ${world.size.x}x${world.size.y}x${world.size.z} but this GPU's max 3D texture size is ${maxTex3D}. Lower T in world.js.`);
}

const solidVoxel = (x, y, z) => {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= world.size.x || iz >= world.size.z) return true;
  if (iy >= world.size.y) return false;               // open sky above the volume
  return world.data[ix + world.size.x * (iy + world.size.y * iz)] !== 0;
};

// Lava sim + its glow field. Resting lava cells feed a coarse 3D texture (lavaglow.js) that the shader samples to
// light every solid surface near them, so blobs on the ground glow onto walls, floors and props around them.
const LAVA_GLOW_COL = new THREE.Vector3(1.0, 0.38, 0.09).multiplyScalar(3.0);   // colour * strength of the glow
const lava = new LavaSim(world, { cell: 2, width: 1, viscosity: 0.6, reach: 8, period: 15, passes: 15 });
const lavaGlow = new LavaGlow(world, lava);
const glowTex = createGlowTexture(lavaGlow);

// Day / night clock. ?time=0.3 sets the start (0 sunrise, .25 noon, .5 sunset, .75 midnight), ?day=240 the cycle length in seconds (0 = frozen).
const num = (k, d) => (Number.isFinite(parseFloat(params.get(k))) ? parseFloat(params.get(k)) : d);
const skyClock = new SkyClock(num('time', 0.3), num('day', 240));
const v3 = (a) => new THREE.Vector3(...a);
const skyU = skyState(skyClock.tod);

const palette = Array.from({ length: 12 }, (_, i) => new THREE.Vector3(...(PALETTE[i] ?? [1, 0, 1])));

await stage('LIGHTING SETUP', 0.45);

// Lights: slot 0 = player torch, then braziers, then shells / explosion flashes (see game/lights.js)
const lights = createLights(world);
const { MAX_LIGHTS, lightPos, lightCol, staticLights, BASE_LIGHTS, lightCount, flashes } = lights;

// Explosion particles live on the CPU; their packed state is uploaded as a small float texture
// that the shader reads (see applyParticles in shader.js).
const particles = new Particles(solidVoxel, M2V);
const particleTex = createParticleTexture(particles);

const uniforms = createUniforms({
  world, voxelTex, coarseTex, superTex, particleTex, glowTex, lavaGlow,
  lightPos, lightCol, lightCount, palette, skyU, LAVA_GLOW_COL, v3,
});
const applySky = (st) => applySkyUniforms(uniforms, st);   // push a sky state into the shader uniforms

const { material, lightMaterial, scene, lightScene, camera, lightRT, lightUniforms, useLightBuffer, resize } = createPipeline({ renderer, canvas, uniforms });

await stage('BUILDING COLLISION', 0.55);

// ---------------------------------------------------------------- physics + player
const physics = await createPhysics(world);   // collision mesh + Rapier world (a second or two)

await stage('WARMING UP', 0.8);
warmUp();   // JIT the explosion code on a scratch grid so the first real blast doesn't hitch
warmUpGlow();   // same for the lava glow solver

// world.spawns are spread across the map (farthest-point sampling). Multiplayer: the server assigns the index.
const spawnPoint = world.spawns[(parseInt(params.get('spawn'), 10) || 0) % world.spawns.length];
const spawn = { x: (spawnPoint.tx + 0.5) * TILE_M, y: spawnPoint.ym ?? 0, z: (spawnPoint.tz + 0.5) * TILE_M };
const player = new Player(physics, spawn);    // tweak the feel: new Player(physics, spawn, { walkSpeed: 5, jumpHeight: 1.3 })
const input = new Input(canvas, { yaw: spawnPoint.yaw });   // spawn facing along the longest open run

const minimapCanvas = document.getElementById('minimap');
const minimap = minimapCanvas ? new Minimap(minimapCanvas, world, { fog: MINIMAP_FOG }) : null;
const mapCap = document.getElementById('mapcap');
if (mapCap) mapCap.textContent = `SEED ${seed}`;

const hint = document.getElementById('hint');
const modeEl = document.getElementById('mapcap');   // reuse the caption under the minimap for the gun mode
if (hint) hint.textContent = 'Esc: menu (settings) · Click to look · WASD move · Shift sprint · Space jump · F fly (Space up, C down) · M map · T time of day (normal / fast / paused) · F3 debug · Esc release mouse · Shift+L: clear lava · Scroll wheel (or G): swap grenades / LAVA GUN · Click: fire (lava gun: hold to spray) · Right click: heavy shell (hold to keep firing)';

const stats = { shots: 0, blasts: 0, lastBlast: null };   // counters updated by shoot() / detonate(), shown in the F3 overlay



// ---------------------------------------------------------------- explosions
// 1. explode() edits world.data (voxels + coarse grid) on the CPU
// 2. the changed box is pushed to the GPU texture with texSubImage3D (not the whole 80 MB volume)
// 3. physics.updateRegion() works out which collision chunks changed; flushPending() re-meshes them a few ms per frame
const uploadBox = createTextureUploader(renderer);   // see render/textures.js
function uploadVoxelBox(box) { uploadBox(voxelTex, world.data, world.size, box); }
function uploadGlowBox(box) { uploadBox(glowTex, lavaGlow.data, lavaGlow.size, box); }

// Carve the crater, throw particles, flash the lights, knock the player back.
// point / normal: where the shell hit (voxels). normal = [0,0,0] means an airburst.
function detonate(point, normal, radiusM) {
  const R = radiusM * M2V;                                    // metres -> voxels
  const c = point.map((p, i) => p + normal[i] * R * 0.3);     // nudge out of the wall so the crater opens into the room
  const debris = [];
  const t0 = performance.now();
  const box = explode(world, c, R, {
    keepClear: [{ x: mToVoxX(player.x), z: mToVoxZ(player.z), r: 0.9 * M2V }],   // no rubble under the player's feet
    debrisOut: debris, debrisMax: DEBRIS_PER_BLAST,
  });

  if (box) {
    uploadVoxelBox(box);
    coarseTex.needsUpdate = true;                             // 157 KB, cheap to re-upload whole
    refreshSuper(box);
    physics.updateRegion(box, { defer: true });               // collision chunks are rebuilt a few ms per frame (physics.flushPending in frame())
    minimap?.refresh(box);                                    // craters show up on the map

    // braziers whose flame voxel was destroyed go out
    staticLights.forEach((l) => { if (!l.dead && voxelAt(world, ...l.anchor) !== 6) l.dead = true; });
    lava.notifyCarved(box);                                   // blasts can carve lava away / open new paths for it
    lavaGlow.carved(box);                                     // ...and open or close paths for its light
    // time spent inside this click's frame (the collision rebuild is no longer part of it)
    stats.lastBlast = { dims: `${box.x1 - box.x0}x${box.y1 - box.y0}x${box.z1 - box.z0}`, ms: performance.now() - t0 };
  }

  stats.blasts++;
  particles.burst(c, normal[0] || normal[1] || normal[2] ? normal : [0, 1, 0], radiusM / BLAST_RADIUS_M, debris);

  // light flash + knockback
  flashes.push({ pos: c, t0: performance.now() / 1000, scale: radiusM / BLAST_RADIUS_M });
  if (flashes.length > MAX_LIGHTS - BASE_LIGHTS) flashes.shift();

  const px = mToVoxX(player.x), py = mToVoxY(player.y), pz = mToVoxZ(player.z);
  let dx = px - c[0], dy = py - c[1], dz = pz - c[2];
  const dist = Math.hypot(dx, dy, dz) / M2V;                  // metres
  const reach = radiusM * 2.4;
  if (dist < reach) {
    const k = 1 - dist / reach;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const s = BLAST_PUSH * k * Math.sqrt(radiusM / BLAST_RADIUS_M);
    player.knock(dx * s, Math.max(dy, 0.35) * s, dz * s);
  }
  shake = Math.max(shake, settings.shake * Math.min(1, Math.sqrt(radiusM / BLAST_RADIUS_M)) * Math.max(0, 1 - dist / (radiusM * 6)));
}

// ---------------------------------------------------------------- gun + projectiles
const eye = new THREE.Vector3();   // camera position in voxels, refreshed by player.eyeVoxels(eye)
let shake = 0;                     // camera shake, decays after a blast (set by detonate(), used by the frame loop)
const projectiles = new Projectiles(world, {
  onImpact: ({ point, normal, radiusM }) => detonate(point, normal, radiusM),
  onTrail: (x, y, z, big) => particles.trail(x, y, z, big),
});

const weapons = createWeapons({ world, player, input, eye, lava, projectiles, stats, uniforms });
const { gun, lavaGun, aimGun, shoot, selectGun } = weapons;   // gun = shared gun state, see game/weapons.js

// ---------------------------------------------------------------- F3 debug overlay + hotkeys
const debug = createDebugHud({ renderer, canvas, uniforms, world, physics, player, input, eye, projectiles, particles,
                               stats, flashes, MAX_LIGHTS, gun, getShake: () => shake });
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) minimap?.toggle();
  if (e.code === 'KeyT' && !e.repeat) { const m = skyClock.cycle(); const h = document.getElementById('hint'); if (h) { const old = h.textContent; h.textContent = 'Time: ' + m; setTimeout(() => { h.textContent = old; }, 1500); } }
  if (e.code === 'F3') { e.preventDefault(); if (!e.repeat && debug) { debug.toggle(); setSetting('debug', debug.on); } }
});

// ---------------------------------------------------------------- menu + settings
// Settings (settings.js) are edited by the in-game menu (ui/menu.js). Push each change to where it takes effect.
const BASE_SENS = input.sens;
function applySettings() {
  uniforms.uLevels.value = settings.ditherLevels;                       // light pass shares these uniform objects
  uniforms.uDither.value = settings.ditherStrength;
  uniforms.uTanHalf.value = Math.tan(THREE.MathUtils.degToRad(settings.fov) / 2);
  input.sens = BASE_SENS * settings.mouseSens;
}
applySettings();
const menu = createMenu({
  overlay, canvas, input, getSeed: () => seed,
  onPlay: () => { canvas.requestPointerLock?.()?.catch?.(() => {}); },   // the browser refuses for ~1 s after Esc: just ignore
  // New game: the world, textures and physics are all built at startup, so the cleanest reset is a reload with no
  // ?seed= (a fresh random one is picked and written to the URL). Settings are kept (localStorage).
  onNewGame: () => {
    const q = new URLSearchParams(location.search);
    q.delete('seed'); q.delete('spawn');
    const qs = q.toString();
    location.href = location.pathname + (qs ? '?' + qs : '');
  },
});
onSettingChange((key, value) => {
  if (key === 'internalHeight') { overlay.resize(); resize(); }          // new internal resolution: UI buffer, render size, light target
  if (key === 'debug' && debug && debug.on !== value) debug.toggle();
  applySettings();
  menu.refresh();
});

// ---------------------------------------------------------------- lava
// LavaSim (lava.js) writes id-8 voxels into world.data; we push the changed box to the GPU like explosions do.
const LAVA_STEP = 1 / 30;                 // sim ticks per second: 30
let lavaAcc = 0;

addEventListener('keydown', (e) => {
  if (e.code !== 'KeyL' || e.repeat) return;
  if (e.shiftKey) { lava.clear(); const b = lava.flush(); if (b) { uploadVoxelBox(b); coarseTex.needsUpdate = true; refreshSuper(b); } }
});


// ---------------------------------------------------------------- loop
// frame() just calls the small steps below, in this order. Each step is one job; edit the step, not frame().
let last = performance.now();
let acc = 0;               // leftover time for the fixed-step simulation (see stepSimulation)
let particlesLive = false;

// 1. fixed-timestep simulation (60 Hz); rendering interpolates between ticks
function stepSimulation(dt) {
    input.frameUpdate(dt);
    acc += dt;
    while (acc >= FIXED_DT) {
      player.tick(input.sample());
      projectiles.update(FIXED_DT);
      lavaGun.update(FIXED_DT);
      acc -= FIXED_DT;
    }
}

// 2. gun controls: scroll / G swap animation, then fire (grenades or lava spray)
function updateGunControls(dt) {
    const wheel = input.consumeWheel();                          // trackpads spam events: ignore them while a swap is running
    if (wheel && input.locked && gun.swapT >= 1) selectGun(!gun.wantLava);
    if (gun.swapT < 1) {
      gun.swapT = Math.min(1, gun.swapT + dt / 0.32);
      if (gun.swapT >= 0.5 && gun.lavaMode !== gun.wantLava) {                 // gun is off-screen: swap the model
        gun.lavaMode = gun.wantLava;
        uniforms.uGunType.value = gun.lavaMode ? 1 : 0;
        if (modeEl) modeEl.textContent = `SEED ${seed} · ${gun.lavaMode ? 'LAVA GUN' : 'GRENADES'}`;
        gun.cooldown = Math.max(gun.cooldown, 0.1);
      }
    }
    const fire = input.consumeFire() || input.fireHeld;
    gun.cooldown -= dt;
    if (gun.swapT < 1) { /* gun is changing */ }
    else if (gun.lavaMode && fire === 1 && input.locked) {
      const { start, dir } = aimGun();
      lavaGun.emit(dt, start, dir, [player.vx * M2V * INHERIT_VELOCITY, player.vy * M2V * INHERIT_VELOCITY, player.vz * M2V * INHERIT_VELOCITY]);
      gun.muzzle = Math.max(gun.muzzle, 0.55);                     // keep the muzzle glowing while it sprays
      gun.kick = Math.max(gun.kick, 0.12);
    } else if (fire && gun.cooldown <= 0 && input.locked) shoot(fire === 2 ? SHOTS.big : SHOTS.small);
}

// 3. player: finish queued collision rebuilds, then smooth the player's render position
function updatePlayer(dt) {
    physics.flushPending(3, [mToVoxX(player.x), mToVoxZ(player.z)]);   // finish queued collision rebuilds, ~3 ms per frame (nearest the player first)

    player.alpha = acc / FIXED_DT;
    player.frameUpdate(dt);
}

// 4. camera: look direction (with blast shake) and position -> shader uniforms. Returns the right vector (the torch needs it)
function updateCamera(dt) {
    // camera uses the freshest look angles, not the last tick's
    const { forward, right, up } = Player.basis(input.yaw, input.pitch);
    player.eyeVoxels(eye);
    uniforms.uCamPos.value.copy(eye);
    if (shake > 0.01) {
      const k = shake * shake * 0.03;                        // look wobble (radians-ish)
      const sx = Math.random() * 2 - 1, sy = Math.random() * 2 - 1;
      uniforms.uCamFwd.value.set(forward[0] + right[0] * sx * k + up[0] * sy * k, forward[1] + right[1] * sx * k + up[1] * sy * k, forward[2] + right[2] * sx * k + up[2] * sy * k).normalize();
      shake *= Math.exp(-5 * dt);
    } else {
      shake = 0;
      uniforms.uCamFwd.value.set(...forward);
    }
    uniforms.uCamRight.value.set(...right);
    uniforms.uCamUp.value.set(...up);
  return right;
}

// 5. lava: fixed-rate sim, upload changed voxels, refresh the glow field
function updateLava(dt) {
    // lava: fixed-rate sim, upload the dirty box, then refresh the glow field
    lavaAcc += dt;
    for (let n = 0; lavaAcc >= LAVA_STEP && n < 3; n++) { lava.step(); lavaAcc -= LAVA_STEP; }
    if (lavaAcc > LAVA_STEP * 3) lavaAcc = 0;
    const lbox = lava.flush();
    if (lbox) { uploadVoxelBox(lbox); coarseTex.needsUpdate = true; refreshSuper(lbox); }
    const gbox = lavaGlow.update(dt);                           // rebuilds (<= ~7x/s) only when lava changed; light spreads from resting cells
    if (gbox) uploadGlowBox(gbox);
}

// 6. particles: simulate, pack, upload only while something is alive
function updateParticles(dt) {
    // particles: simulate, pack, upload only while something is alive
    particles.update(dt);
    const shells = projectiles.cubes(acc / FIXED_DT).concat(lavaGun.cubes(acc / FIXED_DT));
    if (particles.count > 0 || shells.length > 0 || particlesLive) {
      particles.pack(shells);
      uniforms.uParticleCount.value = particles.packed;
      uniforms.uPBound.value.set(...particles.bound);
      particleTex.needsUpdate = true;
      particlesLive = particles.count > 0 || shells.length > 0;
    }
}

// 7. draw: half-res light pass first (if enabled), then the full-res pass
function renderScene() {
    if (useLightBuffer) {
      renderer.setRenderTarget(lightRT);
      renderer.render(lightScene, camera);
      renderer.setRenderTarget(null);
    }
    renderer.render(scene, camera);
}

function frame(now) {
  const cpuStart = performance.now();
  const rawMs = now - last;
  const dt = Math.min(MAX_FRAME_DT, rawMs / 1000);
  last = now;
  const time = now / 1000;

  uniforms.uTime.value = time;
  skyClock.update(dt);
  applySky(skyState(skyClock.tod));

  stepSimulation(dt);
  updateGunControls(dt);
  updatePlayer(dt);
  const right = updateCamera(dt);

  lights.update({ eye, right, player, solidVoxel, projectiles, lavaGun, uniforms, alpha: acc / FIXED_DT, dt, time });
  weapons.animate(dt, time);

  updateLava(dt);
  updateParticles(dt);
  minimap?.draw({ x: mToVoxX(player.x), z: mToVoxZ(player.z), yaw: input.yaw }, time);

  renderScene();
  if (menu.update(dt)) overlay.render(time);                  // dithered UI on top of the world (only while the menu is up)
  debug?.frame(rawMs, performance.now() - cpuStart);
  requestAnimationFrame(frame);
}

// Compile both shaders now (a few seconds) instead of hitching on the first frame, then hand over to the game.
await stage('COMPILING SHADERS', 0.88);
try { await renderer.compileAsync(lightScene, camera); await renderer.compileAsync(scene, camera); } catch (e) { console.warn('shader precompile failed', e); }
loading.set('READY', 1);
await nextPaint();
loading.end();
overlay.onResize = () => menu.refresh();
document.body.classList.remove('loading');
last = performance.now();
requestAnimationFrame(frame);
