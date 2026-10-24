import * as THREE from 'three';
import { buildWorld, PALETTE, T } from './world.js';
import { vert, frag } from './shader.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { createPhysics, FIXED_DT, TILE_M, M2V, mToVoxX, mToVoxY, mToVoxZ } from './physics.js';
import { explode, raycastVoxels, voxelAt, warmUp } from './destruction.js';
import { Particles, MAX_PARTICLES, TEXELS } from './particles.js';
import { Projectiles } from './projectiles.js';
import { DebugOverlay } from './debug.js';
import { Minimap } from './minimap.js';
import { LavaSim } from './lava.js';
import { skyState, SkyClock } from './sky.js';
import { LavaGlow, warmUpGlow } from './lavaglow.js';
import { LavaGun } from './lavagun.js';

// ---------------------------------------------------------------- settings
const INTERNAL_HEIGHT = 360;   // render resolution (width follows aspect ratio)
const DITHER_LEVELS   = 14;    // colour levels per channel (lower = grittier)
const DITHER_STRENGTH = 0.7;   // 0 = flat banding, 1 = full Bayer pattern
const FOV_DEG         = 70;    // vertical FOV
const MINIMAP_FOG    = false; // true = the map is only revealed around where you have walked
const SHOW_DEBUG      = false; // start with the F3 debug overlay open
const MAX_FRAME_DT    = 0.1;   // clamp to avoid a spiral of death after a tab switch
const BLAST_RADIUS_M  = 2.0;   // left click: crater radius in metres (a tile is 4 m wide)
const BIG_BLAST_MUL   = 1.8;   // right click: bigger blast
const BLAST_PUSH      = 13;    // m/s of knockback at point-blank range
const FLASH_LIFE      = 1.4;   // seconds the explosion light lasts (it lingers while the fire burns)
const FLASH_PEAK      = 14;    // explosion light intensity (braziers are 3, torch 2.2)
const SHAKE_AMOUNT    = 1.0;   // camera shake strength for a nearby blast (0 = off)
const DEBRIS_PER_BLAST = 56;   // chunks of the destroyed material thrown out (max)

// gun: left click = grenade, right click = heavy shell (slower, bigger, drops more). Hold to keep firing.
const SHOTS = {
  small: { speed: 34, gravity: 6.0, radiusM: BLAST_RADIUS_M,                 cooldown: 0.32, kick: 1.0, big: false },
  big:   { speed: 22, gravity: 6.0, radiusM: BLAST_RADIUS_M * BIG_BLAST_MUL, cooldown: 0.90, kick: 1.8, big: true  },
};
const INHERIT_VELOCITY = 1.0;  // fraction of the player's own velocity added to the shot
const AIM_CONVERGE_M   = 40;   // the barrel is off-centre, so shots are aimed at what the crosshair sees (up to this far)
const GUN_TIP = [4.8, -4.2, 24];   // muzzle position in camera space (voxels): x right, y up, z forward

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);

// Same seed => same level on every client. Multiplayer: have the server send this number.
// Try ?seed=1234 in the URL; with no seed a random one is picked and written to the URL so you can share it.
const params = new URLSearchParams(location.search);
const seed = Number.isFinite(parseInt(params.get('seed'), 10)) ? parseInt(params.get('seed'), 10) : (Math.random() * 1e9) | 0;
if (!params.has('seed')) { params.set('seed', seed); history.replaceState(null, '', '?' + params); }
const world = buildWorld(seed);

const voxelTex = new THREE.Data3DTexture(world.data, world.size.x, world.size.y, world.size.z);
voxelTex.format = THREE.RedFormat;
voxelTex.type = THREE.UnsignedByteType;
voxelTex.minFilter = voxelTex.magFilter = THREE.NearestFilter;
voxelTex.unpackAlignment = 1;
voxelTex.needsUpdate = true;   // set again after editing world.data at runtime

