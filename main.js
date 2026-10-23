import * as THREE from 'three';
import { buildWorld, PALETTE, T, EYE_Y, isWalkable } from './world.js';
import { vert, frag } from './shader.js';

// ---------------------------------------------------------------- settings
const INTERNAL_HEIGHT = 240;   // render resolution (width follows aspect ratio)
const DITHER_LEVELS   = 5;     // colour levels per channel (lower = grittier)
const FOV_DEG         = 62;    // vertical FOV
const MOVE_TIME       = 0.22;  // seconds per tile step
const TURN_TIME       = 0.18;  // seconds per 90 degree turn

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

const palette = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(...(PALETTE[i] ?? [1, 0, 1])));

const uniforms = {
  uVoxels:   { value: voxelTex },
  uSize:     { value: new THREE.Vector3(world.size.x, world.size.y, world.size.z) },
  uCamPos:   { value: new THREE.Vector3() },
  uCamFwd:   { value: new THREE.Vector3(0, 0, -1) },
  uCamRight: { value: new THREE.Vector3(1, 0, 0) },
  uRes:      { value: new THREE.Vector2(1, 1) },
  uTanHalf:  { value: Math.tan(THREE.MathUtils.degToRad(FOV_DEG) / 2) },
  uTime:     { value: 0 },
  uLevels:   { value: DITHER_LEVELS },
  uTorch:    { value: 1.6 },
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

// ---------------------------------------------------------------- party movement (grid based)
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N, E, S, W  (yaw 0 faces -z)
const center = (t) => (t + 0.5) * T;

const party = {
  tx: world.start.tx, tz: world.start.tz, dir: world.start.dir,
  x: center(world.start.tx), z: center(world.start.tz),
  yaw: world.start.dir * Math.PI / 2,
};
let anim = null;

const keys = new Set();
addEventListener('keydown', (e) => { keys.add(e.code); if (e.code.startsWith('Arrow')) e.preventDefault(); });
addEventListener('keyup',   (e) => keys.delete(e.code));
const down = (...c) => c.some((k) => keys.has(k));

function tryStep(relDir) {
  const d = (party.dir + relDir + 4) % 4;
  const nx = party.tx + DIRS[d][0], nz = party.tz + DIRS[d][1];
  if (!isWalkable(nx, nz)) return;    // TODO: bump sound / feedback
  anim = {
    t: 0, dur: MOVE_TIME, kind: 'move',
    fx: party.x, fz: party.z, tx: center(nx), tz: center(nz), yaw0: party.yaw, yaw1: party.yaw,
  };
  party.tx = nx; party.tz = nz;
}

function turn(sign) {
  party.dir = (party.dir + sign + 4) % 4;
  anim = {
    t: 0, dur: TURN_TIME, kind: 'turn',
    fx: party.x, fz: party.z, tx: party.x, tz: party.z, yaw0: party.yaw, yaw1: party.yaw + sign * Math.PI / 2,
  };
}

function updateParty(dt) {
  if (!anim) {
    if (down('KeyQ'))                          turn(-1);
    else if (down('KeyE'))                     turn(+1);
    else if (down('KeyW', 'ArrowUp'))          tryStep(0);
    else if (down('KeyS', 'ArrowDown'))        tryStep(2);
    else if (down('KeyA'))                     tryStep(3);
    else if (down('KeyD'))                     tryStep(1);
    if (!anim && down('ArrowLeft'))            turn(-1);
    if (!anim && down('ArrowRight'))           turn(+1);
  }
  let bob = 0;
  if (anim) {
    anim.t += dt;
    const u = Math.min(1, anim.t / anim.dur);
    const e = u * u * (3 - 2 * u);
    party.x = anim.fx + (anim.tx - anim.fx) * e;
    party.z = anim.fz + (anim.tz - anim.fz) * e;
    party.yaw = anim.yaw0 + (anim.yaw1 - anim.yaw0) * e;
    if (anim.kind === 'move') bob = Math.sin(u * Math.PI) * 0.07;
    if (u >= 1) anim = null;
  }
  const s = Math.sin(party.yaw), c = Math.cos(party.yaw);
  uniforms.uCamPos.value.set(party.x, EYE_Y + bob, party.z);
  uniforms.uCamFwd.value.set(s, 0, -c);
  uniforms.uCamRight.value.set(c, 0, s);
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  uniforms.uTime.value = now / 1000;
  updateParty(dt);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- side panel UI (placeholders)
const PARTY = [
  { name: 'Jace',    color: '#7a4b2a' },
  { name: 'The Truth', color: '#5b3a2a' },
  { name: 'Mark',    color: '#a66a4a' },
  { name: 'Reverie', color: '#3a4a7a' },
];
const partyEl = document.getElementById('party');
for (const m of PARTY) {
  partyEl.insertAdjacentHTML('beforeend', `
    <div class="card">
      <div class="name">${m.name}</div>
      <div class="body">
        <div class="slots"><div class="slot"></div><div class="slot"></div><div class="slot"></div><div class="slot"></div></div>
        <div class="portrait" style="background:${m.color}"></div>
      </div>
      <div class="bar"><i class="hp" style="width:100%"></i></div>
      <div class="bar" style="margin-top:1px"><i class="mp" style="width:100%"></i></div>
    </div>`);
}
const invEl = document.getElementById('inventory');
for (let i = 0; i < 8 * 6; i++) invEl.insertAdjacentHTML('beforeend', '<div class="cell"></div>');
