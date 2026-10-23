import * as THREE from 'three';
import { buildWorld, PALETTE, T } from './world.js';
import { vert, frag } from './shader.js';
import { Player } from './player.js';
import { Input } from './input.js';
import { createPhysics, FIXED_DT, TILE_M } from './physics.js';

// ---------------------------------------------------------------- settings
const INTERNAL_HEIGHT = 360;   // render resolution (width follows aspect ratio)
const DITHER_LEVELS   = 14;    // colour levels per channel (lower = grittier)
const DITHER_STRENGTH = 0.7;   // 0 = flat banding, 1 = full Bayer pattern
const FOV_DEG         = 70;    // vertical FOV
const SHOW_DEBUG      = true;  // small readout in the top right (position, velocity, keys)
const MAX_FRAME_DT    = 0.1;   // clamp to avoid a spiral of death after a tab switch

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
}));
world.lights.slice(0, MAX_LIGHTS - 1).forEach((l, i) => lightPos[i + 1].set(...l.pos));
const lightCount = 1 + staticLights.length;

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

const spawn = { x: (world.start.tx + 0.5) * TILE_M, y: 0, z: (world.start.tz + 0.5) * TILE_M };
const player = new Player(physics, spawn);    // tweak the feel: new Player(physics, spawn, { walkSpeed: 5, jumpHeight: 1.3 })
const input = new Input(canvas, { yaw: Math.PI / 2 });   // start facing down the first corridor (+X)

const hint = document.getElementById('hint');
if (hint) hint.textContent = 'Click to look · WASD move · Shift sprint · Space jump · F fly (Space up, C down) · Esc release mouse';
const debugEl = document.getElementById('debug');

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;
const eye = new THREE.Vector3();
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
  player.alpha = acc / FIXED_DT;
  player.frameUpdate(dt);

  // camera uses the freshest look angles, not the last tick's
  const { forward, right, up } = Player.basis(input.yaw, input.pitch);
  player.eyeVoxels(eye);
  uniforms.uCamPos.value.copy(eye);
  uniforms.uCamFwd.value.set(...forward);
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
    lightCol[i + 1].copy(l.base).multiplyScalar(1 + 0.10 * Math.sin(time * 7 + i * 2.3) + 0.06 * Math.sin(time * 19 + i));
  });

  if (SHOW_DEBUG && debugEl) {
    const fy = player.y - player.centreOffset;
    debugEl.textContent =
      `pos ${player.x.toFixed(2)} ${fy.toFixed(2)} ${player.z.toFixed(2)} m\n` +
      `vel ${player.vx.toFixed(2)} ${player.vy.toFixed(2)} ${player.vz.toFixed(2)}\n` +
      `${player.onGround ? 'ground' : 'air'}${player.fly ? ' · fly' : ''}${input.locked ? '' : ' · click to capture mouse'}\n` +
      `keys ${[...input.keys].join(' ') || '-'}\n` +
      `${physics.triangles} collision tris`;
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