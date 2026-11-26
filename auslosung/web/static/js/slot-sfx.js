// Klangbild des Automaten: weich, warm, harmonisch. Keine 8-Bit-Pulse, sondern
// die weichen Stimmen aus audio.js (Glocke, E-Piano, Fläche, gefiltertes Rauschen).
//
// Idee: Eine Session ist ein durchgehendes Musikstück in a-Moll, als Variante der Lobby-Musik.
//   • Ein treibender Groove (124 bpm) läuft von der ersten Einsatzpause bis
//     zum Ergebnis. Es entsteht keine Stille, nur die Dichte ändert sich:
//       bet    Einsätze offen: voller Groove, Kalimba-Ostinato, sanfter Zug
//       lock   „Keine Wetten mehr“: Filter schließt sich, die Fläche trägt
//       spin   Walzen laufen: Bass und Shaker, Mechanik vorn
//       tease  letzte Walze: nur Dominante E, Herzschlag, Filter öffnet langsam
//       count  Abrechnung: offen und hell, Akkorde schieben mit
//       hold   Runde vorbei: Fläche und E-Piano, zurückgelehnt
//   • Energie (0..1) steuert die Dichte und hängt an den Ereignissen: der
//     Countdown baut auf, jede Walze und jeder Treffer legt nach, Faktoren
//     schieben ganz nach oben; ohne Ereignisse sinkt sie langsam zurück.
//   • Unterbrechungen (Pleite, leerer Spin) tauchen die Musik kurz ab und lassen
//     sie zurückkommen, statt sie abzuschneiden.
//   • Alles, was passiert, spielt Töne des Akkords, der gerade klingt.
//   • Hochzählen: Akkordstöße im Raster, die Stufe für Stufe aufsteigen und
//     genau mit dem Zählerstand auf a-Moll landen. Der Groove setzt dort neu ein.
//   • Walzen: leises Surren und Klicken pro Symbol, Stopp als satter Holz-Klack
//     mit einem Akkordton, von Walze zu Walze aufsteigend.
import { THEME, sound as S } from "./audio.js";
import * as real from "./slot-real.js";

const BPM = 112, BEAT = 60 / BPM, S16 = BEAT / 4, E8 = BEAT / 2;
const SWING = 0.16;                               // wie die Lobby
const ok = () => S.ready;

// Akkorde: Bass, Stimmen (eng geführt), Töne für Melodie und Treffer
// Gleiche Folge wie das Lobby-Thema: Am – G – F – E7, Gewinne landen auf a-Moll
const CH = {
  Am: { b: 45, v: [60, 64, 69, 72], t: [57, 60, 64, 69, 72] },
  G:  { b: 43, v: [59, 62, 67, 71], t: [55, 59, 62, 67, 71] },
  F:  { b: 41, v: [60, 65, 69, 72], t: [57, 60, 65, 69, 72] },
  E:  { b: 40, v: [62, 64, 68, 71], t: [56, 59, 62, 64, 68] },
  A:  { b: 45, v: [61, 64, 69, 73], t: [57, 61, 64, 69, 73] },
};
const LOOP = ["Am", "G", "F", "E"];               // ein Takt je Akkord, wie die Lobby
// Aufsteigende Leiter beim Hochzählen: [Akkord, Lage]

