// UI overlay pass: draws ui/gfx.js's pixel buffer on top of the game with the SAME look as the world: it renders at
// the internal resolution (one UI pixel = one game pixel), and the shader quantises to uLevels per channel with the
// 8x8 Bayer dither, exactly like shader/entry.js. It also dims the world behind menus with a Bayer dissolve, and can
// draw the animated ember backdrop used by the loading screen. It only needs the renderer, not the world, so it works
// before the game has loaded.

import * as THREE from 'three';
import { Gfx } from './gfx.js';
import { settings, internalSize } from '../settings.js';

const vert = /* glsl */`void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const frag = /* glsl */`layout(location = 0) out highp vec4 fragColor;
uniform sampler2D uUI;     // RGBA bytes, top row first (we flip below)
uniform vec2  uRes;
uniform float uLevels;
uniform float uDither;
uniform float uDim;        // 0..1: fraction of game pixels darkened (Bayer pattern) behind the UI
uniform float uLoad;       // 1 = opaque ember backdrop (loading screen)
uniform float uTime;

float bayer8(ivec2 p) {
  int x = p.x & 7, y = p.y & 7;
  int a = x ^ y;
  int v = ((a & 1) << 5) | ((y & 1) << 4) | ((a & 2) << 2) | ((y & 2) << 1) | ((a & 4) >> 1) | ((y & 4) >> 2);
  return (float(v) + 0.5) / 64.0;
}
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float b = bayer8(p);
  vec4 u = texelFetch(uUI, ivec2(p.x, int(uRes.y) - 1 - p.y), 0);

  vec3 col; float a;
  if (u.a > 0.5) {
    col = u.rgb; a = 1.0;
  } else if (uLoad > 0.5) {
    // embers: lava-coloured glow rising from the bottom, chunky flickering columns
    vec2 uv = gl_FragCoord.xy / uRes;
    float cell = max(2.0, floor(uRes.y / 90.0));
    vec2 cp = floor(gl_FragCoord.xy / cell);
    float n = hash12(vec2(cp.x, floor(uTime * 7.0 + cp.x * 0.37)));
    float g = pow(max(0.0, 1.0 - uv.y), 2.6) * (0.55 + 0.9 * n) * (0.65 + 0.35 * sin(uTime * 0.8 + uv.x * 6.0));
    col = mix(vec3(0.04, 0.035, 0.04), vec3(1.0, 0.34, 0.06), clamp(g, 0.0, 1.0)) ;
    a = 1.0;
  } else {
    col = vec3(0.0); a = step(b, uDim) * 0.8;
    if (a <= 0.0) discard;
  }
  col = floor(col * (uLevels - 1.0) + 0.5 + (b - 0.5) * uDither) / (uLevels - 1.0);
  fragColor = vec4(clamp(col, 0.0, 1.0), a);
}
`;

export function createOverlay({ renderer, canvas }) {
  const o = {
    w: 1, h: 1,
    gfx: new Gfx(1, 1),
    dirty: true,        // redraw requested: whoever draws into o.gfx sets this; render() uploads it
    dim: 0, loading: false,
    scale: 1,           // UI pixel scale for this resolution (menu / loading layout use it)
  };

  const uniforms = {
    uUI: { value: null }, uRes: { value: new THREE.Vector2(1, 1) },
    uLevels: { value: settings.ditherLevels }, uDither: { value: settings.ditherStrength },
    uDim: { value: 0 }, uLoad: { value: 0 }, uTime: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, uniforms, vertexShader: vert, fragmentShader: frag,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  let tex = null;
  // Match the game's internal resolution (same maths as render/pipeline.js resize()).
  o.resize = () => {
    const [w, h] = internalSize();
    if (w === o.w && h === o.h && tex) return;
    o.w = w; o.h = h;
    renderer.setSize(w, h, false);
    o.gfx.resize(w, h);
    tex?.dispose();
    tex = new THREE.DataTexture(o.gfx.buf, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    uniforms.uUI.value = tex;
    uniforms.uRes.value.set(w, h);
    o.scale = Math.max(1, Math.min(6, Math.round(h / 270)));   // 240p -> 1, 500p -> 2, 720p -> 3, 1080p -> 4
    o.dirty = true;
    o.onResize?.(w, h);
  };

  // Draw the overlay over whatever is in the framebuffer (or over black while loading).
  o.render = (time) => {
    if (!tex) o.resize();
    if (o.dirty) { tex.needsUpdate = true; o.dirty = false; }
    uniforms.uTime.value = time;
    uniforms.uLevels.value = settings.ditherLevels;
    uniforms.uDither.value = settings.ditherStrength;
    uniforms.uDim.value = o.dim;
    uniforms.uLoad.value = o.loading ? 1 : 0;
    const prev = renderer.autoClear;
    renderer.autoClear = false;
    if (o.loading) renderer.clear();
    renderer.render(scene, camera);
    renderer.autoClear = prev;
  };

  addEventListener('resize', o.resize);
  o.resize();
  return o;
}
