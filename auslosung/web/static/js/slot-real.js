// Echte Mechanik und Jackpot-Jingle der Slots (aus dem Klanglabor übernommen).
//
//   Rattern   je laufender Walze eine Rastklinke (Rauschimpuls auf ~40 zufällige
//             Resonanzen, 16 Varianten) plus Schnurren: Rumpeln und das Flattern
//             der Bänder im Takt der vorbeiziehenden Symbole.
//   Einrasten Holzkörper mit Gewicht unten, leiser Metallring oben, die Walze
//             federt kurz nach. Das Rattern tritt in dem Moment kurz zurück.
//   Jackpot   Automaten-Jingle im Shuffle (Triolen 2:1): Bass auf dem Schlag,
//             Akkord auf dem Nachschlag, Marimba „ding-da“ aufwärts über
//             F – G – Am – E7, Landung auf a-Moll mit Riff, Glocke und Münzen.
//
// Alles wird einmal Sample für Sample berechnet und dann nur abgespielt.

import { sound as S } from "./audio.js";

let ac, sr, out, cab, hall, jp;
const BUS = {};
const R = (a, b) => a + Math.random() * (b - a);
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** Pegel wie im Labor; der Kompressor der App liegt dahinter. */
const LEVEL = 0.9;

function ready() {
  if (ac) return true;
  if (!S.ctx || !S.sfx) return false;
  ac = S.ctx; sr = ac.sampleRate;
  out = ac.createGain(); out.gain.value = LEVEL; out.connect(S.sfx);
  cab = ac.createConvolver(); cab.buffer = ir(0.3, 0.05, 0.35);
  const cg = ac.createGain(); cg.gain.value = 0.45; cab.connect(cg).connect(out);
  hall = ac.createConvolver(); hall.buffer = ir(2.4, 0.6, 0.6);
  const hg = ac.createGain(); hg.gain.value = 0.25; hall.connect(hg).connect(out);
  jp = ac.createGain(); jp.connect(out);
  const mk = (name, gain, to, hp = 0) => {
    const g = ac.createGain(); g.gain.value = gain; let n = g;
    if (hp) { const f = ac.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp; f.Q.value = 0.6; n.connect(f); n = f; }
    n.connect(to); BUS[name] = g;
  };
  mk("rat", 0.8, out);
  mk("clk", 1.9, out);
  mk("str", 0.75, jp, 220);
  mk("plk", 1, jp);
  mk("mal", 1.1, jp, 300);
  mk("coin", 0.45, jp, 1800);
  mk("bell", 1, jp, 600);
  mk("perc", 0.7, jp, 5000);
  return true;
}

/** Raumantwort: zerfallendes Rauschen, leicht gedämpft. */
function ir(len, tau, k) {
  const n = Math.ceil(len * sr), b = ac.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c); let lp = 0;
    for (let i = 0; i < n; i++) { lp += (1 - k) * ((Math.random() * 2 - 1) - lp); d[i] = lp * Math.exp(-(i / sr) / tau) * (i < sr * 0.004 ? i / (sr * 0.004) : 1); }
  }
  return b;
}

