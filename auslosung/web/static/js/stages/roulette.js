// Bühne: Roulette, die Namen stehen im Kessel, die Kugel sucht sich ein Fach
import { sound } from "../audio.js";
import { clamp } from "../core.js";
import { TAU, reduced } from "../fx.js";
import { C, Stage, bulb, drawBall, easeOutCubic, fitLabel, gold, label, labelFont, pegsPer } from "./stage.js";

// ===========================================================================
// Roulette: die Namen stehen im Kessel, die Kugel sucht sich ein Fach
// ===========================================================================
export class RouletteStage extends Stage {
  layout() {
    this.R = Math.min(this.w * 0.46, this.h * 0.45);
    this.cx = this.w / 2; this.cy = this.h / 2;
    this.img = this.view?.slots.length ? this.render() : null;
  }

  pocketColor(i, n) {
    if (n % 2 && i === n - 1) return "#12945f";
    return i % 2 ? C.ink : C.red;
  }

  render() {
    const R = this.R, dpr = Math.min(2, devicePixelRatio || 1);
    const cv = document.createElement("canvas");
    cv.width = cv.height = Math.ceil(R * 2 * dpr);
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr); ctx.translate(R, R);
    const slots = this.view.slots, n = slots.length, seg = TAU / n;
    const rOut = R * 0.8, rMid = R * 0.42, rIn = R * 0.33;
    const font = labelFont(n, R * 0.85, seg, (rOut + rMid) / 2);
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + (i - 0.5) * seg, a1 = a0 + seg;
      const col = this.pocketColor(i, n);
      ctx.beginPath(); ctx.arc(0, 0, rOut, a0, a1); ctx.arc(0, 0, rMid, a1, a0, true); ctx.closePath();
      ctx.fillStyle = col; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, rMid, a0, a1); ctx.arc(0, 0, rIn, a1, a0, true); ctx.closePath();
      ctx.fillStyle = col === C.red ? C.redDeep : col === C.ink ? "#0c0711" : "#0a5a3a"; ctx.fill();
      ctx.save();
      ctx.rotate(a0 + seg / 2);
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const [txt, f] = fitLabel(ctx, this.name(slots[i]), rOut - rMid - R * 0.05, font);
      label(ctx, txt, rOut - R * 0.025, 0, C.cream, f);
      ctx.restore();
    }
    ctx.strokeStyle = gold(ctx, R); ctx.lineWidth = Math.max(2, R * 0.008);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i - 0.5) * seg;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * rIn, Math.sin(a) * rIn); ctx.lineTo(Math.cos(a) * rOut, Math.sin(a) * rOut); ctx.stroke();
    }
    ctx.strokeStyle = C.line; ctx.lineWidth = Math.max(3, R * 0.016);
    [rOut, rIn].forEach((r) => { ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); });
    ctx.strokeStyle = gold(ctx, R); ctx.lineWidth = Math.max(2, R * 0.008);
    ctx.beginPath(); ctx.arc(0, 0, rMid, 0, TAU); ctx.stroke();
    // Kegel mit Kreuz
    const cone = ctx.createRadialGradient(-R * 0.08, -R * 0.1, R * 0.03, 0, 0, rIn);
    cone.addColorStop(0, C.plumHi); cone.addColorStop(1, C.ink);
    ctx.fillStyle = cone; ctx.beginPath(); ctx.arc(0, 0, rIn - 2, 0, TAU); ctx.fill();
    ctx.lineCap = "round";
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2, x = Math.cos(a) * R * 0.2, y = Math.sin(a) * R * 0.2;
      ctx.strokeStyle = C.line; ctx.lineWidth = R * 0.034;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke();
      ctx.strokeStyle = gold(ctx, R * 0.25); ctx.lineWidth = R * 0.018;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(x, y, R * 0.03, 0, TAU); ctx.fill();
      ctx.fillStyle = C.goldHi; ctx.beginPath(); ctx.arc(x, y, R * 0.021, 0, TAU); ctx.fill();
    }
    ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(0, 0, R * 0.085, 0, TAU); ctx.fill();
    ctx.fillStyle = gold(ctx, R * 0.08); ctx.beginPath(); ctx.arc(0, 0, R * 0.07, 0, TAU); ctx.fill();
    return cv;
  }

  drawBowl(now, running) {
    const { ctx, cx, cy, R } = this;
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.beginPath(); ctx.ellipse(cx + R * 0.04, cy + R * 0.06, R * 1.01, R * 1.01, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
    const rim = ctx.createRadialGradient(cx, cy - R * 0.3, R * 0.5, cx, cy, R);
    rim.addColorStop(0, C.plumHi); rim.addColorStop(1, C.plum);
    ctx.fillStyle = rim; ctx.beginPath(); ctx.arc(cx, cy, R * 0.985, 0, TAU); ctx.fill();
    ctx.save(); ctx.translate(cx, cy);
    // Lichter auf dem Rand
    const nb = Math.max(18, Math.round(R / 10));
    for (let k = 0; k < nb; k++) {
      const a = (k + 0.5) * TAU / nb;
      let on = ((k + Math.floor(this.chase)) % 3 === 0) ? 1 : 0.12;
      if (!running && this.view.pick) on = Math.floor(now / 110) % 2 === k % 2 ? 1 : 0.2;
      bulb(ctx, Math.cos(a) * R * 0.955, Math.sin(a) * R * 0.955, Math.max(2, R * 0.011), on);
    }
    // Laufbahn
    ctx.fillStyle = C.line; ctx.beginPath(); ctx.arc(0, 0, R * 0.925, 0, TAU); ctx.fill();
    const track = ctx.createRadialGradient(0, 0, R * 0.78, 0, 0, R * 0.92);
    track.addColorStop(0, "#0b0710"); track.addColorStop(0.6, "#1d1128"); track.addColorStop(1, "#3a2650");
    ctx.fillStyle = track; ctx.beginPath(); ctx.arc(0, 0, R * 0.91, 0, TAU); ctx.fill();
    for (let k = 0; k < 8; k++) {
      const a = k * TAU / 8 + TAU / 16;
      ctx.save(); ctx.rotate(a); ctx.translate(R * 0.84, 0);
      ctx.fillStyle = gold(ctx, 8); ctx.strokeStyle = C.line; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-R * 0.032, 0); ctx.lineTo(0, -R * 0.014); ctx.lineTo(R * 0.032, 0); ctx.lineTo(0, R * 0.014); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  frame(now) {
    const { ctx, cx, cy, R } = this;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.img) return;
    const n = this.view.slots.length, seg = TAU / n;
    const pick = this.view.pick;
    const running = pick && now < pick.ends_at;
    const p = this.progress(now);
    const ps = 0.92, q = clamp((p ?? 0) / ps, 0, 1);   // Kugel liegt knapp 0,9 s, dann Ergebnis
    this.advanceChase(now, running ? (1 - q) : 0);
    this.drawBowl(now, running);
    // Kessel dreht langsam; während der Ziehung zwei Extra-Umdrehungen (≡ 0, also nahtlos)
    const W = (reduced ? 0 : (now / 1000 * 0.2) % TAU) + (p === null ? 0 : 2 * TAU * easeOutCubic(p));
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(W);
    ctx.drawImage(this.img, -R, -R, R * 2, R * 2);
    ctx.restore();
    if (!pick) return;

    const target = pick.slot * seg;
    const rel = target + 8 * TAU * (1 - easeOutCubic(q));
    const rTrack = R * 0.865, rDef = R * 0.77, rPocket = R * 0.37;
    const a = 0.52, b = 0.69;               // wie vorher, auf die kürzere Ruhe gestreckt
    let rad;
    if (p < a) rad = rTrack;
    else if (p < b) rad = rTrack + (rDef - rTrack) * ((p - a) / (b - a)) ** 2;
    else if (p < ps) {
      const u = (p - b) / (ps - b);
      rad = rPocket + (rDef - rPocket) * (1 - u) ** 1.4 * Math.abs(Math.cos(u * Math.PI * 4.5));
    } else rad = rPocket;
    const B = W + rel - Math.PI / 2;

    if (!running) {
      const k = Math.min(1, (now - pick.ends_at) / 400);
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(W - Math.PI / 2);
      ctx.fillStyle = `rgba(9,6,14,${0.55 * k})`;
      ctx.beginPath(); ctx.arc(0, 0, R * 0.8, target + seg / 2, target + TAU - seg / 2); ctx.arc(0, 0, R * 0.33, target + TAU - seg / 2, target + seg / 2, true);
      ctx.closePath(); ctx.fill();
      const glow = 0.55 + 0.45 * Math.sin(now / 160);
      ctx.strokeStyle = `rgba(255,233,163,${glow})`; ctx.lineWidth = R * 0.016; ctx.lineJoin = "round";
      ctx.beginPath(); ctx.arc(0, 0, R * 0.8, target - seg / 2, target + seg / 2); ctx.arc(0, 0, R * 0.33, target + seg / 2, target - seg / 2, true);
      ctx.closePath(); ctx.stroke();
      ctx.restore();
    }
    drawBall(ctx, cx + Math.cos(B) * rad, cy + Math.sin(B) * rad, R * 0.028);

    if (running) {
      this.onSpeed(p < ps ? (1 - q) ** 2 : 0);
      // Takt fürs Licht: feste Dichte, auch bei wenigen großen Fächern.
      // Klacken nur an echten Fachstegen.
      const per = pegsPer(n), beats = n * per;
      const beat = Math.floor((((rel / (TAU / beats) + per / 2) % beats) + beats) % beats);
      if (now >= pick.started_at && this.beat !== undefined && beat !== this.beat && p < ps) {
        this.onTick(0.5);
        if (this.useSound && p > a && beat % per === 0) sound.clack(0.4 + 0.6 * (p - a) / (ps - a));
      }
      this.beat = beat;
      if (this.useSound && now >= pick.started_at) {
        if (p < ps) sound.roll(0.15 + 0.6 * (1 - q));
        if (this.lastP < ps && p >= ps) { sound.clack(1); sound.rollStop(); this.onLand(); }
      }
      this.lastP = p;
    } else {
      if (this.useSound && this.lastP !== undefined && this.lastP < 1) sound.rollStop();
      this.lastP = 1;
    }
  }
}