// coarse occupancy grid (8^3 bricks) used by the shader to skip empty space
const coarseTex = new THREE.Data3DTexture(world.coarse, world.coarseSize.x, world.coarseSize.y, world.coarseSize.z);
coarseTex.format = THREE.RedFormat;
coarseTex.type = THREE.UnsignedByteType;
coarseTex.minFilter = coarseTex.magFilter = THREE.NearestFilter;
coarseTex.unpackAlignment = 1;
coarseTex.needsUpdate = true;   // set again (and rebuild world.coarse) after editing voxels

const gl = renderer.getContext();
const maxTex3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
if (Math.max(world.size.x, world.size.y, world.size.z) > maxTex3D) {
  console.warn(`World is ${world.size.x}x${world.size.y}x${world.size.z} but this GPU's max 3D texture size is ${maxTex3D}. Lower T in world.js.`);
}

const solidVoxel = (x, y, z) => {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= world.size.x || iy >= world.size.y || iz >= world.size.z) return true;
  return world.data[ix + world.size.x * (iy + world.size.y * iz)] !== 0;
};

// Lava sim + its glow field. Resting lava cells feed a coarse 3D texture (lavaglow.js) that the shader samples to
// light every solid surface near them, so blobs on the ground glow onto walls, floors and props around them.
const LAVA_GLOW_COL = new THREE.Vector3(1.0, 0.38, 0.09).multiplyScalar(3.0);   // colour * strength of the glow
const lava = new LavaSim(world, { cell: 2, width: 1, viscosity: 0.6, reach: 8, period: 15, passes: 15 });
const lavaGlow = new LavaGlow(world, lava);
const glowTex = new THREE.Data3DTexture(lavaGlow.data, lavaGlow.nx, lavaGlow.ny, lavaGlow.nz);
glowTex.format = THREE.RedFormat;
glowTex.type = THREE.UnsignedByteType;
glowTex.minFilter = glowTex.magFilter = THREE.LinearFilter;   // trilinear: smooth falloff between texels
glowTex.unpackAlignment = 1;
glowTex.needsUpdate = true;

// Day / night clock. ?time=0.3 sets the start (0 sunrise, .25 noon, .5 sunset, .75 midnight), ?day=240 the cycle length in seconds (0 = frozen).
const num = (k, d) => (Number.isFinite(parseFloat(params.get(k))) ? parseFloat(params.get(k)) : d);
const skyClock = new SkyClock(num('time', 0.3), num('day', 240));
const v3 = (a) => new THREE.Vector3(...a);
const skyU = skyState(skyClock.tod);

const palette = Array.from({ length: 10 }, (_, i) => new THREE.Vector3(...(PALETTE[i] ?? [1, 0, 1])));

// Lights: index 0 is the player's torch (follows the camera), the rest come from the world.
const MAX_LIGHTS = 8;
const lightPos = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3());
const lightCol = Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector3());
const torchBase = new THREE.Vector3(1.0, 0.85, 0.6).multiplyScalar(2.2);
const staticLights = world.lights.slice(0, MAX_LIGHTS - 1).map((l) => ({
  base: new THREE.Vector3(...l.color).multiplyScalar(l.intensity),
  anchor: l.anchor,   // flame voxel; when an explosion removes it the light goes out
  dead: false,
}));
world.lights.slice(0, MAX_LIGHTS - 1).forEach((l, i) => lightPos[i + 1].set(...l.pos));
const BASE_LIGHTS = 1 + staticLights.length;   // torch + braziers; slots after these are shells / explosion flashes (lava glows via the glow field, not a light)
const lightCount = BASE_LIGHTS;

// Explosion particles live on the CPU; their packed state is uploaded as a small float texture
// that the shader reads (see applyParticles in shader.js).
const particles = new Particles(solidVoxel, M2V);
const particleTex = new THREE.DataTexture(particles.data, TEXELS, MAX_PARTICLES, THREE.RGBAFormat, THREE.FloatType);
particleTex.minFilter = particleTex.magFilter = THREE.NearestFilter;
particleTex.generateMipmaps = false;
particleTex.needsUpdate = true;

