// Grundlagen für alle Seiten: API, Server-Uhr, Event-Stream, Toast, Speicher, Hilfen
// =============================================================================
// Grundlagen
// =============================================================================
// Gemeinsame Helfer für Lobby, großen Bildschirm und Handy.
export const MODE_NAMES = { wheel: "Glücksrad", roulette: "Roulette", plinko: "Plinko" };

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
 *  "running" umfasst letzte Einsätze und „Nichts geht mehr“, siehe stagePhase. */
export function pickPhase(pick) {
  if (!pick) return null;
  return serverNow() < pick.ends_at ? "running" : "done";
}

/** Feinere Phase: "calls" (letzte Einsätze), "lock", "spin", "done" oder null. */
export function stagePhase(pick) {
  if (!pick) return null;
  const t = serverNow();
  if (t >= pick.ends_at) return "done";
  if (t < pick.locks_at) return "calls";
  if (t < pick.started_at || !pick.locked) return "lock";
  return "spin";
}

