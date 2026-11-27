// Bühne: Slots. 5 × 3 Walzen aus DOM-Elementen über der Leinwand.
//
// Der Server dreht jede Runde bei „Keine Wetten mehr“ und schickt das Ergebnis mit
// einem Zeitplan (game/slots.py: timeline). Hier wird daraus eine Liste von
// Ereignissen mit festen Zeitpunkten: Walze stoppt, Glück kopiert eine Zelle,
// Muster zählt, Faktor zündet, Abrechnung. Jedes Bild ist eine Funktion der
// Serverzeit; Effekte und Töne gibt es nur für Ereignisse, die gerade jetzt
// passieren. Wer neu lädt, steigt im richtigen Zustand ein, ohne Feuerwerk.
import { sound } from "../audio.js";
import { badgeHtml, esc, ranked, serverNow, skinHtml, sum } from "../core.js";
import { countTo, fmt, reduced } from "../fx.js";
import { slotSfx } from "../slot-sfx.js";
import { Stage } from "./stage.js";

const COLS = 5, ROWS = 3;
const LEVER = 450;                 // Ersatz, falls der Zeitplan keinen Wert mitbringt (game/slots.py)
const LIVE = 700;                  // so lange nach seinem Zeitpunkt gilt ein Ereignis als „jetzt“
const TIER_WORDS = ["", "Treffer", "Super", "Mega", "Jackpot"];
const SPECIAL_FILL = ["W", "N", "x2"];

export class SlotStage extends Stage {
  constructor(canvas, mode, opts = {}) {
    super(canvas, mode, opts);
    this.onEvent = () => {};          // (art, daten, live) für Bildschirm und Handy
    this.compact = !!opts.compact;    // Handy: ohne Zwischenstand-Karte
    this.root = document.createElement("div");
    this.root.className = "slots-stage";
    this.root.innerHTML = `
      <div class="marquee" aria-live="polite"><span class="txt"></span><span class="dots"></span></div>
      <div class="machine">
        <div class="slot">${Array.from({ length: COLS }, () => `<div class="reel"><div class="reel-strip"></div></div>`).join("")}</div>
        <svg class="slot-lines" aria-hidden="true"></svg>
        <div class="slot-pops" aria-hidden="true"></div>
        <div class="slot-over"></div>
      </div>
      <div class="slot-hud">
        <span class="sbox chips"><small>Punkte</small><b>0</b></span><span class="sop">×</span>
        <span class="sbox mult"><small>Faktor</small><b>1</b></span><span class="sop">=</span>
        <span class="counter zero">0</span>
      </div>`;
    canvas.after(this.root);
    this.reels = [...this.root.querySelectorAll(".reel")];
    this.strips = this.reels.map((r) => r.querySelector(".reel-strip"));
    this.lines = this.root.querySelector(".slot-lines");
    this.pops = this.root.querySelector(".slot-pops");
    this.over = this.root.querySelector(".slot-over");
    this.counter = this.root.querySelector(".counter");
    this.hud = this.root.querySelector(".slot-hud");
    this.chipsBox = this.root.querySelector(".sbox.chips");
    this.multBox = this.root.querySelector(".sbox.mult");
    this.marquee = this.root.querySelector(".marquee");
    this.events = [];
    this.done = 0;
    this.eventsKey = null;
    this.grid = null;
    this.session = {};
    this.version = 0;
  }

  destroy() {
    super.destroy();
    slotSfx.stopAll();
    this.root.remove();
  }

  layout() {
    // Breite des Automaten ≈ 5,9 Zellen, Höhe mit Laufschrift und Zähler ≈ 5,3 Zellen
    const cell = Math.max(28, Math.min(this.w * 0.94 / 5.9, this.h * 0.95 / 5.3, 170));
    this.cell = cell;
    this.root.style.setProperty("--slot-cell", `${cell}px`);
    if (this.grid && !this.spin) this.paintGrid(this.grid);
  }

