// GPU textures for the voxel world, lava glow and particles, plus the partial-upload helper.
// All three world textures are 3D, one byte per texel (R8), sampled by the shader with texelFetch.

import * as THREE from 'three';
import { BRICK } from '../world.js';
import { MAX_PARTICLES, TEXELS } from '../particles.js';

// Voxel grid + coarse grid + "super" grid (the shader's 3 traversal levels, biggest skip first).
// Returns { voxelTex, coarseTex, superTex, refreshSuper }.
// After editing world.data / world.coarse at runtime: upload the changed box, set coarseTex.needsUpdate = true,
// and call refreshSuper(box) so the super grid stays in sync.
export function createWorldTextures(world) {
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

  // third traversal level: 1 byte per 4x4x4 coarse bricks (32^3 voxels), 1 = contains stone. Lets the shader hop over big
  // empty spaces. Kept in sync with the coarse grid by refreshSuper(box) wherever coarseTex is re-uploaded.
  const SUPER = 4;
  const superSize = { x: Math.ceil(world.coarseSize.x / SUPER), y: Math.ceil(world.coarseSize.y / SUPER), z: Math.ceil(world.coarseSize.z / SUPER) };
  const superData = new Uint8Array(superSize.x * superSize.y * superSize.z);
  const superTex = new THREE.Data3DTexture(superData, superSize.x, superSize.y, superSize.z);
  superTex.format = THREE.RedFormat;
  superTex.type = THREE.UnsignedByteType;
  superTex.minFilter = superTex.magFilter = THREE.NearestFilter;
  superTex.unpackAlignment = 1;
  function refreshSuper(box) {   // box in voxels, or null for the whole grid
    const cs = world.coarseSize, W = BRICK * SUPER;
    const x0 = box ? Math.max(0, Math.floor(box.x0 / W)) : 0, x1 = box ? Math.min(superSize.x - 1, Math.floor((box.x1 - 1) / W)) : superSize.x - 1;
    const y0 = box ? Math.max(0, Math.floor(box.y0 / W)) : 0, y1 = box ? Math.min(superSize.y - 1, Math.floor((box.y1 - 1) / W)) : superSize.y - 1;
    const z0 = box ? Math.max(0, Math.floor(box.z0 / W)) : 0, z1 = box ? Math.min(superSize.z - 1, Math.floor((box.z1 - 1) / W)) : superSize.z - 1;
    for (let sz = z0; sz <= z1; sz++) for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
      let any = 0;
      const bz1 = Math.min(cs.z, (sz + 1) * SUPER), by1 = Math.min(cs.y, (sy + 1) * SUPER), bx1 = Math.min(cs.x, (sx + 1) * SUPER);
      scan: for (let bz = sz * SUPER; bz < bz1; bz++) for (let by = sy * SUPER; by < by1; by++) {
        let i = sx * SUPER + cs.x * (by + cs.y * bz);
        for (let bx = sx * SUPER; bx < bx1; bx++, i++) if (world.coarse[i]) { any = 1; break scan; }
      }
      superData[sx + superSize.x * (sy + superSize.y * sz)] = any;
    }
    superTex.needsUpdate = true;
  }
  refreshSuper(null);

  return { voxelTex, coarseTex, superTex, refreshSuper };
}

// Light thrown by resting lava (see lavaglow.js). Linear filter = smooth falloff between texels.
export function createGlowTexture(lavaGlow) {
  const glowTex = new THREE.Data3DTexture(lavaGlow.data, lavaGlow.nx, lavaGlow.ny, lavaGlow.nz);
  glowTex.format = THREE.RedFormat;
  glowTex.type = THREE.UnsignedByteType;
  glowTex.minFilter = glowTex.magFilter = THREE.LinearFilter;   // trilinear: smooth falloff between texels
  glowTex.unpackAlignment = 1;
  glowTex.needsUpdate = true;
  return glowTex;
}

// Explosion particles: CPU state packed into a small float texture the shader reads (see particles.js).
export function createParticleTexture(particles) {
  const particleTex = new THREE.DataTexture(particles.data, TEXELS, MAX_PARTICLES, THREE.RGBAFormat, THREE.FloatType);
  particleTex.minFilter = particleTex.magFilter = THREE.NearestFilter;
  particleTex.generateMipmaps = false;
  particleTex.needsUpdate = true;
  return particleTex;
}

// Returns uploadBox(tex, data, size, box): re-upload only a changed sub-box of a 3D R8 texture
// (texSubImage3D) instead of the whole volume. Used after explosions and lava changes.
export function createTextureUploader(renderer) {
  const gl = renderer.getContext();
  return function uploadBox(tex, data, size, box) {
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
}
