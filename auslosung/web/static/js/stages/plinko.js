// Bühne: Plinko, eine Kugel, ein Fach pro Name
import { sound } from "../audio.js";
import { clamp } from "../core.js";
import { TAU, reduced } from "../fx.js";
import { C, FONT, Stage, drawBall, fitLabel, label, plinkoShape } from "./stage.js";

// ===========================================================================
// Plinko: eine Kugel, ein Fach pro Name
// ===========================================================================
const DROP = 600, LAND = 450, START = 400;
const hop = (k) => 520 - k * 14;

export class PlinkoStage extends Stage {
  layout() {
    if (!this.view?.slots.length) return;
    const n = this.view.slots.length, L = this.view.pick?.layout ?? this.view.layout;
    [this.per, this.rows] = L?.per ? [L.per, L.rows] : plinkoShape(n);
    const cols = n * this.per, rows = this.rows, ctx = this.ctx;

    // Beschriftung: waagerecht, wenn die Fächer breit genug sind, sonst senkrecht
    const dxW = (this.w * 0.9) / cols;
    const longest = (f) => {
      ctx.font = `600 ${f}px ${FONT}`;
      return Math.max(...this.view.slots.map((id) => ctx.measureText(this.name(id)).width));
    };
    const fH = Math.min(dxW * this.per * 0.2, 26);
    this.flat = fH >= 13 && longest(fH) <= dxW * this.per * 0.84;
    const binH = this.flat ? fH * 2.8 : Math.min(this.h * 0.3, Math.max(3.2 * dxW, 90));

    this.dx = Math.min(dxW, (this.h * 0.9 - binH) / (1.4 + (rows - 1) * 0.9 + 0.9));
    this.dy = this.dx * 0.9;
    this.binH = binH;
    this.font = this.flat ? Math.min(fH, this.dx * this.per * 0.2) : Math.max(9, Math.min(this.dx * this.per * 0.42, 22));
    const total = 1.4 * this.dx + (rows - 1) * this.dy + 0.9 * this.dx + binH;
    this.top = (this.h - total) / 2 + 1.4 * this.dx;
    this.left = this.w / 2 - (cols * this.dx) / 2;
    this.binTop = this.top + (rows - 1) * this.dy + 0.9 * this.dx;
    this.pegR = Math.max(2.5, Math.min(this.dx * 0.08, 9));
    this.ballR = Math.min(this.dx * 0.21, 20);
    this.flash = new Map();
    this.trail = [];
  }

  colX(c) { return this.left + (c + 0.5) * this.dx; }

  ballAt(t, layout) {
    const { path, start } = layout;
    const contactY = (k) => this.top + k * this.dy - this.pegR - this.ballR;
    let pos = start;
    if (t < 0) return { x: this.colX(start), y: contactY(0) - this.dx * 1.2, seg: -2 };
    if (t < DROP) {
      const u = t / DROP;
      return { x: this.colX(start), y: contactY(0) - this.dx * 1.2 * (1 - u * u), seg: -1 };
    }
    t -= DROP;
    for (let k = 0; k < path.length; k++) {
      const next = pos + (path[k] ? 0.5 : -0.5);
      const last = k === path.length - 1;
      const d = last ? LAND : hop(k);
      if (t < d) {
        const u = t / d;
        const y0 = contactY(k), y1 = last ? this.binTop + this.ballR * 1.3 : contactY(k + 1);
        const x = this.colX(pos) + (this.colX(next) - this.colX(pos)) * (1 - (1 - u) ** 1.7);
        const y = y0 + (y1 - y0) * u * u - this.dy * 0.35 * Math.sin(Math.PI * u) * (1 - u);
        return { x, y, seg: k, pos };
      }
      t -= d; pos = next;
    }
    return { x: this.colX(pos), y: this.binTop + this.ballR * 1.3, seg: path.length, landed: true };
  }

  frame(now) {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.view?.slots.length || !this.dx) return;
    const { dx, per, rows } = this, n = this.view.slots.length, cols = n * per;
    const pick = this.view.pick;
    const running = pick && now < pick.ends_at;

