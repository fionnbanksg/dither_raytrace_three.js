// Player simulation: Rapier kinematic character controller + capsule, fixed 60 Hz tick.
// No DOM in here, so the same class can run on a server for an online game.
//
// Units are metres and seconds. Each tick the caller passes an `intent`:
//   { forward, strafe, sprint, jumpHeld, jumpPressed, up, down, toggleFly, yaw, pitch }
// forward/strafe are -1..1 (W = +forward, D = +strafe). yaw 0 faces -Z.

import { FIXED_DT, mToVoxX, mToVoxY, mToVoxZ } from './physics.js';

export const DEFAULTS = {
  radius: 0.3,
  height: 1.7,            // total capsule height
  eyeHeight: 1.5,         // eye above the feet

  walkSpeed: 4.5,
  sprintSpeed: 7.0,
  accel: 45,              // ground acceleration (m/s^2)
  decel: 38,              // ground deceleration when no input
  airAccel: 14,           // air control
  airDecel: 1.2,          // light drag in the air

  jumpHeight: 1.1,        // metres
  gravity: 22,            // rising
  fallGravityMul: 1.6,    // heavier on the way down
  jumpCut: 0.5,           // vertical speed multiplier when jump is released early
  maxFallSpeed: 40,
  coyoteTime: 0.10,
  jumpBuffer: 0.12,

  stepHeight: 0.35,       // autostep: climbs ledges up to this high
  stepMinWidth: 0.15,
  snapDistance: 0.25,     // stick to the ground going down slopes/steps
  skin: 0.02,

  flySpeed: 10,
  flyFastMul: 2.5,

  torchRight: 0.35,       // torch offset from the eye (metres)
  torchUp: 0.45,
};

