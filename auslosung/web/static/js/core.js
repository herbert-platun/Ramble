// Grundlagen für alle Seiten: API, Server-Uhr, Event-Stream, Toast, Speicher, Hilfen
// =============================================================================
// Grundlagen
// =============================================================================
// Gemeinsame Helfer für Lobby, großen Bildschirm und Handy.
export const MODE_NAMES = { wheel: "Glücksrad", plinko: "Plinko", slots: "Slots" };

// Feldfarben, in dieser Reihenfolge reihum vergeben
const SLOT_COLORS = [
  { fill: "#ff3d4f", text: "#fff1d6", dark: "#b0142c" },  // Rot
  { fill: "#fff1d6", text: "#120a19", dark: "#d8c39c" },  // Creme
  { fill: "#14a383", text: "#fff1d6", dark: "#0b6b55" },  // Filzgrün
  { fill: "#ffc23d", text: "#120a19", dark: "#c98a1c" },  // Gold
  { fill: "#3a8dff", text: "#fff1d6", dark: "#1a4fb8" },  // Blau
  { fill: "#3e2a52", text: "#ffe9a3", dark: "#24172f" },  // Pflaume
];

/** Farbe je Teilnehmer: stabil über die Reihenfolge im Topf. */
export function colorFor(ids) {
  const order = [...new Set(ids)], n = order.length;
  // Palettenlänge so wählen, dass der letzte Name nicht die Farbe des ersten bekommt
  const k = [6, 5, 4].find((k) => n <= k || n % k !== 1);
  return (id) => SLOT_COLORS[order.indexOf(id) % k];
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: "Der Server antwortet nicht" }));
  if (!res.ok) throw Object.assign(new Error(data.error || "Fehler"), { status: res.status });
  return data;
}

// Animationen hängen an Server-Zeitstempeln, darum die Uhr abgleichen.
let offset = null;
export const serverNow = () => Date.now() + (offset || 0);
export function syncClock(serverMs) {
  const sample = serverMs - Date.now();
  offset = offset === null ? sample : Math.max(sample, offset * 0.8 + sample * 0.2);
}

export function live(url, onState, onStatus = () => {}) {
  let es, retry = 0;
  const open = () => {
    es = new EventSource(url);
    es.onopen = () => { retry = 0; onStatus(true); };
    es.onmessage = (e) => { const s = JSON.parse(e.data); syncClock(s.now); onState(s); };
    es.onerror = () => { onStatus(false); es.close(); setTimeout(open, Math.min(8000, 800 * 2 ** retry++)); };
  };
  open();
}

/** Liste auf neues HTML bringen, ohne bestehende Einträge (data-key) zu ersetzen:
 *  nur so laufen Übergänge, Druck- und Aufzuck-Animationen beim Aktualisieren weiter. */
export function patch(box, html) {
  const t = document.createElement("template");
  t.innerHTML = html;
  const old = new Map([...box.children].map((el) => [el.dataset.key, el]));
  const next = [...t.content.children];
  next.forEach((n, i) => {
    const cur = old.get(n.dataset.key);
    const el = cur?.nodeName === n.nodeName ? morph(cur, n) : n;
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
  });
  while (box.children.length > next.length) box.lastElementChild.remove();
}

function morph(a, b) {
  if (a.nodeType !== 1) { if (a.data !== b.data) a.data = b.data; return a; }
  if (a.classList.contains("bump")) b.classList.add("bump");
  for (const k of a.getAttributeNames()) if (!b.hasAttribute(k)) a.removeAttribute(k);
  for (const k of b.getAttributeNames()) if (a.getAttribute(k) !== b.getAttribute(k)) a.setAttribute(k, b.getAttribute(k));
  const x = [...a.childNodes], y = [...b.childNodes];
  if (x.length === y.length && x.every((n, i) => n.nodeName === y[i].nodeName)) x.forEach((n, i) => morph(n, y[i]));
  else a.replaceChildren(...y);
  return a;
}

export function toast(msg, ms = 2800) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast"; el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function fitCanvas(canvas, onResize) {
  const ctx = canvas.getContext("2d");
  new ResizeObserver(() => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    onResize(r.width, r.height);
  }).observe(canvas);
  return ctx;
}

/** Zustand einer Ziehung aus Sicht der Uhr: null, "running" oder "done".
 *  "running" umfasst letzte Einsätze und „Keine Wetten mehr“, siehe stagePhase. */
export function pickPhase(pick) {
  if (!pick) return null;
  return serverNow() < pick.ends_at ? "running" : "done";
}

/** Slots: die Runde, die gerade läuft oder als Nächstes kommt (null außerhalb einer Session). */
export function currentRound(pick, t = serverNow()) {
  if (!pick?.rounds?.length) return null;
  let r = pick.rounds[0];
  for (const x of pick.rounds) if (x.calls_at <= t) r = x;
  return r;
}