    // Kugel zuerst berechnen (Stift-Leuchten braucht den Kontakt)
    let ball = null;
    if (pick && pick.layout.path) {
      ball = this.ballAt(now - pick.started_at - START, pick.layout);
      if (running && ball.seg !== this.seg && ball.seg >= 0 && ball.seg < rows) {
        this.flash.set(ball.seg + ":" + ball.pos, now);
        this.onTick(0.4 + 0.6 * ball.seg / rows);
        if (this.useSound) sound.ping(ball.seg);
      }
      if (running && ball.landed && this.seg !== rows && this.seg !== undefined) {
        this.landedAt = now;
        if (this.useSound) sound.land();
        this.onLand();
      }
      if (running) this.onSpeed(ball.landed ? 0 : clamp(1 - Math.max(0, ball.seg) / rows, 0.05, 1));
      this.seg = ball.seg;
      if (running && !reduced) { this.trail.push([ball.x, ball.y]); if (this.trail.length > 10) this.trail.shift(); }
      else this.trail = [];
    }

    // Stifte: gerade Reihen auf ganzen, ungerade auf halben Spalten
    for (let r = 0; r < rows; r++) {
      const y = this.top + r * this.dy;
      for (let c = r % 2 ? 0.5 : 0; c <= cols - 1 + 1e-9; c += 1) {
        const f = this.flash.get(r + ":" + c);
        const g = f ? clamp(1 - (now - f) / 420, 0, 1) : 0;
        const x = this.colX(c);
        if (g > 0) {
          ctx.fillStyle = `rgba(255,194,61,${g * 0.35})`;
          ctx.beginPath(); ctx.arc(x, y, this.pegR * (2.5 + g * 2.5), 0, TAU); ctx.fill();
        }
        const pr = this.pegR * (1 + g * 0.5);
        ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(x, y + 1.5, pr + 2, 0, TAU); ctx.fill();
        ctx.fillStyle = g > 0 ? C.goldHi : "#e9dcc0";
        ctx.beginPath(); ctx.arc(x, y, pr, 0, TAU); ctx.fill();
      }
    }

    // Ein Fach pro Name, so breit wie seine Spalten
    const winSlot = pick && pick.layout.path && now >= pick.ends_at - 400 ? pick.slot : -1;
    const done = pick && !running;
    const bw = per * dx, rad = Math.min(10, bw * 0.12);
    for (let i = 0; i < n; i++) {
      const id = this.view.slots[i], col = this.color(id);
      const x = this.left + i * bw, y = this.binTop;
      const lift = i === winSlot && this.landedAt ? Math.sin(clamp((now - this.landedAt) / 420, 0, 1) * Math.PI) * dx * 0.25 : 0;
      ctx.fillStyle = C.line;
      ctx.beginPath(); ctx.roundRect(x + 1, y - lift, bw - 2, this.binH + 4, rad); ctx.fill();
      ctx.fillStyle = col.fill;
      ctx.beginPath(); ctx.roundRect(x + 3.5, y - lift + 2.5, bw - 7, this.binH - 5, rad * 0.7); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.2)";
      ctx.fillRect(x + 6, y - lift + 5, bw - 12, Math.max(2, this.binH * 0.06));
      ctx.save();
      ctx.textBaseline = "middle";
      if (this.flat) {
        ctx.textAlign = "center";
        const [txt, f] = fitLabel(ctx, this.name(id), bw * 0.86, this.font);
        label(ctx, txt, x + bw / 2, y - lift + this.binH * 0.58, col.text, f);
      } else {
        ctx.translate(x + bw / 2, y - lift + this.binH - this.font * 0.7);
        ctx.rotate(-Math.PI / 2);
        const [txt, f] = fitLabel(ctx, this.name(id), this.binH - this.font * 0.6 - this.ballR * 2.8, this.font);
        label(ctx, txt, 0, 0, col.text, f);
      }
      ctx.restore();
      if (done && i !== winSlot) {
        ctx.fillStyle = `rgba(9,6,14,${0.55 * Math.min(1, (now - pick.ends_at) / 400)})`;
        ctx.fillRect(x + 1, y, bw - 2, this.binH + 4);
      }
      if (i === winSlot) {
        const glow = 0.55 + 0.45 * Math.sin(now / 160);
        ctx.strokeStyle = `rgba(255,233,163,${glow})`; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.roundRect(x + 1, y - lift, bw - 2, this.binH + 4, rad); ctx.stroke();
      }
    }

    this.trail.forEach(([x, y], i) => {
      ctx.fillStyle = `rgba(255,233,163,${(i / this.trail.length) * 0.25})`;
      ctx.beginPath(); ctx.arc(x, y, this.ballR * (0.4 + 0.6 * i / this.trail.length), 0, TAU); ctx.fill();
    });
    if (ball) drawBall(ctx, ball.x, ball.y, this.ballR);
    else {
      const bob = reduced ? 0 : Math.sin(now / 300) * dx * 0.08;
      drawBall(ctx, this.w / 2, this.top - dx * 1.2 + bob, this.ballR);
    }
  }
}
