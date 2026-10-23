// First-person player controller for the voxel world.
//  - mouse look (pointer lock) + arrow-key look
//  - WASD with acceleration / deceleration (separate ground and air rates), sprint
//  - jump with gravity, coyote time, jump buffering, variable jump height
//  - AABB collision against the voxel grid with sliding and auto step-up over small rubble
//  - F toggles a noclip fly mode for debugging (Space up, C/Ctrl down)
//
// Units: voxels and seconds. Everything is expressed relative to T (voxels per tile) so the
// feel stays the same if you change the voxel resolution in world.js.

import { T, EYE_Y } from './world.js';

const DEFAULTS = {
  walkSpeed:  2.0 * T,     // top speed, voxels/s (2 tiles/s)
  sprintMul:  1.7,
  accel:      14 * T,      // ground acceleration, voxels/s^2
  decel:      12 * T,      // ground deceleration when no key is held
  airAccel:   4 * T,       // air control
  airDecel:   0.8 * T,     // drag in the air with no input
  gravity:    6.5 * T,
  fallMul:    1.4,         // heavier gravity while falling (snappier jump arc)
  cutMul:     2.5,         // extra gravity if jump is released while rising (variable jump height)
  jumpHeight: 0.17 * T,
  terminal:   4 * T,       // max fall speed
  coyote:     0.10,        // seconds you can still jump after leaving a ledge
  buffer:     0.12,        // seconds a jump press is remembered before landing
  halfWidth:  0.09 * T,    // collision box half width
  height:     0.375 * T,   // collision box height
  eyeHeight:  EYE_Y - 1,   // eye above the feet (floor top is at y = 1)
  stepHeight: 0.11 * T,    // auto step-up height
  sens:       0.0022,      // mouse radians per pixel
  keyLook:    2.0,         // arrow-key look speed, rad/s
  flyMul:     1.5,
  torchRight: 0.35 * (T / 4),
  torchUp:    0.45 * (T / 4),
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Player {
  /**
   * @param world  { data: Uint8Array, size: {x,y,z} }  from buildWorld()
   * @param canvas element that captures the mouse on click
   * @param spawn  { tx, tz, dir }  start tile and facing (0=N 1=E 2=S 3=W)
   * @param opts   overrides for DEFAULTS
   */
  constructor(world, canvas, spawn, opts = {}) {
    this.world = world;
    this.canvas = canvas;
    this.o = { ...DEFAULTS, ...opts };
    this.jumpSpeed = Math.sqrt(2 * this.o.gravity * this.o.jumpHeight);

    // feet position (voxels) and velocity
    this.x = (spawn.tx + 0.5) * T;
    this.z = (spawn.tz + 0.5) * T;
    this.y = 1;
    this.vx = this.vy = this.vz = 0;

    this.yaw = spawn.dir * Math.PI / 2;
    this.pitch = 0;

    this.onGround = false;
    this.fly = false;
    this.coyote = 0;
    this.buffer = 0;
    this.jumpPrev = false;
    this.renderY = this.y;      // smoothed feet height, hides step-up pops

    // camera outputs, refreshed every update()
    this.eye = { x: 0, y: 0, z: 0 };
    this.forward = [0, 0, -1];
    this.right = [1, 0, 0];
    this.up = [0, 1, 0];

    // if the spawn point happens to overlap rubble, lift up until it's clear
    for (let i = 0; i < 24 && this.collides(this.x, this.y, this.z); i++) this.y += 1;
    this.renderY = this.y;

    this.keys = new Set();
    this._bind();
    this._updateCamera(0, true);
  }

  // ------------------------------------------------------------ input
  _bind() {
    addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (e.code === 'KeyF' && !e.repeat) this.toggleFly();
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    this.canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== this.canvas) this.canvas.requestPointerLock?.();
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== this.canvas) return;
      this.yaw += e.movementX * this.o.sens;
      this.pitch = clamp(this.pitch - e.movementY * this.o.sens, -1.5, 1.5);
    });
  }

  toggleFly() {
    this.fly = !this.fly;
    this.vx = this.vy = this.vz = 0;
    this.onGround = false;
  }

  // ------------------------------------------------------------ world queries
  solid(x, y, z) {
    const { x: sx, y: sy, z: sz } = this.world.size;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return true;
    const v = this.world.data[x + sx * y + sx * sy * z];
    return v !== 0 && !(v === 2 && y >= 1);   // grass above the floor is walk-through
  }

  // does the player box, with feet at (x, y, z), overlap any solid voxel?
  collides(x, y, z) {
    const hw = this.o.halfWidth, h = this.o.height, e = 1e-4;
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw - e);
    const y0 = Math.floor(y),      y1 = Math.floor(y + h - e);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw - e);
    for (let zz = z0; zz <= z1; zz++)
      for (let yy = y0; yy <= y1; yy++)
        for (let xx = x0; xx <= x1; xx++)
          if (this.solid(xx, yy, zz)) return true;
    return false;
  }

  // ------------------------------------------------------------ update
  update(dt) {
    dt = Math.min(dt, 0.05);
    const o = this.o, k = this.keys;
    const down = (...c) => c.some((code) => k.has(code));

    // arrow-key look (handy when the pointer isn't locked)
    if (down('ArrowLeft'))  this.yaw -= o.keyLook * dt;
    if (down('ArrowRight')) this.yaw += o.keyLook * dt;
    if (down('ArrowUp'))    this.pitch += o.keyLook * dt;
    if (down('ArrowDown'))  this.pitch -= o.keyLook * dt;
    this.pitch = clamp(this.pitch, -1.5, 1.5);

    const input = {
      fa: (down('KeyW') ? 1 : 0) - (down('KeyS') ? 1 : 0),
      ra: (down('KeyD') ? 1 : 0) - (down('KeyA') ? 1 : 0),
      sprint: down('ShiftLeft', 'ShiftRight'),
      jump: down('Space'),
      crouch: down('KeyC', 'ControlLeft'),
    };

    if (this.fly) this._updateFly(dt, input);
    else this._updateWalk(dt, input);
    this._updateCamera(dt, false);
  }

  _approach3(tx, ty, tz, rate) {
    const dx = tx - this.vx, dy = ty - this.vy, dz = tz - this.vz;
    const dl = Math.hypot(dx, dy, dz);
    if (dl <= rate) { this.vx = tx; this.vy = ty; this.vz = tz; return; }
    this.vx += dx / dl * rate; this.vy += dy / dl * rate; this.vz += dz / dl * rate;
  }

  _updateWalk(dt, inp) {
    const o = this.o;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const speed = o.walkSpeed * (inp.sprint ? o.sprintMul : 1);

    // --- horizontal: accelerate toward the wish velocity, decelerate when idle
    let wx = sy * inp.fa + cy * inp.ra;
    let wz = -cy * inp.fa + sy * inp.ra;
    const wl = Math.hypot(wx, wz);
    const wishing = wl > 0.001;
    if (wl > 1) { wx /= wl; wz /= wl; }
    const rate = (this.onGround ? (wishing ? o.accel : o.decel) : (wishing ? o.airAccel : o.airDecel)) * dt;
    const dx = wx * speed - this.vx, dz = wz * speed - this.vz;
    const dl = Math.hypot(dx, dz);
    if (dl <= rate) { this.vx = wx * speed; this.vz = wz * speed; }
    else { this.vx += dx / dl * rate; this.vz += dz / dl * rate; }

    // --- jump: coyote time + input buffer + variable height
    const pressed = inp.jump && !this.jumpPrev;
    this.jumpPrev = inp.jump;
    this.buffer = pressed ? o.buffer : Math.max(0, this.buffer - dt);
    this.coyote = this.onGround ? o.coyote : Math.max(0, this.coyote - dt);
    if (this.buffer > 0 && this.coyote > 0) {
      this.vy = this.jumpSpeed;
      this.buffer = 0; this.coyote = 0; this.onGround = false;
    }

    // --- gravity
    if (this.onGround && this.vy <= 0) {
      this.vy = 0;
    } else {
      const m = this.vy > 0 ? (inp.jump ? 1 : o.cutMul) : o.fallMul;
      this.vy = Math.max(-o.terminal, this.vy - o.gravity * m * dt);
    }

    // --- integrate in sub-steps of <= 0.5 voxel so we can't tunnel through thin floors
    const maxDisp = Math.max(Math.abs(this.vx), Math.abs(this.vy), Math.abs(this.vz)) * dt;
    const n = Math.max(1, Math.ceil(maxDisp / 0.5));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this._moveHoriz('x', this.vx * h);
      this._moveHoriz('z', this.vz * h);
      this._moveVert(this.vy * h);
    }

    this.onGround = this.vy <= 0 && this.collides(this.x, this.y - 0.05, this.z);
  }

  _moveHoriz(axis, d) {
    if (d === 0) return;
    const nx = axis === 'x' ? this.x + d : this.x;
    const nz = axis === 'z' ? this.z + d : this.z;
    if (!this.collides(nx, this.y, nz)) { this.x = nx; this.z = nz; return; }
    if (this.onGround) {                                   // try stepping up small ledges / rubble
      for (let lift = 0.5; lift <= this.o.stepHeight; lift += 0.5) {
        if (!this.collides(nx, this.y + lift, nz)) { this.x = nx; this.z = nz; this.y += lift; return; }
      }
    }
    if (axis === 'x') this.vx = 0; else this.vz = 0;       // blocked: slide along the other axis
  }

  _moveVert(d) {
    if (d === 0) return;
    const ny = this.y + d;
    if (!this.collides(this.x, ny, this.z)) { this.y = ny; return; }
    if (d < 0) {                                           // landed: stand on top of the voxel
      this.y = Math.floor(ny) + 1;
      this.onGround = true;
    } else {                                               // bonked the ceiling
      this.y = Math.floor(ny + this.o.height - 1e-4) - this.o.height - 1e-3;
    }
    this.vy = 0;
  }

  _updateFly(dt, inp) {
    const o = this.o;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    let wx = cp * sy * inp.fa + cy * inp.ra;
    let wy = sp * inp.fa + (inp.jump ? 1 : 0) - (inp.crouch ? 1 : 0);
    let wz = -cp * cy * inp.fa + sy * inp.ra;
    const wl = Math.hypot(wx, wy, wz);
    const wishing = wl > 0.001;
    if (wl > 1) { wx /= wl; wy /= wl; wz /= wl; }
    const s = o.walkSpeed * o.flyMul * (inp.sprint ? o.sprintMul : 1);
    this._approach3(wx * s, wy * s, wz * s, (wishing ? o.accel : o.decel) * dt);

    const { x: sx, y: sh, z: sz } = this.world.size;
    this.x = clamp(this.x + this.vx * dt, 2, sx - 2);
    this.y = clamp(this.y + this.vy * dt, 1, sh - 2 - o.height);
    this.z = clamp(this.z + this.vz * dt, 2, sz - 2);
    this.jumpPrev = inp.jump;
  }

  // ------------------------------------------------------------ camera
  _updateCamera(dt, snap) {
    if (snap || this.fly) this.renderY = this.y;
    else this.renderY += (this.y - this.renderY) * (1 - Math.exp(-25 * dt));

    this.eye.x = this.x;
    this.eye.y = this.renderY + this.o.eyeHeight;
    this.eye.z = this.z;

    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
    this.forward = [cp * sy, sp, -cp * cy];
    this.right = [cy, 0, sy];
    this.up = [-sy * sp, cp, cy * sp];
  }

  // Torch hangs up and to the right of the eye so walls cast visible shadows.
  // If that spot is inside stone (you're hugging a wall), pull it back toward the eye.
  torchPosition(out) {
    const o = this.o, e = this.eye, r = this.right;
    for (const s of [1, 0.5, 0]) {
      const x = e.x + r[0] * o.torchRight * s;
      const y = e.y + o.torchUp * s;
      const z = e.z + r[2] * o.torchRight * s;
      if (!this.solid(Math.floor(x), Math.floor(y), Math.floor(z))) return out.set(x, y, z);
    }
    return out.set(e.x, e.y, e.z);
  }
}