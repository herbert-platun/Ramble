// Seite: Großer Bildschirm. `qrcode` kommt als globales Skript aus vendor/qrcode.js.
import { STAGES } from "../stages/index.js";
import { sound } from "../audio.js";
import { slotSfx } from "../slot-sfx.js";
import { MODE_NAMES, api, badgeHtml, esc, live, phaseKey, pickPhase, segment, serverNow, stagePhase, store, syncClock, toast } from "../core.js";
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

  let state, stage, stageMode, stageKey, phase = null, phaseId = null;
  let dismissed = +(store.get("dismissed:" + code) || 0);
  let revealing = false, lastSecond = null, prevBets = null, prevBetPhase = null, entered = false;
  let settledFor = null;   // Ziehung, deren Abrechnung schon gezeigt wurde
  let standVersion = -1;
  const shownChips = new Map();

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
    phaseId = phaseKey(s.pick);
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
    $("potGroup").textContent = s.draw.group?.name ?? "";
    document.title = `${s.draw.title} · Auslosung`;
    renderQr(s.join_url);
    renderEntrants();
    renderControls();
    renderDrawn();
    updateStage();
    betFeed(old, s);
    renderBoard();
    renderSide();
    renderBreak();
    // Konten erst nach der Abrechnungs-Show auf den neuen Stand bringen
    const post = s.pick?.locked && s.now >= s.pick.ends_at;   // Server hat schon ausgezahlt
    if (!revealing && (!post || settledFor === s.pick.id)) renderRanks();
  }

  const isSlots = () => (showingPick()?.mode ?? state.draw.mode) === "slots";
  const inPot = () => state.entrants.filter((e) => !state.picked.includes(e.id));
  const skinsNow = () => Object.fromEntries(state.entrants.map((e) => [e.id, e.skin]));
  const showingPick = () => {
    const p = state.pick;
    return p && (pickPhase(p) === "running" || p.id !== dismissed) ? p : null;
  };

  /** Läuft eine Ziehung oder steht ihr Ergebnis noch? Dann deren Belegung zeigen. */
  function currentView() {
    const p = showingPick();
    if (p) {
      // Slots brauchen die Runden schon vor dem Ende der Session, die anderen erst nach dem Ziehen
      const visible = p.mode === "slots" || p.locked;
      return { mode: p.mode, view: { slots: p.layout.slots, names: p.layout.names, layout: p.layout,
        skins: p.layout.skins || skinsNow(), pick: visible ? p : null } };
    }
    const pool = inPot();
    return {
      mode: state.draw.mode,
      view: { slots: buildSlots(pool.map((e) => e.id)), names: Object.fromEntries(pool.map((e) => [e.id, e.name])), skins: skinsNow(), pick: null },
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
      if (mode === "slots") stage.onEvent = slotEvent;
      stageMode = mode;
    }
    const p = view.pick;
    const key = JSON.stringify([view.slots, p?.id, p?.locked, p?.rounds?.map((r) => r.locked)]);
    if (key !== stageKey || !stage.view) { stage.show(view); stageKey = key; }
    else { stage.view.names = view.names; if (mode === "slots") stage.skins = view.skins; }
    $("stageBox").classList.toggle("result-low", mode === "plinko");
  }

  /** Effekte rund um den Automaten: Licht, Wackeln, Hintergrund, Funken. */
  // Live-Auszahlung je Symbol im laufenden Spin: Einsätze × Punkte × Quote, dann × Faktor
  let livePay = null;
  function payEvent(type, e) {
    if (type === "spin") livePay = { base: new Map(), x: 1, slam: false };
    if (!livePay) return;
    livePay.slam = false;
    if (type === "pattern") {
      let st = 0;
      for (const x of Object.values(e.round?.payouts || {})) st += x.stakes?.[String(e.p.id)] || 0;
      if (st) livePay.base.set(e.p.id, (livePay.base.get(e.p.id) || 0) + st * e.p.v * (state.pick?.layout?.q || 1));
    } else if (type === "mult" && livePay.base.size) {
      livePay.x = Math.min(e.spin.x, e.spin.mult.slice(0, e.k + 1).reduce((m, [, , v]) => m * v, 1));
      livePay.slam = true;
    } else if (type === "again") livePay = { base: new Map(), x: 1, slam: false };
    renderBoard();
  }

  function slotEvent(type, e) {
    if (["spin", "pattern", "mult", "again"].includes(type)) payEvent(type, e);
    if (type === "spin") { lights.spin(); bg.setEnergy(0.7); bg.setGold(0); if (e.spin.luck.length) bg.flash(0.4); }
    else if (type === "stop") { shake.add(0.06); lights.tick(); bg.setEnergy(Math.max(0.2, 0.7 - e.c * 0.1)); }
    else if (type === "morph") { bg.flash(0.25); lights.tick(); }
    else if (type === "pattern") {
      shake.add(Math.min(0.5, 0.08 + e.p.v * 0.03)); lights.tick(); bg.flash(Math.min(0.5, 0.1 + e.p.v * 0.03));
      const c = center($("stageBox"));
      particles.burst(c.x, c.y, { n: 6 + e.p.v * 2, kind: "spark", speed: 7 + e.p.v * 0.5, up: 2 });
    } else if (type === "mult") { shake.add(0.35); bg.flash(0.6); lights.reveal(); }
    else if (type === "bust") { shake.add(0.8); bg.flash(0.2); lights.lock(); }
    else if (type === "tally") {
      const tier = e.spin.tier;
      shake.add([0, 0.15, 0.35, 0.6, 1][tier]);
      if (tier >= 2) bg.setGold(tier / 4);
      if (tier >= 3) {
        const c = center($("stageBox"));
        particles.burst(c.x, c.y, { n: tier === 4 ? 160 : 70, speed: 16, up: 8 });
        particles.burst(c.x, c.y, { n: tier === 4 ? 30 : 12, kind: "chip", speed: 12, up: 9 });
        if (tier === 4) setTimeout(() => particles.rain(80), 250);
        lights.reveal();
      }
      renderSide();
    } else if (type === "again") { shake.add(0.3); lights.calls(); }
    else if (type === "summary") { bg.setGold(0.15); bg.setEnergy(0.2); lights.idle(); renderSide(); }
  }

  // ---------------------------------------------------------------------------
  // Phasen. Übergänge laufen über die Uhr, nicht über Nachrichten: so stimmen
  // Licht, Ton und Ergebnis auch nach einem Neuladen. Bei Slots je Runde.
  function loop() {
    requestAnimationFrame(loop);
    if (!state) return;
    const p = state.pick, now = stagePhase(p), id = phaseKey(p);
    if (id !== phaseId) {
      const from = phase;
      phase = now; phaseId = id;
      enterPhase(now, false, from);
      updateStage();
      renderControls(); renderEntrants(); renderDrawn(); renderBoard(); renderSide();
    }
    const seg = segment(p);
    if (now === "calls") {
      const left = Math.ceil((seg.locks_at - serverNow()) / 1000);
      if (left !== lastSecond) {
        lastSecond = left;
        const n = $("phase").querySelector(".calls-n");
        if (n) { n.textContent = left; bump(n); }
        const ring = $("phase").querySelector(".break-ring");
        if (ring) ring.style.setProperty("--p", Math.max(0, (seg.locks_at - serverNow()) / Math.max(1, seg.locks_at - seg.calls_at)).toFixed(3));
        shake.add(left <= 3 ? 0.2 : 0.08);
      }
    }
    if (now === "lock" && seg?.locked && serverNow() > seg.started_at - 450) stampOut();
    if (now === "done" && p.id !== dismissed && $("result").hidden && !revealing) showResult(p, false);
    if (stage?.version !== undefined && stage.version !== standVersion) renderSide();
    renderStatus();
  }

  function enterPhase(ph, initial, from) {
    const p = state.pick;
    const box = $("phase");
    const seg = segment(p);
    if (ph === "calls") {
      hideResult();
      lastSecond = null;
      if (p.mode === "slots") {
        stage?.clearOverlay?.(); stage?.renderMarquee?.();
        box.innerHTML = breakHtml(p, seg);
        renderBreak();
        lights.calls();
        bg.setEnergy(0.3); bg.setGold(0);
        // Musik läuft weiter: Groove der Einsatzpause statt Countdown-Alarm
        if (sound.ctx) { slotSfx.betting(sound.at(seg.locks_at)); if (sound.scene?.name !== "lobby") sound.setScene(null); }
      } else {
        box.innerHTML = `<div class="calls"><p class="calls-title big ink">Letzte Einsätze</p>
          <p class="calls-n big ink">${Math.ceil((seg.locks_at - serverNow()) / 1000)}</p>
          <p class="calls-sub">Jetzt noch auf dem Handy tippen</p></div>`;
        lights.calls();
        bg.setEnergy(0.5); bg.setGold(0);
        if (!initial) { if (sound.ctx) sound.setScene("calls", { endAt: sound.at(seg.locks_at) }); shake.add(0.3); }
      }
    } else if (ph === "lock") {
      hideResult();
      if (p.mode === "slots") { stage?.clearOverlay?.(); stage?.renderMarquee?.(); }
      // Bei Slots mit mehreren Runden: klar machen, dass nach dem Lauf wieder gewettet wird
      const n = seg?.n ?? 1, more = p.mode === "slots" && p.layout.rounds > 1 && n < p.layout.rounds;
      const kick = p.mode === "slots" && p.layout.rounds > 1 ? `<span class="kick">Runde ${n} von ${p.layout.rounds}</span>` : "";
      box.innerHTML = `<div class="stamp big${p.mode === "slots" ? " soft" : ""}">${kick}Keine<br>Wetten mehr${more ? `<span class="next">Nach dieser Runde wieder offen</span>` : ""}</div>`;
      lights.lock();
      bg.setEnergy(0.2); bg.flash(0.7);
      if (p.mode === "slots" && !initial && sound.ctx && sound.scene?.name === "lobby") slotSfx.betting();   // ohne Handys: Lobby gleitet direkt in die Slots-Musik
      sound.lounge(false);
      sound.tensionStop();
      if (!initial) {
        if (p.mode === "slots") slotSfx.lock(); else sound.slam();
        shake.add(0.35);
        particles.burst(innerWidth / 2, innerHeight / 2, { n: 24, kind: "spark", speed: 10, up: 0 });
      }
    } else if (ph === "spin") {
      stampOut();
      lights.spin();
      sound.lounge(false);
      // Slots haben eigene Klänge pro Ereignis; die Spin-Musik liefe darüber
      if (sound.ctx && !sound.scene?.fading) sound.setScene(p.mode === "slots" ? null : "spin");
      if (initial) box.innerHTML = "";
    } else {
      box.innerHTML = "";
      sound.tensionStop();
      sound.rollStop();
      if (!(ph === "done" && !initial && from && p?.mode === "slots")) slotSfx.end();
      if (ph === "done" && !initial && from && p.id !== dismissed && settledFor !== p.id) reveal(p);
      else {
        if (p) settledFor = p.id;
        renderRanks();
        if (ph === "done" && p.id !== dismissed) showResult(p, false);
        lights.idle(); bg.setEnergy(0); bg.setGold(0);
        if (entered) sound.lounge(true);
        sound.tensionStop();
      }
    }
  }

  // -- Pause zwischen den Slot-Runden ------------------------------------------------
  // Klar in drei Spalten: was war, wie es steht, was jetzt zu tun ist. Dazu ein
  // Ring, der die Einsatzzeit abläuft, und live, wer schon gesetzt hat.
  function roundsDone(p, n) { return p.rounds.filter((r) => r.n < n && r.locked && r.result); }

  function breakHtml(p, seg) {
    const n = seg.n, of = p.layout.rounds, names = p.layout.names, skins = p.layout.skins || {};
    const prev = roundsDone(p, n), last = prev[prev.length - 1];
    const badge = (id) => { const sk = skins[id]; return `<span class="badge acc-${sk?.[1] ?? 5}"><svg class="sym"><use href="#sym-${sk?.[0] ?? "chip"}"/></svg></span>`; };
    const totals = {};
    for (const r of prev) for (const [id, v] of Object.entries(r.result.pts || {})) totals[id] = (totals[id] || 0) + v;
    const stand = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = stand[0]?.[1] || 1;
    let recap;
    if (last) {
      const pts = Object.entries(last.result.pts || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      recap = `<h3>Runde ${last.n}</h3>${pts.length
        ? `<ol>${pts.map(([id, v]) => `<li>${badge(id)}<span class="nm">${esc(names[id] ?? "?")}</span><span class="plus">+${fmt(v)}</span></li>`).join("")}</ol>`
        : `<p class="none">Kein Muster gefallen</p>`}`;
    } else {
      recap = `<h3>So gewinnt man</h3><p class="none">Jedes Muster deines Symbols zahlt Chips aus.<br>Faktoren vervielfachen den Spin.</p>`;
    }
    const standing = stand.length
      ? `<ol class="bars">${stand.map(([id, v]) => `<li style="--w:${(v / max).toFixed(3)}">${badge(id)}<span class="nm">${esc(names[id] ?? "?")}</span><span class="pts">${fmt(v)}</span></li>`).join("")}</ol>`
      : `<p class="none">Alle starten bei 0 Punkten.<br>Wer nach ${of === 1 ? "dem Spin" : `${of} Runden`} vorne liegt, wird gezogen.</p>`;
    const steps = Array.from({ length: of }, (_, i) => `<i class="${i + 1 < n ? "done" : i + 1 === n ? "now" : ""}"></i>`).join("");
    return `<div class="break">
      <header><p class="kick">${of > 1 ? `Runde ${n} von ${of}` : "Ein Spin"}</p><h2 class="big ink">Einsätze offen</h2><div class="steps">${of > 1 ? steps : ""}</div></header>
      <div class="break-ring" style="--p:1"><b class="calls-n big ink">${Math.max(0, Math.ceil((seg.locks_at - serverNow()) / 1000))}</b><small>Sekunden</small></div>
      <div class="break-cols">
        <section class="recap">${recap}</section>
        <section class="stand"><h3>${prev.length ? "Zwischenstand" : "Punkte"}</h3>${standing}</section>
        <section class="how"><h3>Am Handy</h3>
          <ol class="howto"><li><span><b>Symbol</b> antippen</span></li><li><span><b>Chips</b> drauflegen</span></li><li><span>Bis zum Ring-Ende ändern</span></li></ol>
          <p class="bets" id="breakBets"></p></section>
      </div></div>`;
  }

  /** Live: wer in dieser Pause schon gesetzt hat. */
  function renderBreak() {
    const el = document.getElementById("breakBets");
    if (!el || !state) return;
    const who = state.entrants.filter((e) => Object.keys(e.wagers || {}).length);
    const chips = who.reduce((s, e) => s + Object.values(e.wagers).reduce((a, b) => a + b, 0), 0);
    const phones = state.entrants.filter((e) => e.phone).length;
    const html = who.length
      ? `<b>${who.length}</b> von ${phones} gesetzt · <b>${fmt(chips)}</b> Chips im Spiel`
      : `Noch keine Einsätze${phones ? ` · ${phones} ${phones === 1 ? "Handy" : "Handys"} dabei` : ""}`;
    if (el._h !== html) { el.innerHTML = html; el._h = html; bump(el); }
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
    const running = ph && ph !== "done";
    const pool = running ? p.layout.slots.length : inPot().length;
    const mode = running ? p.mode : state.draw.mode;
    let sub;
    if (ph === "calls") sub = mode === "slots" ? "Einsätze für diese Runde …" : "Letzte Tipps …";
    else if (ph === "lock") sub = "Keine Wetten mehr";
    else if (ph === "spin") sub = mode === "slots" ? "Die Walzen laufen …" : "Es wird gezogen …";
    else if (pool < 2) sub = pool ? "Noch ein Name fehlt" : "Der Topf ist noch leer";
    else if (mode === "slots") sub = `${pool} Namen · ${state.draw.rounds === 1 ? "ein Spin" : `${state.draw.rounds} Runden`}`;
    else sub = `${pool} Namen im Topf · richtiger Tipp +${state.rules.tip}`;
    // Bei Slots steht die Art schon auf der Laufschrift des Automaten
    const html = `${mode === "slots" ? "" : `<span class="tag">${MODE_NAMES[mode]}</span>`}<span class="sub">${sub}</span>`;
    if ($("status")._h !== html) { $("status").innerHTML = html; $("status")._h = html; }
    $("status").hidden = !$("result").hidden;
  }

  // ---------------------------------------------------------------------------
  // Ergebnis mit Abrechnung
  const entrant = (id) => state.entrants.find((e) => e.id === +id);
  const nameOf = (id) => entrant(id)?.name ?? state.pick?.layout.names[String(id)] ?? "?";
  const skinOf = (id) => state.pick?.layout.skins?.[String(id)] ?? entrant(id)?.skin;
  const list = (names, max = 6) => names.slice(0, max).map(esc).join(", ") + (names.length > max ? ` und ${names.length - max} weitere` : "");

  /** Zeilen fürs Ergebnis: [{el, value, kind}] in Show-Reihenfolge. */
  function resultRows(p) {
    const rows = [];
    const add = (html, cls, value = 0, kind = "") => {
      const el = document.createElement("div");
      el.className = cls; el.innerHTML = html;
      rows.push({ el, value, kind });
    };
    if (p.mode === "slots") {
      const totals = Object.entries(p.payouts?.totals || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      add(`Punkte über ${p.layout.rounds === 1 ? "den Spin" : `${p.layout.rounds} Runden`}`, "pay-head");
      totals.slice(0, 3).forEach(([id, v]) => add(`${badgeHtml(skinOf(id))}<span class="who">${esc(nameOf(id))}</span><span class="box pts">${fmt(v)}</span>`, "pay line", v, "pts"));
      const net = Object.entries(p.payouts?.net || {}).sort((a, b) => b[1] - a[1]);
      if (net.length) {
        add("Chips aus der Session", "pay-head");
        net.slice(0, 4).forEach(([id, v]) => add(`<span></span><span class="who">${esc(nameOf(id))}</span><span class="box ${v > 0 ? "win" : "lost"}">${v > 0 ? "+" : v < 0 ? "−" : "±"}${fmt(Math.abs(v))}</span>`,
          "pay line", v, v > 0 ? "win" : "lost"));
      }
      return rows;
    }
    const tips = Object.entries(p.tips || {});
    const hits = (p.payouts?.hits || []).map(nameOf);
    if (hits.length) add(`<span class="who">Richtig getippt: ${list(hits)}</span><span class="box win">+${fmt(p.payouts.bonus)}</span>`, "pay miss", p.payouts.bonus, "win");
    else if (tips.length) add(`<span class="who">${tips.length === 1 ? "Der Tipp lag" : `Alle ${tips.length} Tipps lagen`} daneben</span><span></span>`, "pay miss", 0, "lost");
    return rows;
  }

  function resultFoot(p) {
    if (p.mode === "slots") {
      const t = p.payouts?.totals?.[String(p.winner_id)] ?? 0;
      return `Meiste Punkte: <b>${fmt(t)}</b>`;
    }
    const n = Object.keys(p.tips || {}).length;
    return n ? `${n} ${n === 1 ? "Tipp" : "Tipps"} abgegeben` : "";
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
    resultRows(p).forEach((r) => box.append(r.el));
    $("resultFoot").innerHTML = resultFoot(p);
  }

  async function reveal(p) {
    revealing = true;
    settledFor = null;
    const soft = p.mode === "slots";
    if (soft) slotSfx.finale(); else sound.reveal();
    lights.reveal();
    shake.add(0.85);
    bg.flash(1); bg.setGold(1); bg.setEnergy(0.6);
    const c = center($("stageBox"));
    particles.burst(c.x, c.y, { n: 160, speed: 18, up: 8 });
    particles.burst(c.x, c.y, { n: 30, kind: "chip", speed: 14, up: 10 });
    setTimeout(() => particles.rain(90), 300);
    showResult(p, true);
    await sleep(1300);

    const box = $("payouts");
    let step = 0;
    for (const r of resultRows(p)) {
      if (p.id !== state.pick?.id) break;
      box.append(r.el);
      if (r.kind === "win") {
        const win = r.el.querySelector(".win");
        await countTo(win, 0, r.value, 520, { format: (v) => "+" + fmt(v), onStep: (_, u) => { if (u > 0 && u < 1) { const k = Math.min(10, step + Math.floor(u * 4)); if (soft) slotSfx.tick(k); else sound.score(k); } } });
        bump(win); if (soft) slotSfx.win(r.value >= 500); else sound.kaching(r.value >= 500); shake.add(0.2);
        const at = center(win);
        particles.burst(at.x, at.y, { n: 18, kind: "spark", speed: 9, up: 3 });
        pop(`+${fmt(r.value)}`, at, { color: "var(--gold-hi)" });
        step += 2;
        await sleep(300);
      } else if (r.kind === "pts") {
        bump(r.el.querySelector(".pts")); if (soft) slotSfx.tick(step++); else sound.score(step++); await sleep(260);
      } else if (r.kind === "lost") {
        if (!soft) sound.press(-5); await sleep(240);
      } else await sleep(160);
    }
    $("resultFoot").innerHTML = resultFoot(p);
    revealing = false;
    settledFor = p.id;
    renderRanks(); renderBoard(); renderSide();
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
    hideResult(); lights.idle(); bg.setGold(0); updateStage(); renderBoard(); renderSide();
  }

  // ---------------------------------------------------------------------------
  // Rechts oben: Tipp-Bonus oder Session-Stand
  function renderSide() {
    const el = $("side");
    let html;
    const p = showingPick();
    if (isSlots()) {
      const live = p?.mode === "slots" && stage?.standings;
      const pts = live ? Object.entries(stage.standings()).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]) : [];
      standVersion = stage?.version ?? -1;
      if (live) {
        const r = segment(p);
        html = `<p class="label">${p.layout.rounds > 1 ? `Runde ${r?.n ?? 1} von ${p.layout.rounds}` : "Ein Spin"}</p>
          ${pts.length ? `<ol class="standings">${pts.slice(0, 5).map(([id, v]) => `<li data-id="${id}">${badgeHtml(skinOf(id))}<span class="nm">${esc(nameOf(id))}</span><span class="pts">${fmt(v)}</span></li>`).join("")}</ol>`
            : `<p class="jp-note" style="margin-top:.6rem">Noch keine Punkte. Wer zuerst ein Muster trifft, führt.</p>`}`;
      } else {
        const pay = state.rules.pay;
        const rows = [["row3", "Dreier"], ["col", "Säule · Schräge"], ["row4", "Vierer"], ["vee", "Tal · Gipfel"], ["row5", "Fünfer"], ["ring", "Auge"], ["full", "Volles Haus"]];
        const v = Object.fromEntries((pay?.rows || []).map(([k, , pts]) => [k, pts]));
        html = `<p class="label">Muster</p>
          <dl class="paytable">${rows.map(([k, label]) => `<dt>${label}</dt><dd>${v[k] ?? ""}</dd>`).join("")}</dl>
          <p class="specials"><span>${badgeHtml(["star", 1])}Joker</span><span>${badgeHtml(["mult", 4])}Faktor</span><span>${badgeHtml(["snakeeyes", 0])}3× Pleite</span></p>`;
      }
    } else {
      const tips = state.entrants.filter((e) => e.on).length;
      html = `<p class="label">Tipp-Bonus</p><p class="jp big">+${fmt(state.rules.tip)}</p>
        <p class="jp-note">${tips ? `${tips} ${tips === 1 ? "Tipp" : "Tipps"} abgegeben` : "Wer auf dem Handy richtig tippt, bekommt Chips. Kostet nichts."}</p>`;
    }
    if (el._h !== html) { el.innerHTML = html; el._h = html; }
  }

  // ---------------------------------------------------------------------------
  // Tisch, Ticker, Bank
  const staked = (e) => Object.values(e.wagers || {}).reduce((a, b) => a + b, 0);

  function currentBets() {
    const p = showingPick();
    if (p && p.mode !== "slots" && p.locked && pickPhase(p) === "done") {
      const hits = new Set(p.payouts?.hits || []);
      return Object.entries(p.tips || {}).map(([by, on]) => ({ by: +by, on, stake: 0, hit: hits.has(+by) }));
    }
    const out = [];
    for (const e of state.entrants) {
      if (e.on) out.push({ by: e.id, on: e.on, stake: 0 });
      for (const [on, st] of Object.entries(e.wagers || {})) out.push({ by: e.id, on: +on, stake: st });
    }
    return out;
  }

  function renderBoard() {
    const bets = currentBets();
    const slots = isSlots();
    const by = new Map();
    for (const b of bets) {
      const t = by.get(b.on) || { on: b.on, total: 0, n: 0, who: [], hit: false };
      t.total += b.stake; t.n++; t.who.push(nameOf(b.by)); t.hit ||= b.hit; by.set(b.on, t);
    }
    const rows = [...by.values()].sort((a, b) => b.total - a.total || b.n - a.n);
    const sum = rows.reduce((s, r) => s + r.total, 0);
    $("tableSum").textContent = slots ? (sum ? fmt(sum) : "") : (bets.length ? `${bets.length} ${bets.length === 1 ? "Tipp" : "Tipps"}` : "");
    const max = (slots ? rows[0]?.total : rows[0]?.n) || 1;
    const done = pickPhase(showingPick()) === "done";
    const live = slots && livePay && stagePhase(state.pick) === "spin" ? livePay : null;
    if (live?.base.size) rows.sort((a, b) => (live.base.get(b.on) || 0) - (live.base.get(a.on) || 0));  // Treffer nach oben
    const html = rows.length ? rows.slice(0, 7).map((r, i) => {
      const pay = live?.base.get(r.on);
      const amt = pay ? `<span class="amt pay">${live.x > 1 ? `<i class="x${live.slam ? " slam" : ""}">×${live.x}</i>` : ""}+${fmt(Math.round(pay * live.x))}</span>` : `<span class="amt">${slots ? fmt(r.total) : r.n}</span>`;
      return `<li data-on="${r.on}" class="${(done && r.hit) || pay ? "win" : ""}">
        <span class="bar" style="width:${((slots ? r.total : r.n) / max) * 100}%"></span>
        <span class="nm">${slots ? badgeHtml(skinOf(r.on)) : ""}${esc(nameOf(r.on))}</span>${amt}
        <span class="meta">${i === 0 && rows.length > 1 && !live?.base.size ? `<span class="fav">Favorit · </span>` : ""}${slots ? `${r.n} ${r.n === 1 ? "Einsatz" : "Einsätze"} · ` : ""}${esc(r.who.slice(0, 3).join(", "))}${r.who.length > 3 ? " …" : ""}</span></li>`;
    }).join("")
      : `<li class="empty">${state.entrants.some((e) => e.phone)
        ? (slots ? "Noch keine Einsätze. Auf dem Handy Chips auf Symbole setzen." : "Noch keine Tipps. Wer kommt dran?")
        : `Wer mit dem Handy mitmacht, bekommt ${fmt(state.rules.start)} Chips.`}</li>`;
    if ($("board")._h !== html) { $("board").innerHTML = html; $("board")._h = html; }
  }

  /** Neue oder geänderte Tipps und Einsätze: Ticker, Chipgeräusch, schwebende Zahl. */
  function betFeed(old, s) {
    const cur = new Map(s.entrants.filter((e) => e.phone).map((e) => [e.id, { on: e.on, w: e.wagers || {} }]));
    const ph = stagePhase(s.pick);
    const samePick = old && (old.pick?.id === s.pick?.id) && (old.pick?.locked === s.pick?.locked);
    if (prevBets && samePick && prevBetPhase === ph && (ph === null || ph === "done" || ph === "calls")) {
      for (const [id, now] of cur) {
        const before = prevBets.get(id);
        if (!before) continue;
        const who = s.entrants.find((e) => e.id === id)?.name ?? "?";
        let line;
        if (now.on !== before.on) {
          line = now.on ? `<b>${esc(who)}</b> tippt auf <b>${esc(nameOf(now.on))}</b>` : `<b>${esc(who)}</b> nimmt den Tipp zurück`;
          sound.chip(now.on ? 2 : 1, { pan: 0.6 });
          if (now.on) requestAnimationFrame(() => { const row = document.querySelector(`.board li[data-on="${now.on}"]`); if (row) bump(row); });
        }
        const keys = new Set([...Object.keys(now.w), ...Object.keys(before.w)]);
        const changed = [...keys].filter((k) => (now.w[k] || 0) !== (before.w[k] || 0));
        if (changed.length) {
          const total = Object.values(now.w).reduce((a, b) => a + b, 0);
          const names = Object.keys(now.w);
          line = !total ? `<b>${esc(who)}</b> nimmt die Einsätze zurück`
            : names.length === 1 ? `<b>${esc(who)}</b> setzt <span class="n">${fmt(total)}</span> auf <b>${esc(nameOf(names[0]))}</b>`
              : `<b>${esc(who)}</b> setzt <span class="n">${fmt(total)}</span> auf ${names.length} Symbole`;
          sound.chip(Math.min(5, 1 + Math.floor(total / 200)), { pan: 0.6 });
          requestAnimationFrame(() => {
            for (const k of changed) {
              const row = document.querySelector(`.board li[data-on="${k}"]`), d = (now.w[k] || 0) - (before.w[k] || 0);
              if (row) { bump(row); pop(d >= 0 ? `+${fmt(d)}` : `−${fmt(-d)}`, row, { size: "2rem", color: d >= 0 ? "var(--gold-hi)" : "var(--mute)" }); }
            }
          });
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
      .map((e) => ({ ...e, total: e.chips + staked(e) }))
      .sort((a, b) => b.total - a.total || a.id - b.id);
    const list = $("ranks");
    if (!players.length) { list.innerHTML = `<li class="empty">Noch niemand mit Handy dabei.</li>`; shownChips.clear(); list._sig = ""; return; }
    const top = players.slice(0, 6);
    const sig = top.map((e) => `${e.id}:${e.name}`).join("|");
    if (list._sig !== sig) {
      list.innerHTML = top.map((e, i) => `<li data-id="${e.id}"><span class="r">${i + 1}</span>
        <span class="nm">${esc(e.name)}</span><span class="c">${fmt(shownChips.get(e.id) ?? e.total)}</span></li>`).join("");
      list._sig = sig;
    }
    for (const e of top) {
      const li = list.querySelector(`li[data-id="${e.id}"]`), el = li?.querySelector(".c");
      const was = shownChips.get(e.id);
      if (el && was !== undefined && was !== e.total) {
        li.classList.toggle("up", e.total > was);
        countTo(el, was, e.total, 900).then(() => setTimeout(() => li.classList.remove("up"), 1500));
        if (e.total > was) pop(`+${fmt(e.total - was)}`, li, { size: "1.6rem", color: "var(--green)" });
      } else if (el && was === undefined) el.textContent = fmt(e.total);
    }
    players.forEach((e) => shownChips.set(e.id, e.total));
  }

  // ---------------------------------------------------------------------------
  function renderEntrants() {
    const list = $("entrants");
    const running = pickPhase(state.pick) === "running";
    const slots = isSlots();
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
      return `<li class="${out ? "out" : ""}" data-id="${e.id}">${slots ? badgeHtml(e.skin) : ""}${e.phone ? `<i class="phone" title="mit Handy"></i>` : ""}<span class="nm">${esc(e.name)}</span>
        ${hostKey && !running ? `<button class="x" data-id="${e.id}" aria-label="${esc(e.name)} entfernen">×</button>` : ""}</li>`;
    }).join("");
    if (list._h !== html) {
      const had = new Set([...list.querySelectorAll("li[data-id]")].map((li) => li.dataset.id));
      const phones = new Set([...list.querySelectorAll("li[data-id]:has(.phone)")].map((li) => li.dataset.id));
      list.innerHTML = html; list._h = html;
      // Nur neue Namen springen herein, und es klackt ein Chip. Wer per Handy seinen Platz übernimmt, blinkt kurz.
      list.querySelectorAll("li[data-id]").forEach((li) => {
        if (had.size && had.has(li.dataset.id)) {
          li.style.animation = "none";
          if (li.querySelector(".phone") && !phones.has(li.dataset.id)) { bump(li); sound.chip(3, { pan: -0.6 }); }
        } else if (had.size) { sound.chip(2, { pan: -0.6 }); }
      });
    }
  }

  function renderDrawn() {
    const running = pickPhase(state.pick) === "running";
    const ws = state.winners.filter((w) => !(running && w.id === state.pick.id));
    $("drawn").innerHTML = ws.length ? `Gezogen: ${ws.map((w) => `<b>${esc(w.winner)}</b>`).join(", ")}` : "";
    $("resetBtn").hidden = !hostKey || !ws.length;
    $("bankBtn").hidden = !hostKey || !state.entrants.some((e) => e.phone);
    $("saveBtn").hidden = !hostKey;
    $("saveBtn").setAttribute("aria-pressed", state.draw.saved);
    $("saveBtn").textContent = state.draw.saved ? "Gespeichert" : "Tisch speichern";
    $("groupBtn").hidden = !hostKey || !state.entrants.length;
    $("groupBtn").textContent = state.draw.group ? "Gruppe aktualisieren" : "Als Gruppe speichern";
  }

  function renderControls() {
    if (!hostKey) return;
    const running = pickPhase(state.pick) === "running";
    for (const b of $("modes").children) {
      b.setAttribute("aria-checked", b.dataset.mode === state.draw.mode);
      b.disabled = running;
    }
    const slots = state.draw.mode === "slots";
    $("rounds").hidden = !slots;
    for (const b of $("rounds").querySelectorAll("button")) {
      b.setAttribute("aria-checked", +b.dataset.rounds === state.draw.rounds);
      b.disabled = running;
    }
    $("drawBtn").disabled = running || inPot().length < 2;
    $("drawBtn").textContent = running ? "Läuft" : slots ? "Drehen" : "Ziehen";
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

  /** Zweimal klicken, damit es kein Versehen ist. */
  function armed(btn, label, ask) {
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = label; return true; }
    btn.dataset.armed = "1"; btn.textContent = ask;
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; }, 3000);
    return false;
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
      const b = e.target.closest(".btn:not([disabled]), .tool, .modes button:not([disabled]), .rounds button:not([disabled])");
      if (b && b !== document._hov) { document._hov = b; sound.hover(); }
      if (!b) document._hov = null;
    });
    document.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".tool, .modes button:not([disabled]), .rounds button:not([disabled]), .add .btn")) sound.press(2);
    });

    addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea, dialog")) return;
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
    $("rounds").onclick = (e) => {
      const b = e.target.closest("[data-rounds]");
      if (b && !b.disabled && +b.dataset.rounds !== state.draw.rounds) host("rounds", { rounds: +b.dataset.rounds });
    };
    $("drawBtn").onclick = draw;
    $("resetBtn").onclick = () => { dismiss(); host("reset"); };
    $("bankBtn").onclick = () => {
      if (armed($("bankBtn"), "Bank zurücksetzen", `Sicher? Alle auf ${fmt(state.rules.start)}`)) host("bank");
    };
    $("saveBtn").onclick = async () => {
      const saved = !state.draw.saved;
      if (await host("save", { saved })) toast(saved ? "Gespeichert. Der Tisch steht jetzt auf der Startseite." : "Nicht mehr gespeichert. Der Tisch verfällt, wenn nichts mehr passiert.");
    };
    $("groupBtn").onclick = () => {
      $("groupName").value = state.draw.group?.name ?? state.draw.title.replace(/\?$/, "").slice(0, 40);
      $("groupDlg").showModal();
      $("groupName").select();
    };
    $("groupDlg").onclose = async () => {
      if ($("groupDlg").returnValue !== "ok") return;
      const r = await host("group", { name: $("groupName").value });
      if (r) { toast(`Gruppe „${r.name}“ mit ${r.members} Namen gespeichert`); sound.kaching(false); }
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