  show(view) {
    const prevSlots = this.view?.slots.join(",");
    this.view = view;
    this.skins = view.skins || {};
    const pick = view.pick?.mode === "slots" ? view.pick : null;
    const key = pick ? `${pick.id}:${pick.rounds.filter((r) => r.locked).length}` : null;
    if (key !== this.eventsKey) {
      const samePick = pick && this.pickId === pick.id;
      this.pickId = pick?.id ?? null;
      this.eventsKey = key;
      this.events = pick ? this.buildEvents(pick) : [];
      if (!samePick) this.reset();
      // Alles wird von vorn nachgespielt: Punkte neu zählen, sonst zählen frühere Runden mehrfach
      this.session = {};
      this.roundPts = {};
      // Bis jetzt Vergangenes still nachholen, ab dem letzten Bild live weiter
      const until = samePick ? this.lastFrame || 0 : Infinity;
      this.done = 0;
      this.replay(Math.min(until, this.now()), false);
    }
    if (!pick && prevSlots !== view.slots.join(",")) this.idleGrid();
    this.renderMarquee();
  }

  now() { return this.lastFrame || serverNow(); }

  reset() {
    slotSfx.stopAll();
    this.spin = null;
    this.session = {};
    this.roundPts = {};
    this.round = null;
    this.version++;
    this.clearMarks();
    this.over.innerHTML = "";
    this.setCounter(0);
    this.idleGrid();
  }

  /** Vor der ersten Runde: die Namen im Topf, gut gemischt, damit jeder sein Symbol sieht. */
  idleGrid() {
    const ids = this.view?.slots || [];
    if (!ids.length) { this.grid = null; this.strips.forEach((s) => { s.innerHTML = ""; }); return; }
    // Schrittweite teilerfremd zur Anzahl: jeder Name kommt vor, Nachbarn unterscheiden sich
    const n = ids.length, gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const step = [7, 5, 4, 3, 2, 1].find((k) => gcd(k, n) === 1);
    const g = Array.from({ length: COLS }, (_, c) => Array.from({ length: ROWS }, (_, r) => ids[(r * COLS + c) * step % n]));
    this.paintGrid(g);
  }

  cellHtml(v, extra = "") { return skinHtml(v, this.skins, this.view?.names || {}, extra); }

  paintGrid(g) {
    this.grid = g.map((col) => [...col]);
    g.forEach((col, c) => this.paintReel(c, col));
  }

  paintReel(c, col, cls = "") {
    const reel = this.reels[c], strip = this.strips[c];
    strip.innerHTML = col.map((v, r) => this.cellHtml(v, `r${r}`)).join("");
    strip.style.transform = "";
    reel.classList.remove("spinning", "tease");
    if (cls) { reel.classList.remove(cls); void reel.offsetWidth; reel.classList.add(cls); }
  }

  cellEl(c, r) { return this.strips[c].children[r]; }

  // ---------------------------------------------------------------------------
  // Ereignisse aus dem Ergebnis
  buildEvents(pick) {
    const ev = [];
    const add = (at, type, data = {}) => ev.push({ at, type, ...data });
    for (const r of pick.rounds) {
      if (!r.locked || !r.result) continue;
      const base = r.started_at, res = r.result;
      add(r.calls_at, "round", { round: r });
      res.spins.forEach((s, i) => {
        const t = s.t, ctx = { round: r, spin: s, i };
        add(base + t.at, "spin", ctx);
        t.stops.forEach((at, c) => add(base + at, "stop", { ...ctx, c }));
        t.luck.forEach((at, k) => add(base + at, "morph", { ...ctx, k }));
        if (s.bust) add(base + t.bust, "bust", ctx);
        t.pat.forEach((at, k) => add(base + at, "pattern", { ...ctx, k }));
        t.mult.forEach((at, k) => add(base + at, "mult", { ...ctx, k }));
        add(base + t.tally, "tally", ctx);
        if (t.lot) add(base + t.lot, "lot", ctx);
        if (t.again) add(base + t.again, "again", ctx);
      });
      add(base + res.summary_at, "summary", { round: r, final: r.n >= pick.layout.rounds });
    }
    return ev.sort((a, b) => a.at - b.at);
  }

  replay(until, live) {
    while (this.done < this.events.length && this.events[this.done].at <= until) {
      const e = this.events[this.done++];
      this.apply(e, live && until - e.at < LIVE);
    }
  }

  frame(now) {
    this.ctx.clearRect(0, 0, this.w, this.h);
    const from = this.lastFrame;
    this.lastFrame = now;
    if (from !== undefined) this.replay(now, true);
    this.animateReels(now);
  }

