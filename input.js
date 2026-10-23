// Browser input -> player intent. Mouse look is applied immediately (low latency);
// movement keys are sampled once per physics tick via sample().

const PITCH_LIMIT = 1.54;   // just under 90 degrees

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.sens = opts.sensitivity ?? 0.0022;       // radians per mouse count
    this.keyLook = opts.keyLook ?? 2.0;           // radians per second with the arrow keys
    this.yaw = opts.yaw ?? 0;
    this.pitch = 0;
    this.keys = new Set();
    this._jumpPressed = false;
    this._toggleFly = false;

    const block = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlLeft', 'Tab']);

    addEventListener('keydown', (e) => {
      if (block.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this._jumpPressed = true;
      if (e.code === 'KeyF') this._toggleFly = true;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      this.yaw += e.movementX * this.sens;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch - e.movementY * this.sens));
    });
  }

  get locked() { return document.pointerLockElement === this.canvas; }

  // once per rendered frame: arrow-key look
  frameUpdate(dt) {
    const k = this.keys;
    this.yaw += ((k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0)) * this.keyLook * dt;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT,
      this.pitch + ((k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0)) * this.keyLook * dt));
  }

  // once per physics tick
  sample() {
    const k = this.keys;
    const intent = {
      forward: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      strafe:  (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      sprint:  k.has('ShiftLeft') || k.has('ShiftRight'),
      jumpHeld: k.has('Space'),
      jumpPressed: this._jumpPressed,
      down: k.has('KeyC') || k.has('ControlLeft'),
      toggleFly: this._toggleFly,
      yaw: this.yaw,
      pitch: this.pitch,
    };
    this._jumpPressed = false;
    this._toggleFly = false;
    return intent;
  }
}