// Lautstärke der Musik je Modus: leise, solange die Walzen rattern, damit die
// Mechanik vorn steht; bei der Auswertung Platz für die Ergebnisklänge.
// -- Natürliche Klänge ---------------------------------------------------------------
// Keine Oszillator-Pieptöne: Klack, Ratsche, Saiten und Marimba werden einmal Sample
// für Sample berechnet (Resonanzen eines Körpers, gezupfte Saite nach Karplus-Strong)
// und dann nur noch abgespielt.
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const bufs = new Map();
function rnd(seed) { let x = (seed * 7919) % 233280; return () => (x = (x * 9301 + 49297) % 233280) / 233280; }
function render(key, sec, fn) {
  let b = bufs.get(key);
  if (b) return b;
  const c = S.ctx, sr = c.sampleRate, n = Math.ceil(sec * sr);
  b = c.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  fn(d, sr);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak) for (let i = 0; i < n; i++) d[i] /= peak;
  const f = Math.min(n, Math.round(sr * 0.01));
  for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
  bufs.set(key, b);
  return b;
}
function playBuf(b, t, { vol = 0.2, rate = 1, pan = 0, out } = {}) {
  const c = S.ctx, s = c.createBufferSource(), g = c.createGain();
  s.buffer = b; s.playbackRate.value = rate; g.gain.value = vol;
  let n = s.connect(g);
  if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; n = n.connect(p); }
  n.connect(out || S.sfx);
  s.start(Math.max(t, c.currentTime));
}
/** Schwingender Körper: Moden [Frequenz, Abklingzeit, Pegel] plus Rauschimpuls als Anschlag. */
function modal(d, sr, at, modes, click, clickTau, r) {
  const o = Math.round(at * sr);
  for (let i = o; i < d.length; i++) {
    const t = (i - o) / sr;
    let v = t < clickTau * 10 ? (r() * 2 - 1) * click * Math.exp(-t / clickTau) : 0;
    for (const [f, tau, a] of modes) if (t < tau * 9) v += a * Math.exp(-t / tau) * Math.sin(6.2832 * f * t);
    d[i] += v;
  }
}
/** Walze schlägt an den Anschlag: dumpfer Körper, Holz und Kunststoff, dann fällt die Sperrklinke. */
/** Schwerer Schlag (Hebel unten, Faktor, Landung). */
const THUD = () => render("thud", 0.45, (d, sr) => modal(d, sr, 0, [[56, 0.1, 1], [88, 0.065, 0.6], [150, 0.035, 0.35], [400, 0.012, 0.18], [900, 0.005, 0.1]], 0.3, 0.0015, rnd(77)));
/** Gezupfte Saite (Karplus-Strong), gestimmt über die Abspielrate. */
function pluckBuf(m) {
  const sr = S.ctx.sampleRate, N = Math.max(2, Math.round(sr / mtof(m) - 0.5));
  const b = render("pl" + m, m < 50 ? 2.4 : 1.8, (d) => {
    const r = rnd(m + 101), q = new Float32Array(N), T60 = m < 50 ? 2.2 : Math.max(0.7, 2 - (m - 50) * 0.035);
    const g = 10 ** (-3 / (T60 * sr / (N + 0.5)));
    let lp = 0;
    for (let i = 0; i < N; i++) { lp += 0.5 * ((r() * 2 - 1) - lp); q[i] = lp; }   // weicher Anschlag mit dem Daumen
    for (let i = 0, k = 0; i < d.length; i++) {
      const cur = q[k], nx = q[(k + 1) % N];
      d[i] = cur; q[k] = g * 0.5 * (cur + nx); k = (k + 1) % N;
    }
  });
  return [b, mtof(m) * (N + 0.5) / sr];
}
/** Akkord gezupft, alle Töne fast gleichzeitig (ein Anschlag). */
function strum(t, notes, { vol = 0.06, spread = 0.007, out, width = 0.5 } = {}) {
  const ns = [...notes].sort((a, b) => a - b), v = vol / Math.sqrt(ns.length) * 1.6;
  ns.forEach((m, k) => {
    const [b, rate] = pluckBuf(m);
    playBuf(b, t + k * spread, { vol: v, rate, pan: ns.length > 1 ? (k / (ns.length - 1) - 0.5) * width : 0, out });
  });
}
/** Streicher: warme, gefilterte Fläche, die anschwillt und sauber in den nächsten Akkord übergeht. */
function strings(t, notes, { vol = 0.04, a = 0.08, dur = 0.5, r = 0.15, lp = 1500, lpTo = 0, out } = {}) {
  const c = S.ctx, f = c.createBiquadFilter(), g = c.createGain(), lfo = c.createOscillator(), lg = c.createGain();
  const end = t + a + dur, v = vol / Math.sqrt(notes.length * 3);
  f.type = "lowpass"; f.Q.value = 0.5;
  f.frequency.setValueAtTime(lp, t);
  if (lpTo) f.frequency.linearRampToValueAtTime(lpTo, end);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v, t + a);
  g.gain.setValueAtTime(v, end);
  g.gain.setTargetAtTime(0, end, r / 3);
  lfo.frequency.value = 5.2; lg.gain.value = 7; lfo.connect(lg);
  f.connect(g).connect(out || S.sfx);
  lfo.start(t); lfo.stop(end + r * 2);
  for (const m of notes) for (const det of [-11, 1, 12]) {
    const o = c.createOscillator();
    o.type = "sawtooth"; o.frequency.value = mtof(m); o.detune.value = det; lg.connect(o.detune);
    o.connect(f); o.start(t); o.stop(end + r * 2);
  }
}
/** Marimba: Holzplatte mit Resonator, für das Anzählen der Felder. */
const mallet = (m) => render("ml" + m, 0.9, (d, sr) => {
  const f = mtof(m);
  modal(d, sr, 0, [[f, 0.3, 1], [f * 3.93, 0.05, 0.32], [f * 9.2, 0.012, 0.1], [f * 2, 0.12, 0.06]], 0.12, 0.0007, rnd(m + 300));
});
/** Umkehrung: n-mal den tiefsten Ton eine Oktave nach oben, so steigen Akkorde glatt auf. */
const inv = (v, n) => { const a = [...v].sort((x, y) => x - y); for (let i = 0; i < n; i++) a.push(a.shift() + 12); return a; };
/** a-Moll-Landung passend zur Lage des letzten E7, damit die Stimmen nur einen Schritt gehen (Gis → A). */
const LAND = [[60, 64, 69, 72], [64, 69, 72, 76], [69, 72, 76, 81]];

const MODES = {
  bet:   { lp: 3600, vol: 0.7 },
  lock:  { lp: 800,  vol: 0.45 },
  spin:  { lp: 1500, vol: 0.22 },
  tease: { lp: 1100, vol: 0.28 },
  count: { lp: 2400, vol: 0.32 },
  hold:  { lp: 2800, vol: 0.55 },
};

// -- Kanäle ohne Überlappung -------------------------------------------------------
// Jede Klangart hat einen Kanal. Ein neuer Klang auf demselben Kanal blendet den
// vorigen in wenigen Millisekunden aus, statt sich darüberzulegen.
const chans = {};
function chan(name, fade = 0.07) {
  if (!S.ctx) return undefined;
  const old = chans[name];
  if (old) {
    old.gain.cancelScheduledValues(S.now);
    old.gain.setTargetAtTime(0, S.now, fade);
    setTimeout(() => old.disconnect(), 2000);
  }
  const g = S.ctx.createGain();
  g.connect(S.sfx);
  chans[name] = g;
  return g;
}