  animateReels(now) {
    const s = this.spin;
    if (!s) return;
    const loop = this.cell * 1.08 * s.fill;
    const dt = Math.min(100, now - (s.last ?? now));
    s.last = now;
    let moving = 0;
    for (let c = 0; c < COLS; c++) {
      if (s.stopped[c]) continue;
      const run = now - s.start - s.lever;
      // Beinahe-Muster: die letzte Walze läuft langsamer, man sieht die Namen vorbeiziehen
      const slow = s.tease && c === COLS - 1 && s.stopped[COLS - 2];
      if (run >= 0) s.pos[c] += dt * this.cell * (slow ? 0.011 : 0.028);
      // Ausholen: kurz nach oben, dann Vollgas
      const y = run < 0 ? -this.cell * 0.12 * Math.sin((1 + run / s.lever) * Math.PI) : s.pos[c] % loop;
      this.strips[c].style.transform = `translateY(${-loop + y}px)`;
      if (run >= 0) moving++;
    }
  }

  apply(e, live) {
    const fx = live && !reduced;
    const sfx = live && this.useSound;
    switch (e.type) {
      case "round": {
        this.round = e.round;
        this.roundPts = {};
        this.renderMarquee();
        const old = this.over.firstElementChild;      // Rundenkarte weg, die Pause übernimmt
        if (old) { old.classList.add("out"); setTimeout(() => old.remove(), 340); }
        return;
      }
      case "spin": return this.startSpin(e, live, sfx);
      case "stop": {
        const col = e.spin.grid[e.c];
        this.grid[e.c] = [...col];
        if (this.spin) this.spin.stopped[e.c] = true;
        this.paintReel(e.c, col, fx ? "stop" : "");
        if (sfx) slotSfx.reelStop(e.c);
        else if (this.useSound && e.c === COLS - 1) slotSfx.stopAll();
        if (live) this.onEvent("stop", e, live);
        if (e.spin.tease && e.c === COLS - 2 && this.spin) {
          this.reels[COLS - 1].classList.add("tease");
          if (sfx) slotSfx.tease();
        }
        if (e.c === COLS - 1) {
          if (this.useSound) slotSfx.spinEnd();
          this.spin = null;
          const busts = this.grid.flat().filter((v) => v === "N").length;
          if (busts === 2 && !e.spin.bust) {
            this.renderMarquee("Zwei Nieten!", "warn");
            if (sfx) slotSfx.warn();
          }
        }
        return;
      }
      case "morph": {
        const [c, r, id] = e.spin.luck[e.k];
        this.grid[c][r] = id;
        const el = this.cellEl(c, r);
        if (el) el.outerHTML = this.cellHtml(id, `r${r} morph`);
        if (sfx) slotSfx.morph(e.k);
        if (live) this.onEvent("morph", e, live);
        return;
      }
      case "bust": {
        this.forCells((v, el) => el.classList.toggle(v === "N" ? "shake" : "dim", fx || v !== "N"));
        this.overlay(`<div class="bust-stamp">Pleite<small>Drei Nieten, dieser Spin zählt nicht</small></div>`);
        this.renderMarquee("Pleite", "warn");
        if (sfx) slotSfx.bust();
        if (live) this.onEvent("bust", e, live);
        return;
      }
      case "pattern": return this.scorePattern(e, live, fx, sfx);
      case "mult": {
        const [c, r, x] = e.spin.mult[e.k];
        const el = this.cellEl(c, r);
        if (el) { el.classList.remove("dim", "fire"); void el.offsetWidth; el.classList.add("fire"); }
        const total = e.spin.mult.slice(0, e.k + 1).reduce((m, [, , v]) => m * v, 1);
        this.setBox(this.multBox, `×${Math.min(total, e.spin.x)}`, fx, true);
        if (sfx) slotSfx.multiplier(e.k, x);
        if (live) this.onEvent("mult", { ...e, x }, live);
        return;
      }
      case "tally": return this.tally(e, live, fx, sfx);
      case "lot": {
        const name = this.view.names[String(e.spin.lot.id)] ?? "?";
        this.overlay(`<div class="again-stamp">Los entscheidet<small>${esc(name)} bekommt den Punkt</small></div>`);
        if (sfx) slotSfx.lot();
        if (live) this.onEvent("lot", e, live);
        return;
      }
      case "again": {
        const why = e.spin.again === "tie" ? "Gleichstand an der Spitze" : "Noch niemand vorn";
        this.overlay(`<div class="again-stamp">Nochmal!<small>${why} · zählt nur für die Punkte</small></div>`);
        if (sfx) slotSfx.again();
        if (live) this.onEvent("again", e, live);
        return;
      }
      case "summary": {
        // Letzte Runde: Endstand über alle Runden, bevor der Name kommt. Gezogen wird, wer insgesamt vorn liegt,
        // nicht wer den letzten Spin gewinnt.
        if (e.final) { if (fx) this.overlay(this.finalCard()); else this.clearOverlay(); }
        // Nur live: beim Nachspielen (neue Runde, Neuladen) läge die Karte sonst unter Pause und Stempel
        else if (!this.compact && fx) this.overlay(this.roundCard(e.round));
        if (sfx && !e.final) slotSfx.roundEnd();
        if (live) this.onEvent("summary", e, live);
        return;
      }
    }
  }

