// Verwaltung: eigenständiges Modul. Spricht nur mit /api/admin/…
// Der Schlüssel kommt einmalig über /admin#SCHLÜSSEL und bleibt im Browser.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n || 0).toLocaleString("de-DE");
const when = (ms) => ms ? new Date(ms).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–";
const bytes = (n) => n > 1048576 ? `${(n / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB` : `${Math.ceil(n / 1024)} KB`;
const MODE = { wheel: "Glücksrad", plinko: "Plinko", slots: "Slots" };
const TABS = ["uebersicht", "tische", "sql", "anleitung"];
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let key = store.get("admin:key") || "";
/** Steht statt eines Bereichs ein Schlüssel im Fragment, übernehmen und ausblenden */
function takeKey() {
  const frag = decodeURIComponent(location.hash.slice(1));
  if (frag && !TABS.includes(frag.split("/")[0])) {
    key = frag; store.set("admin:key", frag);
    history.replaceState(null, "", "/admin#uebersicht");
  }
}

function toast(msg, ms = 2600) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), ms);
}

async function api(path, body, raw = false) {
  const res = await fetch("/api/admin/" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 403) { showLock("Der Schlüssel passt nicht (mehr). Neue Adresse steht in der Konsole."); throw new Error("Schlüssel"); }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({ error: "Der Server antwortet nicht" }));
  if (!res.ok) throw new Error(data.error || "Fehler");
  return data;
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");

/** Gefährliches erst beim zweiten Klick */
function twice(btn, label = "Sicher?") {
  if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; return true; }
  btn.dataset.label = btn.textContent; btn.dataset.armed = "1"; btn.textContent = label;
  setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 3500);
  return false;
}

// -----------------------------------------------------------------------------
function showLock(msg) {
  $("#view").innerHTML = `<section class="panel lock"><h2 class="label">Schlüssel</h2>
    <p>${esc(msg || "Die Verwaltung braucht den Schlüssel, den der Server beim Start in der Konsole ausgibt (Adresse mit #… am Ende).")}</p>
    <form class="row" id="keyForm"><input class="field" id="keyIn" placeholder="Schlüssel einfügen" autocomplete="off"><button class="btn">Öffnen</button></form></section>`;
  $("#keyForm").onsubmit = (e) => { e.preventDefault(); key = $("#keyIn").value.trim(); store.set("admin:key", key); route(); };
}

async function route() {
  takeKey();
  const [tab = "uebersicht", arg] = location.hash.slice(1).split("/");
  document.querySelectorAll("#tabs a").forEach((a) => a.setAttribute("aria-current", a.hash === "#" + tab ? "page" : "false"));
  if (tab === "anleitung") { $("#view").innerHTML = ""; $("#view").append($("#guide").content.cloneNode(true)); return; }
  if (!key) return showLock();
  try {
    if (tab === "tische") await tables(arg);
    else if (tab === "sql") sqlView();
    else await overview();
  } catch (e) { if (e.message !== "Schlüssel") toast(e.message); }
}
addEventListener("hashchange", route);

