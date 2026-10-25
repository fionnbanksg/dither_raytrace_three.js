// Light slots sent to the shader. Slot layout (max MAX_LIGHTS = 8, the shader's uLightPos/uLightCol arrays):
//   0              the player's torch (follows the camera)
//   1..BASE_LIGHTS braziers from world.lights (they go out when their flame voxel is destroyed)
//   after that     glowing shells, the lava gun, and explosion flashes (all filled in each frame by update() below)

import * as THREE from 'three';
import { T } from '../world.js';
import { TILE_M, M2V } from '../physics.js';
import { FLASH_LIFE, FLASH_PEAK } from '../config.js';

export function createLights(world) {
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

  const flashes = [];   // explosion flashes: { pos: [x,y,z] voxels, t0, scale }, pushed by detonate() in main.js

  let torchK = 1;   // 0 = torch at the eye, 1 = full offset (eases back out after being pulled in by a wall)

  // Called once per frame. Fills every slot: torch, brazier flicker, flying shells, the lava gun's glow, explosion flashes.
  //   eye, right  camera position (voxels) and right vector;  alpha  0..1 fixed-step interpolation (acc / FIXED_DT)
  //   solidVoxel(x, y, z)  true if that voxel is stone;  uniforms  gets uLightCount
  function update({ eye, right, player, solidVoxel, projectiles, lavaGun, uniforms, alpha, dt, time }) {
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

    // glowing shells light the corridor as they fly (up to two), explosion flashes fill the remaining slots
    const dynSlots = MAX_LIGHTS - BASE_LIGHTS;
    let used = 0;
    for (let i = 0; i < projectiles.list.length && used < Math.min(2, dynSlots); i++, used++) {
      const pp = projectiles.interpolated(alpha, i);
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
  }

  return { MAX_LIGHTS, lightPos, lightCol, torchBase, staticLights, BASE_LIGHTS, lightCount, flashes, update };
}
