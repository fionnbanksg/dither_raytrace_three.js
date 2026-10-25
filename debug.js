// F3 debug overlay: text panel (top right) + frame-time graph.
// No game logic in here. main.js calls frame() every frame with the raw frame time, and passes a
// getStats() callback that is only invoked when the panel is visible (about 7 times a second).

const HISTORY = 160;            // frames shown in the graph
const TEXT_EVERY_MS = 150;      // how often the text is rebuilt
const GRAPH_W = 240, GRAPH_H = 44, GRAPH_MAX_MS = 40;

const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '-');
const pad = (n, w = 2) => String(n).padStart(w, '0');

export class DebugOverlay {
  constructor(el, getStats) {
    this.el = el;
    this.getStats = getStats;
    this.on = false;
    this.times = new Float32Array(HISTORY);   // ring buffer of frame times (ms)
    this.cpu = new Float32Array(HISTORY);     // ring buffer of JS time per frame (ms)
    this.n = 0;
    this.sinceText = 1e9;

    this.text = document.createElement('pre');
    this.graph = document.createElement('canvas');
    this.graph.width = GRAPH_W; this.graph.height = GRAPH_H;
    this.ctx = this.graph.getContext('2d');
    el.append(this.text, this.graph);
    this._apply();
  }

  toggle() { this.on = !this.on; this.sinceText = 1e9; this._apply(); }
  _apply() { this.el.classList.toggle('on', this.on); }

  // call once per rendered frame. cpuMs = time spent in JS this frame (sim + submit)
  frame(dtMs, cpuMs) {
    const i = this.n % HISTORY;
    this.times[i] = dtMs; this.cpu[i] = cpuMs;
    this.n++;
    if (!this.on) return;
    this.sinceText += dtMs;
    if (this.sinceText >= TEXT_EVERY_MS) { this.sinceText = 0; this._text(); }
    this._graph();
  }

  // frame-time statistics over the history window
  _stats() {
    const m = Math.min(this.n, HISTORY);
    if (!m) return { fps: 0, avg: 0, min: 0, max: 0, low1: 0, cpu: 0 };
    const t = Array.from(this.times.subarray(0, m)).sort((a, b) => a - b);
    let sum = 0, cs = 0;
    for (let i = 0; i < m; i++) { sum += this.times[i]; cs += this.cpu[i]; }
    const avg = sum / m;
    const worst = t.slice(Math.floor(m * 0.99));            // slowest 1% of frames
    const low1 = worst.reduce((a, b) => a + b, 0) / Math.max(1, worst.length);
    return { fps: 1000 / avg, avg, min: t[0], max: t[m - 1], low1: 1000 / low1, cpu: cs / m };
  }

  _text() {
    const s = this.getStats();
    const fr = this._stats();
    const L = [];
    const head = (t) => L.push('', `-- ${t} --`);

    L.push(`${f(fr.fps, 0)} fps   ${f(fr.avg, 1)} ms  (min ${f(fr.min, 1)}  max ${f(fr.max, 1)})`);
    L.push(`1% low ${f(fr.low1, 0)} fps   js ${f(fr.cpu, 2)} ms/frame`);

    head('render');
    L.push(`${s.gpu}`);
    L.push(`internal ${s.res[0]}x${s.res[1]} -> canvas ${s.canvas[0]}x${s.canvas[1]}  (${s.upscale}x)`);
    L.push(`draw calls ${s.calls}   fov ${s.fov}   dither ${s.levels} lvl @ ${f(s.ditherStrength, 2)}`);
    L.push(`lights ${s.lights}/${s.maxLights}   flashes ${s.flashes}   max 3D tex ${s.maxTex3D}`);

    head('player');
    L.push(`pos ${f(s.pos[0])} ${f(s.pos[1])} ${f(s.pos[2])} m`);
    L.push(`tile ${s.tile[0]},${s.tile[1]}   voxel ${s.voxel.map((v) => Math.floor(v)).join(' ')}`);
    L.push(`vel ${f(s.vel[0])} ${f(s.vel[1])} ${f(s.vel[2])}   speed ${f(s.speed)} m/s`);
    L.push(`yaw ${f(s.yaw, 1)}  pitch ${f(s.pitch, 1)}  facing ${s.facing}`);
    L.push(`${s.state}${s.locked ? '' : '  (click to capture mouse)'}`);

    head('looking at');
    L.push(s.look
      ? `${s.look.name} (id ${s.look.id}) at ${s.look.cell.join(' ')}   ${f(s.look.dist, 1)} m`
      : 'nothing in range');

    head('gun');
    L.push(`shots ${s.shots}   in flight ${s.inFlight}   cooldown ${f(Math.max(0, s.cooldown), 2)} s`);
    L.push(`blasts ${s.blasts}   last ${s.lastBlast ? `${s.lastBlast.dims} vox  ${f(s.lastBlast.ms, 1)} ms` : '-'}`);
    L.push(`shake ${f(s.shake, 2)}`);

    head('particles');
    L.push(`live ${s.particles}/${s.maxParticles}   uploaded ${s.packed}`);

    head('world');
    L.push(`${s.world.size.join(' x ')} voxels  (${s.world.metres.join(' x ')} m)`);
    L.push(`voxel texture ${f(s.world.mb, 1)} MB   bricks ${s.world.bricks.join(' x ')}`);
    L.push(`${s.tris} collision tris   tile ${s.world.tileVox} vox = ${s.world.tileM} m`);

    head('system');
    L.push(s.heap != null ? `js heap ${f(s.heap, 1)} MB` : 'js heap n/a');
    const d = new Date();
    L.push(`${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}   t ${f(s.time, 1)} s`);

    L.push('', 'F3 to hide');
    this.text.textContent = L.join('\n');
  }

  _graph() {
    const c = this.ctx, W = GRAPH_W, H = GRAPH_H;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(0, 0, W, H);

    const m = Math.min(this.n, HISTORY);
    const bw = W / HISTORY;
    for (let k = 0; k < m; k++) {
      const idx = (this.n - m + k) % HISTORY;
      const ms = this.times[idx];
      const h = Math.min(1, ms / GRAPH_MAX_MS) * H;
      c.fillStyle = ms <= 17.5 ? '#7ddc6a' : ms <= 34 ? '#e8c547' : '#e8624a';
      c.fillRect(W - (m - k) * bw, H - h, Math.max(1, bw - 0.5), h);
      const j = Math.min(1, this.cpu[idx] / GRAPH_MAX_MS) * H;
      c.fillStyle = 'rgba(255,255,255,0.55)';                       // JS time drawn as a white cap
      c.fillRect(W - (m - k) * bw, H - j, Math.max(1, bw - 0.5), 1);
    }
    c.fillStyle = 'rgba(255,255,255,0.35)';
    for (const ms of [16.7, 33.3]) c.fillRect(0, H - (ms / GRAPH_MAX_MS) * H, W, 1);   // 60 / 30 fps guides
  }
}