// ---------- Physik: Anregung + dichte Resonatorbank ---------------------------------
function noiseExc(ms, dark = 0) {
  const n = Math.max(2, Math.round(ms / 1000 * sr * 6)), e = new Float32Array(n), tau = ms / 1000 * sr; let lp = 0;
  for (let i = 0; i < n; i++) { const x = Math.random() * 2 - 1; lp += (1 - dark) * (x - lp); e[i] = lp * Math.exp(-i / tau); }
  return e;
}
function pulseExc(ms) {
  const n = Math.max(2, Math.round(ms / 1000 * sr)), e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = Math.sin(Math.PI * i / n);
  return e;
}
function dense(n, lo, hi, tlo, thi, tilt = 0.5) {
  const m = [];
  for (let i = 0; i < n; i++) { const f = lo * (hi / lo) ** Math.random(); m.push({ f, tau: R(tlo, thi), g: (f / lo) ** -tilt * R(0.3, 1) }); }
  return m;
}
function bank(len, modes, e) {
  const n = Math.ceil(len * sr), o = new Float32Array(n);
  for (const { f, tau, g } of modes) {
    if (f > sr * 0.45) continue;
    const r = Math.exp(-1 / (tau * sr)), w = 2 * Math.PI * f / sr, a1 = 2 * r * Math.cos(w), a2 = -r * r, b = g * Math.sin(w);
    let y1 = 0, y2 = 0; const stop = Math.min(n, e.length + Math.round(tau * sr * 8));
    for (let i = 0; i < stop; i++) { const x = i < e.length ? e[i] : 0; const y = a1 * y1 + a2 * y2 + b * x; y2 = y1; y1 = y; o[i] += y; }
  }
  return o;
}
function norm(a) { let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); if (p) for (let i = 0; i < a.length; i++) a[i] /= p; return a; }
function mix(len, layers) {
  const n = Math.ceil(len * sr), o = new Float32Array(n);
  for (const [arr, g, at = 0] of layers) { const off = Math.round(at * sr); for (let i = 0; i + off < n && i < arr.length; i++) o[i + off] += arr[i] * g; }
  norm(o);
  const f = Math.round(sr * 0.008); for (let i = 0; i < f; i++) o[n - 1 - i] *= i / f;
  return o;
}
function buf(arr) { const b = ac.createBuffer(1, arr.length, sr); b.copyToChannel(arr, 0); return b; }
function play(b, t, { vol = 1, rate = 1, pan = 0, bus, cabW = 0, hallW = 0 } = {}) {
  const s = ac.createBufferSource(), g = ac.createGain(), p = ac.createStereoPanner();
  s.buffer = b; s.playbackRate.value = rate; g.gain.value = vol; p.pan.value = Math.max(-1, Math.min(1, pan));
  s.connect(g).connect(p); p.connect(BUS[bus] || out);
  if (cabW) { const w = ac.createGain(); w.gain.value = cabW; p.connect(w).connect(cab); }
  if (hallW) { const w = ac.createGain(); w.gain.value = hallW; p.connect(w).connect(hall); }
  s.start(Math.max(t, ac.currentTime));
}

// ---------- Klänge berechnen ------------------------------------------------------------
const TICKS = [], CLK = [], COINS = [], SHAKE = [];
let BELL = null, prepared = false;
function tickArr(heavy = 1) {
  const L = 0.07;
  const shell = norm(bank(L, dense(36, 1400, 9500, 0.0015, 0.009, 0.5), noiseExc(0.35)));
  const body = norm(bank(L, dense(8, 220 / heavy, 1100, 0.004, 0.016, 0), pulseExc(0.8 * heavy)));
  const raw = norm(noiseExc(0.25));
  return mix(L, [[shell, 0.8], [body, 0.45 * heavy], [raw, 0.2]]);
}
/** Einrasten (K-D): Holz-Wucht mit leisem Metallring. */
function clackArr() {
  const L = 0.45, settle = tickArr();
  const weight = norm(bank(L, dense(5, 48, 100, 0.06, 0.12, 0), pulseExc(7)));
  const wood = norm(bank(L, dense(22, 170, 1300, 0.02, 0.06, 0.35), pulseExc(1.6)));
  const knock = norm(bank(L, dense(9, 380, 850, 0.035, 0.07, 0), pulseExc(1.2)));
  const latch = norm(bank(L, dense(24, 1800, 9000, 0.005, 0.025, 0.5), noiseExc(0.35)));
  const ring = norm(bank(L, [{ f: R(2350, 2450), tau: 0.16, g: 1 }, { f: R(3650, 3800), tau: 0.11, g: 0.6 }, { f: R(5600, 5900), tau: 0.07, g: 0.35 }], noiseExc(0.25)));
  return mix(L, [[weight, 0.85], [wood, 1], [knock, 0.5], [latch, 0.38], [ring, 0.11], [settle, 0.16, 0.03]]);
}
function coinArr() {
  const L = 0.5;
  return mix(L, [[norm(bank(L, dense(7, 2500, 12000, 0.04, 0.18, 0.2), noiseExc(0.2))), 1], [norm(bank(L, dense(6, 500, 1800, 0.02, 0.06, 0.2), noiseExc(0.5))), 0.3]]);
}
function bellArr() {
  const L = 1.6, f0 = 1180, rat = [1, 2.76, 5.4, 8.93, 13.34], tau = [0.9, 0.45, 0.25, 0.12, 0.07];
  return mix(L, [[norm(bank(L, rat.map((r, i) => ({ f: f0 * r, tau: tau[i], g: [1, 0.6, 0.4, 0.25, 0.15][i] })), noiseExc(0.3))), 1]]);
}
function shakeArr() {
  const n = Math.round(0.05 * sr), d = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = i / n; d[i] = (Math.random() * 2 - 1) * Math.min(1, u * 12) * (1 - u) ** 3; }
  return norm(d);
}
function loopNoise(sec, brown) {
  const n = Math.ceil(sec * sr), d = new Float32Array(n); let b = 0;
  for (let i = 0; i < n; i++) { const x = Math.random() * 2 - 1; if (brown) { b = (b + 0.02 * x) / 1.02; d[i] = b; } else d[i] = x; }
  return buf(norm(d));
}