/** Funkeln: hohe Glockentöne aus dem Akkord statt Münzgeklimper. */
function sparkle(t, tones, n, dur, out, vol = 0.016) {
  for (let k = 0; k < n; k++) {
    S.bell(t + (k / n) * dur, tones[k % tones.length] + 24, { vol: vol * (1 - 0.5 * k / n), d: 0.25, pan: k % 2 ? 0.45 : -0.45, bright: 0.3, out });
  }
}

/** Luftzug auf- oder abwärts. */
function whoosh(t, dur, up = true, vol = 0.04, out) {
  S.hiss(t, { f: up ? 300 : 2400, sweepTo: up ? 2800 : 300, type: "bandpass", q: 0.9, vol, a: dur * 0.7, d: dur * 0.3, dur, out });
}

// -----------------------------------------------------------------------------
class Bed {
  constructor() {
    this.on = false;
    this.mode = "bet";
    this.step = 0;
    this.next = 0;
    this.bar = 0;
    this.chord = "Am";
    this.hold = null;           // Akkord festhalten (tease)
    this.stabs = [];            // geplante Akkordstöße [Zeit, Akkord, Lage, Stärke]
    this.stabsUntil = 0;
    this.reels = 0;             // laufende Walzen
    this.slowReel = false;
    this.nextClick = 0;
    this.teaseAt = 0;
    this.energy = 0.4;
    this.floor = 0.3;           // darunter fällt die Energie nicht (je Modus)
    this.buildTo = null;        // [Start, Ende] Audiozeit: Countdown baut auf
  }

  /** Energie anheben (Ereignisse) oder setzen. */
  push(d, max = 1) { this.energy = Math.min(max, Math.max(this.energy, 0) + d); }

  build() {
    if (this.out || !S.ctx) return;
    const c = S.ctx;
    this.out = c.createGain(); this.out.gain.value = 0;
    this.lp = c.createBiquadFilter(); this.lp.type = "lowpass"; this.lp.frequency.value = 2000; this.lp.Q.value = 0.6;
    this.lp.connect(this.out).connect(S.game);
    this.mech = c.createGain(); this.mech.gain.value = 1; this.mech.connect(S.sfx);
  }

  start() {
    real.prepare();
    if (S.ctx && !bufs.size) {
      THUD();
      // Saiten und Marimba nach und nach im Leerlauf, damit die Auszahlung nie hakt
      let m = 33;
      const warm = () => { for (let k = 0; k < 3 && m <= 90; k++, m++) { pluckBuf(m); if (m >= 55) mallet(m); } if (m <= 90) setTimeout(warm, 40); };
      setTimeout(warm, 200);
    }
    this.build();
    if (!this.out || this.on) return;
    this.on = true;
    this.step = 0; this.bar = 0; this.chord = LOOP[0]; this.hold = null; this.stabs = [];
    this.next = S.now + 0.08;
    // Läuft die Lobby, im selben Raster übernehmen: gleicher Takt, gleicher Akkord, Überblendung
    const lob = S.scene?.name === "lobby" ? S.scene : null;
    if (lob && S.next > S.now) {
      this.next = S.next;
      this.step = lob.step % 16;
      this.bar = Math.floor(lob.step / 16) % 4;
      S.fadeScene?.(1.6);
    }
    this.level(MODES[this.mode].vol, lob ? 0.5 : 1.2);
    this.timer = setInterval(() => this.pump(), 25);
  }

  stop(fade = 2.5) {
    this.reels = 0;
    this.whir(0);
    if (!this.on) return;
    this.on = false;
    this.level(0, fade / 3);
    clearInterval(this.timer);
  }

  level(v, tau = 0.4) {
    if (!this.out) return;
    const music = S.musicOn && S.enabled ? 1 : 0;
    this.out.gain.cancelScheduledValues(S.now);
    this.out.gain.setTargetAtTime(v * music, S.now, tau);
  }

  setMode(m, tau = 0.35) {
    this.mode = m;
    if (m !== "tease") this.hold = null;
    if (!this.out || !this.on) return;
    const d = MODES[m];
    this.lp.frequency.cancelScheduledValues(S.now);
    this.lp.frequency.setTargetAtTime(d.lp, S.now, tau);
    this.level(d.vol, tau);
  }

  /** Kurz abtauchen und zurückkommen (elegante Unterbrechung). */
  duck(depth = 0.4, back = 1.2, lp = 600) {
    if (!this.out || !this.on) return;
    const t = S.now, d = MODES[this.mode], music = S.musicOn && S.enabled ? 1 : 0;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(d.vol * depth * music, t, 0.08);
    this.out.gain.setTargetAtTime(d.vol * music, t + back * 0.5, back / 3);
    this.lp.frequency.cancelScheduledValues(t);
    this.lp.frequency.setTargetAtTime(lp, t, 0.1);
    this.lp.frequency.setTargetAtTime(d.lp, t + back * 0.5, back / 3);
  }

  /** Raster neu ansetzen: der nächste Takt beginnt bei t mit Akkord name. */
  landAt(t, name = "Am") {
    this.next = t;
    this.step = 0;
    this.bar = Math.max(0, LOOP.indexOf(name));
    this.chord = name;
  }

  /** Nächste Achtel ab t (damit Treffer im Takt sitzen). */
  grid(t) {
    if (!this.on) return t;
    let n = this.next + ((16 - this.step % 16) % 2) * S16;   // auf Achtel
    while (n < t) n += E8;
    return n;
  }

