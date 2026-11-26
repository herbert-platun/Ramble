// Bühnen: gemeinsame Zeichenhelfer und Basisklasse für Glücksrad, Roulette und Plinko
import { sound } from "../audio.js";
import { clamp, colorFor, fitCanvas, serverNow } from "../core.js";
import { TAU, reduced } from "../fx.js";

// =============================================================================
// Bühnen: Glücksrad, Roulette, Plinko
// =============================================================================
// Die drei Arten zu ziehen, jeweils mit den Namen aus dem Lostopf.
// Jede Animation ist eine reine Funktion der Serverzeit seit `started_at`:
// Fernseher und Handys zeigen dasselbe Bild, ein Neuladen steigt an der
// richtigen Stelle wieder ein. Wo sie landet, hat der Server vorher entschieden.
//
// view.pick ist nur gesetzt, wenn der Name schon gezogen ist (pick.locked).
// Vorher zeigen die Bühnen den eingefrorenen Topf im Leerlauf.

export const C = {
  line: "#120a19", ink: "#1a1024", plum: "#2b1b3a", plumHi: "#3e2a52",
  gold: "#ffc23d", goldHi: "#ffe9a3", goldLo: "#b8701a", cream: "#fff1d6",
  red: "#ff3d4f", redDeep: "#b0142c", felt: "#14a383", feltDeep: "#08392f",
};
export const FONT = '"Pixelify", system-ui, sans-serif';
export const easeOutQuart = (t) => 1 - (1 - t) ** 4;
export const WHEEL_REST = 450;   // ms Stillstand des Rads vor dem Ergebnis
export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** Wie casino/draws.py: ein Feld pro Name. */
export const buildSlots = (ids) => [...ids];

/** Wie casino/draws.py: (Spalten je Name, Reihen) für Plinko. */
export function plinkoShape(names) {
  const per = Math.max(1, Math.ceil(8 / names));
  const rows = Math.max(8, Math.min(16, Math.round(names * per * 0.6) + 4));
  return [per, rows - (rows % 2)];
}

/** Schrift für Namen in einem Kreissegment: so groß wie das Feld es hergibt. */
export function labelFont(n, R, seg, rText) {
  const cap = R * (n <= 3 ? 0.12 : n <= 6 ? 0.1 : n <= 12 ? 0.08 : 0.064);
  return Math.max(8, Math.min(cap, seg * rText * 0.6));
}

/** Zwischenstifte, damit auch bei wenigen Namen ein dichter Takt entsteht. */
export const pegsPer = (n) => Math.max(1, Math.ceil(24 / n));

export function hashRand(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0; x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

export function gold(ctx, r) {
  const g = ctx.createLinearGradient(-r, -r, r, r);
  g.addColorStop(0, C.goldHi); g.addColorStop(0.45, C.gold); g.addColorStop(1, C.goldLo);
  return g;
}

function fitText(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/** Setzt die Schrift so groß wie möglich (bis 60 % kleiner), kürzt erst danach. */
export function fitLabel(ctx, text, max, size) {
  const set = (f) => { ctx.font = `600 ${f}px ${FONT}`; return f; };
  let f = set(size);
  const w = ctx.measureText(text).width;
  if (w > max) f = set(Math.max(size * 0.6, 8, size * max / w));
  return [fitText(ctx, text, max), f];
}

/** Text mit dunkler Kontur, wenn die Schrift hell ist */
export function label(ctx, text, x, y, color, size) {
  if (color !== C.line) {
    ctx.lineJoin = "round"; ctx.strokeStyle = C.line; ctx.lineWidth = Math.max(2, size * 0.24);
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function drawBall(ctx, x, y, r) {
  ctx.fillStyle = "rgba(0,0,0,.4)";
  ctx.beginPath(); ctx.ellipse(x + r * 0.3, y + r * 0.45, r * 1.05, r * 0.8, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = C.line;
  ctx.beginPath(); ctx.arc(x, y, r + Math.max(1.5, r * 0.18), 0, TAU); ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, "#ffffff"); g.addColorStop(0.45, C.cream); g.addColorStop(1, "#b9a98a");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}

/** Glühbirne auf der Leinwand */
export function bulb(ctx, x, y, r, on) {
  ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(x, y, r * 1.45, 0, TAU); ctx.fill();
  if (on > 0.05) {
    ctx.fillStyle = `rgba(255,170,60,${0.28 * on})`;
    ctx.beginPath(); ctx.arc(x, y, r * 3.2, 0, TAU); ctx.fill();
  }
  const a = 0.25 + 0.75 * on;
  ctx.fillStyle = `rgba(${255},${Math.round(150 + 90 * on)},${Math.round(40 + 140 * on)},${a})`;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}

export class Stage {
  /** opts.sound: Klänge abspielen (auf Handys aus) */
  constructor(canvas, mode, opts = {}) {
    this.mode = mode;
    this.canvas = canvas;
    this.useSound = opts.sound !== false;
    this.onTick = () => {};
    this.onSpeed = () => {};
    this.onLand = () => {};
    this.view = null;
    this.alive = true;
    this.chase = 0;
    this.lastNow = 0;
    this.ctx = fitCanvas(canvas, (w, h) => { this.w = w; this.h = h; this.layout(); });
    const loop = () => { if (!this.alive) return; if (this.w) this.frame(serverNow()); requestAnimationFrame(loop); };
    // Namen erst mit geladenen Schriften vermessen
    document.fonts?.load(`600 20px ${FONT}`).then(() => { if (this.w && this.view) this.layout(); });
    requestAnimationFrame(loop);
  }

  destroy() { this.alive = false; if (this.useSound) sound.rollStop(); }

  /**
   * view = { slots: [id…], names: {id: name}, pick: null | {id, slot, started_at, ends_at, layout} }
   */
  show(view) {
    const key = view.slots.join(",") + "|" + JSON.stringify(view.names) + "|" + (view.pick?.layout.rows ?? "");
    const changed = key !== this.viewKey;
    this.view = view;
    this.viewKey = key;
    this.color = colorFor(view.slots);
    if (changed && this.w) this.layout();
  }

  name(id) { return this.view.names[String(id)] ?? "?"; }

  /** 0..1 Fortschritt der laufenden Ziehung oder null */
  progress(now, lead = 0) {
    const p = this.view?.pick;
    if (!p) return null;
    return clamp((now - p.started_at) / (p.ends_at - p.started_at - lead), 0, 1);
  }

  /** Lauflicht-Phase: schneller, je schneller die Bühne gerade ist */
  advanceChase(now, speed) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastNow) / 1000));
    this.lastNow = now;
    this.chase += dt * (reduced ? 0 : 3 + speed * 40);
  }

  tick(strength = 1) {
    this.onTick(strength);
    if (this.useSound) sound.tick(strength);
  }
}