/**
 * Alles vorbereiten, in kleinen Häppchen, damit die Musik nicht hakt.
 * Mechanik zuerst (wird beim Hebel gebraucht), Jingle-Material danach.
 */
export function prepare() {
  if (prepared || !ready()) return;
  prepared = true;
  const jobs = [];
  for (let i = 0; i < 16; i++) jobs.push(() => TICKS.push(buf(tickArr(R(0.9, 1.15)))));
  for (let i = 0; i < 4; i++) jobs.push(() => CLK.push(buf(clackArr())));
  jobs.push(() => { NOISE.white = loopNoise(3, false); NOISE.brown = loopNoise(3, true); });
  for (let i = 0; i < 12; i++) jobs.push(() => COINS.push(buf(coinArr())));
  for (let i = 0; i < 6; i++) jobs.push(() => SHAKE.push(buf(shakeArr())));
  jobs.push(() => { BELL = buf(bellArr()); });
  for (let m = 33; m <= 96; m += 3) jobs.push(() => { for (let k = m; k < m + 3; k++) { pluck(k); if (k >= 57) mallet(k); } });
  const step = () => { const t = performance.now(); while (jobs.length && performance.now() - t < 6) jobs.shift()(); if (jobs.length) setTimeout(step, 30); };
  step();
}
const NOISE = {};

// ---------- Rattern ----------------------------------------------------------------------
const RAT = { tick: 0.75, whir: 0.55 };                 // R3 · Mischung
const reels = [0, 1, 2, 3, 4].map((i) => ({ on: false, next: 0, pan: -0.6 + i * 0.3, since: 0 }));
let whir = null, slowAt = 0;

function startWhir() {
  if (whir || !NOISE.white) return;
  const t = ac.currentTime, mk = (b, type, f, q) => {
    const s = ac.createBufferSource(); s.buffer = b; s.loop = true;
    const fl = ac.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
    const g = ac.createGain(); g.gain.value = 0; s.connect(fl).connect(g); g.connect(BUS.rat);
    const w = ac.createGain(); w.gain.value = 0.6; g.connect(w).connect(cab);
    s.start(t); return { s, fl, g };
  };
  const rumble = mk(NOISE.brown, "lowpass", 380, 0.7), flut = mk(NOISE.white, "bandpass", 650, 0.8);
  const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 15; lg.gain.value = 0; lfo.connect(lg).connect(flut.g.gain); lfo.start(t);
  whir = { rumble, flut, lfo, lg };
}
function setWhir(n, slow) {
  if (!whir) return;
  const t = ac.currentTime, k = RAT.whir, lvl = n / 5;
  whir.rumble.g.gain.setTargetAtTime(n ? 0.5 * k * (0.4 + 0.6 * lvl) : 0, t, 0.12);
  whir.flut.g.gain.setTargetAtTime(n ? 0.09 * k * (0.3 + 0.7 * lvl) : 0, t, 0.12);
  whir.lg.gain.setTargetAtTime(n ? 0.05 * k * (0.3 + 0.7 * lvl) : 0, t, 0.12);
  whir.lfo.frequency.setTargetAtTime(slow ? 6 : 15, t, 0.4);
  whir.flut.fl.frequency.setTargetAtTime(slow ? 480 : 650, t, 0.4);
}
function stopWhir() {
  if (!whir) return;
  const w = whir; whir = null; const t = ac.currentTime;
  for (const x of [w.rumble, w.flut]) { x.g.gain.cancelScheduledValues(t); x.g.gain.setTargetAtTime(0, t, 0.08); x.s.stop(t + 0.6); }
  w.lfo.stop(t + 0.6);
}

