// Klang: 8-Bit-Klangerzeuger und Musik mit der Web-Audio-API
import { serverNow } from "./core.js";
import { reduced } from "./fx.js";

// =============================================================================
// Klang: 8-Bit
// =============================================================================
// Nachbau der Klangerzeuger alter Spielkonsolen, live mit der Web-Audio-API:
//
//   Puls       Rechteck mit 12,5 / 25 / 50 % Tastgrad: Melodie, Klicks, Münzen
//   Dreieck    in 4-Bit-Stufen wie das Original: Bass, Kick, Herzschlag
//   Rauschen   aus einem 15-Bit-Schieberegister; lang = Zischen, kurz = metallisch
//
// Lautstärke und Tonhöhe springen wie damals in Schritten von 1/60 Sekunde.
// Damit es nicht nervt: bandbegrenzte Wellen ohne Überschwingen, ein weicher
// Tiefpass, ein kleiner Raum und eher leise Pegel.
//
// Die Musik ist eine Szene, die mit dem Spiel mitgeht:
//   lobby   Casino-Thema in a-Moll, Teil A und B, Echo, Glitzer
//   calls   Countdown-Groove; das Raster endet exakt auf „Nichts geht mehr“,
//           jede Sekunde steigt das Ostinato einen Halbton
//   spin    folgt dem Rad: treibend → steigender Bass mit Sirene → nur noch
//           Herzschlag → Stille, bevor das Ergebnis fällt
// Die Klicks am Zeiger spielen eine Moll-Pentatonik; kurz vor Stillstand
// steigen sie Halbton für Halbton.

const FR = 1 / 60;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const rnd = (a, b) => a + Math.random() * (b - a);
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
const MINOR_PENTA = [0, 3, 5, 7, 10];
const CHORD = { m: [0, 3, 7], M: [0, 4, 7], 7: [0, 4, 7, 10] };

// -- Lobby-Thema ------------------------------------------------------------------
// Je Takt: [Schritt (16tel), MIDI-Ton, Länge in 16teln]
const A1 = [[0, 76, 2], [3, 72, 1], [4, 74, 2], [6, 76, 2], [10, 79, 2], [12, 76, 4]];
const A2 = [[0, 74, 2], [2, 71, 2], [4, 67, 4], [10, 71, 2], [12, 74, 2], [14, 71, 2]];
const A3 = [[0, 72, 3], [4, 69, 2], [6, 72, 2], [8, 77, 4], [12, 76, 2], [14, 74, 2]];
const A4 = [[0, 71, 2], [2, 68, 2], [4, 71, 2], [6, 74, 2], [8, 76, 6], [14, 75, 2]];
const A7 = [[0, 72, 2], [2, 77, 2], [4, 76, 2], [6, 74, 2], [8, 71, 2], [10, 68, 2], [12, 71, 4]];
const A8 = [[0, 69, 6], [8, 64, 2], [10, 69, 2], [12, 72, 2], [14, 76, 2]];
const B = [
  [[0, 74, 4], [6, 77, 2], [8, 81, 4], [12, 77, 4]],
  [[0, 76, 6], [8, 72, 2], [10, 76, 2], [12, 69, 4]],
  [[0, 74, 2], [2, 77, 2], [4, 81, 2], [6, 84, 4], [12, 81, 2], [14, 77, 2]],
  [[0, 80, 4], [4, 76, 4], [8, 71, 4], [12, 68, 4]],
  [[0, 72, 2], [2, 77, 2], [4, 81, 4], [10, 79, 2], [12, 77, 4]],
  [[0, 79, 2], [2, 74, 2], [4, 71, 4], [10, 74, 2], [12, 79, 4]],
  [[0, 76, 4], [4, 72, 4], [8, 69, 8]],
  [[0, 68, 2], [4, 71, 2], [8, 74, 2], [12, 76, 2]],
];
const LOBBY_MEL = [A1, A2, A3, A4, A1, A2, A7, A8, ...B];
const LOBBY_ROOT = [45, 43, 41, 40, 45, 43, 41, 45, 38, 45, 38, 40, 41, 43, 45, 40];
const LOBBY_CHORD = ["m", "M", "M", "7", "m", "M", "M", "m", "m", "m", "m", "7", "M", "M", "m", "7"];