  startSpin(e, live, sfx) {
    this.round = e.round;
    this.clearMarks();
    this.over.innerHTML = "";
    this.setCounter(0);
    const lucky = e.spin.luck.length > 0;
    this.renderMarquee(lucky ? "Glücks-Spin!" : null, lucky ? "luck" : "");
    if (!this.grid) this.idleGrid();
    // Füllstreifen: Namen im Topf und ab und zu eine Sonderzelle, die letzte Zeile wie das Endbild
    const ids = this.view.slots, fill = 9;
    const lever = e.spin.t.lever ?? LEVER;
    this.spin = { start: e.at, lever, stopped: Array(COLS).fill(false), fill, tease: e.spin.tease,
      pos: Array(COLS).fill(Math.max(0, serverNow() - e.at - lever) * this.cell * 0.028) };
    for (let c = 0; c < COLS; c++) {
      const cells = [];
      for (let k = 0; k < fill; k++) {
        const x = (c * 31 + k * 17 + e.i * 7) % 23;
        cells.push(x < 2 ? SPECIAL_FILL[x % 3] : ids[(c * 5 + k * 3 + e.i) % ids.length]);
      }
      const strip = [...cells, ...(this.grid?.[c] || cells.slice(0, ROWS))];
      this.strips[c].innerHTML = strip.map((v) => this.cellHtml(v)).join("");
      this.reels[c].classList.remove("stop", "tease");
      this.reels[c].classList.add("spinning");
    }
    if (sfx) {
      slotSfx.lever(lever);
      slotSfx.spinStart(lever);
      if (lucky) setTimeout(() => slotSfx.luckSurge(), lever + 150);
    }
    if (live) this.onEvent("spin", e, live);
  }

  /**
   * Ein Muster zählt wie eine Hand in Balatro: Feld für Feld ruckt, tickt eine
   * Stufe höher und schiebt seine Punkte in den Punkte-Kasten. Danach die Linie
   * mit dem Namen und ein Akkord, der das Muster abschließt.
   */
  scorePattern(e, live, fx, sfx) {
    const p = e.spin.pat[e.k];
    const acc = this.skins[String(p.id)]?.[1] ?? 1;
    if (e.k === 0) this.forCells((v, el) => el.classList.add("dim"));
    this.lines.querySelectorAll(".pattern-line").forEach((l) => l.classList.add("old"));
    const pts = this.centers(p.cells);
    const d = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    this.lines.insertAdjacentHTML("beforeend",
      `<g class="acc-${acc}"><polyline class="pattern-line under${fx ? "" : " old"}" pathLength="1" points="${d}"/><polyline class="pattern-line${fx ? "" : " old"}" pathLength="1" points="${d}"/></g>`);
    const base = this.spinBase || 0;
    this.spinBase = base + p.v;
    const n = p.cells.length;
    // Punkte auf die Felder verteilen (Rest auf die letzten)
    const per = p.cells.map((_, i) => Math.floor(p.v / n) + (i >= n - (p.v % n) ? 1 : 0));
    const gap = fx ? Math.min(110, 560 / n) : 0;
    const pid = this.pickId;
    let sum = base;
    p.cells.forEach(([c, r], i) => {
      const go = () => {
        if (this.pickId !== pid) return;
        const el = this.cellEl(c, r);
        if (el) { el.classList.remove("dim", "hit"); if (fx) void el.offsetWidth; el.classList.add("hit"); }
        sum += per[i];
        this.setBox(this.chipsBox, fmt(sum), fx);
        if (fx && per[i]) this.cellPop(pts[i], `+${per[i]}`);
        if (sfx) slotSfx.cellTick(i, e.k);
      };
      if (gap) setTimeout(go, i * gap); else go();
    });
    const after = () => {
      if (this.pickId !== pid) return;
      this.setBox(this.chipsBox, fmt(this.spinBase));
      // Name des Musters im Punkte-Kasten statt einer zweiten Einblendung über den Feldern
      const lab = this.chipsBox.querySelector("small");
      lab.textContent = this.view.names[String(p.id)] ?? "Punkte";
      lab.className = `acc-${acc}`;
      if (fx) this.setBox(this.chipsBox, fmt(this.spinBase), true, true);
      if (sfx) slotSfx.pattern(e.k, p.v);
      if (live) this.onEvent("pattern", { ...e, p }, live);
    };
    if (gap) setTimeout(after, n * gap + 40); else after();
  }

