// Seite: Großer Bildschirm. `qrcode` kommt als globales Skript aus vendor/qrcode.js.
import { STAGES } from "../stages/index.js";
import { sound } from "../audio.js";
import { MODE_NAMES, api, esc, live, pickPhase, serverNow, stagePhase, store, syncClock, toast } from "../core.js";
import { Background, bump, center, countTo, fmt, letters, particles, pop, shake, sleep } from "../fx.js";
import { Lights } from "../lights.js";
import { buildSlots } from "../stages/stage.js";

// =============================================================================
// Seite: Großer Bildschirm
// =============================================================================
export function hostPage() {
  const $ = (id) => document.getElementById(id);
  const code = location.pathname.split("/").pop().toUpperCase();

  if (location.hash.length > 1) {   // Host-Schlüssel kommt einmalig über das URL-Fragment
    store.set("host:" + code, decodeURIComponent(location.hash.slice(1)));
    history.replaceState(null, "", location.pathname);
  }
  const hostKey = store.get("host:" + code);

  let state, stage, stageMode, stageKey, phase = null, seenRunning = null;
  let dismissed = +(store.get("dismissed:" + code) || 0);
  let revealing = false, lastSecond = null, prevBets = null, prevBetPhase = null, entered = false;
  let settledFor = null;   // Ziehung, deren Abrechnung schon gezeigt wurde
  const shownChips = new Map();
  let shownJackpot = null;

  const lights = new Lights([...document.querySelectorAll(".bulbs")]);
  const bg = new Background($("bg"));
  particles.attach($("fx"));
  shake.attach($("app"));

  async function boot() {
    const s = await api(`/api/d/${code}/state`);
    syncClock(s.now);
    // Ergebnis, das schon lange her ist, nicht wieder aufziehen
    if (s.pick && serverNow() - s.pick.ends_at > 10 * 60_000) dismissed = s.pick.id;
    phase = stagePhase(s.pick);
    if (phase && phase !== "done") seenRunning = s.pick.id;
    if (phase === "done" || !phase) settledFor = s.pick?.id ?? null;
    onState(s);
    live(`/api/d/${code}/events`, onState);
    setup();
    enterPhase(phase, true);
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------------
  function onState(s) {
    const old = state;
    state = s;
    $("title").textContent = s.draw.title;
    // Lange Fragen kleiner setzen statt kürzen
    $("title").style.fontSize = `${Math.max(2.6, Math.min(4, 4 * 36 / s.draw.title.length))}rem`;
    $("powerTitle").textContent = s.draw.title;
    $("powerCode").textContent = s.draw.code;
    $("code").textContent = s.draw.code;
    document.title = `${s.draw.title} · Auslosung`;
    renderQr(s.join_url);
    renderEntrants();
    renderControls();
    renderDrawn();
    updateStage();
    betFeed(old, s);
    renderBoard();
    // Konten und Jackpot erst nach der Abrechnungs-Show auf den neuen Stand bringen
    const post = s.pick?.locked && s.now >= s.pick.ends_at;   // Server hat schon ausgezahlt
    if (!revealing && (!post || settledFor === s.pick.id)) { renderRanks(); renderJackpot(); }
  }

  const inPot = () => state.entrants.filter((e) => !state.picked.includes(e.id));
  const showingPick = () => {
    const p = state.pick;
    return p && (pickPhase(p) === "running" || p.id !== dismissed) ? p : null;
  };

  /** Läuft eine Ziehung oder steht ihr Ergebnis noch? Dann deren Belegung zeigen. */
  function currentView() {
    const p = showingPick();
    if (p) {
      return { mode: p.mode, view: { slots: p.layout.slots, names: p.layout.names, layout: p.layout, pick: p.locked ? p : null } };
    }
    const pool = inPot();
    return {
      mode: state.draw.mode,
      view: { slots: buildSlots(pool.map((e) => e.id)), names: Object.fromEntries(pool.map((e) => [e.id, e.name])), pick: null },
    };
  }

  function updateStage() {
    const { mode, view } = currentView();
    if (mode !== stageMode) {
      stage?.destroy();
      const old = $("canvas"), canvas = old.cloneNode();
      old.replaceWith(canvas);
      stage = new STAGES[mode](canvas, mode);
      stage.onTick = (s) => {
        lights.tick();
        if (stagePhase(state.pick) === "spin" && (stage.speed ?? 1) < 0.35) shake.add(0.035 * s);
      };
      stage.onSpeed = (v) => {
        lights.setSpeed(v);
        if (stagePhase(state.pick) === "spin") { bg.setEnergy(0.25 + 0.75 * v); sound.tension(1 - v); }
      };
      stage.onLand = () => { shake.add(0.3); bg.flash(0.3); };
      stageMode = mode;
    }
    const key = JSON.stringify([view.slots, view.pick?.id, view.pick?.locked]);
    if (key !== stageKey || !stage.view) { stage.show(view); stageKey = key; }
    else stage.view.names = view.names;
    $("stageBox").classList.toggle("result-low", mode === "plinko");
  }

  // ---------------------------------------------------------------------------
  // Phasen. Übergänge laufen über die Uhr, nicht über Nachrichten: so stimmen
  // Licht, Ton und Ergebnis auch nach einem Neuladen.
  function loop() {
    requestAnimationFrame(loop);
    if (!state) return;
    const p = state.pick, now = stagePhase(p);
    if (now !== phase || (p && now !== "done" && p.id !== seenRunning)) {
      const from = phase;
      phase = now;
      if (now && now !== "done") seenRunning = p.id;
      enterPhase(now, false, from);
      updateStage();
      renderControls(); renderEntrants(); renderDrawn(); renderBoard();
    }
    if (now === "calls") {
      const left = Math.ceil((p.locks_at - serverNow()) / 1000);
      if (left !== lastSecond) {
        lastSecond = left;
        const n = $("phase").querySelector(".calls-n");
        if (n) { n.textContent = left; bump(n); }
        shake.add(left <= 3 ? 0.2 : 0.08);
      }
    }
    if (now === "lock" && p.locked && serverNow() > p.started_at - 450) stampOut();
    if (now === "done" && p.id !== dismissed && $("result").hidden && !revealing) showResult(p, false);
    renderStatus();
  }

  function enterPhase(ph, initial, from) {
    const p = state.pick;
    const box = $("phase");
    if (ph === "calls") {
      hideResult();
      lastSecond = null;
      box.innerHTML = `<div class="calls"><p class="calls-title big ink">Letzte Einsätze</p>
        <p class="calls-n big ink">${Math.ceil((p.locks_at - serverNow()) / 1000)}</p>
        <p class="calls-sub">Jetzt noch auf dem Handy setzen</p></div>`;
      lights.calls();
      bg.setEnergy(0.5); bg.setGold(0);
      if (!initial) { if (sound.ctx) sound.setScene("calls", { endAt: sound.at(p.locks_at) }); shake.add(0.3); }
    } else if (ph === "lock") {
      hideResult();
      box.innerHTML = `<div class="stamp big">Nichts<br>geht mehr</div>`;
      lights.lock();
      bg.setEnergy(0.2); bg.flash(0.7);
      sound.lounge(false);
      sound.tensionStop();
      if (!initial) { sound.slam(); shake.add(0.75); particles.burst(innerWidth / 2, innerHeight / 2, { n: 30, kind: "spark", speed: 16, up: 0 }); }
    } else if (ph === "spin") {
      stampOut();
      lights.spin();
      sound.lounge(false);
      if (sound.ctx) sound.setScene("spin");
      if (initial) box.innerHTML = "";
    } else {
      box.innerHTML = "";
      sound.tensionStop();
      sound.rollStop();
      if (ph === "done" && !initial && from && p.id !== dismissed && settledFor !== p.id) reveal(p);
      else {
        if (p) settledFor = p.id;
        renderRanks(); renderJackpot();
        if (ph === "done" && p.id !== dismissed) showResult(p, false);
        lights.idle(); bg.setEnergy(0); bg.setGold(0);
        if (entered) sound.lounge(true);
        sound.tensionStop();
      }
    }
  }

  function stampOut() {
    const st = $("phase").querySelector(".stamp");
    if (st && !st.classList.contains("out")) {
      st.classList.add("out");
      setTimeout(() => { if (stagePhase(state.pick) !== "lock") $("phase").innerHTML = ""; }, 520);
    }
  }

  function renderStatus() {
    const p = state.pick, ph = stagePhase(p);
    const pool = ph && ph !== "done" ? p.layout.slots.length : inPot().length;
    const mode = MODE_NAMES[ph && ph !== "done" ? p.mode : state.draw.mode];
    let sub;
    if (ph === "calls") sub = "Letzte Einsätze …";
    else if (ph === "lock") sub = "Nichts geht mehr";
    else if (ph === "spin") sub = "Es wird gezogen …";
    else if (pool < 2) sub = pool ? "Noch ein Name fehlt" : "Der Topf ist noch leer";
    else sub = `${pool} Namen im Topf · Quote ×${pool}`;
    const html = `<span class="tag">${mode}</span><span class="sub">${sub}</span>`;
    if ($("status")._h !== html) { $("status").innerHTML = html; $("status")._h = html; }
    $("status").hidden = !$("result").hidden;
  }

  // ---------------------------------------------------------------------------
  // Ergebnis mit Abrechnung
  const nameOf = (id) => state.entrants.find((e) => e.id === +id)?.name
    ?? state.pick?.layout.names[String(id)] ?? "?";

  function payoutRows(p) {
    const bets = Object.entries(p.payouts?.bets || {}).map(([id, b]) => ({ id: +id, ...b }));
    const hits = bets.filter((b) => b.hit).sort((a, b) => b.win + b.jp - (a.win + a.jp));
    const miss = bets.filter((b) => !b.hit).sort((a, b) => b.stake - a.stake);
    return { bets, hits, miss };
  }

  function hitRow(b, quote) {
    const el = document.createElement("div");
    el.className = "pay";
    el.innerHTML = `<span class="who">${esc(nameOf(b.id))}</span>
      <span class="box stake">${fmt(b.stake)}</span><span class="op">×</span>
      <span class="box quote">${quote}</span>
      ${b.mult > 1 ? `<span class="op">×</span><span class="box mult">${String(b.mult).replace(".", ",")}</span>` : `<span></span><span></span>`}
      <span class="op">=</span><span class="box win">${fmt(b.win + b.jp)}</span>`;
    return el;
  }

  function missRow(miss) {
    const el = document.createElement("div");
    el.className = "pay miss";
    const lost = miss.reduce((s, b) => s + b.stake, 0);
    el.innerHTML = `<span class="who">Daneben: ${miss.slice(0, 5).map((b) => esc(nameOf(b.id))).join(", ")}${miss.length > 5 ? ` und ${miss.length - 5} weitere` : ""}</span>
      <span>−${fmt(lost)}</span>`;
    return el;
  }

  function resultFoot(p) {
    const after = p.payouts?.jackpot_after ?? 0, before = p.payouts?.jackpot ?? 0;
    const { hits, bets } = payoutRows(p);
    if (!bets.length) return "";
    if (hits.length && before) return `Jackpot von <b>${fmt(before)}</b> geknackt`;
    return `Jackpot steht jetzt bei <b>${fmt(after)}</b>`;
  }

  function showResult(p, animate) {
    $("result").hidden = false;
    const nm = $("resultName");
    nm.style.fontSize = `${Math.max(4, Math.min(9, 9 * 9 / Math.max(9, p.winner.length)))}rem`;
    if (animate) letters(nm, p.winner); else nm.textContent = p.winner;
    const box = $("payouts");
    box.innerHTML = "";
    $("resultFoot").innerHTML = "";
    if (animate) return;
    const { hits, miss, bets } = payoutRows(p);
    hits.slice(0, 5).forEach((b) => box.append(hitRow(b, p.payouts.quote)));
    if (!hits.length && bets.length) box.insertAdjacentHTML("beforeend", `<div class="pay bank">Die Bank gewinnt</div>`);
    if (miss.length) box.append(missRow(miss));
    $("resultFoot").innerHTML = resultFoot(p);
  }

  async function reveal(p) {
    revealing = true;
    settledFor = null;
    sound.reveal();
    lights.reveal();
    shake.add(0.85);
    bg.flash(1); bg.setGold(1); bg.setEnergy(0.6);
    const c = center($("stageBox"));
    particles.burst(c.x, c.y, { n: 160, speed: 18, up: 8 });
    particles.burst(c.x, c.y, { n: 30, kind: "chip", speed: 14, up: 10 });
    setTimeout(() => particles.rain(90), 300);
    showResult(p, true);
    await sleep(1300);

    const { hits, miss, bets } = payoutRows(p);
    const box = $("payouts");
    let step = 0;
    for (const b of hits.slice(0, 5)) {
      if (p.id !== state.pick?.id) break;
      const row = hitRow(b, p.payouts.quote);
      const win = row.querySelector(".win");
      win.textContent = fmt(b.stake);
      box.append(row);
      sound.chip(3);
      await sleep(260);
      // Balatro-Prinzip: jede Stufe hebt den Ton
      for (const sel of [".stake", ".quote", ".mult"]) {
        const el = row.querySelector(sel);
        if (!el || !el.textContent) continue;
        bump(el); sound.score(step++); await sleep(170);
      }
      await countTo(win, b.stake, b.win + b.jp, 650, { onStep: (_, u) => { if (u > 0 && u < 1) sound.score(Math.min(10, step + Math.floor(u * 4))); } });
      step += 2;
      bump(win);
      sound.kaching(b.win + b.jp >= 2000);
      shake.add(0.25);
      const at = center(win);
      particles.burst(at.x, at.y, { n: 24, kind: "spark", speed: 9, up: 3 });
      particles.burst(at.x, at.y, { n: 8, kind: "chip", speed: 8, up: 7 });
      const rank = document.querySelector(`.ranks li[data-id="${b.id}"]`);
      pop(`+${fmt(b.win + b.jp)}`, rank || at, { color: "var(--gold-hi)" });
      await sleep(380);
    }
    if (bets.length && !hits.length) {
      box.insertAdjacentHTML("beforeend", `<div class="pay bank big">Die Bank gewinnt</div>`);
      sound.lose(); shake.add(0.2);
      await sleep(700);
    }
    if (miss.length) { box.append(missRow(miss)); sound.press(-5); await sleep(400); }
    $("resultFoot").innerHTML = resultFoot(p);
    revealing = false;
    settledFor = p.id;
    renderJackpot(); renderRanks(); renderBoard();
    await sleep(900);
    bg.setGold(0.25); bg.setEnergy(0);
    lights.idle();
    if (stagePhase(state.pick) === "done") sound.lounge(true);
  }

  function hideResult() { $("result").hidden = true; }

  function dismiss() {
    const p = state.pick;
    if (!p || pickPhase(p) === "running") return;
    dismissed = p.id; store.set("dismissed:" + code, p.id);
    hideResult(); lights.idle(); bg.setGold(0); updateStage(); renderBoard();
  }

  // ---------------------------------------------------------------------------
  // Tisch, Ticker, Bank, Jackpot
  function currentBets() {
    const p = showingPick();
    if (p && p.locked && p.payouts?.bets) {
      return Object.entries(p.payouts.bets).map(([id, b]) => ({ by: +id, on: b.on, stake: b.stake, hit: b.hit }));
    }
    return state.entrants.filter((e) => e.on && e.stake).map((e) => ({ by: e.id, on: e.on, stake: e.stake }));
  }

  function renderBoard() {
    const bets = currentBets();
    const by = new Map();
    for (const b of bets) {
      const t = by.get(b.on) || { on: b.on, total: 0, who: [], hit: b.hit };
      t.total += b.stake; t.who.push(nameOf(b.by)); by.set(b.on, t);
    }
    const rows = [...by.values()].sort((a, b) => b.total - a.total);
    const sum = rows.reduce((s, r) => s + r.total, 0);
    $("tableSum").textContent = sum ? fmt(sum) : "";
    const p = showingPick();
    const quote = p ? p.layout.slots.length : inPot().length;
    const max = rows[0]?.total || 1;
    const done = p && pickPhase(p) === "done";
    const html = rows.length ? rows.slice(0, 7).map((r, i) => `<li data-on="${r.on}" class="${done && r.hit ? "win" : ""}">
        <span class="bar" style="width:${(r.total / max) * 100}%"></span>
        <span class="nm">${esc(nameOf(r.on))}</span><span class="amt">${fmt(r.total)}</span>
        <span class="meta">${i === 0 && rows.length > 1 ? `<span class="fav">Favorit · </span>` : ""}${r.who.length} ${r.who.length === 1 ? "Wette" : "Wetten"} · Quote ×${quote} · ${esc(r.who.slice(0, 3).join(", "))}${r.who.length > 3 ? " …" : ""}</span></li>`).join("")
      : `<li class="empty">${state.entrants.some((e) => e.phone) ? "Noch keine Einsätze. Wer traut sich?" : "Wer mit dem Handy mitmacht, bekommt 1.000 Chips zum Setzen."}</li>`;
    if ($("board")._h !== html) { $("board").innerHTML = html; $("board")._h = html; }
  }

  /** Neue oder geänderte Einsätze: Ticker, Chipgeräusch, schwebende Zahl. */
  function betFeed(old, s) {
    const cur = new Map(s.entrants.filter((e) => e.phone).map((e) => [e.id, [e.on, e.stake]]));
    const ph = stagePhase(s.pick);
    const samePick = old && (old.pick?.id === s.pick?.id) && (old.pick?.locked === s.pick?.locked);
    if (prevBets && samePick && prevBetPhase === ph && (ph === null || ph === "done" || ph === "calls")) {
      for (const [id, [on, stake]] of cur) {
        const before = prevBets.get(id);
        if (!before || (before[0] === on && before[1] === stake)) continue;
        const who = s.entrants.find((e) => e.id === id)?.name ?? "?";
        let line;
        if (stake && on) {
          const delta = stake - (before[0] === on ? before[1] : 0);
          line = `<b>${esc(who)}</b> setzt <span class="n">${fmt(stake)}</span> auf <b>${esc(nameOf(on))}</b>`;
          sound.chip(Math.min(5, 1 + Math.floor(stake / 200)), { pan: 0.6 });
          requestAnimationFrame(() => {
            const row = document.querySelector(`.board li[data-on="${on}"]`);
            if (row) { bump(row); pop(delta >= 0 ? `+${fmt(delta)}` : `−${fmt(-delta)}`, row, { size: "2rem", color: delta >= 0 ? "var(--gold-hi)" : "var(--mute)" }); }
          });
        } else if (before[1]) {
          line = `<b>${esc(who)}</b> nimmt den Einsatz zurück`;
          sound.chip(1, { pan: 0.6 });
        }
        if (line) {
          $("feed").insertAdjacentHTML("afterbegin", `<li>${line}</li>`);
          while ($("feed").children.length > 3) $("feed").lastElementChild.remove();
        }
      }
    }
    prevBets = cur;
    prevBetPhase = ph;
  }

  function renderRanks() {
    const players = state.entrants.filter((e) => e.phone)
      .map((e) => ({ ...e, total: e.chips + (e.stake || 0) }))
      .sort((a, b) => b.total - a.total || a.id - b.id);
    const list = $("ranks");
    if (!players.length) { list.innerHTML = `<li class="empty">Noch niemand mit Handy dabei.</li>`; shownChips.clear(); return; }
    const top = players.slice(0, 6);
    const sig = top.map((e) => `${e.id}:${e.streak}:${e.name}`).join("|");
    if (list._sig !== sig) {
      list.innerHTML = top.map((e, i) => `<li data-id="${e.id}"><span class="r">${i + 1}</span>
        <span class="nm">${esc(e.name)}${e.streak ? `<span class="st">×${String(1 + 0.5 * Math.min(e.streak, 4)).replace(".", ",")}</span>` : ""}</span>
        <span class="c">${fmt(shownChips.get(e.id) ?? e.total)}</span></li>`).join("");
      list._sig = sig;
    }
    for (const e of top) {
      const li = list.querySelector(`li[data-id="${e.id}"]`), el = li?.querySelector(".c");
      const was = shownChips.get(e.id);
      if (el && was !== undefined && was !== e.total) {
        li.classList.toggle("up", e.total > was);
        countTo(el, was, e.total, 900).then(() => setTimeout(() => li.classList.remove("up"), 1500));
      } else if (el && was === undefined) el.textContent = fmt(e.total);
    }
    players.forEach((e) => shownChips.set(e.id, e.total));
  }

  function renderJackpot() {
    const v = state.draw.jackpot || 0, el = $("jackpot");
    if (shownJackpot === null) { el.textContent = fmt(v); shownJackpot = v; return; }
    if (v === shownJackpot) return;
    const up = v > shownJackpot;
    countTo(el, shownJackpot, v, 1200, { onStep: (_, u) => { if (u > 0 && u < 1 && up) sound.score(Math.floor(u * 6)); } })
      .then(() => { bump(el.parentElement); if (up) particles.burst(center(el).x, center(el).y, { n: 30, kind: "spark", speed: 8 }); });
    shownJackpot = v;
  }

  // ---------------------------------------------------------------------------
  function renderEntrants() {
    const list = $("entrants");
    const running = pickPhase(state.pick) === "running";
    // Während der Ziehung zählt der eingefrorene Topf, sonst verrät die Zahl, dass schon gezogen ist
    $("potCount").textContent = state.entrants.length ? (running ? state.pick.layout.slots.length : inPot().length) : "";
    if (!state.entrants.length) {
      const html = `<li class="empty">Noch niemand drin. Code scannen oder Namen unten eintragen.</li>`;
      if (list._h !== html) { list.innerHTML = html; list._h = html; }
      return;
    }
    const html = state.entrants.map((e) => {
      // Während der Ziehung bleibt der Gewinner unverraten
      const out = state.picked.includes(e.id) && !(running && e.id === state.pick.winner_id);
      return `<li class="${out ? "out" : ""}" data-id="${e.id}">${e.phone ? `<i class="phone" title="mit Handy"></i>` : ""}<span class="nm">${esc(e.name)}</span>
        ${hostKey && !running ? `<button class="x" data-id="${e.id}" aria-label="${esc(e.name)} entfernen">×</button>` : ""}</li>`;
    }).join("");
    if (list._h !== html) {
      const had = new Set([...list.querySelectorAll("li[data-id]")].map((li) => li.dataset.id));
      list.innerHTML = html; list._h = html;
      // Nur neue Namen springen herein, und es klackt ein Chip
      list.querySelectorAll("li[data-id]").forEach((li) => {
        if (had.size && had.has(li.dataset.id)) li.style.animation = "none";
        else if (had.size) { sound.chip(2, { pan: -0.6 }); }
      });
    }
  }

  function renderDrawn() {
    const running = pickPhase(state.pick) === "running";
    const ws = state.winners.filter((w) => !(running && w.id === state.pick.id));
    $("drawn").innerHTML = ws.length ? `Gezogen: ${ws.map((w) => `<b>${esc(w.winner)}</b>`).join(", ")}` : "";
    $("resetBtn").hidden = !hostKey || !ws.length;
    $("bankBtn").hidden = !hostKey || !state.entrants.some((e) => e.phone);
  }

  function renderControls() {
    if (!hostKey) return;
    const running = pickPhase(state.pick) === "running";
    for (const b of $("modes").children) {
      b.setAttribute("aria-checked", b.dataset.mode === state.draw.mode);
      b.disabled = running;
    }
    $("drawBtn").disabled = running || inPot().length < 2;
    $("drawBtn").textContent = running ? "Läuft" : "Ziehen";
    $("resetBtn").disabled = running;
    $("bankBtn").disabled = running;
  }

  function renderQr(url) {
    const el = $("qr");
    if (el.dataset.url === url) return;
    el.dataset.url = url;
    $("joinUrl").textContent = url.replace(/^https?:\/\//, "");
    const qr = qrcode(0, "M"); qr.addData(url); qr.make();
    const n = qr.getModuleCount(), q = 1;
    let d = "";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + q} ${y + q}h1v1h-1z`;
    el.innerHTML = `<svg viewBox="0 0 ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR-Code: ${esc(url)}"><path d="${d}" fill="#120a19"/></svg>`;
  }

  // ---------------------------------------------------------------------------
  async function host(action, body = {}) {
    try { return await api(`/api/d/${code}/${action}`, { ...body, host_key: hostKey }); }
    catch (e) { toast(e.message); sound.press(-12); return null; }
  }

  function draw() {
    if (pickPhase(state.pick) === "running" || $("drawBtn").disabled) return;
    enter();
    dismiss();
    sound.press(-3); shake.add(0.2);
    host("pick");
  }

  function enter() {
    if (entered) return;
    entered = true;
    sound.unlock();
    sound.powerOn();
    setTimeout(() => { if (!pickPhase(state?.pick) || pickPhase(state.pick) === "done") sound.lounge(true); }, 1400);
    $("power").classList.add("off");
    $("app").classList.add("boot");
    setTimeout(() => $("app").classList.remove("boot"), 900);
    bg.flash(0.8);
  }

  function setup() {
    $("power").onclick = enter;
    $("resultClose").onclick = () => { sound.press(); dismiss(); };
    $("soundBtn").onclick = () => {
      sound.unlock(); sound.setEnabled(!sound.enabled);
      $("soundBtn").setAttribute("aria-pressed", sound.enabled);
      store.set("sound", sound.enabled ? "1" : "0");
    };
    $("musicBtn").onclick = () => {
      sound.unlock(); sound.setMusic(!sound.musicOn);
      $("musicBtn").setAttribute("aria-pressed", sound.musicOn);
      store.set("music", sound.musicOn ? "1" : "0");
    };
    if (store.get("sound") === "0") { sound.setEnabled(false); $("soundBtn").setAttribute("aria-pressed", false); }
    if (store.get("music") === "0") { sound.setMusic(false); $("musicBtn").setAttribute("aria-pressed", false); }
    $("fsBtn").onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();

    // Jeder Knopf klingt und federt
    document.addEventListener("pointerover", (e) => {
      const b = e.target.closest(".btn:not([disabled]), .tool, .modes button:not([disabled])");
      if (b && b !== document._hov) { document._hov = b; sound.hover(); }
      if (!b) document._hov = null;
    });
    document.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tool, .modes button:not([disabled]), .add .btn")) sound.press(2);
    });

    addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea")) return;
      if (!entered) { enter(); return; }
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (hostKey) draw(); }
      else if (e.key === "Escape") dismiss();
      else if ("123".includes(e.key) && hostKey) $("modes").children[+e.key - 1]?.click();
      else if (e.key === "f" || e.key === "F") $("fsBtn").click();
      else if (e.key === "m" || e.key === "M") $("soundBtn").click();
      else if (e.key === "n" || e.key === "N") $("musicBtn").click();
    });
    if (!hostKey) { $("viewerNote").hidden = false; return; }

    $("controls").hidden = false;
    $("addForm").hidden = false;
    $("modes").onclick = (e) => {
      const b = e.target.closest("[data-mode]");
      if (b && !b.disabled && b.dataset.mode !== state.draw.mode) { dismiss(); host("mode", { mode: b.dataset.mode }); }
    };
    $("drawBtn").onclick = draw;
    $("resetBtn").onclick = () => { dismiss(); host("reset"); };
    $("bankBtn").onclick = () => {
      if (!$("bankBtn").dataset.armed) {   // zweimal klicken, damit es kein Versehen ist
        $("bankBtn").dataset.armed = "1"; $("bankBtn").textContent = "Sicher? Alle auf 1.000";
        setTimeout(() => { delete $("bankBtn").dataset.armed; $("bankBtn").textContent = "Bank zurücksetzen"; }, 3000);
        return;
      }
      delete $("bankBtn").dataset.armed; $("bankBtn").textContent = "Bank zurücksetzen";
      host("bank");
    };
    $("entrants").onclick = (e) => {
      const x = e.target.closest(".x");
      if (x) host("remove", { entrant_id: +x.dataset.id });
    };
    $("addForm").onsubmit = async (e) => {
      e.preventDefault();
      const name = $("addName").value.trim();
      if (!name) return;
      if (await host("add", { name })) $("addName").value = "";
    };
  }

  boot().catch((e) => toast(e.message, 10000));
}