export class Player {
  constructor(physics, startMetres, opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    const o = this.o;
    const { RAPIER, world } = physics;
    this.physics = physics;

    this.halfHeight = (o.height - 2 * o.radius) / 2;    // cylinder half-length
    this.centreOffset = this.halfHeight + o.radius;     // feet -> capsule centre

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(startMetres.x, startMetres.y + this.centreOffset + 0.05, startMetres.z));
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(this.halfHeight, o.radius), this.body);

    const cc = world.createCharacterController(o.skin);
    cc.setUp({ x: 0, y: 1, z: 0 });
    cc.setSlideEnabled(true);
    cc.enableAutostep(o.stepHeight, o.stepMinWidth, false);
    cc.enableSnapToGround(o.snapDistance);
    cc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    cc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    cc.setApplyImpulsesToDynamicBodies(false);
    this.cc = cc;

    // state (centre of the capsule, metres)
    this.x = startMetres.x; this.y = startMetres.y + this.centreOffset + 0.05; this.z = startMetres.z;
    this.px = this.x; this.py = this.y; this.pz = this.z;      // previous tick, for render interpolation
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.fly = false;
    this.coyote = 0;
    this.buffer = 0;
    this.launched = false;    // true after knock(): disables the short-hop cut until we start falling
    this.slopeBoost = 1;      // compensates the controller's slope shortening (see tick)
    this.stepOffset = 0;      // visual-only smoothing for step-ups
    this.alpha = 1;           // interpolation factor set by the loop
  }

  // ---------------------------------------------------------------- simulation
  tick(intent, dt = FIXED_DT) {
    const o = this.o;
    this.px = this.x; this.py = this.y; this.pz = this.z;
    this.yaw = intent.yaw; this.pitch = intent.pitch;

    if (intent.toggleFly) {
      this.fly = !this.fly;
      this.vx = this.vy = this.vz = 0;
    }

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    // forward on the ground plane, and right
    const fx = sy, fz = -cy, rx = cy, rz = sy;

    if (this.fly) return this._tickFly(intent, dt);

    // ---- horizontal: accelerate toward the wish velocity, or decelerate with no input
    let wx = fx * intent.forward + rx * intent.strafe;
    let wz = fz * intent.forward + rz * intent.strafe;
    const wl = Math.hypot(wx, wz);
    const hasInput = wl > 1e-4;
    if (wl > 1) { wx /= wl; wz /= wl; }
    const speed = intent.sprint ? o.sprintSpeed : o.walkSpeed;
    const tx = hasInput ? wx * speed : 0, tz = hasInput ? wz * speed : 0;
    const rate = this.onGround ? (hasInput ? o.accel : o.decel) : (hasInput ? o.airAccel : o.airDecel);
    const dx = tx - this.vx, dz = tz - this.vz;
    const dl = Math.hypot(dx, dz);
    const maxD = rate * dt;
    if (dl <= maxD) { this.vx = tx; this.vz = tz; }
    else { this.vx += (dx / dl) * maxD; this.vz += (dz / dl) * maxD; }

    // ---- jump: buffer + coyote time
    if (intent.jumpPressed) this.buffer = o.jumpBuffer; else this.buffer = Math.max(0, this.buffer - dt);
    this.coyote = this.onGround ? o.coyoteTime : Math.max(0, this.coyote - dt);
    let jumped = false;
    if (this.buffer > 0 && this.coyote > 0) {
      this.vy = Math.sqrt(2 * o.gravity * o.jumpHeight);
      this.buffer = 0; this.coyote = 0; jumped = true;
    }
    if (this.vy <= 0 || this.onGround) this.launched = false;
    if (!intent.jumpHeld && this.vy > 0 && !jumped && !this.launched) this.vy *= Math.pow(o.jumpCut, dt * 60);   // short hop

    // ---- gravity
    if (this.onGround && this.vy <= 0 && !jumped) this.vy = 0;
    else {
      const g = o.gravity * (this.vy < 0 ? o.fallGravityMul : 1);
      this.vy = Math.max(-o.maxFallSpeed, this.vy - g * dt);
    }

    // ---- move through the physics world
    // The character controller shortens horizontal travel on a slope (it follows the surface), which would slow you
    // right down on hills. slopeBoost learns how much it shortened the last few ticks and asks for that much more.
    const boost = this.onGround ? this.slopeBoost : 1;
    const desired = { x: this.vx * dt * boost, y: this.vy * dt, z: this.vz * dt * boost };
    if (jumped) this.cc.disableSnapToGround(); else this.cc.enableSnapToGround(o.snapDistance);
    this.cc.computeColliderMovement(this.collider, desired);
    const m = this.cc.computedMovement();
    const wasGrounded = this.onGround;
    this.onGround = this.cc.computedGrounded() && !jumped && this.vy <= 0.001;

    // head bump
    if (desired.y > 0 && m.y < desired.y * 0.5) this.vy = Math.min(this.vy, 0);
    // climbing = same heading as asked, but shorter and going up: slope projection, not a wall
    const mh = Math.hypot(m.x, m.z), dh = Math.hypot(desired.x, desired.z);
    const climbing = this.onGround && dh > 1e-6 && mh > 1e-6 && m.y > 0.0005 && (m.x * desired.x + m.z * desired.z) / (mh * dh) > 0.98 && mh < dh;
    const wantBoost = climbing ? Math.min(1.6, (dh / boost) / mh) : 1;
    this.slopeBoost += (wantBoost - this.slopeBoost) * 0.3;
    // keep the slid horizontal velocity so walls don't leave residual push-back (but not the slope shortening)
    if (!climbing) { this.vx = m.x / dt; this.vz = m.z / dt; }
    if (this.onGround && this.vy < 0) this.vy = 0;

    // visual step-up smoothing: remember how far the capsule jumped up while grounded
    if (wasGrounded && this.onGround && m.y > 0.02 && m.y < o.stepHeight + 0.05) this.stepOffset -= m.y;

    this.x += m.x; this.y += m.y; this.z += m.z;
    this.body.setNextKinematicTranslation({ x: this.x, y: this.y, z: this.z });
    this.physics.world.step();
  }

  // Explosion / external push: adds to the current velocity (metres per second).
  knock(vx, vy, vz) {
    this.vx += vx; this.vy += vy; this.vz += vz;
    if (!this.fly && vy > 0) { this.onGround = false; this.coyote = 0; this.launched = true; }
  }

  _tickFly(intent, dt) {
    const o = this.o;
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const fx = sy * cp, fy = sp, fz = -cy * cp, rx = cy, rz = sy;
    const sp2 = o.flySpeed * (intent.sprint ? o.flyFastMul : 1);
    const vert = (intent.jumpHeld 
      ? 1 : 0) - (intent.down ? 1 : 0);
    const tx = (fx * intent.forward + rx * intent.strafe) * sp2;
    const ty = (fy * intent.forward + vert) * sp2;
    const tz = (fz * intent.forward + rz * intent.strafe) * sp2;
    const k = 1 - Math.exp(-12 * dt);
    this.vx += (tx - this.vx) * k; this.vy += (ty - this.vy) * k; this.vz += (tz - this.vz) * k;
    this.x += this.vx * dt; this.y += this.vy * dt; this.z += this.vz * dt;
    this.onGround = false;
    this.body.setNextKinematicTranslation({ x: this.x, y: this.y, z: this.z });
    this.physics.world.step();
  }

  // ---------------------------------------------------------------- rendering helpers
  // Interpolated eye position in *voxel* units (what the shader wants).
  eyeVoxels(out) {
    const a = this.alpha, o = this.o;
    const x = this.px + (this.x - this.px) * a;
    const y = this.py + (this.y - this.py) * a;
    const z = this.pz + (this.z - this.pz) * a;
    const eyeY = y - this.centreOffset + o.eyeHeight + this.stepOffset;
    return out.set(mToVoxX(x), mToVoxY(eyeY), mToVoxZ(z));
  }

  // Call once per rendered frame: decays the step-up smoothing.
  frameUpdate(dt) {
    this.stepOffset *= Math.exp(-16 * dt);
    if (Math.abs(this.stepOffset) < 1e-4) this.stepOffset = 0;
  }

  // Camera basis from the current look angles (any yaw/pitch, e.g. the freshest mouse values).
  static basis(yaw, pitch) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch), sy = Math.sin(yaw), cy = Math.cos(yaw);
    const forward = [sy * cp, sp, -cy * cp];
    const right = [cy, 0, sy];
    const up = [
      right[1] * forward[2] - right[2] * forward[1],
      right[2] * forward[0] - right[0] * forward[2],
      right[0] * forward[1] - right[1] * forward[0],
    ];
    return { forward, right, up };
  }
}