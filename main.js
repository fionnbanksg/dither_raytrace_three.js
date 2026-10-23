import * as THREE from 'three';
import { buildWorld, PALETTE, T } from './world.js';
import { vert, frag } from './shader.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { createPhysics, FIXED_DT, TILE_M, M2V, mToVoxX, mToVoxY, mToVoxZ } from './physics.js';
import { explode, raycastVoxels, voxelAt, warmUp } from './destruction.js';
import { Particles, MAX_PARTICLES, TEXELS } from './particles.js';

// ---------------------------------------------------------------- settings
const INTERNAL_HEIGHT = 360;   // render resolution (width follows aspect ratio)
const DITHER_LEVELS   = 14;    // colour levels per channel (lower = grittier)
const DITHER_STRENGTH = 0.7;   // 0 = flat banding, 1 = full Bayer pattern
const FOV_DEG         = 70;    // vertical FOV
const SHOW_DEBUG      = true;  // small readout in the top right (position, velocity, keys)
const MAX_FRAME_DT    = 0.1;   // clamp to avoid a spiral of death after a tab switch
const BLAST_RADIUS_M  = 2.0;   // left click: crater radius in metres (a tile is 4 m wide)
const BIG_BLAST_MUL   = 1.8;   // right click: bigger blast
const BLAST_PUSH      = 13;    // m/s of knockback at point-blank range
const FLASH_LIFE      = 1.4;   // seconds the explosion light lasts (it lingers while the fire burns)
const FLASH_PEAK      = 14;    // explosion light intensity (braziers are 3, torch 2.2)
const SHAKE_AMOUNT    = 1.0;   // camera shake strength for a nearby blast (0 = off)
const DEBRIS_PER_BLAST = 56;   // chunks of the destroyed material thrown out (max)

// ---------------------------------------------------------------- renderer
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);

const world = buildWorld();

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

const palette = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(...(PALETTE[i] ?? [1, 0, 1])));

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
const BASE_LIGHTS = 1 + staticLights.length;   // torch + braziers; slots after these are explosion flashes
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
  uParticleCount: { value: 0 },
  uPBound: { value: new THREE.Vector4() },
};

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

const spawn = { x: (world.start.tx + 0.5) * TILE_M, y: 0, z: (world.start.tz + 0.5) * TILE_M };
const player = new Player(physics, spawn);    // tweak the feel: new Player(physics, spawn, { walkSpeed: 5, jumpHeight: 1.3 })
const input = new Input(canvas, { yaw: Math.PI / 2 });   // start facing down the first corridor (+X)

const hint = document.getElementById('hint');
if (hint) hint.textContent = 'Click to look · WASD move · Shift sprint · Space jump · F fly (Space up, C down) · Esc release mouse · Click: explode · Right click: big explosion';
const debugEl = document.getElementById('debug');