const SCENES = {
  lobby: {
    bpm: 112, swing: 0.16, out: "music",
    play(c, i, t, d) {
      const bar = Math.floor(i / 16) % 16, s = i % 16, o = c.music;
      let r = LOBBY_ROOT[bar], ch = LOBBY_CHORD[bar];
      if (bar === 6 && s >= 8) { r = 40; ch = "7"; }                 // F → E7 im selben Takt
      const fps = d * 60;
      // Schlagzeug
      if (s === 0 || s === 10) c.kick(t, 0.3, o);
      if (s === 4 || s === 12) c.snare(t, 0.13, o);
      if (s % 2 === 0) c.hat(t, s % 4 === 0 ? 0.045 : 0.028, o);
      if (bar % 8 === 7 && s >= 12) c.snare(t, 0.05 + (s - 12) * 0.025, o);   // Wirbel vor der Wiederholung
      // Bass
      const next = LOBBY_ROOT[(bar + 1) % 16];
      const bass = { 0: r, 3: r + 12, 6: r + 7, 8: r, 11: r + 12, 14: next + (next > r ? -1 : 1) }[s];
      if (bass !== undefined) c.note(t, { m: bass, wave: "tri", vol: s === 3 || s === 11 ? 0.12 : 0.2, frames: Math.round(fps * (s === 0 || s === 8 ? 2.4 : 1.4)), decay: 0.5, out: o });
      // Melodie mit Echo
      for (const [st, m, len] of LOBBY_MEL[bar]) {
        if (st !== s) continue;
        const frames = Math.max(3, Math.round(len * fps * 0.92));
        c.note(t, { m, wave: "25", vol: 0.06, frames, decay: 0.3, vib: 0.2, vibAt: 12, out: o });
        c.note(t + 3 * d, { m, wave: "12", vol: 0.02, frames: Math.round(frames * 0.8), decay: 0.6, pan: 0.45, out: o });
      }
      // Glitzer in der zweiten Hälfte von Teil B
      if (bar >= 12 && bar <= 14) {
        const tones = CHORD[ch];
        c.note(t, { m: r + 36 + tones[s % tones.length], wave: "12", vol: 0.014, frames: 3, pan: -0.4, out: o });
      }
    },
  },

  calls: {
    bpm: 120, out: "game",
    play(c, i, t, d, sc) {
      const left = sc.left, o = c.game;
      if (sc.total === undefined) sc.total = left;
      const rise = Math.floor((sc.total - left) / 8);                  // jede Sekunde einen Halbton höher
      // Sekundenschlag, die letzten drei höher und lauter
      if (left % 8 === 0 && left > 0) {
        const sec = left / 8;
        c.note(t, { m: sec <= 3 ? 84 + (3 - sec) * 2 : 81, wave: "50", vol: sec <= 3 ? 0.11 : 0.07, frames: sec <= 3 ? 10 : 6, decay: 1.2, out: o });
      }
      if (left % 2 === 0) c.note(t, { m: 33 + (left % 4 === 0 ? 0 : 12) + rise, wave: "tri", vol: 0.22, frames: 5, decay: 0.8, out: o });
      c.hat(t, left % 2 === 0 ? 0.035 : 0.02, o);
      c.note(t, { m: 69 + rise + [0, 7, 12, 7][left % 4], wave: "25", vol: 0.035, frames: 3, decay: 1, out: o });
      if (left % 8 === 0) c.kick(t, 0.3, o);
      if (left <= 16) c.noise(t, { rate: 0.7, vol: 0.018 + (16 - left) * 0.0035, frames: 3, decay: 1.6, out: o });   // Wirbel, die letzten zwei Sekunden
    },
  },

  spin: {
    bpm: 150, out: "game",
    play(c, i, t, d, sc) {
      const L = c.level, s = i % 16, o = c.game;
      if (L >= 0.995) return;                                         // Stille vor dem Ergebnis
      if (L < 0.45) {                                                 // schnell: treibend
        sc.slowAt = undefined;
        const shift = Math.floor(i / 32) % 2 ? -4 : 0;               // a-Moll / F-Dur im Wechsel
        if (s === 0 || s === 8) c.kick(t, 0.38, o);
        if (s === 4 || s === 12) c.snare(t, 0.16, o);
        c.hat(t, s % 2 ? 0.022 : 0.04, o);
        if (s % 2 === 0) c.note(t, { m: 33 + shift + (s % 4 === 0 ? 0 : 12), wave: "tri", vol: 0.24, frames: 5, decay: 0.7, out: o });
        c.note(t, { m: 69 + shift + (shift ? [0, 4, 7, 12] : [0, 3, 7, 12])[s % 4], wave: "12", vol: 0.04, frames: 3, out: o });
      } else if (L < 0.8) {                                           // wird langsam: alles steigt
        if (sc.slowAt === undefined) sc.slowAt = i;
        const up = Math.min(8, Math.floor((i - sc.slowAt) / 8));
        if (s === 0 || s === 8) c.kick(t, 0.34, o);
        if (s % 2 === 0) c.hat(t, 0.028, o);
        if (s % 2 === 0) c.note(t, { m: 33 + up + (s % 4 === 0 ? 0 : 12), wave: "tri", vol: 0.24, frames: 5, decay: 0.7, out: o });
        if (s % 8 === 0) c.note(t, { m: 81 + up, wave: "50", vol: 0.04, frames: 44, decay: 0.35, vib: 0.35, vibAt: 4, out: o });
        c.note(t, { m: 69 + up + [0, 3, 7, 12][s % 4], wave: "12", vol: 0.026, frames: 3, out: o });
      } else {                                                        // kriecht: nur noch Herzschlag
        const k = i % 8;
        if (k === 0) c.kick(t, 0.42, o);
        if (k === 2) c.kick(t, 0.26, o);
        c.note(t, { m: 93 + (i % 2), wave: "12", vol: 0.008 + 0.01 * (L - 0.8) * 5, frames: 4, out: o });
      }
    },
  },
};