/**
 * Welche Walzen laufen. n = Anzahl der noch laufenden (von rechts), slow = die letzte
 * dreht in die Spannung aus und wird langsam.
 */
export function setReels(n, slow = false) {
  if (!ready() || !prepared) return;
  const now = ac.currentTime;
  reels.forEach((r, i) => {
    const on = i >= 5 - n;
    if (on && !r.on) { r.next = now + 0.01 + i * 0.015; r.since = now; }
    r.on = on;
  });
  if (slow && !slowAt) slowAt = now;
  if (!slow) slowAt = 0;
  if (n) startWhir();
  setWhir(n, slow && n === 1);
  if (!n) stopWhir();
}

function rateOf(r, t) {
  let v = 6 + 12 * Math.min(1, (t - r.since) / 0.35);              // Anlauf
  if (slowAt && t > slowAt) v = 18 - 13 * Math.min(1, (t - slowAt) / 2.3) ** 0.7;   // letzte Walze läuft aus
  return v;
}

/** Vom Takt der Musik aus aufgerufen (alle 25 ms): Rastzähne für die nächsten 120 ms. */
export function pump() {
  if (!ac || !prepared || !TICKS.length) return;
  const now = ac.currentTime;
  for (const r of reels) {
    if (!r.on) continue;
    if (r.next < now) r.next = now + 0.005;
    while (r.next < now + 0.12) {
      const t = r.next, rate = rateOf(r, t), slow = rate < 10;
      play(TICKS[(Math.random() * TICKS.length) | 0], t, { vol: RAT.tick * R(0.65, 1) * (slow ? 1.15 : 0.7), rate: R(0.95, 1.05) * (slow ? 0.9 : 1), pan: r.pan + R(-0.05, 0.05), cabW: 0.5, bus: "rat" });
      r.next += (1 / rate) * R(0.88, 1.12);
    }
  }
}

/** Walze rastet ein. */
export function clack(col = 0, { tease = false, vol = 1, t } = {}) {
  if (!ready() || !CLK.length) return;
  const at = t ?? ac.currentTime;
  play(CLK[col % CLK.length], at, { vol: vol * (tease ? 1.15 : 1), rate: 1 - col * 0.01, pan: (-0.6 + col * 0.3) * 0.8, cabW: 0.45, bus: "clk" });
  // Rattern tritt kurz zurück, damit der Klack frei steht
  const g = BUS.rat.gain;
  g.cancelScheduledValues(at); g.setValueAtTime(0.8, at); g.linearRampToValueAtTime(0.4, at + 0.01); g.setTargetAtTime(0.8, at + 0.12, 0.08);
}

/** Einzelner Rastzahn (Hebel, Anzählen). */
export function tick(t, vol = 0.3, rate = 1) {
  if (!ready() || !TICKS.length) return;
  play(TICKS[(Math.random() * TICKS.length) | 0], t, { vol, rate, cabW: 0.3, bus: "rat" });
}

