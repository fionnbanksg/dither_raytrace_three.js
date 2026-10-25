// Day / night cycle. Pure maths (no DOM / WebGL), so a server can share the clock.
// tod: time of day in [0,1).  0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight.
// Returns everything the shader needs: sun / moon directions, the single directional light that is
// currently on (sun by day, moon by night), sky ambient, and the sky gradient colours.

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const mul = (a, k) => a.map((v) => v * k);
const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };

const ZENITH_DAY = [0.05, 0.16, 0.55], ZENITH_NIGHT = [0.004, 0.007, 0.022];
const HORIZON_DAY = [0.42, 0.62, 0.92], HORIZON_NIGHT = [0.02, 0.035, 0.08];
const DUSK = [1.0, 0.42, 0.14];
const AMB_DAY = [0.22, 0.30, 0.45], AMB_NIGHT = [0.03, 0.045, 0.09];

export function skyState(tod) {
  const a = (tod - 0.25) * Math.PI * 2;
  const sun = norm([Math.sin(a), Math.cos(a), 0.35]);
  const moon = norm([-Math.sin(a), -Math.cos(a), 0.35]);

  const day = smooth(-0.1, 0.3, sun[1]);                 // 0 night .. 1 full day
  const night = 1 - smooth(-0.2, 0.05, sun[1]);          // star visibility
  const dusk = Math.exp(-((sun[1] / 0.22) ** 2));        // peaks when the sun is on the horizon

  const sunCol = mul(mix([1.0, 0.45, 0.15], [1.0, 0.93, 0.8], smooth(0, 0.45, sun[1])), 1.7 * smooth(0, 0.15, sun[1]));
  const moonCol = mul([0.45, 0.55, 0.95], 0.38 * smooth(0, 0.15, moon[1]));
  const bySun = sun[1] >= 0;

  return {
    sunDir: sun, moonDir: moon,
    lightDir: bySun ? sun : moon,
    lightCol: bySun ? sunCol : moonCol,
    skyAmb: mix(AMB_NIGHT, AMB_DAY, day),
    zenith: mix(ZENITH_NIGHT, ZENITH_DAY, day),
    horizon: mix(mix(HORIZON_NIGHT, HORIZON_DAY, day), DUSK, dusk * 0.6),
    dusk: mul(DUSK, dusk * 0.8),
    sunDisc: mul(mix([1.0, 0.5, 0.2], [1.0, 0.95, 0.8], smooth(0, 0.4, sun[1])), 3.0 * smooth(-0.08, 0.04, sun[1])),
    night,
    rot: [Math.cos(a), Math.sin(a)],                     // stars wheel with the sun
  };
}

// Clock with speed control: normal / fast / paused.
export class SkyClock {
  constructor(start = 0.3, daySeconds = 240) { this.tod = start; this.daySeconds = daySeconds; this.mode = 0; }
  static SPEEDS = [1, 30, 0];
  static NAMES = ['normal', 'fast', 'paused'];
  cycle() { this.mode = (this.mode + 1) % 3; return SkyClock.NAMES[this.mode]; }
  update(dt) {
    if (this.daySeconds <= 0) return;
    this.tod = (this.tod + (dt / this.daySeconds) * SkyClock.SPEEDS[this.mode]) % 1;
  }
}