class Chip {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.musicOn = true;
    this.wantLobby = false;
    this.scene = null;
    this.level = 0;            // Spannung 0..1 beim Drehen
    this.combo = 0; this.lastChip = 0;
    this.climb = 0; this.tickN = 0; this.lastTick = 0;
    this.lastHover = 0; this.hoverN = 0; this.lastPing = 0;
    this._roll = null;
    this.hits = [];            // [Audiozeit, Stärke, Nummer]: hörbare Schläge für den Puls der Knöpfe
    this.hitN = 0;
  }

  // -- Aufbau ---------------------------------------------------------------------
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = this.ctx = new AC({ latencyHint: "interactive" });
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 10; comp.ratio.value = 3;
      comp.attack.value = 0.003; comp.release.value = 0.2;
      this.out = this.gain(0.9);
      comp.connect(this.out).connect(ctx.destination);
      const soft = ctx.createBiquadFilter(); soft.type = "lowpass"; soft.frequency.value = 6800; soft.Q.value = 0.3;
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 35;
      hp.connect(soft).connect(comp);
      this.sfx = this.gain(this.enabled ? 1 : 0); this.sfx.connect(hp);
      this.game = this.gain(this.enabled ? 1 : 0); this.game.connect(hp);
      this.music = this.gain(0); this.music.connect(hp);
      const room = ctx.createConvolver(); room.buffer = this.room(0.9);
      this.send = this.gain(0.16); this.send.connect(room).connect(soft);
      [this.sfx, this.game, this.music].forEach((g) => g.connect(this.send));
      this.waves = { 12: this.pulse(0.125), 25: this.pulse(0.25), 50: this.pulse(0.5), tri: this.tri4() };
      this.noiseLong = this.lfsr(false);
      this.noiseShort = this.lfsr(true);
      this.next = ctx.currentTime + 0.1;
      setInterval(() => this.pump(), 25);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  get ready() { return !!this.ctx && this.ctx.state === "running" && this.enabled; }
  get now() { return this.ctx.currentTime; }
  /** Server-Millisekunden → Audiozeit */
  at(serverMs) { return this.ctx.currentTime + (serverMs - serverNow()) / 1000; }

  gain(v) { const g = this.ctx.createGain(); g.gain.value = v; return g; }

  /** Bandbegrenzter Puls; Lanczos-Gewichtung verhindert das Klirren an den Kanten */
  pulse(duty) {
    const n = 40, re = new Float32Array(n + 1), im = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) {
      const x = Math.PI * k / (n + 1);
      re[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty) * (Math.sin(x) / x);
    }
    return this.ctx.createPeriodicWave(re, im);
  }

  /** Dreieck in 16 Stufen, wie es die Konsole ausgibt: im Bass leicht körnig */
  tri4() {
    const N = 32, n = 24, re = new Float32Array(n + 1), im = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) {
      for (let i = 0; i < N; i++) {
        const v = ((i < 16 ? 15 - i : i - 16) - 7.5) / 7.5, a = 2 * Math.PI * k * i / N;
        re[k] += (2 / N) * v * Math.cos(a);
        im[k] += (2 / N) * v * Math.sin(a);
      }
    }
    return this.ctx.createPeriodicWave(re, im);
  }

  /** Rauschen aus dem 15-Bit-Schieberegister; kurz = Abgriff an Bit 6, metallisch */
  lfsr(short) {
    const steps = short ? 93 * 31 : 32767, hold = 4;
    const b = this.ctx.createBuffer(1, steps * hold, this.ctx.sampleRate), d = b.getChannelData(0);
    let reg = 1;
    for (let i = 0; i < steps; i++) {
      const bit = (reg ^ (reg >> (short ? 6 : 1))) & 1;
      reg = (reg >> 1) | (bit << 14);
      d.fill(reg & 1 ? 0.7 : -0.7, i * hold, i * hold + hold);
    }
    return b;
  }

  room(sec) {
    const rate = this.ctx.sampleRate, len = Math.floor(rate * sec), b = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        y += 0.35 * ((Math.random() * 2 - 1) - y);
        d[i] = y * Math.exp(-i / rate * 5);
      }
    }
    return b;
  }

  _connect(node, out, pan) {
    let n = node;
    if (pan) { const p = this.ctx.createStereoPanner(); p.pan.value = pan; n.connect(p); n = p; }
    n.connect(out || this.sfx);
  }

  _volume(g, t, vol, frames, decay) {
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i <= frames; i++) {
      const v = i === frames ? 0 : vol * (1 - i / frames) ** decay;
      g.gain.setTargetAtTime(v, t + i * FR, 0.0025);    // Stufen, aber ohne Knacksen
    }
  }

  /** Ein Ton: Hüllkurve und Tonhöhe in Bildschritten (1/60 s) */
  note(t, { m, f, wave = "50", vol = 0.1, frames = 6, decay = 1, arp, sweep = 0, vib = 0, vibAt = 8, out, pan = 0 } = {}) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.setPeriodicWave(this.waves[wave]);
    const base = f ?? mtof(m);
    for (let i = 0; i <= frames; i++) {
      let fr = base;
      if (arp) fr *= 2 ** (arp[Math.min(i, arp.length - 1)] / 12);
      if (sweep) fr *= 2 ** (sweep * i / 12);
      if (vib && i >= vibAt) fr *= 2 ** (vib * Math.sin((i - vibAt) * 0.85) / 12);
      o.frequency.setValueAtTime(Math.max(20, Math.min(15000, fr)), t + i * FR);
    }
    this._volume(g, t, vol, frames, decay);
    o.connect(g); this._connect(g, out, pan);
    o.start(t); o.stop(t + (frames + 3) * FR);
  }

  /** Rauschen; rates = Tonhöhenverlauf je Bild */
  noise(t, { short = false, rate = 1, rates, vol = 0.1, frames = 4, decay = 1, out, pan = 0 } = {}) {
    if (!this.ctx) return;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = short ? this.noiseShort : this.noiseLong; s.loop = true;
    for (let i = 0; i <= frames; i++) {
      s.playbackRate.setValueAtTime(rates ? rates[Math.min(i, rates.length - 1)] : rate, t + i * FR);
    }
    this._volume(g, t, vol, frames, decay);
    s.connect(g); this._connect(g, out, pan);
    s.start(t, Math.random() * s.buffer.duration); s.stop(t + (frames + 3) * FR);
  }

  kick(t, v = 0.4, out) {
    this._hit(t, Math.min(1, v * 2), out);
    this.note(t, { f: 170, wave: "tri", vol: v, frames: 8, decay: 0.7, sweep: -4.5, out });
    this.noise(t, { rate: 0.3, vol: v * 0.18, frames: 1, out });
  }
  snare(t, v = 0.15, out) {
    this._hit(t, Math.min(0.45, v * 1.6), out);
    this.noise(t, { rate: 0.6, vol: v, frames: 7, decay: 1.5, out });
    this.note(t, { f: 230, wave: "50", vol: v * 0.25, frames: 3, sweep: -3, out });
  }
  hat(t, v = 0.03, out) { this.noise(t, { rate: 2.4, vol: v, frames: 2, decay: 2, out }); }

  // -- Musik --------------------------------------------------------------------
  setScene(name, opts = {}) {
    if (!this.ctx) return;
    const t = this.now + 0.05;
    if (!name) { this.scene = null; this.applyGains(); return; }
    const def = SCENES[name];
    this.scene = { name, ...def, opts, step: 0 };
    if (opts.endAt) {               // Raster so legen, dass der letzte Schritt auf endAt fällt
      const dur = 60 / def.bpm / 4, k = Math.max(0, Math.floor((opts.endAt - t) / dur));
      this.scene.left = k;
      this.next = opts.endAt - k * dur;
    } else this.next = t;
    if (name === "spin") this.level = 0;
    this.applyGains();
  }

  pump() {
    const sc = this.scene;
    if (!sc || !this.ctx || this.ctx.state !== "running") return;
    const dur = 60 / sc.bpm / 4;
    if (this.next < this.now - 0.2) this.next = this.now + 0.02;    // nach Pause im Hintergrund nicht nachholen
    while (this.scene === sc && this.next < this.now + 0.12) {
      const swing = sc.swing && sc.step % 2 ? dur * sc.swing : 0;
      try { sc.play(this, sc.step, this.next + swing, dur, sc); } catch (e) { console.error(e); }
      sc.step++;
      this.next += dur;
      if (sc.left !== undefined && --sc.left < 0) { this.scene = null; this.applyGains(); }
    }
  }

  applyGains() {
    if (!this.ctx) return;
    const lobby = this.musicOn && this.scene?.name === "lobby";
    // Lobby ist Bett, Spielmusik trägt, Effekte stehen vorn
    this.music.gain.setTargetAtTime(lobby ? 0.42 : 0, this.now, lobby ? 0.6 : 0.12);
    this.game.gain.setTargetAtTime(this.enabled ? 0.78 : 0, this.now, 0.05);
    this.sfx.gain.setTargetAtTime(this.enabled ? 1 : 0, this.now, 0.05);
  }

  /** Bildschirm wünscht Lobbymusik (Ruhe) oder nicht */
  lounge(on) {
    this.wantLobby = on;
    if (!this.ctx) return;
    if (on && !this.scene) this.setScene("lobby");
    else if (!on && this.scene?.name === "lobby") this.setScene(null);
  }

  setMusic(on) {
    this.musicOn = on;
    if (on && this.wantLobby && this.ctx && !this.scene) this.setScene("lobby");
    this.applyGains();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.rollStop();
    this.applyGains();
  }

  // -- Oberfläche -----------------------------------------------------------------
  hover() {
    if (!this.ready) return;
    const n = performance.now();
    if (n - this.lastHover < 45) return;
    this.lastHover = n;
    this.hoverN ^= 1;
    this.note(this.now, { m: this.hoverN ? 96 : 100, wave: "12", vol: 0.028, frames: 2, decay: 2 });
  }

  /** Knopf: kurzer Abwärtsschlag mit Klick */
  press(semi = 0) {
    if (!this.ready) return;
    const t = this.now;
    this.note(t, { m: 76 + semi, wave: "25", vol: 0.09, frames: 5, arp: [0, 0, -5, -5, -12], decay: 0.8 });
    this.noise(t, { short: true, rate: 1.1, vol: 0.05, frames: 1 });
  }

  /** Chip gesetzt. Schnell hintereinander steigt die Tonleiter: die Combo-Leiter. */
  chip(n = 1, { pan = 0 } = {}) {
    if (!this.ready) return;
    if (this.now - this.lastChip > 0.8) this.combo = 0;
    let t = Math.max(this.now, this.lastChip);
    for (let k = 0; k < n; k++) {
      const m = 79 + PENTA[this.combo];
      this.note(t, { m, wave: "50", vol: 0.06, frames: 2, pan });
      this.note(t + 2 * FR, { m: m + 5, wave: "50", vol: 0.055, frames: 9, decay: 1.4, pan });
      this.noise(t, { short: true, rate: 1.8, vol: 0.03, frames: 1, pan });
      this.combo = Math.min(this.combo + 1, PENTA.length - 1);
      t += 4 * FR;
    }
    this.lastChip = t;
  }

  // -- Bühnen -----------------------------------------------------------------------
  /** Zeiger fängt einen Stift */
  tick(strength = 1) {
    if (!this.ready) return;
    const n = performance.now();
    if (n - this.lastTick < 22) return;
    this.lastTick = n;
    let m;
    if (this.level >= 0.8) { this.climb = Math.min(24, this.climb + 1); m = 69 + this.climb; }
    else { this.climb = 0; this.tickN = (this.tickN + 1) % 5; m = 81 + MINOR_PENTA[this.tickN]; }
    const v = (0.022 + 0.04 * strength) * (this.level >= 0.8 ? 1.35 : 1);
    const t = this.now;
    this.note(t, { m, wave: "12", vol: v, frames: 2, decay: 1.5 });
    this.noise(t, { short: true, rate: 2.2, vol: v * 0.6, frames: 1 });
  }

  clack(strength = 1) {
    if (!this.ready) return;
    const t = this.now, v = 0.3 + 0.7 * strength;
    this.noise(t, { short: true, rate: 1.3, vol: 0.06 * v, frames: 1, pan: rnd(-0.3, 0.3) });
    this.note(t, { m: 93 + Math.floor(rnd(0, 3)) * 2, wave: "12", vol: 0.025 * v, frames: 1 });
  }

  /** Rollende Kugel; speed 0..1 */
  roll(speed) {
    if (!this.ready) return;
    if (!this._roll) {
      const s = this.ctx.createBufferSource(), g = this.gain(0);
      s.buffer = this.noiseLong; s.loop = true;
      s.connect(g).connect(this.sfx); s.start();
      this._roll = { s, g };
    }
    const t = this.now;
    this._roll.s.playbackRate.setTargetAtTime(0.08 + speed * 0.3, t, 0.05);
    this._roll.g.gain.setTargetAtTime(0.008 + speed * 0.03, t, 0.05);
  }

  rollStop() {
    if (!this._roll) return;
    const r = this._roll; this._roll = null;
    r.g.gain.setTargetAtTime(0, this.now, 0.04);
    r.s.stop(this.now + 0.3);
  }

  /** Plinko-Stift: Pentatonik nach Reihe, mit Echo */
  ping(row) {
    if (!this.ready) return;
    const n = performance.now();
    if (n - this.lastPing < 25) return;
    this.lastPing = n;
    const t = this.now, m = 72 + PENTA[row % PENTA.length], pan = rnd(-0.4, 0.4);
    this.note(t, { m, wave: "50", vol: 0.06, frames: 8, decay: 1.2, pan });
    this.note(t + 0.12, { m, wave: "12", vol: 0.02, frames: 6, decay: 1.2, pan: -pan });
  }

  land() {
    if (!this.ready) return;
    const t = this.now;
    this.kick(t, 0.45, this.sfx);
    this.noise(t, { rate: 0.4, vol: 0.1, frames: 6, decay: 1.2 });
  }

  // -- Ablauf -------------------------------------------------------------------------
  /** Sekundenschlag für Geräte ohne Countdown-Musik (Handys) */
  clock(left) {
    if (!this.ready) return;
    this.note(this.now, { m: left <= 3 ? 84 + (3 - left) * 2 : 81, wave: "50", vol: left <= 3 ? 0.08 : 0.05, frames: 6, decay: 1.2 });
  }

  /** Spannung beim Drehen; 0 = schnell, 1 = steht */
  tension(level) { this.level = level; }
  tensionStop() { this.level = 0; this.climb = 0; }

  /** „Nichts geht mehr“: abfallendes Rauschen, tiefer Schlag, fallende Tonfolge */
  slam() {
    if (!this.ready) return;
    this.setScene(null);
    const t = this.now;
    this.noise(t, { rates: Array.from({ length: 24 }, (_, i) => 1.3 * 0.89 ** i), vol: 0.22, frames: 24, decay: 0.8 });
    this.note(t, { f: 190, wave: "tri", vol: 0.5, frames: 16, sweep: -3, decay: 0.6 });
    [76, 72, 69, 64, 57].forEach((m, k) => this.note(t + k * 3 * FR, { m, wave: "25", vol: 0.075, frames: 4, decay: 0.8 }));
  }

  /** Ergebnis: Fanfare in A-Dur nach all dem Moll */
  reveal() {
    if (!this.ready) return;
    this.setScene(null);
    this.tensionStop();
    const t = this.now + 0.03;
    const t2 = t + 13 * FR, t3 = t2 + 14 * FR;
    this.noise(t, { rate: 0.9, vol: 0.11, frames: 50, decay: 1.6 });
    this.kick(t, 0.5, this.sfx);
    [69, 73, 76, 81].forEach((m, k) => this.note(t + k * 3 * FR, { m, wave: "25", vol: 0.085, frames: 3 }));
    this.note(t2, { m: 76, wave: "25", vol: 0.085, frames: 6, decay: 0.5 });
    this.note(t2 + 7 * FR, { m: 81, wave: "25", vol: 0.085, frames: 6, decay: 0.5 });
    this.note(t3, { m: 85, wave: "25", vol: 0.095, frames: 58, decay: 0.55, vib: 0.3, vibAt: 12 });
    this.note(t3, { m: 81, wave: "12", vol: 0.045, frames: 58, decay: 0.55, vib: 0.3, vibAt: 12 });
    this.note(t, { m: 45, wave: "tri", vol: 0.28, frames: 11, decay: 0.4 });
    this.note(t2, { m: 40, wave: "tri", vol: 0.28, frames: 12, decay: 0.4 });
    this.note(t3, { m: 45, wave: "tri", vol: 0.3, frames: 52, decay: 0.45 });
    this.kick(t2, 0.35, this.sfx);
    this.snare(t3, 0.16, this.sfx);
    for (let k = 0; k < 8; k++) {
      this.note(t3 + 0.5 + k * 2 * FR, { m: [93, 97, 100, 105][k % 4] + (k >= 4 ? 12 : 0), wave: "12", vol: 0.025, frames: 3, pan: k % 2 ? 0.4 : -0.4 });
    }
  }

  /** Münzen klimpern */
  coins(n = 12, at = 0, spread = 1) {
    if (!this.ready) return;
    for (let k = 0; k < n; k++) {
      const t = this.now + at + Math.random() ** 1.5 * spread;
      this.note(t, { m: 91 + PENTA[Math.floor(rnd(0, 6))], wave: "12", vol: rnd(0.012, 0.025), frames: 3, pan: rnd(-0.7, 0.7) });
    }
  }

  /** Zählschritt bei der Abrechnung: jede Stufe eine Note höher */
  score(step = 0) {
    if (!this.ready) return;
    const t = this.now, m = 76 + PENTA[Math.min(step, PENTA.length - 1)];
    this.note(t, { m, wave: "50", vol: 0.075, frames: 5, decay: 1.2 });
    this.note(t + 0.08, { m, wave: "12", vol: 0.025, frames: 4, decay: 1.2, pan: 0.4 });
  }

  /** Gewinn eingestrichen */
  kaching(big = false, at = 0) {
    if (!this.ready) return;
    const t = this.now + at;
    this.note(t, { m: 88, wave: "50", vol: 0.07, frames: 3 });
    this.note(t + 3 * FR, { m: 93, wave: "50", vol: 0.07, frames: 20, decay: 1.2 });
    if (big) [93, 97, 100, 105, 109].forEach((m, k) => this.note(t + 0.12 + k * 2 * FR, { m, wave: "12", vol: 0.03, frames: 3 }));
    this.coins(big ? 14 : 5, at + 0.1, big ? 0.9 : 0.4);
  }

  /** Die Bank gewinnt: Posaune in 8 Bit */
  lose() {
    if (!this.ready) return;
    const t = this.now;
    [76, 75, 74].forEach((m, k) => this.note(t + k * 16 * FR, { m, wave: "25", vol: 0.07, frames: 14, decay: 0.3 }));
    this.note(t + 48 * FR, { m: 73, wave: "25", vol: 0.075, frames: 54, decay: 0.45, vib: 0.5, vibAt: 6 });
    [45, 44, 43].forEach((m, k) => this.note(t + k * 16 * FR, { m, wave: "tri", vol: 0.18, frames: 14, decay: 0.5 }));
    this.note(t + 48 * FR, { m: 42, wave: "tri", vol: 0.2, frames: 50, decay: 0.5 });
  }

  /** Konsole an: Rauschen schwillt an, Tonleiter hoch, Münze */
  powerOn() {
    if (!this.ready) return;
    const t = this.now;
    this.noise(t, { rates: Array.from({ length: 20 }, (_, i) => 0.08 * 1.17 ** i), vol: 0.07, frames: 20, decay: 0.5 });
    [57, 64, 69, 76, 81, 88].forEach((m, k) => this.note(t + 0.32 + k * 2 * FR, { m, wave: "25", vol: 0.07, frames: 3 }));
    this.kaching(false, 0.62);
  }
}
export const sound = new Chip();