// ---------- Instrumente des Jingles ---------------------------------------------------
const plk = new Map(), mal = new Map();
function pluck(m) {
  if (plk.has(m)) return plk.get(m);
  const N = Math.max(2, Math.round(sr / mtof(m) - 0.5)), len = m < 50 ? 2.4 : 1.8, n = Math.ceil(len * sr), d = new Float32Array(n), q = new Float32Array(N);
  const T60 = m < 50 ? 2.2 : Math.max(0.7, 2 - (m - 50) * 0.035), g = 10 ** (-3 / (T60 * sr / (N + 0.5)));
  let lp = 0; for (let i = 0; i < N; i++) { lp += 0.5 * ((Math.random() * 2 - 1) - lp); q[i] = lp; }
  for (let i = 0, k = 0; i < n; i++) { const c = q[k], nx = q[(k + 1) % N]; d[i] = c; q[k] = g * 0.5 * (c + nx); k = (k + 1) % N; }
  const r = [buf(mix(len, [[d, 1]])), mtof(m) * (N + 0.5) / sr];
  plk.set(m, r); return r;
}
function mallet(m) {
  if (!mal.has(m)) { const f = mtof(m); mal.set(m, buf(mix(0.9, [[norm(bank(0.9, [{ f, tau: 0.3, g: 1 }, { f: f * 3.93, tau: 0.05, g: 0.32 }, { f: f * 9.2, tau: 0.012, g: 0.1 }], noiseExc(0.3))), 1]]))); }
  return mal.get(m);
}
function strum(t, notes, { vol = 0.5, spread = 0.007, hallW = 0.3 } = {}) {
  const ns = [...notes].sort((a, b) => a - b), v = vol / Math.sqrt(ns.length);
  ns.forEach((m, k) => { const [b, rate] = pluck(m); play(b, t + k * spread, { vol: v, rate, pan: ns.length > 1 ? (k / (ns.length - 1) - 0.5) * 0.6 : 0, hallW, bus: "plk" }); });
}
function strings(t, notes, { vol = 0.3, a = 0.08, dur = 0.5, r = 0.4, lp = 1500, lpTo = 0 } = {}) {
  const f = ac.createBiquadFilter(), g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain(), end = t + a + dur, v = vol / Math.sqrt(notes.length * 3);
  f.type = "lowpass"; f.Q.value = 0.5; f.frequency.setValueAtTime(lp, t); if (lpTo) f.frequency.linearRampToValueAtTime(lpTo, end);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + a); g.gain.setValueAtTime(v, end); g.gain.setTargetAtTime(0, end, r / 3);
  lfo.frequency.value = 5.2; lg.gain.value = 7; lfo.connect(lg);
  f.connect(g); g.connect(BUS.str); const w = ac.createGain(); w.gain.value = 0.4; g.connect(w).connect(hall);
  lfo.start(t); lfo.stop(end + r * 2);
  for (const m of notes) for (const det of [-11, 1, 12]) { const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = mtof(m); o.detune.value = det; lg.connect(o.detune); o.connect(f); o.start(t); o.stop(end + r * 2); }
}
function coinRain(t, n, dur, vol) {
  for (let i = 0; i < n; i++) {
    const u = Math.random(), at = t + dur * (u < 0.7 ? u ** 1.6 : u);
    play(COINS[(Math.random() * COINS.length) | 0], at, { vol: vol * R(0.3, 1) * (1 - 0.5 * (at - t) / dur), rate: R(0.9, 1.15), pan: R(-0.75, 0.75), cabW: 0.25, hallW: 0.15, bus: "coin" });
  }
}
const shaker = (t, vol) => play(SHAKE[(Math.random() * SHAKE.length) | 0], t, { vol, pan: 0.3, bus: "perc" });

// ---------- Jackpot-Jingle --------------------------------------------------------------
const MIX = { shake: 0.38, bell: 0.24, str: 0.24, bass: 0.55, chord: 0.5, mel: 0.5, hit: 0.5, coin: 0.3 };
const VO = { F: [41, [60, 65, 69]], G: [43, [62, 67, 71]], Am: [45, [64, 69, 72]], E7: [40, [62, 68, 71]] };
// „ding-da“ je Akkord: der letzte Durchgang oben, ein früherer eine Oktave tiefer (E7 tief → F hoch ist ein Halbton)
const HI = { F: [69, 72], G: [71, 74], Am: [72, 76], E7: [76, 80] };

/**
 * Jingle so takten, dass die Landung genau auf `end` fällt (Zählerstand erreicht).
 * Tempo um 150 BPM, je nach Dauer 4 bis 8 Schläge Anlauf. Liefert die Länge in Sekunden.
 */