  /** Kleiner Punkte-Chip über einem Feld. */
  cellPop([x, y], text) {
    const el = document.createElement("div");
    el.className = "cell-pop";
    el.style.left = `${x}px`; el.style.top = `${y - this.cell * 0.32}px`;
    el.textContent = text;
    this.pops.append(el);
    setTimeout(() => el.remove(), 700);
  }

  tally(e, live, fx, sfx) {
    const s = e.spin;
    const total = sum(s.pts);
    for (const [id, v] of Object.entries(s.pts)) {
      this.session[id] = (this.session[id] || 0) + v;
      this.roundPts[id] = (this.roundPts[id] || 0) + v;
    }
    if (s.lot) {
      this.session[s.lot.id] = (this.session[s.lot.id] || 0) + 1;
      this.roundPts[s.lot.id] = (this.roundPts[s.lot.id] || 0) + 1;
    }
    this.version++;
    if (!s.pat.length) {
      if (!s.bust) this.overlay(`<div class="again-stamp" style="color:var(--mute)">Kein Muster</div>`);
      this.setBox(this.chipsBox, "0"); this.setBox(this.multBox, "1");
      if (sfx && !s.bust) slotSfx.blank();
      this.setCounter(0);
      if (live) this.onEvent("tally", { ...e, total }, live);
      return;
    }
    // Erst hochzählen, dann Banner und Feier: so fällt der Höhepunkt auf den Glockenschlag
    const roll = fx ? (s.t.roll || 900) : 0;
    // Punkte × Faktor verschmelzen zum Ergebnis, das hochzählt
    this.resetLabel();
    this.setBox(this.chipsBox, fmt(this.spinBase || 0));
    this.setBox(this.multBox, String(s.x || 1));
    if (fx) { this.hud.classList.remove("fuse"); void this.hud.offsetWidth; this.hud.classList.add("fuse"); }
    this.hud.classList.toggle("hot", s.tier >= 3);
    if (fx) countTo(this.counter, 0, total, roll);
    else this.setCounter(total);
    this.counter.dataset.tier = s.tier;
    this.counter.classList.remove("zero");
    if (sfx) slotSfx.payoff(roll, s.tier);
    const pid = this.pickId;
    const land = () => {
      if (this.pickId !== pid || this.events[this.done - 1]?.at > e.at + roll + 400) return;   // längst weiter
      this.overlay(`<div class="tier-banner t${s.tier}">${TIER_WORDS[s.tier]}</div>`);
      // Banner nach dem Höhepunkt wieder weg, damit nichts unter dem nächsten Bild liegt
      const b = this.over.lastElementChild;
      setTimeout(() => { if (b?.isConnected) { b.classList.add("out"); setTimeout(() => b.remove(), 340); } }, 1700 + s.tier * 350);
      if (live) this.onEvent("tally", { ...e, total }, live);
    };
    if (roll) setTimeout(land, roll); else land();
  }

  roundCard(round) {
    const pts = ranked(this.roundPts);
    const top = Object.entries(this.session).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const lead = pts[0] && (!pts[1] || pts[1][1] < pts[0][1]) ? this.view.names[pts[0][0]] : null;
    const row = ([id, v]) => {
      const sk = this.skins[id];
      return `<li>${badgeHtml(sk || ["chip", 5])}
        <span class="nm">${esc(this.view.names[id] ?? "?")}</span><span class="plus">${this.roundPts[id] ? "+" + fmt(this.roundPts[id]) : ""}</span><span class="pts">${fmt(v)}</span></li>`;
    };
    return `<div class="round-card"><h3>Runde ${round.n} vorbei</h3>
      <p class="lead">${lead ? `${esc(lead)} holt die Runde` : "Kein Rundensieger"}</p>
      <ol>${top.map(row).join("")}</ol></div>`;
  }

