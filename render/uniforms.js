// Builds the `uniforms` object shared by both shader passes. Every uniform declared in shader/uniforms.js
// needs an entry here (main.js updates the changing ones each frame: camera, time, lights, sky, gun...).

import * as THREE from 'three';
import { T } from '../world.js';
import { FOV_DEG, DITHER_LEVELS, DITHER_STRENGTH } from '../config.js';

export function createUniforms({ world, voxelTex, coarseTex, superTex, particleTex, glowTex, lavaGlow,
                                 lightPos, lightCol, lightCount, palette, skyU, LAVA_GLOW_COL, v3 }) {
  return {
    uVoxels:   { value: voxelTex },
    uCoarse:   { value: coarseTex },
    uSuper:    { value: superTex },
    uLightTex: { value: null },                // set below: the half-res light pass target
    uResLow:   { value: new THREE.Vector2(1, 1) },
    uAspect:   { value: 1 },
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
}

// Push a sky state (from sky.js skyState()) into the sky uniforms. main.js wraps this as applySky(st).
export function applySkyUniforms(uniforms, st) {
  uniforms.uSunDir.value.set(...st.sunDir); uniforms.uMoonDir.value.set(...st.moonDir);
  uniforms.uCelLightDir.value.set(...st.lightDir); uniforms.uCelLightCol.value.set(...st.lightCol);
  uniforms.uSkyAmb.value.set(...st.skyAmb); uniforms.uZenith.value.set(...st.zenith); uniforms.uHorizon.value.set(...st.horizon);
  uniforms.uDusk.value.set(...st.dusk); uniforms.uSunDisc.value.set(...st.sunDisc);
  uniforms.uNight.value = st.night; uniforms.uSkyRot.value.set(...st.rot);
}