export function jackpot(t0, end) {
  if (!ready() || !BELL || !SHAKE.length) return 0;
  const M = MIX, span = Math.max(1.4, end - t0 - 0.03);
  const n = Math.max(4, Math.min(8, Math.round(span / 0.4))), BEAT = span / n, SH = BEAT * 2 / 3;
  const start = end - n * BEAT;
  const P = ["F", "G", "Am", "E7"];
  jp.gain.cancelScheduledValues(start); jp.gain.setValueAtTime(1, start);
  for (let k = 0; k < n; k++) {
    const nm = P[(k + 4 - (n % 4)) % 4], [b, v] = VO[nm], high = k >= n - 4;
    const mel = high ? HI[nm] : HI[nm].map((m) => m - 12);
    const at = start + k * BEAT, u = k / (n - 1);
    strum(at, [b, b + 12], { vol: M.bass, hallW: 0.08 });
    strum(at + SH, v, { vol: M.chord * (0.75 + 0.35 * u), spread: 0.004, hallW: 0.2 });
    strings(at, v, { vol: M.str * (0.6 + 0.4 * u), a: 0.04, dur: BEAT - 0.05, r: 0.1, lp: 1500 + 1500 * u });
    play(mallet(mel[0]), at, { vol: M.mel * (0.8 + 0.2 * u), hallW: 0.25, bus: "mal" });
    play(mallet(mel[1]), at + SH, { vol: M.mel * (0.65 + 0.2 * u), hallW: 0.25, bus: "mal" });
    shaker(at, M.shake * 0.6); shaker(at + SH, M.shake);
  }
  const hit = end;
  clack(1, { vol: M.hit, t: hit });
  strum(hit, [33, 45], { vol: M.bass * 1.2, hallW: 0.12 });
  strum(hit, [57, 64, 69, 72, 76], { vol: M.chord * 1.3, spread: 0.008, hallW: 0.35 });
  strings(hit, [57, 64, 69, 72, 76], { vol: M.str * 1.1, a: 0.04, dur: BEAT * 2.6, r: 1, lp: 2800, lpTo: 1900 });
  [[0, 81], [SH, 76], [BEAT, 79], [BEAT + SH, 81], [BEAT * 2, 84], [BEAT * 2 + SH, 81]]
    .forEach(([d, m], k) => play(mallet(m), hit + d, { vol: M.mel * (k % 2 ? 0.75 : 1), hallW: 0.3, bus: "mal" }));
  for (let b = 0; b < 3; b++) {
    strum(hit + b * BEAT + SH, [64, 69, 72], { vol: M.chord * 0.65, spread: 0.003, hallW: 0.2 });
    if (b) strum(hit + b * BEAT, [45], { vol: M.bass, hallW: 0.08 });
    shaker(hit + b * BEAT, M.shake * 0.6); shaker(hit + b * BEAT + SH, M.shake);
  }
  play(BELL, hit + SH, { vol: M.bell, pan: 0.2, hallW: 0.3, bus: "bell" });
  play(BELL, hit + BEAT + SH, { vol: M.bell, pan: -0.2, hallW: 0.3, bus: "bell" });
  coinRain(hit + 0.05, 45, 2.2, M.coin);
  const fin = hit + BEAT * 3;
  strum(fin, [33, 45], { vol: M.bass * 1.2, hallW: 0.15 });
  strum(fin, [57, 64, 69, 72, 76, 81], { vol: M.chord * 1.4, spread: 0.01, hallW: 0.45 });
  play(mallet(81), fin, { vol: M.mel * 1.1, hallW: 0.4, bus: "mal" });
  play(mallet(93), fin + 0.02, { vol: M.mel * 0.35, hallW: 0.5, bus: "mal" });
  return fin + 1.5 - t0;
}

/** Jingle weich beenden (nächster Hebel, Abbruch). */
export function chokeJackpot(fade = 0.15) {
  if (!jp) return;
  const t = ac.currentTime;
  jp.gain.cancelScheduledValues(t); jp.gain.setTargetAtTime(0, t, fade);
}