  finalCard() {
    const n = this.view.pick?.layout.rounds || 1;
    const top = ranked(this.session).slice(0, 4);
    const row = ([id, v], i) => `<li class="${i ? "" : "top"}">${badgeHtml(this.skins[id] || ["chip", 5])}
      <span class="nm">${esc(this.view.names[id] ?? "?")}</span><span class="plus">${i ? "" : "★"}</span><span class="pts">${fmt(v)}</span></li>`;
    return `<div class="round-card final"><h3>Endstand · ${n === 1 ? "ein Spin" : `alle ${n} Runden`}</h3>
      <p class="lead">Meiste Punkte gewinnt</p>
      <ol>${top.map(row).join("")}</ol></div>`;
  }

  // ---------------------------------------------------------------------------
  standings() { return this.session; }

  renderMarquee(text, cls = "") {
    const p = this.view?.pick?.mode === "slots" ? this.view.pick : null;
    const n = p?.layout.rounds || 0, cur = this.round?.n || (p ? 1 : 0);
    const def = p ? (n > 1 ? `Runde ${cur} / ${n}` : "Ein Spin") : `Slots · ${this.view?.slots.length || 0} Namen`;
    const txt = text || def;
    if (this.marquee._h === txt + cls + cur) return;
    this.marquee._h = txt + cls + cur;
    this.marquee.className = `marquee ${cls}`;
    this.marquee.querySelector(".txt").textContent = txt;
    this.marquee.querySelector(".dots").innerHTML = n > 1
      ? Array.from({ length: n }, (_, i) => `<i class="dot${i < cur ? " on" : ""}"></i>`).join("") : "";
  }

  clearOverlay() {
    for (const el of this.over.children) { el.classList.add("out"); setTimeout(() => el.remove(), 340); }
  }

  overlay(html) {
    const old = this.over.firstElementChild;
    if (old) { old.classList.add("out"); setTimeout(() => old.remove(), 340); }
    this.over.insertAdjacentHTML("beforeend", html);
  }

  clearMarks() {
    this.lines.innerHTML = "";
    this.pops.innerHTML = "";
    this.spinBase = 0;
    this.hud.classList.remove("fuse", "hot");
    this.setBox(this.chipsBox, "0"); this.setBox(this.multBox, "1");
    this.resetLabel();
    this.setCounter(0);
    delete this.counter.dataset.tier;
    this.root.querySelectorAll(".skin.hit, .skin.dim, .skin.fire, .skin.shake").forEach((el) => el.classList.remove("hit", "dim", "fire", "shake"));
  }

  resetLabel() { const l = this.chipsBox.querySelector("small"); l.textContent = "Punkte"; l.className = ""; }

  /** Punkte- oder Faktor-Kasten setzen, mit Ruck. */
  setBox(box, text, bump = false, big = false) {
    box.querySelector("b").textContent = text;
    if (!bump) return;
    box.classList.remove("jolt", "slam"); void box.offsetWidth; box.classList.add(big ? "slam" : "jolt");
  }

  setCounter(v, bump = false) {
    this.counter.textContent = fmt(v);
    this.counter.classList.toggle("zero", !v);
    if (bump) { this.counter.classList.remove("tick"); void this.counter.offsetWidth; this.counter.classList.add("tick"); }
  }

  forCells(fn) {
    if (!this.grid) return;
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) {
      const el = this.cellEl(c, r);
      if (el) fn(this.grid[c][r], el, c, r);
    }
  }

  /** Mittelpunkte der Zellen im Koordinatensystem von .machine */
  centers(cells) {
    const box = this.root.querySelector(".machine").getBoundingClientRect();
    const sx = box.width / (this.root.querySelector(".machine").offsetWidth || box.width);
    this.lines.setAttribute("viewBox", `0 0 ${box.width / sx} ${box.height / sx}`);
    return cells.map(([c, r]) => {
      const el = this.cellEl(c, r);
      if (!el) return [0, 0];
      const b = el.getBoundingClientRect();
      return [(b.left + b.width / 2 - box.left) / sx, (b.top + b.height / 2 - box.top) / sx];
    });
  }
}