/** Zeitpunkte des laufenden Abschnitts: bei Slots die aktuelle Runde, sonst die Ziehung. */
export function segment(pick) {
  if (!pick) return null;
  if (pick.mode !== "slots") return { n: 0, locks_at: pick.locks_at, started_at: pick.started_at, locked: pick.locked, calls_at: 0 };
  const r = currentRound(pick);
  return r && { n: r.n, locks_at: r.locks_at, started_at: r.started_at, locked: r.locked, calls_at: r.calls_at, ends_at: r.ends_at };
}

/** Feinere Phase: "calls" (letzte Einsätze), "lock", "spin", "done" oder null.
 *  Bei Slots gilt das je Runde; zwischen zwei Runden läuft noch "spin". */
export function stagePhase(pick) {
  if (!pick) return null;
  const t = serverNow();
  if (t >= pick.ends_at && pick.locked) return "done";
  const s = segment(pick);
  if (!s) return "lock";
  if (t < s.locks_at) return "calls";
  if (t < s.started_at || !s.locked) return "lock";
  return "spin";
}

/** Phase plus Rundennummer: Wechsel davon lösen Licht, Ton und Einblendungen aus. */
export function phaseKey(pick) {
  const ph = stagePhase(pick);
  return ph && `${pick.id}:${ph}:${segment(pick)?.n ?? 0}`;
}

// -- Punkte und Chips --------------------------------------------------------------
/** Summe aller Werte eines Objekts, z. B. Einsätze {name_id: chips}. */
export const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

/** [[id, wert], …] absteigend, nur Werte über 0 (Punktestände). */
export const ranked = (o) => Object.entries(o || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);

/** Punkte je Name über gedrehte Slot-Runden (wie session_points im Server). */
export function sessionPoints(rounds) {
  const out = {};
  for (const r of rounds) for (const [id, v] of Object.entries(r.result?.pts || {})) out[id] = (out[id] || 0) + v;
  return out;
}

/** Bestenliste: Spieler mit Handy nach Chips, gesetzte Einsätze zählen mit. */
export const chipRanking = (entrants) => entrants.filter((e) => e.phone)
  .map((e) => ({ ...e, total: e.chips + sum(e.wagers) }))
  .sort((a, b) => b.total - a.total || a.id - b.id);

/** Vorzeichen für Chip-Bilanzen: +120, −80, ±0 */
export const signed = (v, fmt) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v))}`;

// -- Slot-Symbole -----------------------------------------------------------------
export const SPECIALS = { W: ["star", "Joker", "wild"], N: ["snakeeyes", "Niete", "bust"] };

// Farbe, die jedes Bild in der ersten Runde des Vorrats bekommt (wie BASE_ACCENT in game/slots.py).
// Ab dem neunten Namen wiederholen sich die Bilder in anderer Farbe: dann färbt sich das Bild selbst mit.
const NATIVE_ACCENT = { cherry: 2, lemon: 3, bell: 7, horseshoe: 0, bar: 5, chip: 1, diamond: 6, seven: 4 };
// Eigene Grundfarbe des Bilds (Akzentnummer). Fällt die Umfärbung darauf, sähe es aus wie das Original.
const BODY_COLOR = { cherry: 0, lemon: 1, bell: 1, horseshoe: 1, bar: 5, chip: 4, diamond: 3, seven: 0 };

/** CSS-Klassen für Bild und Farbe eines Namens: "acc-3" oder "acc-3 tint tint-3". */
export function skinClass(skin) {
  const [sym, acc] = skin || ["chip", 5];
  if (!(sym in NATIVE_ACCENT) || NATIVE_ACCENT[sym] === acc) return `acc-${acc}`;
  const tint = BODY_COLOR[sym] === acc ? (acc === 7 ? 3 : 7) : acc;
  return `acc-${acc} tint tint-${tint}`;
}

/** HTML eines Symbols mit Namensschild. v: Name-ID (Zahl) oder Sonderzelle ("W", "N", "x3"). */
export function skinHtml(v, skins, names, extra = "") {
  if (typeof v === "string" && v[0] === "x") {
    return `<div class="skin special mult ${extra}"><svg class="sym"><use href="#sym-mult"/></svg><span class="x">×${v.slice(1)}</span><span class="tag">Faktor</span></div>`;
  }
  if (SPECIALS[v]) {
    const [sym, label, cls] = SPECIALS[v];
    return `<div class="skin special ${cls} ${extra}"><svg class="sym"><use href="#sym-${sym}"/></svg><span class="tag">${label}</span></div>`;
  }
  const skin = skins[String(v)] || ["chip", 5];
  return `<div class="skin ${skinClass(skin)} ${extra}" data-id="${v}"><svg class="sym"><use href="#sym-${skin[0]}"/></svg><span class="tag">${esc(names[String(v)] ?? "?")}</span></div>`;
}

/** Kleines Symbol ohne Schild, z. B. vor einem Namen in einer Liste. */
export function badgeHtml(skin) {
  if (!skin) return "";
  return `<span class="badge ${skinClass(skin)}" aria-hidden="true"><svg class="sym"><use href="#sym-${skin[0]}"/></svg></span>`;
}