const uniforms = {
  uVoxels:   { value: voxelTex },
  uCoarse:   { value: coarseTex },
  uBlock:    { value: T / 16 },    // blocky colour-variation cell size in voxels
  uSize:     { value: new THREE.Vector3(world.size.x, world.size.y, world.size.z) },
  uCamPos:   { value: new THREE.Vector3() },
  uCamFwd:   { value: new THREE.Vector3(0, 0, -1) },
  uCamRight: { value: new THREE.Vector3(1, 0, 0) },
  uCamUp:    { value: new THREE.Vector3(0, 1, 0) },
  uRes:      { value: new THREE.Vector2(1, 1) },
  uTanHalf:  { value: Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) },
  uTime:     { value: 0 },
  uLevels:   { value: DITHER_LEVELS },
  uAmbient:  { value: 0.07 },
  uSoft:     { value: 0.8 * (T / 4) },  // soft-shadow jitter radius in voxels (0 = hard shadows)
  uEmissive: { value: 1.4 },
  uDither:   { value: DITHER_STRENGTH },
  uInvScale: { value: 4 / T },
  uLightPos:   { value: lightPos },
  uLightCol:   { value: lightCol },
  uLightCount: { value: lightCount },
  uPalette:  { value: palette },
  uParticles: { value: particleTex },
  uGunOff: { value: new THREE.Vector3() },
  uMuzzle: { value: 0 },
  uGunType: { value: 0 },
  uParticleCount: { value: 0 },
  uPBound: { value: new THREE.Vector4() },
  uGlow: { value: glowTex },
  uGlowCol: { value: LAVA_GLOW_COL },
  uGlowScale: { value: lavaGlow.max },
  uGlowTexel: { value: lavaGlow.G },
  uSunDir: { value: v3(skyU.sunDir) }, uMoonDir: { value: v3(skyU.moonDir) },
  uCelLightDir: { value: v3(skyU.lightDir) }, uCelLightCol: { value: v3(skyU.lightCol) },
  uSkyAmb: { value: v3(skyU.skyAmb) }, uZenith: { value: v3(skyU.zenith) }, uHorizon: { value: v3(skyU.horizon) },
  uDusk: { value: v3(skyU.dusk) }, uSunDisc: { value: v3(skyU.sunDisc) },
  uNight: { value: skyU.night }, uSkyRot: { value: new THREE.Vector2(...skyU.rot) },
};

function applySky(st) {
  uniforms.uSunDir.value.set(...st.sunDir); uniforms.uMoonDir.value.set(...st.moonDir);
  uniforms.uCelLightDir.value.set(...st.lightDir); uniforms.uCelLightCol.value.set(...st.lightCol);
  uniforms.uSkyAmb.value.set(...st.skyAmb); uniforms.uZenith.value.set(...st.zenith); uniforms.uHorizon.value.set(...st.horizon);
  uniforms.uDusk.value.set(...st.dusk); uniforms.uSunDisc.value.set(...st.sunDisc);
  uniforms.uNight.value = st.night; uniforms.uSkyRot.value.set(...st.rot);
}

const material = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3,
  uniforms, vertexShader: vert, fragmentShader: frag,
  depthTest: false, depthWrite: false,
});

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // unused by the shader
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
quad.frustumCulled = false;
scene.add(quad);

