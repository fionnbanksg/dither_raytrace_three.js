// Weapons: the grenade launcher and the lava gun. Aiming, firing, and the first-person gun animation.
//
// `gun` is the one shared state object. main.js reads/writes it in the frame loop:
//   cooldown   seconds until the grenade launcher can fire again
//   kick       recoil 0..1, muzzle: muzzle-flash 0..1 (both decay in animate())
//   lavaMode   which gun model is actually in hand (flips halfway through a swap)
//   wantLava   which gun the player asked for;  swapT: 0..1 swap animation progress, 1 = idle
// Firing itself (cooldown checks, holding the button) is still decided in main.js `frame()`.

import { Player } from '../player.js';
import { LavaGun } from '../lavagun.js';
import { raycastVoxels } from '../destruction.js';
import { M2V } from '../physics.js';
import { GUN_TIP, AIM_CONVERGE_M, INHERIT_VELOCITY } from '../config.js';

export function createWeapons({ world, player, input, eye, lava, projectiles, stats, uniforms }) {
  const gun = {
    cooldown: 0,
    kick: 0, muzzle: 0,                 // recoil + muzzle flash, both decay after a shot
    bobPhase: 0, bobAmt: 0,             // walking bob
    sway: { x: 0, y: 0 },               // gun lag when you turn
    lastYaw: 0, lastPitch: 0,
    lavaMode: false,                    // which gun is actually in hand (switches halfway through the swap animation)
    wantLava: false, swapT: 1,          // swapT: 0..1 = swap in progress, 1 = idle
  };

  const lavaGun = new LavaGun(world, lava, { rate: 90, speed: 30 * M2V, spread: 0.025, gravity: 7 * M2V });

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
    gun.cooldown = shot.cooldown;
    gun.kick = Math.max(gun.kick, shot.kick);
    gun.muzzle = 1;
  }

  function selectGun(lava) {                  // scroll wheel / G: lower the gun, switch model, raise it again
    if (lava === gun.wantLava && gun.swapT >= 1) return;
    gun.wantLava = lava; gun.swapT = 0;
  }

  addEventListener('keydown', (e) => { if (e.code === 'KeyG' && !e.repeat) selectGun(!gun.wantLava); });

  // Per-frame gun animation: recoil, bob, sway, swap-dip. Writes uGunOff / uMuzzle for the shader's viewmodel.
  function animate(dt, time) {
    // gun animation: recoil kick, walking bob, and lag when you turn
    gun.kick *= Math.exp(-11 * dt);
    gun.muzzle *= Math.exp(-22 * dt);
    const speed = player.onGround && !player.fly ? Math.hypot(player.vx, player.vz) : 0;
    gun.bobAmt += (Math.min(1, speed / 5) - gun.bobAmt) * (1 - Math.exp(-8 * dt));
    gun.bobPhase += speed * dt * 1.7;
    const dyaw = input.yaw - gun.lastYaw, dpitch = input.pitch - gun.lastPitch;
    gun.lastYaw = input.yaw; gun.lastPitch = input.pitch;
    gun.sway.x = Math.max(-2, Math.min(2, gun.sway.x - dyaw * 18)) * Math.exp(-9 * dt);
    gun.sway.y = Math.max(-2, Math.min(2, gun.sway.y - dpitch * 18)) * Math.exp(-9 * dt);
    uniforms.uGunOff.value.set(
      Math.sin(gun.bobPhase) * 0.35 * gun.bobAmt + gun.sway.x,
      -Math.abs(Math.cos(gun.bobPhase)) * 0.45 * gun.bobAmt + Math.sin(time * 1.3) * 0.05 + 0.9 * gun.kick + gun.sway.y - 9 * Math.sin(Math.PI * gun.swapT),
      -3.0 * gun.kick);
    uniforms.uMuzzle.value = gun.muzzle > 0.03 ? gun.muzzle : 0;
  }

  return { gun, lavaGun, aimGun, shoot, selectGun, animate };
}