  /** Walzen laufen: Rattern und Schnurren aus slot-real.js (R3). */
  whir(n) {
    if (!S.ctx) return;
    real.setReels(n, this.slowReel);
  }

  pump() {
    if (!S.ctx || S.ctx.state !== "running") return;
    const now = S.now;
    if (this.on) {
      if (this.next < now - 0.25) this.next = now + 0.03;
      while (this.next < now + 0.15) {
        const sw = this.step % 2 ? S16 * SWING : 0;
        try { this.play(this.step, this.next + sw); } catch (e) { console.error(e); }
        this.step++;
        this.next += S16;
      }
    }
    // Rastzähne der laufenden Walzen (Effekt, nicht Musik)
    real.pump();
  }

  play(i, t) {
    const s = i % 16;                    // Sechzehntel im Takt
    if (s === 0 && i > 0) this.bar++;
    const m = this.mode;
    // Energie: Countdown baut auf, sonst sinkt sie langsam zum Boden des Modus
    if (this.buildTo && m === "bet") {
      const [a, b] = this.buildTo, u = Math.max(0, Math.min(1, (t - a) / (b - a)));
      this.energy = Math.max(this.energy, 0.35 + 0.6 * u);
    } else this.energy = Math.max(this.floor, this.energy - 0.0035);
    const E = this.energy;
    const name = this.hold || (m === "tease" ? "E" : LOOP[this.bar % LOOP.length]);
    this.chord = name;
    const ch = CH[name], o = this.lp;

    // Akkordstöße beim Hochzählen haben Vorrang
    while (this.stabs.length && this.stabs[0][0] < t + S16 / 2) {
      const [at, nm, up, v] = this.stabs.shift();
      const c = CH[nm];
      S.keys(at, c.v.map((x) => x + up), { vol: 0.035 + v * 0.025, d: 0.22, lp: 5000, out: o });
      S.tone(at, { m: c.b, type: "sawtooth", vol: 0.09, a: 0.004, d: 0.14, dur: 0.22, lp: 700, out: o });
      S.bell(at, c.t[3] + 12 + up, { vol: 0.025 + v * 0.02, d: 0.25, out: o });
      S.thump(at, { f: 60, vol: 0.18 + v * 0.08, d: 0.09, out: o });
      this.chord = nm;
    }
    if (this.stabsUntil > t) {           // beim Zählen: Akkorde plus treibende Hats
      S.hiss(t, { f: 8000, type: "highpass", q: 0.5, vol: s % 2 ? 0.008 : 0.016, d: 0.02, out: o });
      if (s % 4 === 2) S.hiss(t, { f: 5500, type: "highpass", vol: 0.02, d: 0.07, out: o });
      return;
    }

    if (m === "tease") {
      // Halbes Tempo, Orgelpunkt G, Puls wird dichter, Glocke steigt
      const k = Math.floor((t - this.teaseAt) / BEAT);
      if (s % 4 === 0) S.tone(t, { m: 40, type: "sawtooth", vol: 0.1, a: 0.005, d: 0.18, dur: 0.3, lp: 500, out: o });
      if (s === 0 || s === 8) { S.thump(t, { f: 55, vol: 0.3, d: 0.11, out: o }); S.thump(t + 0.16, { f: 50, vol: 0.16, d: 0.08, out: o }); }
      if (s % 2 === 0) S.hiss(t, { f: 7000, type: "highpass", vol: 0.006 + Math.min(0.016, k * 0.002), d: 0.02, out: o });
      if (s % 4 === 2) S.bell(t, ch.t[(k + s / 2) % 5] + 24, { vol: 0.016 + Math.min(0.02, k * 0.003), d: 0.18, bright: 0.5, out: o });
      if (s === 0) S.pad(t, ch.v, { vol: 0.045, a: 0.3, dur: BEAT * 3.6, lp: 2000, out: o });
      return;
    }

    // Fläche zum Taktbeginn
    if (s === 0) S.pad(t, ch.v, { vol: 0.02 + E * 0.02, a: 0.15, dur: BEAT * 3.7, lp: 1600 + E * 1600, out: o });
    if (m === "lock") {
      if (s % 4 === 0) S.tone(t, { m: ch.b - 12, type: "triangle", vol: 0.16, a: 0.01, d: 0.3, dur: 0.4, out: o });
      return;
    }
    if (m === "hold") {
      if (s === 0) S.tone(t, { m: ch.b, type: "triangle", vol: 0.18, a: 0.01, d: 0.6, dur: 1, lp: 900, out: o });
      if (s === 4 || s === 10) S.keys(t, ch.v, { vol: 0.024, d: 0.3, lp: 2600, out: o });
      if (s % 4 === 2) S.hiss(t, { f: 7000, type: "highpass", vol: 0.008, d: 0.03, out: o });
      return;
    }

    // Kick: ab mittlerer Energie Four-on-the-floor, darunter 1 und 3
    if (s % 4 === 0 && (E > 0.45 || s % 8 === 0)) S.thump(t, { f: 56, vol: 0.2 + E * 0.12, d: 0.1, out: o });
    // Clap auf 2 und 4
    if ((s === 4 || s === 12) && E > 0.3) {
      S.hiss(t, { f: 1500, q: 1.2, vol: 0.03 + E * 0.02, d: 0.05, out: o });
      S.hiss(t + 0.012, { f: 1700, q: 1.2, vol: 0.02 + E * 0.015, d: 0.07, out: o });
    }
    // Hats: Sechzehntel, offene Hat auf dem Offbeat
    S.hiss(t, { f: 8500, type: "highpass", q: 0.5, vol: (s % 2 ? 0.005 : 0.01) * (0.6 + E), d: 0.018, out: o });
    if (s % 4 === 2 && E > 0.5) S.hiss(t, { f: 6000, type: "highpass", vol: 0.014 + E * 0.008, d: 0.08, out: o });
    // Bass: hüpfende Oktaven auf den Offbeats, gefilterter Sägezahn für Druck
    const bassAt = [0, 3, 6, 8, 11, 14];
    if (bassAt.includes(s)) {
      const nextB = CH[LOOP[(this.bar + 1) % LOOP.length]].b;
      const bm = s === 14 ? nextB + (nextB > ch.b ? -1 : 1) : s === 3 || s === 11 ? ch.b + 12 : s === 6 ? ch.b + 7 : ch.b;
      S.tone(t, { m: bm, type: "sawtooth", vol: 0.075 + E * 0.04, a: 0.004, d: 0.1, dur: 0.16, lp: 500 + E * 700, q: 2, out: o });
      S.tone(t, { m: bm - 12, vol: 0.12, a: 0.004, d: 0.12, dur: 0.18, out: o });
    }
    // Akkord-Stabs auf der „und“
    if ((s === 6 || s === 14) && m !== "spin") S.keys(t, ch.v, { vol: 0.02 + E * 0.015, d: 0.18, lp: 2400 + E * 2000, out: o });
    // Arpeggio: ab mittlerer Energie Achtel, oben Sechzehntel
    if (E > 0.5 && m !== "count" && (s % 2 === 0 || E > 0.8)) {
      const arp = [0, 1, 2, 3, 4, 3, 2, 1][(s >> (E > 0.8 ? 0 : 1)) % 8];
      S.bell(t, ch.t[arp] + 12, { vol: 0.012 + (E - 0.5) * 0.02, d: 0.12, pan: s % 4 < 2 ? -0.35 : 0.35, bright: 0.5, out: o });
    }
    // Das Lobby-Thema obenauf, sobald es heiß wird: dieselbe Melodie, nur getrieben
    if (E > 0.65 && m === "bet" && !this.hold) {
      for (const [st, mm, len] of THEME[this.bar % 4]) {
        if (st !== s) continue;
        S.bell(t, mm + 12, { vol: 0.02 + (E - 0.65) * 0.06, d: 0.15 + len * 0.05, bright: 0.7, out: o });
        S.tone(t, { m: mm, type: "square", vol: 0.008 + (E - 0.65) * 0.02, a: 0.005, d: len * S16 * 0.8, dur: len * S16, lp: 2200, out: o });
      }
    }
        // Wirbel in die letzte Sekunde des Countdowns
    if (m === "bet" && this.buildTo && t > this.buildTo[1] - 1 && t < this.buildTo[1]) {
      const u = 1 - (this.buildTo[1] - t);
      S.hiss(t, { f: 1800, q: 1, vol: 0.012 + u * 0.03, d: 0.03, out: o });
    }
  }