function resize() {
  const r = canvas.getBoundingClientRect();
  const h = INTERNAL_HEIGHT;
  const w = Math.max(1, Math.round(h * r.width / Math.max(1, r.height)));
  renderer.setSize(w, h, false);       // false = don't touch CSS size; CSS upscales
  uniforms.uRes.value.set(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- physics + player
const physics = await createPhysics(world);   // collision mesh + Rapier world (a second or two)

warmUp();   // JIT the explosion code on a scratch grid so the first real blast doesn't hitch
warmUpGlow();   // same for the lava glow solver

// world.spawns are spread across the map (farthest-point sampling). Multiplayer: the server assigns the index.
const spawnPoint = world.spawns[(parseInt(params.get('spawn'), 10) || 0) % world.spawns.length];
const spawn = { x: (spawnPoint.tx + 0.5) * TILE_M, y: 0, z: (spawnPoint.tz + 0.5) * TILE_M };
const player = new Player(physics, spawn);    // tweak the feel: new Player(physics, spawn, { walkSpeed: 5, jumpHeight: 1.3 })
const input = new Input(canvas, { yaw: spawnPoint.yaw });   // spawn facing along the longest open run

const minimapCanvas = document.getElementById('minimap');
const minimap = minimapCanvas ? new Minimap(minimapCanvas, world, { fog: MINIMAP_FOG }) : null;
const mapCap = document.getElementById('mapcap');
if (mapCap) mapCap.textContent = `SEED ${seed}`;

const hint = document.getElementById('hint');
const modeEl = document.getElementById('mapcap');   // reuse the caption under the minimap for the gun mode
if (hint) hint.textContent = 'Click to look · WASD move · Shift sprint · Space jump · F fly (Space up, C down) · M map · T time of day (normal / fast / paused) · F3 debug · Esc release mouse · Shift+L: clear lava · Scroll wheel (or G): swap grenades / LAVA GUN · Click: fire (lava gun: hold to spray) · Right click: heavy shell (hold to keep firing)';

// ---------------------------------------------------------------- F3 debug overlay
const stats = { shots: 0, blasts: 0, lastBlast: null };   // counters updated by shoot() / detonate()
const GL_DEBUG = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = GL_DEBUG ? gl.getParameter(GL_DEBUG.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const MATERIALS = ['air', 'stone', 'grass', 'dungeon floor', 'wood', 'brick', 'flame', 'scorched stone', 'lava'];
const COMPASS = ['N (-Z)', 'NE', 'E (+X)', 'SE', 'S (+Z)', 'SW', 'W (-X)', 'NW'];
const debugEl = document.getElementById('debug');
const debug = debugEl && new DebugOverlay(debugEl, () => {
  const { forward } = Player.basis(input.yaw, input.pitch);
  player.eyeVoxels(eye);
  const hit = raycastVoxels(world, [eye.x, eye.y, eye.z], forward, 400 * M2V);
  const yawDeg = ((THREE.MathUtils.radToDeg(input.yaw) % 360) + 360) % 360;
  const heading = Math.atan2(forward[0], -forward[2]);                    // 0 = facing -Z, like the player's yaw
  const r = canvas.getBoundingClientRect();
  return {
    gpu: gpuName, calls: renderer.info.render.calls, maxTex3D, fov: FOV_DEG, levels: DITHER_LEVELS, ditherStrength: DITHER_STRENGTH,
    res: [uniforms.uRes.value.x, uniforms.uRes.value.y], canvas: [Math.round(r.width), Math.round(r.height)],
    upscale: (r.height / uniforms.uRes.value.y).toFixed(2),
    lights: uniforms.uLightCount.value, maxLights: MAX_LIGHTS, flashes: flashes.length,
    pos: [player.x, player.y - player.centreOffset, player.z],
    tile: [Math.floor(player.x / TILE_M), Math.floor(player.z / TILE_M)],
    voxel: [eye.x, eye.y, eye.z],
    vel: [player.vx, player.vy, player.vz], speed: Math.hypot(player.vx, player.vy, player.vz),
    yaw: yawDeg, pitch: THREE.MathUtils.radToDeg(input.pitch),
    facing: COMPASS[Math.round(((heading + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8],
    state: `${player.onGround ? 'on ground' : 'airborne'}${player.fly ? ' · fly' : ''}`, locked: input.locked,
    look: hit ? { id: voxelAt(world, ...hit.cell), name: MATERIALS[voxelAt(world, ...hit.cell)] ?? '?', cell: hit.cell, dist: hit.t / M2V } : null,
    shots: stats.shots, blasts: stats.blasts, lastBlast: stats.lastBlast, inFlight: projectiles.list.length,
    cooldown: gunCooldown, shake,
    particles: particles.count, packed: particles.packed, maxParticles: MAX_PARTICLES,
    world: {
      size: [world.size.x, world.size.y, world.size.z],
      metres: [world.size.x, world.size.y, world.size.z].map((v) => (v / M2V).toFixed(1)),
      mb: world.data.length / 1e6, bricks: [world.coarseSize.x, world.coarseSize.y, world.coarseSize.z],
      tileVox: T, tileM: TILE_M,
    },
    tris: physics.triangles,
    heap: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
    time: performance.now() / 1000,
  };
});
if (debug && SHOW_DEBUG) debug.toggle();
addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) minimap?.toggle();
  if (e.code === 'KeyT' && !e.repeat) { const m = skyClock.cycle(); const h = document.getElementById('hint'); if (h) { const old = h.textContent; h.textContent = 'Time: ' + m; setTimeout(() => { h.textContent = old; }, 1500); } }
  if (e.code === 'F3') { e.preventDefault(); if (!e.repeat) debug?.toggle(); }
});


// ---------------------------------------------------------------- explosions
// 1. explode() edits world.data (voxels + coarse grid) on the CPU
// 2. the changed box is pushed to the GPU texture with texSubImage3D (not the whole 80 MB volume)
// 3. physics.updateRegion() re-meshes only the collision chunks that changed
function uploadBox(tex, data, size, box) {
  const glTex = renderer.properties.get(tex).__webglTexture;
  if (!glTex) { tex.needsUpdate = true; return; }              // not on the GPU yet: the normal full upload covers it
  const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
  const buf = new Uint8Array(w * h * d);
  let o = 0;
  for (let z = box.z0; z < box.z1; z++) for (let y = box.y0; y < box.y1; y++) {
    const row = box.x0 + size.x * (y + size.y * z);
    buf.set(data.subarray(row, row + w), o);
    o += w;
  }
  gl.bindTexture(gl.TEXTURE_3D, glTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage3D(gl.TEXTURE_3D, 0, box.x0, box.y0, box.z0, w, h, d, gl.RED, gl.UNSIGNED_BYTE, buf);
  renderer.resetState();                                      // three caches GL bindings; we changed one behind its back
}
function uploadVoxelBox(box) { uploadBox(voxelTex, world.data, world.size, box); }
function uploadGlowBox(box) { uploadBox(glowTex, lavaGlow.data, lavaGlow.size, box); }

const flashes = [];   // { pos: [x,y,z] voxels, t0 }

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
    physics.updateRegion(box);
    minimap?.refresh(box);                                    // craters show up on the map
    stats.lastBlast = { dims: `${box.x1 - box.x0}x${box.y1 - box.y0}x${box.z1 - box.z0}`, ms: performance.now() - t0 };

    // braziers whose flame voxel was destroyed go out
    staticLights.forEach((l) => { if (!l.dead && voxelAt(world, ...l.anchor) !== 6) l.dead = true; });
    lava.notifyCarved(box);                                   // blasts can carve lava away / open new paths for it
    lavaGlow.carved(box);                                     // ...and open or close paths for its light
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
  shake = Math.max(shake, SHAKE_AMOUNT * Math.min(1, Math.sqrt(radiusM / BLAST_RADIUS_M)) * Math.max(0, 1 - dist / (radiusM * 6)));
}

// ---------------------------------------------------------------- gun + projectiles
const projectiles = new Projectiles(world, {
  onImpact: ({ point, normal, radiusM }) => detonate(point, normal, radiusM),
  onTrail: (x, y, z, big) => particles.trail(x, y, z, big),
});

let gunCooldown = 0;
let gunKick = 0, gunMuzzle = 0;                               // recoil + muzzle flash, both decay after a shot
let bobPhase = 0, bobAmt = 0;
const sway = { x: 0, y: 0 };
let lastYaw = 0, lastPitch = 0;

// where the muzzle is and which way it points (shared by the shells and the lava gun)
function aimGun() {
  const { forward, right, up } = Player.basis(input.yaw, input.pitch);
  player.eyeVoxels(eye);

  // muzzle position in the world
  const barrel = [0, 1, 2].map((i) => eye.getComponent(i) + right[i] * GUN_TIP[0] + up[i] * GUN_TIP[1] + forward[i] * GUN_TIP[2]);

  // the barrel sits off to the side, so aim at whatever the crosshair is on (or a far point if it sees nothing close)
  const crosshair = raycastVoxels(world, [eye.x, eye.y, eye.z], forward, AIM_CONVERGE_M * M2V);
  const aimDist = crosshair ? Math.max(crosshair.t, 12) : AIM_CONVERGE_M * M2V;
  const target = [eye.x + forward[0] * aimDist, eye.y + forward[1] * aimDist, eye.z + forward[2] * aimDist];
  let dir = [target[0] - barrel[0], target[1] - barrel[1], target[2] - barrel[2]];
  const dl = Math.hypot(...dir) || 1;
  dir = dir.map((v) => v / dl);

  // if the barrel is poking into a wall, fire from the eye instead (the shellgit  will blow up right in front of you)
  let start = barrel;
  const toBarrel = [barrel[0] - eye.x, barrel[1] - eye.y, barrel[2] - eye.z];
  const bl = Math.hypot(...toBarrel) || 1;
  if (raycastVoxels(world, [eye.x, eye.y, eye.z], toBarrel.map((v) => v / bl), bl)) start = [eye.x, eye.y, eye.z];
  return { start, dir };
}

function shoot(shot) {
  const { start, dir } = aimGun();

  const sp = shot.speed * M2V;
  projectiles.spawn(start, [
    dir[0] * sp + player.vx * M2V * INHERIT_VELOCITY,
    dir[1] * sp + player.vy * M2V * INHERIT_VELOCITY,
    dir[2] * sp + player.vz * M2V * INHERIT_VELOCITY,
  ], { gravity: shot.gravity * M2V, radiusM: shot.radiusM, big: shot.big });

  stats.shots++;
  gunCooldown = shot.cooldown;
  gunKick = Math.max(gunKick, shot.kick);
  gunMuzzle = 1;
}

// ---------------------------------------------------------------- lava
// LavaSim (lava.js) writes id-8 voxels into world.data; we push the changed box to the GPU like explosions do.
const LAVA_STEP = 1 / 30;                 // sim ticks per second: 30
let lavaAcc = 0;

addEventListener('keydown', (e) => {
  if (e.code !== 'KeyL' || e.repeat) return;
  if (e.shiftKey) { lava.clear(); const b = lava.flush(); if (b) { uploadVoxelBox(b); coarseTex.needsUpdate = true; } }
});

// ---------------------------------------------------------------- lava gun (G toggles; left click sprays, hold to keep pouring)
const lavaGun = new LavaGun(world, lava, { rate: 90, speed: 30 * M2V, spread: 0.025, gravity: 7 * M2V });
let lavaMode = false;                       // which gun is actually in hand (switches halfway through the swap animation)
let wantLava = false, swapT = 1;            // swapT: 0..1 = swap in progress, 1 = idle
function selectGun(lava) {                  // scroll wheel / G: lower the gun, switch model, raise it again
  if (lava === wantLava && swapT >= 1) return;
  wantLava = lava; swapT = 0;
}
addEventListener('keydown', (e) => { if (e.code === 'KeyG' && !e.repeat) selectGun(!wantLava); });

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;
const eye = new THREE.Vector3();
let shake = 0;    // camera shake, decays after a blast
let particlesLive = false;
let torchK = 1;   // 0 = torch at the eye, 1 = full offset
function frame(now) {
  const cpuStart = performance.now();
  const rawMs = now - last;
  const dt = Math.min(MAX_FRAME_DT, rawMs / 1000);
  last = now;
  const time = now / 1000;
  uniforms.uTime.value = time;
  skyClock.update(dt);
  applySky(skyState(skyClock.tod));

  // fixed-timestep simulation (60 Hz), render interpolates between ticks
  input.frameUpdate(dt);
  acc += dt;
  while (acc >= FIXED_DT) {
    player.tick(input.sample());
    projectiles.update(FIXED_DT);
    lavaGun.update(FIXED_DT);
    acc -= FIXED_DT;
  }
  const wheel = input.consumeWheel();                          // trackpads spam events: ignore them while a swap is running
  if (wheel && input.locked && swapT >= 1) selectGun(!wantLava);
  if (swapT < 1) {
    swapT = Math.min(1, swapT + dt / 0.32);
    if (swapT >= 0.5 && lavaMode !== wantLava) {                 // gun is off-screen: swap the model
      lavaMode = wantLava;
      uniforms.uGunType.value = lavaMode ? 1 : 0;
      if (modeEl) modeEl.textContent = `SEED ${seed} · ${lavaMode ? 'LAVA GUN' : 'GRENADES'}`;
      gunCooldown = Math.max(gunCooldown, 0.1);
    }
  }
  const fire = input.consumeFire() || input.fireHeld;
  gunCooldown -= dt;
  if (swapT < 1) { /* gun is changing */ }
  else if (lavaMode && fire === 1 && input.locked) {
    const { start, dir } = aimGun();
    lavaGun.emit(dt, start, dir, [player.vx * M2V * INHERIT_VELOCITY, player.vy * M2V * INHERIT_VELOCITY, player.vz * M2V * INHERIT_VELOCITY]);
    gunMuzzle = Math.max(gunMuzzle, 0.55);                     // keep the muzzle glowing while it sprays
    gunKick = Math.max(gunKick, 0.12);
  } else if (fire && gunCooldown <= 0 && input.locked) shoot(fire === 2 ? SHOTS.big : SHOTS.small);

  player.alpha = acc / FIXED_DT;
  player.frameUpdate(dt);

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

  // torch: held to the right of the eye, pulled back if it would end up inside stone
  const o = player.o;
  const mv = T / TILE_M;
  const dx = right[0] * o.torchRight * mv, dy = o.torchUp * mv, dz = right[2] * o.torchRight * mv;
  let target = 1;
  for (let i = 1; i <= 12; i++) {                      // slide back along the offset to just before any stone
    const f = i / 12;
    if (solidVoxel(eye.x + dx * f, eye.y + dy * f, eye.z + dz * f)) {
      target = Math.max(0, (i - 1) / 12 - 3 / Math.hypot(dx, dy, dz));   // 3 voxel margin
      break;
    }
  }
  torchK = target < torchK ? target : torchK + (target - torchK) * (1 - Math.exp(-20 * dt));   // retract instantly, ease back out
  lightPos[0].set(eye.x + dx * torchK, eye.y + dy * torchK, eye.z + dz * torchK);

  // flicker
  lightCol[0].copy(torchBase).multiplyScalar(1 + 0.02 * Math.sin(time * 9));
  staticLights.forEach((l, i) => {
    if (l.dead) lightCol[i + 1].set(0, 0, 0);
    else lightCol[i + 1].copy(l.base).multiplyScalar(1 + 0.10 * Math.sin(time * 7 + i * 2.3) + 0.06 * Math.sin(time * 19 + i));
  });

  // gun animation: recoil kick, walking bob, and lag when you turn
  gunKick *= Math.exp(-11 * dt);
  gunMuzzle *= Math.exp(-22 * dt);
  const speed = player.onGround && !player.fly ? Math.hypot(player.vx, player.vz) : 0;
  bobAmt += (Math.min(1, speed / 5) - bobAmt) * (1 - Math.exp(-8 * dt));
  bobPhase += speed * dt * 1.7;
  const dyaw = input.yaw - lastYaw, dpitch = input.pitch - lastPitch;
  lastYaw = input.yaw; lastPitch = input.pitch;
  sway.x = Math.max(-2, Math.min(2, sway.x - dyaw * 18)) * Math.exp(-9 * dt);
  sway.y = Math.max(-2, Math.min(2, sway.y - dpitch * 18)) * Math.exp(-9 * dt);
  uniforms.uGunOff.value.set(
    Math.sin(bobPhase) * 0.35 * bobAmt + sway.x,
    -Math.abs(Math.cos(bobPhase)) * 0.45 * bobAmt + Math.sin(time * 1.3) * 0.05 + 0.9 * gunKick + sway.y - 9 * Math.sin(Math.PI * swapT),
    -3.0 * gunKick);
  uniforms.uMuzzle.value = gunMuzzle > 0.03 ? gunMuzzle : 0;

  // glowing shells light the corridor as they fly (up to two), explosion flashes fill the remaining slots
  const dynSlots = MAX_LIGHTS - BASE_LIGHTS;
  let used = 0;
  for (let i = 0; i < projectiles.list.length && used < Math.min(2, dynSlots); i++, used++) {
    const pp = projectiles.interpolated(acc / FIXED_DT, i);
    lightPos[BASE_LIGHTS + used].set(pp[0], pp[1], pp[2]);
    lightCol[BASE_LIGHTS + used].set(1.0, 0.6, 0.25).multiplyScalar((projectiles.list[i].big ? 3.4 : 2.4) * (1 + 0.2 * Math.sin(time * 40 + i)));
  }

  const lc = lavaGun.centroid();
  if (lc && used < dynSlots) {
    lightPos[BASE_LIGHTS + used].set(lc[0], lc[1], lc[2]);
    lightCol[BASE_LIGHTS + used].set(1.0, 0.42, 0.1).multiplyScalar(2.6 * (1 + 0.15 * Math.sin(time * 37)));
    used++;
  }

  // explosion flashes occupy the light slots after the torch and braziers
  for (let i = flashes.length - 1; i >= 0; i--) if (time - flashes[i].t0 > FLASH_LIFE) flashes.splice(i, 1);
  const firstFlash = Math.max(0, flashes.length - (dynSlots - used));
  flashes.slice(firstFlash).forEach((f, i0) => {
    const i = i0 + used;
    const age = (time - f.t0) / FLASH_LIFE;
    const flick = 1 + 0.25 * Math.sin(time * 31 + i * 5.1) + 0.15 * Math.sin(time * 53 + i);
    const e = (0.75 * Math.exp(-age * 5) + 0.25 * Math.exp(-age * 1.6)) * (1 - age) * FLASH_PEAK * f.scale * flick;
    lightPos[BASE_LIGHTS + i].set(f.pos[0], f.pos[1] + age * 6 * M2V * 0.25, f.pos[2]);   // the fire climbs a little as it burns
    // white-orange at the start, cooling to red
    lightCol[BASE_LIGHTS + i].set(1.0, 0.62 - 0.3 * age, 0.3 - 0.22 * age).multiplyScalar(e);
  });
  uniforms.uLightCount.value = BASE_LIGHTS + used + (flashes.length - firstFlash);

  // lava: fixed-rate sim, upload the dirty box, then refresh the glow field
  lavaAcc += dt;
  for (let n = 0; lavaAcc >= LAVA_STEP && n < 3; n++) { lava.step(); lavaAcc -= LAVA_STEP; }
  if (lavaAcc > LAVA_STEP * 3) lavaAcc = 0;
  const lbox = lava.flush();
  if (lbox) { uploadVoxelBox(lbox); coarseTex.needsUpdate = true; }
  const gbox = lavaGlow.update(dt);                           // rebuilds (<= ~7x/s) only when lava changed; light spreads from resting cells
  if (gbox) uploadGlowBox(gbox);

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

  minimap?.draw({ x: mToVoxX(player.x), z: mToVoxZ(player.z), yaw: input.yaw }, time);

  renderer.render(scene, camera);
  debug?.frame(rawMs, performance.now() - cpuStart);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Vite hot-swap: edit shader.js and see it live without losing your position
if (import.meta.hot) {
  import.meta.hot.accept('./shader.js', (mod) => {
    if (!mod) return;
    material.vertexShader = mod.vert;
    material.fragmentShader = mod.frag;
    material.needsUpdate = true;
  });
  
}