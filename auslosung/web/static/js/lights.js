// Glühbirnen-Ketten um Schilder und Bühne
import { reduced } from "./fx.js";

// =============================================================================
// Licht
// =============================================================================
// Lauflicht, das der Spannung folgt.
//
// Ruhe:     langsames Lauflicht, jede vierte Birne an.
// Letzte Einsätze: hektisches Wechselblinken, wird zum Ende schneller.
// Keine Wetten mehr: alles aus, dann ein einzelner Blitz.
// Drehung:  Tempo des Lauflichts = Tempo des Rads. Je langsamer es wird,
//           desto dunkler der Rahmen und desto deutlicher blitzen alle
//           Birnen bei jedem Feld, das am Zeiger vorbeigeht.
// Ergebnis: kurzes Stroboskop, danach volles, ruhig flackerndes Licht.

export class Lights {
  constructor(boxes, spacing = 26) {
    this.boxes = boxes;
    this.spacing = spacing;
    this.bulbs = [];
    this.phase = 0;
    this.flashLevel = 0;
    this.speed = 0;          // 0..1, von der Bühne gemeldet
    this.mode = "idle";
    this.revealAt = 0;
    this.last = performance.now();
    const ro = new ResizeObserver(() => this.build());
    boxes.forEach((b) => ro.observe(b.parentElement));
    document.fonts?.ready.then(() => this.build());
    requestAnimationFrame((t) => this.frame(t));
  }

  /** Birnen gleichmäßig um ein Rechteck verteilen. */
  build() {
    this.bulbs = [];
    let k = 0;
    for (const box of this.boxes) {
      const { width: W, height: H } = box.getBoundingClientRect();
      if (!W || !H) continue;
      const per = 2 * (W + H), n = Math.max(8, Math.round(per / this.spacing));
      let html = "";
      for (let i = 0; i < n; i++) {
        let s = (i / n) * per, x, y;
        if (s < W) { x = s; y = 0; }
        else if ((s -= W) < H) { x = W; y = s; }
        else if ((s -= H) < W) { x = W - s; y = H; }
        else { x = 0; y = H - (s - W); }
        html += `<span class="bulb" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px"><b></b></span>`;
      }
      box.innerHTML = html;
      box.querySelectorAll("b").forEach((el) => this.bulbs.push({ el, i: k++, v: -1 }));
    }
  }

  idle() { this.mode = "idle"; }
  calls() { this.mode = "calls"; this.callsAt = performance.now(); }
  lock() { this.mode = "lock"; this.lockAt = performance.now(); }
  spin() { if (this.mode !== "spin") { this.mode = "spin"; this.speed = 1; } }
  reveal() { this.mode = "reveal"; this.revealAt = performance.now(); }
  /** Ein Feld/Stift ist vorbeigekommen. */
  tick() { this.flashLevel = 1; }
  setSpeed(s) { this.speed = s; }

  frame(t) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    const n = this.bulbs.length;
    if (!n) return;

    let rate, floor, every, flash = 0;
    if (this.mode === "calls") {
      const since = (t - this.callsAt) / 1000;
      const hz = 3 + since * 1.2;
      const on = Math.floor(since * hz) % 2;
      for (const b of this.bulbs) this.set(b, (b.i % 2) === on ? 1 : 0.15);
      return;
    }
    if (this.mode === "lock") {
      const since = (t - this.lockAt) / 1000;
      const v = since < 0.12 ? 1 : Math.max(0.04, 0.9 * Math.exp(-(since - 0.12) * 3));
      for (const b of this.bulbs) this.set(b, v);
      return;
    }
    if (this.mode === "spin") {
      const s = this.speed;
      rate = 2 + 70 * s * s;                 // Birnen pro Sekunde
      floor = 0.06 + 0.3 * s;                // langsamer = dunkler
      every = 3;
      flash = this.flashLevel * (1 - s) ** 1.5;
    } else if (this.mode === "reveal") {
      const since = (t - this.revealAt) / 1000;
      if (since < 2.4) {
        const on = Math.floor(since * 12) % 2;
        for (const b of this.bulbs) this.set(b, (b.i % 2) === on ? 1 : 0.1);
        return;
      }
      rate = 6; floor = 0.82; every = 5;
    } else {
      rate = 3; floor = 0.12; every = 4;
    }
    if (reduced) { rate = 0; flash = Math.min(flash, 0.4); }
    this.phase += rate * dt;
    this.flashLevel = Math.max(0, this.flashLevel - dt * 7);

    for (const b of this.bulbs) {
      const lit = ((b.i - Math.floor(this.phase)) % every + every) % every === 0;
      const v = Math.min(1, (lit ? 1 : floor) + flash);
      this.set(b, v);
    }
  }

  set(b, v) {
    const q = Math.round(v * 20) / 20;      // nur bei echter Änderung schreiben
    if (q !== b.v) { b.v = q; b.el.style.opacity = q; }
  }
}
