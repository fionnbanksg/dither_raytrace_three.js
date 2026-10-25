// F3 debug overlay: gathers a stats snapshot each frame for DebugOverlay (debug.js).
// Read-only: it only reads game state, never changes it. Add new debug lines in the object returned below.

import * as THREE from 'three';
import { Player } from '../player.js';
import { DebugOverlay } from '../debug.js';
import { raycastVoxels, voxelAt } from '../destruction.js';
import { M2V, TILE_M } from '../physics.js';
import { T } from '../world.js';
import { MAX_PARTICLES } from '../particles.js';
import { settings } from '../settings.js';

// ctx: everything the overlay reads. getShake is a function because `shake` is a changing number in main.js.
export function createDebugHud({ renderer, canvas, uniforms, world, physics, player, input, eye, projectiles, particles,
                                 stats, flashes, MAX_LIGHTS, gun, getShake }) {
  const gl = renderer.getContext();
  const maxTex3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  const GL_DEBUG = gl.getExtension('WEBGL_debug_renderer_info');
  const gpuName = GL_DEBUG ? gl.getParameter(GL_DEBUG.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const MATERIALS = ['air', 'stone', 'grass', 'dungeon floor', 'wood', 'brick', 'flame', 'scorched stone', 'lava', 'leaves', 'boulder'];
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
      gpu: gpuName, calls: renderer.info.render.calls, maxTex3D, fov: settings.fov, levels: settings.ditherLevels, ditherStrength: settings.ditherStrength,
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
      cooldown: gun.cooldown, shake: getShake(),
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
  if (debug && settings.debug) debug.toggle();
  return debug;
}
