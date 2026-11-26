// Bühne: Glücksrad
import { clamp } from "../core.js";
import { TAU, reduced } from "../fx.js";
import { C, Stage, WHEEL_REST, bulb, easeOutQuart, fitLabel, gold, hashRand, label, labelFont, pegsPer, smooth } from "./stage.js";

// ===========================================================================
// Glücksrad
// ===========================================================================
export class WheelStage extends Stage {
  layout() {
    this.R = Math.min(this.w * 0.44, this.h * 0.41);
    this.cx = this.w / 2;
    this.cy = this.h / 2 + this.R * 0.07;
    this.img = this.view?.slots.length ? this.render() : null;
  }

  render() {
    const R = this.R, dpr = Math.min(2, devicePixelRatio || 1);
    const cv = document.createElement("canvas");
    cv.width = cv.height = Math.ceil(R * 2.1 * dpr);
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr); ctx.translate(R * 1.05, R * 1.05);
    const slots = this.view.slots, n = slots.length, seg = TAU / n;
    const rOut = R * 0.9, rIn = R * 0.21;
    const lw = Math.max(2, R * 0.014);

    // Rand: dunkler Ring mit Goldkante
    ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    const rim = ctx.createRadialGradient(0, -R * 0.4, R * 0.3, 0, 0, R);
    rim.addColorStop(0, C.plumHi); rim.addColorStop(1, C.ink);
    ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(0, 0, R - lw, 0, TAU); ctx.fill();

