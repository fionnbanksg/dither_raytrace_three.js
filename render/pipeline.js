// Render pipeline: the two shader materials (half-res light pass + full-res pass), their fullscreen quads,
// the light render target, and resize(). main.js calls renderer.render(...) with what this returns.

import * as THREE from 'three';
import { vert, frag } from '../shader.js';
import { INTERNAL_HEIGHT, HALF_RES_LIGHT, LIGHT_DIV } from '../config.js';

export function createPipeline({ renderer, canvas, uniforms }) {
  // Light pass: world traced at 1/LIGHT_DIV resolution into a float target; sky / sun / point-light rays are cast there once
  // per texel and the full-res pass reuses them (see LIGHT_PASS / fetchLight in shader.js). Needs float render targets.
  const useLightBuffer = HALF_RES_LIGHT && renderer.extensions.has('EXT_color_buffer_float');
  if (HALF_RES_LIGHT && !useLightBuffer) console.warn('EXT_color_buffer_float missing: light pass disabled, using per-pixel rays');

  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms, vertexShader: vert, fragmentShader: frag,
    defines: useLightBuffer ? { USE_LIGHT_BUFFER: 1 } : {},
    depthTest: false, depthWrite: false,
  });

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // unused by the shader
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quad = new THREE.Mesh(quadGeo, material);
  quad.frustumCulled = false;
  scene.add(quad);

  const lightRT = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false,
  });
  uniforms.uLightTex.value = lightRT.texture;
  // same uniforms, except its own resolution and no light texture (it writes that texture, so it must not read it)
  const lightUniforms = { ...uniforms, uRes: { value: new THREE.Vector2(1, 1) }, uLightTex: { value: null } };
  const lightMaterial = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: lightUniforms, vertexShader: vert, fragmentShader: frag,
    defines: { LIGHT_PASS: 1 },
    depthTest: false, depthWrite: false,
  });
  const lightScene = new THREE.Scene();
  const lightQuad = new THREE.Mesh(quadGeo, lightMaterial);
  lightQuad.frustumCulled = false;
  lightScene.add(lightQuad);

  function resize() {
    const r = canvas.getBoundingClientRect();
    const h = INTERNAL_HEIGHT;
    const w = Math.max(1, Math.round(h * r.width / Math.max(1, r.height)));
    renderer.setSize(w, h, false);       // false = don't touch CSS size; CSS upscales
    uniforms.uRes.value.set(w, h);
    uniforms.uAspect.value = w / h;
    const lw = Math.max(1, Math.ceil(w / LIGHT_DIV)), lh = Math.max(1, Math.ceil(h / LIGHT_DIV));
    lightRT.setSize(lw, lh);
    uniforms.uResLow.value.set(lw, lh);
    lightUniforms.uRes.value.set(lw, lh);
  }
  window.addEventListener('resize', resize);
  resize();

  hotMaterials.push(material, lightMaterial);
  return { material, lightMaterial, scene, lightScene, camera, lightRT, lightUniforms, useLightBuffer, resize };
}

// Vite hot-swap: edit anything under shader/ and see it live without losing your position.
// (Lives at module level because Vite wants import.meta.hot.accept in a fixed form; createPipeline registers its materials here.)
const hotMaterials = [];
if (import.meta.hot) {
  import.meta.hot.accept('../shader.js', (mod) => {
    if (!mod) return;
    for (const m of hotMaterials) {
      m.vertexShader = mod.vert;
      m.fragmentShader = mod.frag;
      m.needsUpdate = true;
    }
  });
}