  /** Ton des aktuellen Akkords, Stufe k nach oben gezählt. */
  tone(k, base = 72) {
    const tt = CH[this.chord].t.map((m) => { while (m < base) m += 12; return m; }).sort((a, b) => a - b);
    return tt[k % tt.length] + 12 * Math.floor(k / tt.length);
  }
}

const bed = new Bed();

// -----------------------------------------------------------------------------
export const slotSfx = {
  bed,

  /** Einsätze offen: Groove an, die letzten drei Sekunden leise auf G hin. */
  betting(locksAtAudio) {
    if (!S.ctx) return;
    bed.start();
    bed.setMode("bet", 0.8);
    bed.floor = 0.35;
    bed.energy = Math.min(bed.energy, 0.45);
    bed.buildTo = locksAtAudio ? [S.now, locksAtAudio] : null;
    if (!ok() || !locksAtAudio) return;
    // E – Gis – H (Dominante), aufgelöst vom a-Moll-Akkord bei „Keine Wetten mehr“
    [[3, 64], [2, 68], [1, 71]].forEach(([k, m]) => {
      const t = locksAtAudio - k;
      if (t > S.now) S.bell(t, m + 12, { vol: 0.04, d: 0.4 });
    });
  },

  /** Keine Wetten mehr: Musik atmet aus, warmer C-Dur-Abschluss. */
  lock() {
    bed.start();
    bed.buildTo = null;
    bed.setMode("lock", 0.25);
    if (!ok()) return;
    S.slam(57);
    // Riegel fällt: zwei Holzschläge, dann ein Bläserakkord auf E, der nach dem Spin verlangt
    const t = S.now + 0.02, o = chan("res");
    [0, 0.13].forEach((d, k) => real.clack(k, { vol: 0.5 - k * 0.2, t: t + d }));
    strum(t + 0.32, [40, 52, 56, 59, 64, 68], { vol: 0.07, spread: 0.012, out: o });
    strings(t + 0.32, [56, 59, 62, 64], { vol: 0.05, a: 0.3, dur: 0.6, r: 0.6, out: o });
  },

  /** Hebel: weiche Ratsche, Schwung, die Walzen springen an. */
  lever(leverMs = 450) {
    if (!S.ctx) return;
    bed.start();
    bed.buildTo = null;
    bed.setMode("spin", 0.5);
    bed.floor = 0.4; bed.energy = 0.5;
    chan("res", 0.25);                          // Ausklang der letzten Auswertung weich weg
    if (!ok()) return;
    const t = S.now, d = leverMs / 1000, o = chan("spin");
    real.chokeJackpot();
    for (let k = 0; k < 5; k++) real.tick(t + k * d * 0.12, 0.35, 0.8 + k * 0.05);
    whoosh(t + d * 0.45, d * 0.6, true, 0.025, o);
    playBuf(THUD(), t + d, { vol: 0.5, out: o });
    real.clack(2, { vol: 0.45, t: t + d });
  },

  spinStart(leverMs = 450) {
    clearTimeout(this._spin);
    this._spin = setTimeout(() => { bed.reels = 5; bed.slowReel = false; bed.whir(5); }, leverMs * 0.95);
  },

  /** Walze rastet ein: echter Klack, aus den Resonanzen eines Körpers berechnet. */
  reelStop(col = 0) {
    clearTimeout(this._spin);
    const slow = bed.slowReel;
    bed.reels = Math.max(0, 4 - col);
    if (!bed.reels) bed.slowReel = false;
    bed.whir(bed.reels);
    bed.push(0.09);
    if (!ok()) return;
    real.clack(col, { tease: slow && !bed.reels });
  },

  /** Letzte Walze: langsamer, Herzschlag, Dominante, Luft steigt. */
  tease() {
    bed.slowReel = true;
    bed.teaseAt = S.ctx ? S.now : 0;
    bed.hold = "E";
    bed.setMode("tease", 0.3);
    bed.hold = "E";
    bed.whir(1);
    if (!ok()) return;
    S.hiss(S.now, { f: 400, sweepTo: 2400, q: 1.2, vol: 0.02, a: 2, d: 0.2, dur: 2.3, out: chan("spin") });
  },

  /** Alle Walzen stehen. */
  spinEnd() {
    clearTimeout(this._spin);
    bed.reels = 0; bed.slowReel = false; bed.whir(0);
    if (bed.mode === "tease" || bed.mode === "spin") bed.setMode("count", 0.4);
  },

  /** Zwei Nieten im Bild: leiser Hinweis, tief unter der Musik. */
  warn() {
    if (!ok()) return;
    const t = S.now + 0.12, o = chan("res");
    strum(t, [40, 47], { vol: 0.06, out: o });
    strum(t + 0.2, [40, 46], { vol: 0.05, out: o });
  },

  /** Glücks-Spin: Schimmer aus Akkordtönen nach oben. */
  luckSurge() {
    if (!ok()) return;
    const t = S.now, o = chan("res");
    for (let k = 0; k < 6; k++) S.bell(t + k * 0.08, bed.tone(k, 72), { vol: 0.022, d: 0.35, pan: k % 2 ? 0.4 : -0.4, bright: 0.4, out: o });
  },

  /** Glück kopiert einen Namen: ein Glockenton im Akkord, jeder weitere höher. */
  morph(k = 0) {
    if (!ok()) return;
    const t = S.now, o = chan("res");
    S.bell(t + 0.05, bed.tone(k + 2, 72), { vol: 0.04, d: 0.45, pan: k % 2 ? 0.35 : -0.35, bright: 0.4, out: o });
  },

  /**
   * Muster leuchtet auf. Natürlich und harmonisch: ein weicher Glockenschlag auf
   * dem nächsten Ton des Akkords, darunter der Akkord leise als E-Piano. Jeder
   * Treffer eine Stufe höher; große Muster klingen voller, nicht lauter.
   */
  pattern(step = 0, v = 1) {
    bed.setMode("count", 0.3);
    bed.floor = 0.5;
    bed.push(0.08 + Math.min(0.15, v * 0.015));
    if (!ok()) return;
    const t = S.now + 0.02, o = chan("res"), m = bed.tone(step + 1, 69);
    S.bell(t, m, { vol: 0.05 + Math.min(0.02, v * 0.003), d: 0.55, bright: 0.45, out: o });
    S.bell(t + 0.004, m - 12, { vol: 0.025, d: 0.5, bright: 0.2, out: o });
    strum(t, [CH[bed.chord].b, ...inv(CH[bed.chord].v, step % 3)], { vol: 0.05 + Math.min(0.03, v * 0.004), out: o });
    if (v >= 5) [1, 2, 3].forEach((i) => S.bell(t + 0.12 * i, bed.tone(step + 1 + i, 69), { vol: 0.022, d: 0.3, bright: 0.3, out: o }));
  },

  /** Faktor: kurzer Atemzug, dann ein voller Akkord, jeder weitere höher. */
  multiplier(k = 0, x = 2) {
    bed.push(0.2);
    if (!ok()) return;
    const t = S.now, o = chan("res"), hit = t + 0.28;
    whoosh(t, 0.28, true, 0.02, o);
    const c = CH[["F", "G", "E", "Am"][k % 4]], v = inv(c.v, Math.min(3, k + (x >= 5 ? 1 : 0)));
    playBuf(THUD(), hit, { vol: 0.45, out: o });
    strum(hit, [c.b - 12, c.b, ...v], { vol: 0.09, spread: 0.006, out: o });
    strings(hit, v, { vol: 0.06, a: 0.03, dur: 0.35, r: 0.35, lp: 2200, out: o });
  },

  /** Kein Muster: Musik taucht kurz ab, zwei weiche Töne abwärts. */
  blank() {
    bed.floor = 0.3; bed.energy = 0.35;
    bed.setMode("hold", 1.2);
    bed.duck(0.5, 1.6, 800);
    if (!ok()) return;
    const t = S.now + 0.05, o = chan("res");
    S.bell(t, 64, { vol: 0.03, d: 0.35, bright: 0.2, out: o });
    S.bell(t + 0.25, 60, { vol: 0.026, d: 0.5, bright: 0.2, out: o });
  },

  /** Pleite: die Musik verliert kurz die Luft und kommt nach dem Seufzer wieder. */
  bust() {
    bed.floor = 0.3; bed.energy = 0.3;
    bed.setMode("hold", 1);
    bed.duck(0.2, 2.6, 400);
    if (!ok()) return;
    const t = S.now, o = chan("res");
    [64, 63, 62].forEach((m, k) => playBuf(mallet(m), t + k * 0.32, { vol: 0.16, out: o }));
    strum(t + 0.64, [38, 50, 53, 57], { vol: 0.06, spread: 0.02, out: o });
  },

  /**
   * Abrechnung: Akkordstöße im Raster steigen auf (Musik), darüber zählt eine
   * Kalimba die Pentatonik hoch, langsam beginnend und dann zügiger. Genau mit dem
   * Zählerstand landet alles auf a-Moll, dann die Fanfare der Stufe.
   */
  payoff(ms = 900, tier = 1) {
    if (!S.ctx || tier <= 0) return;
    bed.start();
    bed.setMode("count", 0.2);
    const t0 = S.now, end = t0 + ms / 1000;
    if (ok()) {
      const o = chan("res", 0.12);
      // Jackpot: eigener Automaten-Jingle im Shuffle, getaktet auf den Zählerstand.
      // Die Musik geht dafür ganz raus, weil der Jingle sein eigenes Tempo hat.
      const jl = tier >= 4 ? real.jackpot(t0, end) : 0;
      if (jl) {
        bed.stabs = []; bed.stabsUntil = t0 + jl;
        bed.level(0, 0.12);
        clearTimeout(this._jp);
        this._jp = setTimeout(() => bed.level(MODES[bed.mode].vol, 1.2), jl * 1000);
      } else {
        bed.stabs = [];
        bed.stabsUntil = end;                    // Musik tritt zurück: nur noch treibende Hats
        // Am – F – G – E7 und Landung auf a-Moll. Gemischt statt nur Blöcke: Streicher
        // halten den Akkord und schwellen an, der Bass zupft den Grundton, darüber läuft
        // ein Arpeggio durch die Akkordtöne, und eine Marimba-Oberstimme steigt Schritt
        // für Schritt (Gis führt am Ende ins A). Nur jeder zweite Akkord und das E7
        // werden zusätzlich als voller Anschlag gesetzt.
        const P = ["Am", "F", "G", "E"];
        const n = Math.max(3, Math.round((end - t0) / E8)), step = (end - t0 - 0.03) / n;
        // Oberstimme rückwärts vom Gis aus: je Akkord der nächste Akkordton darunter, höchstens eine Terz
        const seq = Array.from({ length: n }, (_, k) => P[(k + 4 - (n % 4)) % 4]), line = [];
        for (let k = n - 1, m = 81; k >= 0; k--) {
          const tones = CH[seq[k]].t.flatMap((x) => [x + 12, x + 24]);
          m = k === n - 1 ? 80 : Math.max(...tones.filter((x) => x < m && m - x <= 4).concat(tones.filter((x) => x <= m).slice(-1)));
          line[k] = m;
        }
        for (let k = 0; k < n; k++) {
          const nm = P[(k + 4 - (n % 4)) % 4], c = CH[nm], at = t0 + 0.03 + k * step, u = n > 1 ? k / (n - 1) : 1;
          const L = Math.min(2, Math.floor(u * 3)), v = inv(c.v, L), last = k === n - 1;
          strings(at, v, { vol: 0.04 + 0.08 * u, a: 0.04, dur: step - 0.03, r: 0.1, lp: 1300 + u * 1600, out: o });
          strum(at, [c.b], { vol: 0.07 + 0.03 * u, out: o });
          if (k % 2 === 0 || last) strum(at, v, { vol: 0.035 + 0.035 * u + (last ? 0.02 : 0), out: o });
          [1, 2, 3].forEach((q) => strum(at + step * q / 4, [v[q]], { vol: 0.035 + 0.025 * u, out: o, width: 0 }));
          playBuf(mallet(line[k]), at, { vol: 0.13 + 0.07 * u, out: o });
          this._land = L;
        }
        this.fanfare(tier, end, o);
      }
    }
    bed.landAt(end + BEAT, "Am");
    bed.energy = 0.9; bed.floor = 0.45;
    clearTimeout(this._hold);
    this._hold = setTimeout(() => { if (bed.mode === "count") bed.floor = 0.4; }, ms + 2400);
  },

  /** Landung je Stufe auf a-Moll: 1 Treffer, 2 Super, 3 Mega, 4 Jackpot. Nur Töne aus a-Moll. */
  fanfare(tier, t = S.now, o = chan("res")) {
    if (!ok()) return;
    const v = LAND[this._land ?? 1], hold = 0.5 + tier * 0.25;
    playBuf(THUD(), t, { vol: 0.55, out: o });
    strum(t, [33, 45, 52, ...v], { vol: 0.12, spread: 0.008, out: o });
    strings(t, [45, 52, ...v], { vol: 0.12 + tier * 0.02, a: 0.02, dur: hold, r: 0.5, lp: 2600, lpTo: 1800, out: o });
    if (tier >= 2) strum(t + E8, v.map((m) => m + 12), { vol: 0.07, out: o });
    if (tier >= 3) strum(t + E8 * 1.5, [...v, v[0] + 12, v[1] + 12], { vol: 0.08, spread: 0.01, out: o });
    if (tier >= 4) [0, 1, 2, 3, 4, 5].forEach((k) => playBuf(mallet(v[k % 4] + 12 * (1 + Math.floor(k / 4))), t + E8 * 2 + k * 0.07, { vol: 0.12, pan: k % 2 ? 0.4 : -0.4, out: o }));
    playBuf(mallet(81), t, { vol: 0.2, out: o });
    S.bell(t + 0.02, v[3] + 12, { vol: 0.03, d: 0.6, bright: 0.35, out: o });
    this._land = 1;
  },

  /** Nochmal: Musik zieht kurz an. */
  again() {
    if (!ok()) return;
    const t = S.now, o = chan("res");
    whoosh(t, 0.5, true, 0.022, o);
    S.keys(t + 0.5, CH.E.v, { vol: 0.03, d: 0.45, lp: 3000, out: o });
    playBuf(THUD(), t + 0.5, { vol: 0.35, out: o });
  },

  /** Das Los: weicher Wirbel, dann Glocke auf A. */
  lot() {
    bed.setMode("lock", 0.3);
    if (!ok()) return;
    const t = S.now, o = chan("res");
    for (let k = 0; k < 26; k++) S.hiss(t + k * 0.05, { f: 1800, q: 1.5, vol: 0.007 + k * 0.001, d: 0.03, out: o });
    const hit = t + 1.35;
    playBuf(THUD(), hit, { vol: 0.45, out: o });
    S.bell(hit, 81, { vol: 0.06, d: 0.8, bright: 0.45, out: o });
    S.keys(hit, CH.Am.v, { vol: 0.035, d: 0.9, lp: 3500, out: o });
    setTimeout(() => bed.setMode("count", 0.5), 1400);
  },

  /** Runde vorbei: E7 → a, dann zurückgelehnt in die Pause. */
  roundEnd() {
    bed.floor = 0.3;
    bed.setMode("hold", 0.8);
    if (!ok()) return;
    const t = bed.grid(S.now), o = chan("res", 0.2);
    S.keys(t, CH.E.v, { vol: 0.026, d: 0.4, lp: 2500, out: o });
    S.keys(t + BEAT, CH.Am.v, { vol: 0.03, d: 1, lp: 2500, out: o });
    S.bell(t + BEAT, 81, { vol: 0.03, d: 0.7, bright: 0.4, out: o });
  },

  /** Schluss der Session: großer a-Moll-Akkord, die Musik klingt aus. */
  finale() {
    if (ok()) {
      const t = S.now + 0.02, o = chan("res", 0.15);
      playBuf(THUD(), t, { vol: 0.55, out: o });
      S.pad(t, [45, 52, 57, 60, 64, 71, 72], { vol: 0.07, a: 0.08, dur: 2, lp: 3000, out: o });
      strum(t, [33, 45, 52, 57, 60, 64, 69, 72], { vol: 0.13, spread: 0.012, out: o });
      strings(t, [45, 57, 60, 64, 69], { vol: 0.12, a: 0.05, dur: 1.4, r: 1, lp: 2400, out: o });
      [69, 72, 76, 81, 84, 88].forEach((m, k) => S.bell(t + 0.12 + k * 0.1, m + 12, { vol: 0.034, d: 0.6, bright: 0.45, pan: (k - 2.5) * 0.2, out: o }));
    }
    bed.stop(3);
  },

  /**
   * Ein Feld wird angezählt: Marimba auf den Tönen des laufenden Akkords, jedes
   * Feld und jedes weitere Muster eine Stufe höher, wie Karten in Balatro.
   */
  cellTick(i = 0, step = 0) {
    if (!ok()) return;
    const t = S.now, o = chan("cell", 0.05);
    playBuf(mallet(bed.tone(i + step, 64)), t, { vol: 0.22, out: o });
    real.tick(t, 0.12, 1.2);
  },

  /** Zählschritt beim Ergebnis und auf dem Handy. */
  tick(step = 0) {
    if (!ok()) return;
    S.bell(S.now, [69, 72, 74, 76, 79, 81, 84, 86, 88, 91, 93][Math.min(10, step)], { vol: 0.032, d: 0.22, bright: 0.35, out: chan("tick", 0.03) });
  },

  /** Gewinn eingestrichen (Ergebnisliste, Handy). */
  win(big = false) {
    if (!ok()) return;
    const t = S.now, o = chan("win");
    S.bell(t, 81, { vol: 0.04, d: 0.4, bright: 0.45, out: o });
    S.bell(t + 0.1, 88, { vol: 0.036, d: 0.55, bright: 0.45, out: o });
    if (big) { strum(t + 0.1, [45, 60, 64, 69, 72], { vol: 0.08, out: o }); sparkle(t + 0.3, [69, 72, 76], 5, 0.5, o); }
  },

  /** Musik der Session aus (Ergebnis, Abbruch, anderer Modus). */
  end(fade = 2) { bed.stop(fade); real.setReels(0); },

  /** Nur die Mechanik anhalten (Bühne wird neu aufgebaut). */
  stopAll() { clearTimeout(this._spin); bed.reels = 0; bed.slowReel = false; bed.whir(0); real.chokeJackpot(0.1); },
};