    const font = labelFont(n, R, seg, R * 0.6);
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * seg;
      const col = this.color(slots[i]);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, rOut, a0, a0 + seg); ctx.closePath();
      const g = ctx.createRadialGradient(0, 0, rIn, 0, 0, rOut);
      g.addColorStop(0, col.dark); g.addColorStop(0.35, col.fill); g.addColorStop(1, col.fill);
      ctx.fillStyle = g; ctx.fill();
      // Lichtkante außen
      ctx.save(); ctx.clip();
      ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = R * 0.03;
      ctx.beginPath(); ctx.arc(0, 0, rOut - R * 0.02, a0, a0 + seg); ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const [txt, f] = fitLabel(ctx, this.name(slots[i]), rOut - rIn - R * 0.12, font);
      label(ctx, txt, rOut - R * 0.06, 0, col.text, f);
      ctx.restore();
    }
    // Stege
    ctx.strokeStyle = C.line; ctx.lineWidth = Math.max(lw * 0.8, Math.min(lw * 1.4, seg * R * 0.05));
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + i * seg;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn); ctx.lineTo(Math.cos(a) * rOut, Math.sin(a) * rOut); ctx.stroke();
    }
    ctx.lineWidth = lw * 1.5;
    ctx.beginPath(); ctx.arc(0, 0, rOut, 0, TAU); ctx.stroke();
    ctx.strokeStyle = gold(ctx, R); ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(0, 0, rOut + lw * 1.3, 0, TAU); ctx.stroke();

    // Stifte: groß an den Feldgrenzen, kleiner dazwischen
    const per = pegsPer(n), pegs = n * per, step = TAU / pegs;
    const pegR = Math.min(R * 0.014, step * R * 0.3);
    for (let k = 0; k < pegs; k++) {
      const a = -Math.PI / 2 + k * step, r = k % per ? pegR * 0.7 : pegR;
      const x = Math.cos(a) * R * 0.95, y = Math.sin(a) * R * 0.95;
      ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(x, y, r + 1.5, 0, TAU); ctx.fill();
      ctx.fillStyle = gold(ctx, R); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    }

    // Nabe: Chip mit Stern
    ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(0, 0, rIn + lw, 0, TAU); ctx.fill();
    ctx.fillStyle = C.redDeep; ctx.beginPath(); ctx.arc(0, 0, rIn, 0, TAU); ctx.fill();
    ctx.strokeStyle = C.cream; ctx.lineWidth = rIn * 0.16; ctx.setLineDash([rIn * 0.32, rIn * 0.3]);
    ctx.beginPath(); ctx.arc(0, 0, rIn * 0.86, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = C.plum; ctx.beginPath(); ctx.arc(0, 0, rIn * 0.68, 0, TAU); ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = lw; ctx.stroke();
    ctx.fillStyle = gold(ctx, R * 0.2);
    ctx.beginPath();
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 8, r = i % 2 ? rIn * 0.22 : rIn * 0.58;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill(); ctx.stroke();
    return cv;
  }

  angleAt(now) {
    const pick = this.view?.pick;
    const n = this.view?.slots.length || 1, seg = TAU / n;
    if (!pick) {
      this.spinFrom = null;
      if (!reduced) this.angle = (this.angle ?? 0) + (this.idleSpeed ?? 0.0016);
      return this.angle ?? 0;
    }
    const final = -(pick.slot + 0.5 + (hashRand(pick.id) - 0.5) * 0.7) * seg;
    if (!this.spinFrom || this.spinFrom.id !== pick.id) {
      const running = now < pick.ends_at;
      const start = running ? (this.angle ?? 0) : final;
      let end = final;
      while (end < start + 7 * TAU) end += TAU;
      this.spinFrom = { id: pick.id, start, end: running ? end : final };
    }
    const p = this.progress(now, WHEEL_REST);
    // Anlauf: kurz zurückziehen, dann losschnellen
    const wind = now < pick.started_at ? 0 : -0.25 * Math.sin(clamp((now - pick.started_at) / 350, 0, 1) * Math.PI) * (p < 0.05 ? 1 : 0);
    this.speed = p >= 1 ? 0 : 4 * (1 - p) ** 3;
    this.onSpeed(Math.min(1, this.speed / 2.5));
    const { start, end } = this.spinFrom;
    this.angle = start + (end - start) * easeOutQuart(p) + wind;
    return this.angle;
  }

  frame(now) {
    const { ctx, cx, cy, R } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.img) return;
    const A = this.angleAt(now);
    const n = this.view.slots.length, seg = TAU / n;
    const pick = this.view.pick;
    const running = pick && now < pick.ends_at;
    const p = this.progress(now, WHEEL_REST) ?? 0;
    this.advanceChase(now, running ? Math.min(1, this.speed / 2) : 0);

    // Kamera rückt an den Zeiger, wenn es langsam wird
    const zt = pick ? (running ? smooth(0.6, 0.97, p) : Math.max(0, 1 - (now - pick.ends_at) / 900)) : 0;
    const zoom = 1 + 0.16 * (reduced ? 0 : zt);
    const fx = cx, fy = cy - R * 0.85;
    ctx.save();
    ctx.translate(fx, fy); ctx.scale(zoom, zoom); ctx.translate(-fx, -fy);

    // Schatten und Ständer
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.beginPath(); ctx.ellipse(cx + R * 0.05, cy + R * 1.04, R * 0.8, R * 0.07, 0, 0, TAU); ctx.fill();
    // Äußerer Lichterkranz (steht still, Lauflicht läuft)
    ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(cx, cy, R * 1.075, 0, TAU); ctx.fill();
    ctx.fillStyle = C.plum; ctx.beginPath(); ctx.arc(cx, cy, R * 1.06, 0, TAU); ctx.fill();
    const nb = Math.max(20, Math.round(R / 9)), done = pick && !running;
    for (let k = 0; k < nb; k++) {
      const a = -Math.PI / 2 + (k + 0.5) * TAU / nb;
      let on = ((k + Math.floor(this.chase)) % 3 === 0) ? 1 : 0.12;
      if (done) on = Math.floor(now / 110) % 2 === k % 2 ? 1 : 0.2;
      bulb(ctx, cx + Math.cos(a) * R * 1.03, cy + Math.sin(a) * R * 1.03, Math.max(2.2, R * 0.012), on);
    }

    ctx.save(); ctx.translate(cx, cy); ctx.rotate(A);
    ctx.drawImage(this.img, -R * 1.05, -R * 1.05, R * 2.1, R * 2.1);
    // Ergebnis: alle anderen Felder abdunkeln, das gezogene pulsiert
    if (done) {
      const k = Math.min(1, (now - pick.ends_at) / 400);
      ctx.fillStyle = `rgba(9,6,14,${0.6 * k})`;
      ctx.beginPath(); ctx.moveTo(0, 0);
      const a0 = -Math.PI / 2 + pick.slot * seg;
      ctx.arc(0, 0, R * 0.9, a0 + seg, a0 + TAU); ctx.closePath(); ctx.fill();
      const glow = 0.55 + 0.45 * Math.sin(now / 160);
      ctx.strokeStyle = `rgba(255,233,163,${glow})`; ctx.lineWidth = R * 0.022; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R * 0.9, a0, a0 + seg); ctx.closePath(); ctx.stroke();
    }
    ctx.restore();
    // Glanz oben links, dreht nicht mit
    const sheen = ctx.createLinearGradient(cx - R, cy - R, cx + R * 0.2, cy + R * 0.2);
    sheen.addColorStop(0, "rgba(255,255,255,.13)"); sheen.addColorStop(0.5, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen; ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, TAU); ctx.fill();

    // Stift unter dem Zeiger gewechselt? Das ist der Takt für Klappe, Ton und Licht.
    const pegStep = seg / pegsPer(n);
    const under = Math.floor(((-A % TAU) + TAU) % TAU / pegStep);
    if (running && now >= pick.started_at && this.under !== undefined && under !== this.under) {
      this.tick(0.55 + 0.45 * (1 - p));
    }
    this.under = under;

    // Zeiger: Zunge mit Goldkappe, wird vom Stift ausgelenkt
    const phase = (((-A % pegStep) + pegStep) % pegStep) / pegStep;
    const push = running && phase < 0.3 ? 1 - phase / 0.3 : 0;
    this.flap = (this.flap || 0) + (push - (this.flap || 0)) * 0.45;
    const s = R * 0.085;
    ctx.save();
    ctx.translate(cx, cy - R * 1.02);
    ctx.rotate(this.flap * 0.5);
    ctx.lineJoin = "round"; ctx.lineWidth = Math.max(3, R * 0.012); ctx.strokeStyle = C.line;
    ctx.fillStyle = C.red;
    ctx.beginPath(); ctx.moveTo(-s * 0.75, -s * 0.2); ctx.lineTo(s * 0.75, -s * 0.2); ctx.lineTo(0, s * 1.7); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,.35)";
    ctx.beginPath(); ctx.moveTo(-s * 0.45, -s * 0.05); ctx.lineTo(-s * 0.1, -s * 0.05); ctx.lineTo(0, s * 1.1); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.save(); ctx.translate(cx, cy - R * 1.02);
    ctx.fillStyle = gold(ctx, s); ctx.strokeStyle = C.line; ctx.lineWidth = Math.max(3, R * 0.012);
    ctx.beginPath(); ctx.arc(0, -s * 0.15, s * 0.55, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.restore();
    ctx.restore();
  }
}