// -- Übersicht ------------------------------------------------------------------
async function overview() {
  const o = await api("overview");
  const tile = (label, v, s = "") => `<div class="panel tile"><p class="label">${label}</p><p class="v">${v}</p><p class="s">${s}</p></div>`;
  $("#view").innerHTML = `
    <div class="adm-grid">
      ${tile("Tische", fmt(o.counts.draws), o.last ? `zuletzt ${when(o.last)}` : "noch keine")}
      ${tile("Namen", fmt(o.counts.entrants), `${fmt(o.phones)} mit Handy`)}
      ${tile("Ziehungen", fmt(o.counts.picks))}
      ${tile("Chips im Umlauf", fmt(o.chips), o.staked ? `${fmt(o.staked)} gerade gesetzt` : "")}
      ${tile("Gruppen", fmt(o.counts.groups), `${fmt(o.counts.members)} Namen gespeichert`)}
      ${tile("Datei", bytes(o.size + o.wal), `${fmt(o.free_pages)} von ${fmt(o.pages)} Seiten frei`)}
      ${tile("Schema", `v${o.version}`, o.version === o.latest ? "aktuell" : `neu: v${o.latest}`)}
    </div>
    <section class="panel adm-card"><h2 class="label">Datenbank</h2>
      <p class="mono">${esc(o.path)} · SQLite ${esc(o.sqlite)}</p>
      <div class="row" style="margin-top:12px">
        <button class="btn green" id="bk">Sicherung laden</button>
        <button class="btn dark" id="chk">Prüfen</button>
        <button class="btn dark" id="vac">Aufräumen</button>
      </div>
      <p class="out" id="dbOut"></p>
    </section>
    <section class="panel adm-card"><h2 class="label">Alte Tische löschen</h2>
      <form class="row" id="purge">Alles, woran seit <input class="field" type="number" id="days" min="1" value="30" style="width:6em"> Tagen nichts passiert ist
        <button class="btn red">Löschen</button></form>
      <p class="out" id="purgeOut"></p>
    </section>
    <section class="panel adm-card"><h2 class="label">Gruppen</h2><ul class="grp-list" id="groups"></ul></section>`;
  const { groups } = await api("groups");
  $("#groups").innerHTML = groups.length ? groups.map((g) => `<li><div class="grp-row"><span class="t"><b>${esc(g.name)}</b>
      <span class="m">${g.members.length} Namen · ${esc(g.members.slice(0, 10).join(", "))}${g.members.length > 10 ? " …" : ""}</span></span>
      <button class="btn dark" data-del="${g.id}">Löschen</button></div></li>`).join("")
    : `<li class="empty">Noch keine Gruppe. Gespeichert wird am großen Bildschirm.</li>`;
  $("#groups").onclick = async (e) => {
    const b = e.target.closest("[data-del]");
    if (!b || !twice(b)) return;
    try { await api("group/delete", { id: +b.dataset.del }); toast("Gruppe gelöscht"); } catch (err) { toast(err.message); }
    overview();
  };
  $("#bk").onclick = async () => {
    const res = await api("backup", undefined, true);
    download(await res.blob(), `auslosung-${stamp()}.db`);
    $("#dbOut").innerHTML = `<span class="ok">Sicherung geladen.</span>`;
  };
  $("#chk").onclick = async () => {
    const r = await api("integrity", {});
    const good = r.integrity.length === 1 && r.integrity[0] === "ok" && !r.foreign_keys.length;
    $("#dbOut").innerHTML = good ? `<span class="ok">Alles in Ordnung.</span>`
      : `<span class="bad">${esc(r.integrity.join(" · "))} ${r.foreign_keys.length ? `· ${r.foreign_keys.length} verwaiste Verweise` : ""}</span>`;
  };
  $("#vac").onclick = async () => {
    const r = await api("vacuum", {});
    $("#dbOut").innerHTML = `<span class="ok">Aufgeräumt: ${bytes(r.before)} → ${bytes(r.after)}</span>`;
  };
  $("#purge").onsubmit = async (e) => {
    e.preventDefault();
    if (!twice(e.submitter, "Wirklich löschen?")) return;
    const r = await api("purge", { days: +$("#days").value });
    $("#purgeOut").innerHTML = `<span class="ok">${r.deleted} ${r.deleted === 1 ? "Tisch" : "Tische"} gelöscht.</span>`;
  };
}