// ---------------------------------------------------------------- explosions
// 1. explode() edits world.data (voxels + coarse grid) on the CPU
// 2. the changed box is pushed to the GPU texture with texSubImage3D (not the whole 80 MB volume)
// 3. physics.updateRegion() re-meshes only the collision chunks that changed
function uploadVoxelBox(box) {
  const glTex = renderer.properties.get(voxelTex).__webglTexture;
  if (!glTex) { voxelTex.needsUpdate = true; return; }       // not on the GPU yet: the normal full upload covers it
  const w = box.x1 - box.x0, h = box.y1 - box.y0, d = box.z1 - box.z0;
  const buf = new Uint8Array(w * h * d);
  const { x: sx, y: sy } = world.size;
  let o = 0;
  for (let z = box.z0; z < box.z1; z++) for (let y = box.y0; y < box.y1; y++) {
    const row = box.x0 + sx * (y + sy * z);
    buf.set(world.data.subarray(row, row + w), o);
    o += w;
  }
  gl.bindTexture(gl.TEXTURE_3D, glTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage3D(gl.TEXTURE_3D, 0, box.x0, box.y0, box.z0, w, h, d, gl.RED, gl.UNSIGNED_BYTE, buf);
  renderer.resetState();                                      // three caches GL bindings; we changed one behind its back
}

const flashes = [];   // { pos: [x,y,z] voxels, t0 }

function blast(radiusM) {
  const { forward } = Player.basis(input.yaw, input.pitch);
  player.eyeVoxels(eye);
  const hit = raycastVoxels(world, [eye.x, eye.y, eye.z], forward);
  if (!hit) return;

  const R = radiusM * M2V;                                    // metres -> voxels
  const c = hit.point.map((p, i) => p + hit.normal[i] * R * 0.3);   // nudge out of the wall so the crater opens into the room
  const debris = [];
  const box = explode(world, c, R, {
    keepClear: [{ x: mToVoxX(player.x), z: mToVoxZ(player.z), r: 0.9 * M2V }],   // no rubble under the player's feet
    debrisOut: debris, debrisMax: DEBRIS_PER_BLAST,
  });
  if (!box) return;

  particles.burst(c, hit.normal, radiusM / BLAST_RADIUS_M, debris);

  uploadVoxelBox(box);
  coarseTex.needsUpdate = true;                               // 157 KB, cheap to re-upload whole
  physics.updateRegion(box);

  // braziers whose flame voxel was destroyed go out
  staticLights.forEach((l) => { if (!l.dead && voxelAt(world, ...l.anchor) !== 6) l.dead = true; });

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

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;
const eye = new THREE.Vector3();
let shake = 0;    // camera shake, decays after a blast
let particlesLive = false;
let torchK = 1;   // 0 = torch at the eye, 1 = full offset
function frame(now) {
  const dt = Math.min(MAX_FRAME_DT, (now - last) / 1000);
  last = now;
  const time = now / 1000;
  uniforms.uTime.value = time;

  // fixed-timestep simulation (60 Hz), render interpolates between ticks
  input.frameUpdate(dt);
  acc += dt;
  while (acc >= FIXED_DT) {
    player.tick(input.sample());
    acc -= FIXED_DT;
  }
  const fire = input.consumeFire();
  if (fire) blast(BLAST_RADIUS_M * (fire === 2 ? BIG_BLAST_MUL : 1));

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

  // explosion flashes occupy the light slots after the torch and braziers
  for (let i = flashes.length - 1; i >= 0; i--) if (time - flashes[i].t0 > FLASH_LIFE) flashes.splice(i, 1);
  flashes.forEach((f, i) => {
    const age = (time - f.t0) / FLASH_LIFE;
    const flick = 1 + 0.25 * Math.sin(time * 31 + i * 5.1) + 0.15 * Math.sin(time * 53 + i);
    const e = (0.75 * Math.exp(-age * 5) + 0.25 * Math.exp(-age * 1.6)) * (1 - age) * FLASH_PEAK * f.scale * flick;
    lightPos[BASE_LIGHTS + i].set(f.pos[0], f.pos[1] + age * 6 * M2V * 0.25, f.pos[2]);   // the fire climbs a little as it burns
    // white-orange at the start, cooling to red
    lightCol[BASE_LIGHTS + i].set(1.0, 0.62 - 0.3 * age, 0.3 - 0.22 * age).multiplyScalar(e);
  });
  uniforms.uLightCount.value = BASE_LIGHTS + flashes.length;

  // particles: simulate, pack, upload only while something is alive
  particles.update(dt);
  if (particles.count > 0 || particlesLive) {
    particles.pack();
    uniforms.uParticleCount.value = particles.packed;
    uniforms.uPBound.value.set(...particles.bound);
    particleTex.needsUpdate = true;
    particlesLive = particles.count > 0;
  }

  if (SHOW_DEBUG && debugEl) {
    const fy = player.y - player.centreOffset;
    debugEl.textContent =
      `pos ${player.x.toFixed(2)} ${fy.toFixed(2)} ${player.z.toFixed(2)} m\n` +
      `vel ${player.vx.toFixed(2)} ${player.vy.toFixed(2)} ${player.vz.toFixed(2)}\n` +
      `${player.onGround ? 'ground' : 'air'}${player.fly ? ' · fly' : ''}${input.locked ? '' : ' · click to capture mouse'}\n` +
      `keys ${[...input.keys].join(' ') || '-'}\n` +
      `${physics.triangles} collision tris · ${particles.count} particles`;
  }

  renderer.render(scene, camera);
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