// -----------------------------------------------------------------------------
// Puls der Knöpfe
// -----------------------------------------------------------------------------
// Knöpfe atmen im Takt der Schläge, die gerade wirklich zu hören sind: ruhig in
// der Lobby, fester im Countdown, schnell beim Drehen, Lub-Dub beim Herzschlag.
// Zwei CSS-Variablen auf <html>: --pulse (0..1, springt beim Schlag hoch und
// klingt ab) und --swing (−1..1, pendelt von Schlag zu Schlag hin und her).
// Ohne hörbare Musik (Handy stumm, Musik aus) atmen sie ganz leicht im Lobby-Tempo.

Chip.prototype._hit = function (t, v, out) {
  if (!this.enabled || (out === this.music && !this.musicOn)) return;
  this.hits.push([t, v, this.hitN++]);
  if (this.hits.length > 24) this.hits.shift();
};

/** Puls und Pendel zum gerade gehörten Schlag, oder null, wenn nichts spielt */
Chip.prototype.groove = function () {
  if (!this.ctx || this.ctx.state !== "running") return null;
  const now = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
  let last = null, prev = null;
  for (const h of this.hits) {
    if (h[0] > now) break;
    prev = last; last = h;
  }
  if (!last || now - last[0] > 1.6) return null;
  const pulse = last[1] * Math.exp(-(now - last[0]) * 7);
  const gap = prev ? Math.max(0.15, last[0] - prev[0]) : 0.5;
  const swing = (last[2] % 2 ? 1 : -1) * Math.cos(Math.PI * Math.min(1, (now - last[0]) / gap));
  return { pulse, swing };
};

(function beatLoop() {
  if (reduced) return;
  const root = document.documentElement.style;
  let shownP = -1, shownS = -1;
  const idle = 60 / 112;
  const frame = (ms) => {
    requestAnimationFrame(frame);
    let g = sound.groove();
    if (!g) {                                   // kein Ton: leises Atmen
      const t = ms / 1000, n = Math.floor(t / idle), f = (t % idle) / idle;
      g = { pulse: 0.3 * Math.exp(-f * 5), swing: (n % 2 ? 1 : -1) * Math.cos(Math.PI * f) };
    }
    const p = Math.round(g.pulse * 100) / 100, sw = Math.round(g.swing * 50) / 50;
    if (p !== shownP) { root.setProperty("--pulse", p); shownP = p; }
    if (sw !== shownS) { root.setProperty("--swing", sw); shownS = sw; }
  };
  requestAnimationFrame(frame);
})();