// -- Tische ---------------------------------------------------------------------
let query = "";
async function tables(code) {
  $("#view").innerHTML = `<div class="split">
    <section class="panel adm-card"><h2 class="label">Tische</h2>
      <input class="field" id="q" placeholder="Code oder Frage suchen" value="${esc(query)}" autocomplete="off">
      <ul class="list" id="list"></ul></section>
    <section class="panel adm-card detail" id="detail"><p class="empty">Links einen Tisch wählen.</p></section></div>`;
  let timer;
  $("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(() => { query = $("#q").value; loadList(code); }, 200); };
  await loadList(code);
  if (code) await detail(code);
}

async function loadList(sel) {
  const { draws } = await api("draws?q=" + encodeURIComponent(query));
  $("#list").innerHTML = draws.length ? draws.map((d) => `<li><button data-code="${d.code}" aria-current="${d.code === sel}">
      <span class="c">${d.code}</span><span class="t">${esc(d.title)}</span><span class="j">${d.grp ? esc(d.grp) : ""}</span>
      <span class="m">${d.entrants} Namen · ${d.phones} Handys · ${d.picks} Ziehungen · ${when(d.active_at)}</span></button></li>`).join("")
    : `<li class="empty">Nichts gefunden.</li>`;
  $("#list").onclick = (e) => { const b = e.target.closest("[data-code]"); if (b) location.hash = "tische/" + b.dataset.code; };
}

async function detail(code) {
  const { draw: d, entrants, picks } = await api("draw/" + code);
  const names = Object.fromEntries(entrants.map((e) => [e.id, e.name]));
  $("#detail").innerHTML = `
    <h2 class="label">Tisch <span class="code">${d.code}</span> · seit ${when(d.created_at)}</h2>
    <form class="titlebar" id="ren"><input class="field" id="title" maxlength="60" value="${esc(d.title)}"><button class="btn">Speichern</button></form>
    <div class="row">
      <span class="seg" id="mode">${Object.entries(MODE).map(([k, v]) => `<button data-mode="${k}" aria-pressed="${k === d.mode}">${v}</button>`).join("")}</span>
      ${d.mode === "slots" ? `<span class="seg" id="rounds">${[1, 3, 5, 7].map((n) => `<button data-rounds="${n}" aria-pressed="${n === d.rounds}">${n === 1 ? "1 Spin" : `${n} Runden`}</button>`).join("")}</span>` : ""}
      <span class="muted">${d.group ? `Gruppe <b>${esc(d.group.name)}</b>` : "ohne Gruppe"}</span>
    </div>
    <div class="row" style="margin-top:14px">
      <a class="btn dark" href="/host/${d.code}#${encodeURIComponent(d.host_key)}" target="_blank" rel="noopener">Bildschirm öffnen</a>
      <button class="btn dark" id="exp">Export JSON</button>
      <button class="btn dark" id="pot">Topf zurück</button>
      <button class="btn dark" id="bank">Bank zurück</button>
    </div>
    <h2 class="label" style="margin-top:20px">Namen <span class="muted">${entrants.length}</span></h2>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Name</th><th></th><th class="n">Chips</th><th class="n">Gesetzt</th><th>Tipp</th><th></th></tr></thead>
      <tbody id="ents">${entrants.map((e) => `<tr data-id="${e.id}">
        <td><input data-f="name" value="${esc(e.name)}" maxlength="24" aria-label="Name"></td>
        <td>${e.phone ? `<span class="tag phone">Handy</span>` : `<span class="tag">Bildschirm</span>`}${e.member ? ` <span class="tag">Gruppe</span>` : ""}</td>
        <td class="n">${e.phone ? `<input class="num" data-f="chips" type="number" min="0" value="${e.chips}" aria-label="Chips">` : "–"}</td>
        <td class="n">${e.staked ? fmt(e.staked) : ""}</td><td>${e.tip_id ? esc(names[e.tip_id] ?? "?") : ""}</td>
        <td><button class="x" data-kick="${e.id}" aria-label="${esc(e.name)} entfernen">×</button></td></tr>`).join("") || `<tr><td colspan="6" class="empty">Noch niemand.</td></tr>`}</tbody></table></div>
    <h2 class="label" style="margin-top:20px">Ziehungen <span class="muted">${picks.length}</span></h2>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Wann</th><th>Art</th><th>Gezogen</th><th class="n">Tipps · Einsätze</th><th class="n">Gesetzt</th><th class="n">Ausgezahlt</th></tr></thead>
      <tbody>${picks.map((p) => `<tr><td>${when(p.ends_at)}</td><td>${MODE[p.mode] ?? p.mode}${p.rounds > 1 ? ` <span class="muted">${p.rounds} R.</span>` : ""}</td>
        <td>${p.locked ? esc(p.winner) : "<i>läuft</i>"} ${p.cleared ? `<span class="tag">zurück im Topf</span>` : ""}</td>
        <td class="n">${p.mode === "slots" ? (p.bets || "") : p.tips ? `${p.tips}${p.hits ? ` <span class="tag hit">${p.hits} richtig</span>` : ""}` : ""}</td>
        <td class="n">${p.staked ? fmt(p.staked) : ""}</td><td class="n">${p.paid ? fmt(p.paid) : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">Noch nicht gezogen.</td></tr>`}</tbody></table></div>
    <div class="danger row"><button class="btn red" id="del">Tisch löschen</button><span class="muted">mit allen Namen und Ziehungen</span></div>`;

  const act = async (action, body = {}, msg = "Gespeichert") => {
    try { await api(`draw/${code}/${action}`, body); toast(msg); } catch (e) { toast(e.message); }
    await detail(code); await loadList(code);
  };
  $("#ren").onsubmit = (e) => { e.preventDefault(); act("rename", { title: $("#title").value }); };
  $("#mode").onclick = (e) => { const b = e.target.closest("[data-mode]"); if (b) act("mode", { mode: b.dataset.mode }, MODE[b.dataset.mode]); };
  $("#rounds")?.addEventListener("click", (e) => { const b = e.target.closest("[data-rounds]"); if (b) act("rounds", { rounds: +b.dataset.rounds }, b.textContent); });
  $("#pot").onclick = (e) => { if (twice(e.target)) act("pot", {}, "Alle zurück im Topf"); };
  $("#bank").onclick = (e) => { if (twice(e.target, "Alle auf 1.000?")) act("bank", {}, "Bank zurückgesetzt"); };
  $("#exp").onclick = async () => {
    const res = await api(`draw/${code}/export`, undefined, true);
    download(await res.blob(), `tisch-${code}-${stamp()}.json`);
  };
  $("#del").onclick = async (e) => {
    if (!twice(e.target, "Endgültig löschen?")) return;
    try { await api(`draw/${code}/delete`, {}); toast(`Tisch ${code} gelöscht`); location.hash = "tische"; }
    catch (err) { toast(err.message); }
  };
  $("#ents").addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-f]"), id = +e.target.closest("tr").dataset.id;
    if (inp.dataset.f === "chips") act("chips", { entrant_id: id, chips: +inp.value }, "Chips gesetzt");
    else act("entrant", { entrant_id: id, name: inp.value }, "Name geändert");
  });
  $("#ents").onclick = (e) => {
    const b = e.target.closest("[data-kick]");
    if (b && twice(b, "?")) act("kick", { entrant_id: +b.dataset.kick }, "Entfernt");
  };
}

// -- SQL --------------------------------------------------------------------------
const EXAMPLES = {
  "Reichste Spieler": "SELECT e.name, e.chips + e.stake AS chips, d.code\nFROM entrants e JOIN draws d ON d.id = e.draw_id\nWHERE e.token IS NOT NULL\nORDER BY chips DESC LIMIT 20",
  "Wer wurde wie oft gezogen": "SELECT winner, COUNT(*) AS mal\nFROM picks WHERE locked = 1\nGROUP BY winner ORDER BY mal DESC",
  "Ziehungen pro Tag": "SELECT date(ends_at / 1000, 'unixepoch', 'localtime') AS tag, COUNT(*) AS ziehungen\nFROM picks GROUP BY tag ORDER BY tag DESC",
  "Tabellen": "SELECT name, sql FROM sqlite_master WHERE type = 'table'",
};
let lastSql = EXAMPLES["Reichste Spieler"];
function sqlView() {
  $("#view").innerHTML = `<section class="panel adm-card sql"><h2 class="label">SQL · nur lesend</h2>
    <textarea class="field" id="sqlIn" spellcheck="false">${esc(lastSql)}</textarea>
    <div class="examples">${Object.keys(EXAMPLES).map((k) => `<button data-ex="${esc(k)}">${esc(k)}</button>`).join("")}</div>
    <div class="row" style="margin-top:12px"><button class="btn" id="run">Ausführen</button><span class="muted">Strg + Enter</span><span class="muted" id="meta"></span></div>
    <div id="res"></div></section>`;
  const run = async () => {
    lastSql = $("#sqlIn").value;
    try {
      const r = await api("sql", { sql: lastSql });
      $("#meta").textContent = `${fmt(r.rows.length)} Zeilen${r.truncated ? " (gekürzt)" : ""} · ${String(r.ms).replace(".", ",")} ms`;
      $("#res").innerHTML = r.columns.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr>${r.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${r.rows.map((row) => `<tr>${row.map((v) => `<td title="${esc(v)}">${v === null ? `<span class="muted">NULL</span>` : esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
        : `<p class="out muted">Keine Spalten.</p>`;
    } catch (e) { $("#meta").textContent = ""; $("#res").innerHTML = `<p class="out bad">${esc(e.message)}</p>`; }
  };
  $("#run").onclick = run;
  $("#sqlIn").onkeydown = (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); } };
  document.querySelector(".examples").onclick = (e) => { const b = e.target.closest("[data-ex]"); if (b) { $("#sqlIn").value = EXAMPLES[b.dataset.ex]; run(); } };
  run();
}

route();
