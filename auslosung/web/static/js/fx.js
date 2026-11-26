// Effekte: Hintergrund-Shader, Partikel, Wackeln, hochzählende Zahlen (reine Dekoration)
// =============================================================================
// Effekte: Hintergrund-Shader, Partikel, Wackeln, Zähler
// =============================================================================
// Effekte: Hintergrund-Shader, Partikel, Wackeln, hochzählende Zahlen.
// Alles hier ist Dekoration; ohne WebGL oder mit reduzierter Bewegung läuft
// die Seite genauso, nur ruhiger.

export const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
export const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

export const fmt = (n) => Math.round(n).toLocaleString("de-DE");

// ---------------------------------------------------------------------------
// Hintergrund: Farbstrudel aus verdrehtem Rauschen, in Bändern quantisiert und
// grob aufgelöst. Energie 0..1 treibt Tempo und Drall, `gold` mischt zum Ergebnis
// hin in warme Töne.
// ---------------------------------------------------------------------------
const FRAG = `
precision mediump float;
uniform vec2 res;
uniform float t, energy, gold, flash;
uniform vec3 c0, c1, c2, c3;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * res) / res.y;
  float r = length(uv);
  // Drall: zur Mitte hin stärker, mit Energie schneller und enger
  float a = atan(uv.y, uv.x) + (0.9 + energy * 3.0) * exp(-r * 1.3) * 2.2 + t * (0.03 + energy * 0.35);
  vec2 p = vec2(cos(a), sin(a)) * r * 3.2;
  // Flüssige Verwirbelung: jede Stufe feiner und schwächer
  for (int i = 1; i < 6; i++) {
    float fi = float(i);
    p.x += 0.6 / fi * sin(fi * p.y + t * 0.32 + 0.3 * fi);
    p.y += 0.55 / fi * cos(fi * p.x - t * 0.27 + 0.7 * fi);
  }
  float v = 0.5 + 0.5 * sin(p.x * 1.15 + p.y * 0.85 + noise(p * 1.5) * 0.6);
  // Bänder wie Farbe auf Wasser, mit dunklen Kanten
  float k = 6.0;
  float bands = floor(v * k) / (k - 1.0);
  float f = fract(v * k);
  float edge = smoothstep(0.0, 0.07, f) * (1.0 - smoothstep(0.93, 1.0, f));
  vec3 col = mix(c0, c1, smoothstep(0.0, 0.45, bands));
  col = mix(col, c2, smoothstep(0.4, 0.8, bands));
  col = mix(col, c3, smoothstep(0.82, 1.0, bands) * (0.6 + 0.4 * gold));
  col *= 0.72 + 0.28 * edge;
  vec3 warm = vec3(dot(col, vec3(0.35, 0.5, 0.15))) * vec3(1.35, 0.9, 0.38);
  col = mix(col, warm, gold * 0.55);
  col *= mix(1.0, 0.35, smoothstep(0.35, 1.25, r));
  col *= 0.6 + energy * 0.3 + flash * 0.9;
  gl_FragColor = vec4(col, 1.0);
}`;
const VERT = `attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

export class Background {
  constructor(canvas, { scale = 5, palette = ["#110818", "#55163e", "#0d5a52", "#d0602c"] } = {}) {
    this.canvas = canvas;
    this.scale = scale;
    this.energy = 0; this.target = 0;
    this.gold = 0; this.goldTarget = 0;
    this.flashV = 0;
    this.t = rand(0, 100);
    const gl = canvas.getContext("webgl", { antialias: false, premultipliedAlpha: false });
    if (!gl) { canvas.remove(); return; }
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { canvas.remove(); this.gl = null; return; }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = Object.fromEntries(["res", "t", "energy", "gold", "flash", "c0", "c1", "c2", "c3"]
      .map((k) => [k, gl.getUniformLocation(prog, k)]));
    this.setPalette(palette);
    const resize = () => {
      canvas.width = Math.max(32, Math.round(innerWidth / this.scale));
      canvas.height = Math.max(32, Math.round(innerHeight / this.scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    };
    addEventListener("resize", resize); resize();
    this.last = performance.now();
    const loop = (now) => { requestAnimationFrame(loop); this.frame(now); };
    requestAnimationFrame(loop);
  }

  setPalette(p) {
    if (!this.gl) return;
    p.forEach((c, i) => this.gl.uniform3fv(this.u["c" + i], hex(c)));
  }
  setEnergy(e) { this.target = e; }
  setGold(g) { this.goldTarget = g; }
  flash(v = 1) { this.flashV = Math.max(this.flashV, v); }

  frame(now) {
    const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    this.energy += (this.target - this.energy) * Math.min(1, dt * 2.2);
    this.gold += (this.goldTarget - this.gold) * Math.min(1, dt * 1.5);
    this.flashV = Math.max(0, this.flashV - dt * 2.5);
    this.t += dt * (reduced ? 0.15 : 0.6 + this.energy * 2.4);
    const { gl, u } = this;
    gl.uniform2f(u.res, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.t, this.t);
    gl.uniform1f(u.energy, this.energy);
    gl.uniform1f(u.gold, this.gold);
    gl.uniform1f(u.flash, this.flashV);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

// ---------------------------------------------------------------------------
// Partikel auf einer Vollbild-Leinwand: Konfetti (Pixelquadrate), Chips, Funken
// ---------------------------------------------------------------------------
const CONFETTI = ["#ffc23d", "#ff3d4f", "#3a8dff", "#45e07f", "#fff1d6", "#ff5fae"];
const CHIP = ["#ff3d4f", "#3a8dff", "#45e07f", "#ffc23d", "#2b1b3a"];

class Particles {
  constructor() {
    this.list = [];
    this.canvas = null;
  }
  attach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    addEventListener("resize", resize); resize();
    this.last = performance.now();
    const loop = (now) => { requestAnimationFrame(loop); this.frame(now); };
    requestAnimationFrame(loop);
  }

  burst(x, y, { n = 40, kind = "confetti", speed = 9, up = 6, spread = TAU, angle = -Math.PI / 2, size = 1 } = {}) {
    if (!this.canvas || reduced) return;
    n = Math.min(n, 400 - this.list.length);
    for (let i = 0; i < n; i++) {
      const a = angle + rand(-spread / 2, spread / 2), v = rand(0.35, 1) * speed;
      const colors = kind === "chip" ? CHIP : kind === "spark" ? ["#fff6d0", "#ffc23d", "#ff9d2e"] : CONFETTI;
      this.list.push({
        kind, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up * rand(0.3, 1),
        r: rand(0, TAU), vr: rand(-0.3, 0.3), life: 0, max: rand(1.4, 2.6) * (kind === "spark" ? 0.35 : 1),
        s: (kind === "chip" ? rand(9, 15) : kind === "spark" ? rand(2, 4) : rand(5, 10)) * size,
        c: colors[(Math.random() * colors.length) | 0], flip: rand(0, TAU),
      });
    }
  }

  /** Regen von oben über die ganze Breite */
  rain(n = 120, kind = "confetti") {
    if (!this.canvas || reduced) return;
    for (let i = 0; i < n; i++) {
      setTimeout(() => this.burst(rand(0, innerWidth), -20, { n: 1, kind, speed: 2, up: -2, angle: Math.PI / 2, spread: 1 }), i * 12);
    }
  }

  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000) * 60; this.last = now;
    const { ctx } = this;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    if (!this.list.length) return;
    this.list = this.list.filter((p) => (p.life += dt / 60) < p.max && p.y < innerHeight + 40);
    for (const p of this.list) {
      const drag = p.kind === "spark" ? 0.9 : 0.975;
      p.vx *= drag ** dt; p.vy = p.vy * drag ** dt + (p.kind === "spark" ? 0.15 : 0.32) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.flip += 0.18 * dt;
      const fade = Math.min(1, (p.max - p.life) * 3);
      ctx.globalAlpha = fade;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      if (p.kind === "chip") {
        const sy = Math.abs(Math.cos(p.flip));
        ctx.scale(1, Math.max(0.15, sy));
        ctx.fillStyle = "#120a19"; ctx.beginPath(); ctx.arc(0, 0, p.s + 2, 0, TAU); ctx.fill();
        ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(0, 0, p.s, 0, TAU); ctx.fill();
        ctx.strokeStyle = "#fff1d6"; ctx.lineWidth = p.s * 0.22; ctx.setLineDash([p.s * 0.5, p.s * 0.55]);
        ctx.beginPath(); ctx.arc(0, 0, p.s * 0.72, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      } else if (p.kind === "spark") {
        ctx.fillStyle = p.c; ctx.fillRect(-p.s, -p.s, p.s * 2, p.s * 2);
      } else {
        const sx = Math.cos(p.flip);
        ctx.scale(sx, 1);
        ctx.fillStyle = "#120a19"; ctx.fillRect(-p.s / 2 - 1.5, -p.s / 2 - 1.5, p.s + 3, p.s * 0.6 + 3);
        ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
export const particles = new Particles();

// ---------------------------------------------------------------------------
// Wackeln: Trauma-Modell, Ausschlag = Trauma², klingt von selbst ab
// ---------------------------------------------------------------------------
class Shaker {
  constructor() { this.trauma = 0; this.el = null; this.last = performance.now(); }
  attach(el) {
    this.el = el;
    const loop = (now) => { requestAnimationFrame(loop); this.frame(now); };
    requestAnimationFrame(loop);
  }
  add(v) { if (!reduced) this.trauma = Math.min(1, this.trauma + v); }
  frame(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    if (!this.el) return;
    if (this.trauma <= 0) { if (this.on) { this.el.style.transform = ""; this.on = false; } return; }
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    const s = this.trauma ** 2, t = now / 1000;
    const n = (k) => Math.sin(t * 47 + k) * 0.6 + Math.sin(t * 83 + k * 2.3) * 0.4;
    this.el.style.transform = `translate(${n(1) * 18 * s}px, ${n(4) * 14 * s}px) rotate(${n(7) * 1.4 * s}deg)`;
    this.on = true;
  }
}
export const shake = new Shaker();

// ---------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------

/** Schwebende Zahl an einer Bildschirmposition oder über einem Element. */
export function pop(text, at, { color, size, cls = "" } = {}) {
  const r = at instanceof Element ? at.getBoundingClientRect() : null;
  const x = r ? r.left + r.width / 2 : at.x, y = r ? r.top + r.height / 2 : at.y;
  const el = document.createElement("div");
  el.className = `popnum ink ${cls}`;
  el.textContent = text;
  el.style.left = x + "px"; el.style.top = y + "px";
  if (color) el.style.setProperty("--pc", color);
  if (size) el.style.setProperty("--s", size);
  document.body.append(el);
  setTimeout(() => el.remove(), 1300);
}

/** Zahl hochzählen; onStep(wert, schritt) für Ton. Gibt ein Promise zurück. */
export function countTo(el, from, to, ms = 900, { onStep, format = fmt, steps = 18 } = {}) {
  return new Promise((done) => {
    if (reduced || from === to) { el.textContent = format(to); done(); return; }
    const t0 = performance.now();
    let last = -1;
    const tick = (now) => {
      const u = Math.min(1, (now - t0) / ms), e = 1 - (1 - u) ** 3;
      el.textContent = format(from + (to - from) * e);
      const step = Math.floor(u * steps);
      if (step !== last) { last = step; onStep?.(from + (to - from) * e, step / steps); }
      if (u < 1) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
}

/** Text in einzelne Buchstaben zerlegen, die nacheinander hereinspringen. */
export function letters(el, text) {
  el.textContent = "";
  [...text].forEach((ch, i) => {
    const s = document.createElement("span");
    s.className = "ltr"; s.textContent = ch; s.style.setProperty("--i", i);
    el.append(s);
  });
  el.setAttribute("aria-label", text);
}

/** Kurzes Aufzucken neu auslösen. */
export function bump(el) {
  if (!el) return;
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mittelpunkt eines Elements auf dem Bildschirm */
export function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
