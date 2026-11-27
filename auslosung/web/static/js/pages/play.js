// Seite: Handy (eintragen, tippen oder setzen, Ziehung live verfolgen)
//
// Glücksrad und Plinko: ein kostenloser Tipp, richtig getippt gibt Chips.
// Slots: Chips auf beliebig viele Symbole, je Runde neu. Jedes Muster eines
// Symbols zahlt Einsatz × Musterpunkte × Faktor × Quote.
import { STAGES } from "../stages/index.js";
import { sound } from "../audio.js";
import { slotSfx } from "../slot-sfx.js";
import { api, esc, live, phaseKey, segment, serverNow, skinClass, skinHtml, stagePhase, store, syncClock, toast } from "../core.js";
import { Background, bump, center, countTo, fmt, particles, pop, shake, sleep } from "../fx.js";

// =============================================================================
// Seite: Handy
// =============================================================================
export function playPage() {
  const $ = (id) => document.getElementById(id);
  const code = location.pathname.split("/").pop().toUpperCase();
  const KEY = "tok:" + code;
  let token = store.get(KEY), state, stage, stageMode, stageKey, phase = null, phaseId = null;
  let myOn = null, myW = {}, lastW = null, sel = null, pending = 0, sendTimer = null;
  let shownTotal = null, verdictFor = null, lastSecond = null;
  let gain = 0, gainRound = null, paying = false;           // Slots: in dieser Runde schon gesehene Gewinne
  let spinBase = 0, spinX = 1;                              // laufender Spin: Gewinn vor Faktor, Faktor
  let soundOn = store.get("psound") === "1";

  new Background($("bg"), { scale: 6 });
  particles.attach($("fx"));
  shake.attach($("app"));

  const buzz = (p) => { try { navigator.vibrate?.(p); } catch {} };
  const fresh = (p) => p && serverNow() - p.ends_at < 10 * 60_000;
  const dec = (x) => String(x).replace(".", ",");
  const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

  async function boot() {
    const s = await api(`/api/d/${code}/state${token ? "?token=" + encodeURIComponent(token) : ""}`);
    syncClock(s.now);
    $("drawTitle").textContent = s.draw.title;
    $("startChips").textContent = fmt(s.rules.start);
    document.title = `${s.draw.title} · Auslosung`;
    if (token && !s.me) { store.del(KEY); token = null; }
    token ? start(s) : showJoin();
  }

  function showJoin() {
    $("join").hidden = false;
    $("name").value = store.get("lastName") || "";
    $("joinForm").onsubmit = async (e) => {
      e.preventDefault();
      const name = $("name").value.trim();
      try {
        const r = await api(`/api/d/${code}/join`, { name });
        token = r.token;
        store.set(KEY, token); store.set("lastName", name);
        $("join").hidden = true;
        buzz([20, 40, 20]);
        if (r.claimed) toast("Willkommen zurück, dein Platz war schon reserviert");
        const c = center($("joinForm"));
        particles.burst(c.x, c.y, { n: 40, kind: "chip", speed: 12, up: 9 });
        start(await api(`/api/d/${code}/state?token=${encodeURIComponent(token)}`));
      } catch (err) { $("joinError").textContent = err.message; shake.add(0.3); buzz(80); }
    };
  }

  function start(s) {
    $("main").hidden = false;
    $("hud").hidden = false;
    $("slip").hidden = false;
    phase = stagePhase(s.pick);
    phaseId = phaseKey(s.pick);
    if (phase === "done") verdictFor = s.pick.id;     // altes Ergebnis nicht neu feiern
    render(s);
    live(`/api/d/${code}/events?token=${encodeURIComponent(token)}`, render);
    setupInput();
    requestAnimationFrame(loop);
  }

  function render(s) {
    if (!s.me) { store.del(KEY); location.reload(); return; }
    state = s;
    if (!pending) { myOn = s.me.on; myW = { ...s.me.wagers }; }
    $("who").textContent = s.me.name;
    $("drawTitle").textContent = s.draw.title;
    renderHud();
    renderCards();
    renderSlip();
    renderLive();
    renderBanner();
    renderPaytable();
    renderLeaders();
  }

  /** Gesetzt wird nach der laufenden Ziehung, sonst nach der Art, die der Tisch gerade eingestellt hat. */
  const slots = () => {
    const p = state.pick, ph = stagePhase(p);
    return (ph && ph !== "done" ? p.mode : state.draw.mode) === "slots";
  };
  const total = () => state.me.chips + sum(state.me.wagers);
  const free = () => total() - sum(myW);
  const bettingOpen = () => { const ph = stagePhase(state.pick); return !ph || ph === "done" || ph === "calls"; };
  const skinOf = (id) => state.pick?.layout.skins?.[String(id)] ?? state.entrants.find((e) => e.id === id)?.skin;

  /** Wer steht gerade im Topf? Während einer Ziehung der eingefrorene Topf. */
  function pool() {
    const p = state.pick, ph = stagePhase(p);
    if (ph && ph !== "done") return p.layout.slots.map((id) => state.entrants.find((e) => e.id === id) || { id, name: p.layout.names[String(id)], backers: 0, backed: 0 });
    return state.entrants.filter((e) => !state.picked.includes(e.id));
  }

  // ---------------------------------------------------------------------------
  function loop() {
    requestAnimationFrame(loop);
    if (!state) return;
    const p = state.pick, now = stagePhase(p), id = phaseKey(p);
    if (id !== phaseId) {
      const from = phase;
      phase = now; phaseId = id;
      if (now === "calls") { buzz([60, 40, 60]); lastSecond = null; paying = false; stage?.clearOverlay?.(); stage?.renderMarquee?.(); }
      if (now === "lock") {
        buzz(p.mode === "slots" ? 60 : 120); shake.add(p.mode === "slots" ? 0.2 : 0.5);
        if (soundOn) { sound.slam(); }
        if (sum(myW)) lastW = { ...myW };
      }
      if (now === "done" && from && from !== "done") celebrate(p);
      renderCards(); renderSlip(); renderLive(); renderBanner();
    }
    if (now === "calls") {
      const left = Math.ceil((segment(p).locks_at - serverNow()) / 1000);
      if (left !== lastSecond) {
        lastSecond = left;
        renderBanner();
        bump($("banner").querySelector(".n"));
        if (left <= 3) buzz(25);
        if (soundOn) sound.clock(left);
      }
    }
  }

  function renderBanner() {
    const p = state.pick, ph = stagePhase(p), n = pool().length;
    const seg = segment(p);
    let html;
    if (ph === "calls" && p.mode === "slots") {
      html = breakBanner(p, seg);
      if (!$("gain").hidden) clearGain();          // Pause: das Ergebnis steht im Banner
    } else if (ph === "calls") {
      const left = Math.max(0, Math.ceil((seg.locks_at - serverNow()) / 1000));
      html = `<div class="b calls"><span class="big">Letzte<br>Tipps</span><span class="n">${left}</span></div>`;
    } else if ((ph === "lock" || ph === "spin") && p.mode === "slots") {
      const w = myW, k = Object.keys(w).length;
      const mine = k ? `${fmt(sum(w))} auf ${k === 1 ? esc(p.layout.names[Object.keys(w)[0]] ?? "?") : `${k} Symbole`}` : "Du setzt diese Runde aus";
      const at = paying ? 2 : 1;
      html = `<div class="b brk run"><div class="brk-top"><span class="kick">${p.layout.rounds > 1 ? `Runde ${seg?.n ?? 1} von ${p.layout.rounds}` : "Ein Spin"}</span><span class="mine">${mine}</span></div>${stepsHtml(at)}</div>`;
    } else if (ph === "lock" || ph === "spin") {
      let mine;
      if (p.mode === "slots") {
        const w = myW, k = Object.keys(w).length;
        mine = k ? `${fmt(sum(w))} auf ${k === 1 ? esc(p.layout.names[Object.keys(w)[0]] ?? "?") : `${k} Symbole`}` : "ohne Einsatz";
      } else {
        const on = p.tips?.[String(state.me.id)] ?? myOn;
        mine = on ? `Tipp: ${esc(p.layout.names[String(on)] ?? "?")}` : "ohne Tipp";
      }
      const what = p.mode === "slots" && p.layout.rounds > 1 ? `Runde ${seg?.n ?? 1} läuft` : "Keine Wetten mehr";
      html = `<div class="b lock"><span class="big">${what}</span><span>${mine}</span></div>`;
    } else if (n < 2) {
      html = `<div class="b info">Sobald mindestens zwei Namen im Topf sind, geht es los.</div>`;
    } else if (slots()) {
      html = `<div class="b info"><span>Setz Chips auf <b>Symbole</b>. Jedes Muster deines Symbols zahlt aus, Faktoren vervielfachen. Mehrere Symbole gleichzeitig gehen.</span></div>`;
    } else {
      html = `<div class="b info"><span>Tipp <b>kostenlos</b> auf einen Namen. Liegst du richtig, gibt es <b>+${fmt(state.rules.tip)}</b> Chips.</span></div>`;
    }
    if ($("banner")._h !== html) { $("banner").innerHTML = html; $("banner")._h = html; }
  }

  const STEPS = ["Setzen", "Walzen", "Auszahlung"];
  const stepsHtml = (at) => `<ol class="brk-steps">${STEPS.map((x, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}">${x}</li>`).join("")}</ol>`;

  /** Slots, Einsätze offen: Runde, Zeit, was die letzte Runde dir gebracht hat, was jetzt zu tun ist. */
  function breakBanner(p, seg) {
    const left = Math.max(0, Math.ceil((seg.locks_at - serverNow()) / 1000));
    const frac = Math.max(0, Math.min(1, (seg.locks_at - serverNow()) / Math.max(1, seg.locks_at - seg.calls_at)));
    const prev = p.rounds.find((r) => r.n === seg.n - 1 && r.locked);
    let last = "";
    if (prev) {
      const x = prev.payouts?.[String(state.me.id)];
      if (!x) last = `<p class="brk-last">Runde ${prev.n} hast du ausgesetzt.</p>`;
      else {
        const staked = Object.values(x.stakes).reduce((a, b) => a + b, 0), net = x.win - staked;
        last = `<p class="brk-last ${net > 0 ? "up" : "down"}">Runde ${prev.n}: ${x.win
          ? `<b>+${fmt(x.win)}</b> Chips gewonnen${net < 0 ? ` (Einsatz ${fmt(staked)})` : ""}`
          : `kein Treffer, <b>−${fmt(staked)}</b>`}${x.bail ? ` · Bank hilft mit +${fmt(x.bail)}` : ""}</p>`;
      }
    }
    const n = Object.keys(myW).length;
    const todo = n ? `<p class="brk-todo ok">Gesetzt: <b>${fmt(sum(myW))}</b> auf ${n === 1 ? "ein Symbol" : `${n} Symbole`}. Du kannst noch ändern.</p>`
      : `<p class="brk-todo">Symbol antippen, dann Chips drauflegen${lastW && repeatable() ? " oder unten <b>Wie eben</b>" : ""}.</p>`;
    return `<div class="b brk"><div class="brk-top"><span class="kick">${p.layout.rounds > 1 ? `Runde ${seg.n} von ${p.layout.rounds}` : "Ein Spin"} · Einsätze offen</span><span class="n">${left}</span></div>
      <div class="brk-bar"><i style="transform:scaleX(${frac.toFixed(3)})"></i></div>${last}${todo}${stepsHtml(0)}</div>`;
  }

  let counting = false;
  function renderHud() {
    const t = total(), el = $("chips");
    if (shownTotal !== null && t !== shownTotal) {
      // Konto hat sich von außen geändert (Gewinn, Bank, Rettung): hochzählen
      counting = true;
      const up = t > shownTotal;
      countTo(el, Math.max(0, shownTotal - sum(myW)), free(), 900,
        { onStep: (_, u) => { if (soundOn && u > 0 && u < 1 && up) sound.score(Math.floor(u * 6)); } })
        .then(() => { counting = false; el.textContent = fmt(free()); });
      bump(el);
      if (up) clearGain();
    } else if (!counting) el.textContent = fmt(free());
    shownTotal = t;
    const players = state.entrants.filter((e) => e.phone).sort((a, b) => (b.chips + sum(b.wagers)) - (a.chips + sum(a.wagers)));
    const rank = players.findIndex((e) => e.id === state.me.id) + 1;
    $("rank").textContent = players.length > 1 ? `Platz ${rank} von ${players.length}` : "Allein am Tisch";
  }

  function renderCards() {
    const open = bettingOpen();
    const list = pool();
    const sl = slots();
    const max = Math.max(1, ...list.map((e) => (sl ? e.backed : e.backers) || 0));
    const c = $("cards");
    c.classList.toggle("symcards", sl);
    c.setAttribute("aria-label", sl ? "Auf welche Symbole setzt du?" : "Auf wen tippst du?");
    const html = list.length ? list.map((e, i) => {
      if (sl) {
        const mine = myW[String(e.id)] || 0;
        const others = (e.backed || 0) - (state.me.wagers?.[String(e.id)] || 0);
        return `<button class="card scard ${skinClass(e.skin)}" role="radio" data-id="${e.id}" aria-checked="${e.id === sel}" ${open ? "" : "disabled"} style="--i:${i}">
          ${mine ? `<span class="mine">${fmt(mine)}</span>` : ""}
          <svg class="sym"><use href="#sym-${e.skin?.[0] ?? "chip"}"/></svg>
          <span class="nm">${esc(e.name)}${e.id === state.me.id ? ` <small>(du)</small>` : ""}</span>
          <span class="crowd"><span>${others > 0 ? `andere ${fmt(others)}` : "noch frei"}</span></span>
          <span class="heat"><i style="width:${((e.backed || 0) / max) * 100}%"></i></span>
        </button>`;
      }
      const others = (e.backers || 0) - (e.id === state.me.on ? 1 : 0);
      return `<button class="card" role="radio" data-id="${e.id}" aria-checked="${e.id === myOn}" ${open ? "" : "disabled"} style="--i:${i}">
        ${e.id === myOn ? `<span class="mine">Tipp</span>` : ""}
        <span class="nm">${esc(e.name)}${e.id === state.me.id ? ` <small>(du)</small>` : ""}</span>
        <span class="crowd"><span>${others > 0 ? `${others} ${others === 1 ? "anderer Tipp" : "andere Tipps"}` : e.id === myOn ? "nur du" : "noch frei"}</span></span>
        <span class="heat"><i style="width:${((e.backers || 0) / max) * 100}%"></i></span>
      </button>`;
    }).join("") : `<p class="note">Noch ist der Topf leer.</p>`;
    if (c._h !== html) {
      const first = !c._h;
      c.innerHTML = html; c._h = html;
      if (!first) c.querySelectorAll(".card").forEach((b) => { b.style.animation = "none"; });
    }
    c.classList.toggle("locked", !open);
  }

  function renderSlip() {
    const open = bettingOpen();
    const slip = $("slip"), sl = slots();
    slip.classList.toggle("locked", !open);
    slip.classList.toggle("tip", !sl);
    const f = free();
    slip.querySelectorAll("[data-add]").forEach((b) => { b.disabled = !open || f < 1; });
    slip.querySelector("[data-all]").disabled = !open || f < 1;
    slip.querySelector("[data-clear]").disabled = !open || !(sl ? sum(myW) : myOn);
    let html;
    if (!sl) {
      const target = myOn && (state.entrants.find((e) => e.id === myOn)?.name ?? state.pick?.layout.names[String(myOn)]);
      html = !open ? `<span class="on">Tipps sind gesperrt</span>`
        : myOn ? `<span class="on">Dein Tipp: <b>${esc(target ?? "?")}</b></span><span class="calc"><span class="bx w">+${fmt(state.rules.tip)}</span></span>`
          : `<span class="on">Tipp einen Namen an. Kostet nichts.</span>`;
    } else {
      const n = Object.keys(myW).length, q = state.rules.pay?.q;
      const name = sel && (state.entrants.find((e) => e.id === sel)?.name ?? state.pick?.layout.names[String(sel)]);
      if (!open) html = `<span class="on">${n ? `${fmt(sum(myW))} auf ${n === 1 ? "ein Symbol" : `${n} Symbole`}` : "Einsätze sind gesperrt"}</span>`;
      else if (!n && repeatable()) html = `<span class="on">Symbol antippen oder</span><button class="again" data-repeat>Wie eben · ${fmt(sum(lastW))}</button>`;
      else if (!sel) html = `<span class="on">${n ? `${fmt(sum(myW))} auf ${n === 1 ? "ein Symbol" : `${n} Symbole`} · ` : ""}Symbol antippen, dann Chips drauf</span>`;
      else {
        const st = myW[String(sel)] || 0;
        html = !st ? `<span class="on"><b>${esc(name ?? "?")}</b> gewählt · Chips antippen</span>`
          : `<span class="on">auf <b>${esc(name ?? "?")}</b>${n > 1 ? ` · gesamt ${fmt(sum(myW))}` : ""}</span>
          <span class="calc" title="Jedes Muster zahlt Einsatz × Punkte × Quote"><span class="bx s">${fmt(st)}</span><span class="op">×</span><span class="bx q">Pkt</span>${q ? `<span class="op">×</span><span class="bx m">${dec(q)}</span>` : ""}</span>`;
      }
    }
    if ($("slipLine")._h !== html) { $("slipLine").innerHTML = html; $("slipLine")._h = html; }
    if (sl && stagePhase(state.pick) === "calls") renderBanner();
  }

  /** Einsätze der letzten Runde lassen sich mit einem Tipp wiederholen, solange Chips und Namen passen. */
  function repeatable() {
    if (!lastW || sum(lastW) > free()) return false;
    const ids = new Set(pool().map((e) => String(e.id)));
    return Object.keys(lastW).every((k) => ids.has(k));
  }

  /** Bestenliste: wer am Tisch die meisten Chips hat (Einsätze zählen mit). Top 5, dazu der eigene Platz. */
  function renderLeaders() {
    const players = state.entrants.filter((e) => e.phone)
      .map((e) => ({ ...e, total: e.chips + sum(e.wagers) }))
      .sort((a, b) => b.total - a.total || a.id - b.id);
    const box = $("leaders");
    box.hidden = players.length < 2;
    if (box.hidden) return;
    const mine = players.findIndex((e) => e.id === state.me.id);
    const rows = players.slice(0, 5).map((e, i) => [e, i]);
    if (mine >= 5) rows.push(null, [players[mine], mine]);
    const html = rows.map((x) => {
      if (!x) return `<li class="gap" aria-hidden="true">…</li>`;
      const [e, i] = x;
      return `<li class="${i < 3 ? `m${i + 1}` : ""}${e.id === state.me.id ? " me" : ""}"><span class="r">${i + 1}</span>`
        + `<span class="nm">${esc(e.name)}${e.id === state.me.id ? " <small>(du)</small>" : ""}</span><span class="c">${fmt(e.total)}</span></li>`;
    }).join("");
    if ($("leadersList")._h !== html) { $("leadersList").innerHTML = html; $("leadersList")._h = html; }
  }

  function renderPaytable() {
    const pay = state.rules.pay, box = $("paytable");
    box.hidden = !slots() || !pay;
    if (box.hidden) return;
    const html = `<table><thead><tr><th>Muster</th><th>Punkte</th><th>100 Chips bringen</th></tr></thead><tbody>
      ${pay.rows.map(([, label, v, x]) => `<tr><td>${label}</td><td>${v}</td><td>${fmt(100 * x)}</td></tr>`).join("")}</tbody></table>
      <p class="pt-note">${skinHtml("W", {}, {})}<span><b>Joker</b> zählt für jedes Symbol.</span></p>
      <p class="pt-note">${skinHtml("x2", {}, {})}<span><b>Faktor ×2, ×3, ×5</b> vervielfacht den ganzen Spin, wenn ein Muster fällt.</span></p>
      <p class="pt-note">${skinHtml("N", {}, {})}<span><b>Niete</b> blockiert. Drei Nieten im Bild: Pleite, der Spin zählt nicht.</span></p>
      <p class="pt-note muted">Quote ${dec(pay.q)} gleicht die Zahl der Namen aus. Gezogen wird, wer am Ende die meisten Punkte hat.</p>`;
    if ($("paytableBody")._h !== html) { $("paytableBody").innerHTML = html; $("paytableBody")._h = html; }
  }

  function renderLive() {
    const p = state.pick, ph = stagePhase(p);
    const show = p && (p.mode === "slots" ? (ph !== "done" || fresh(p)) : (ph === "lock" || ph === "spin" || (ph === "done" && fresh(p))));
    $("live").hidden = !show;
    $("live").classList.toggle("wide", p?.mode === "slots");
    if (show) {
      if (stageMode !== p.mode) {
        stage?.destroy();
        const old = $("canvas"), c = old.cloneNode(); old.replaceWith(c);
        stage = new STAGES[p.mode](c, p.mode, { sound: false, compact: true });
        stage.onLand = () => buzz(30);
        if (p.mode === "slots") stage.onEvent = slotEvent;
        stageMode = p.mode; stageKey = null;
      }
      const visible = p.mode === "slots" || p.locked;
      const key = JSON.stringify([p.id, p.locked, p.rounds?.map((r) => r.locked)]);
      if (key !== stageKey) {
        stageKey = key;
        stage.show({ slots: p.layout.slots, names: p.layout.names, layout: p.layout, skins: p.layout.skins, pick: visible ? p : null });
      }
    }
    const v = $("verdict");
    if (ph === "done" && fresh(p) && p.locked) {
      if (v.dataset.pick !== String(p.id) || v.hidden) {
        v.dataset.pick = p.id;
        verdict(p);
      }
    } else v.hidden = true;
  }

  // -- Slots: eigene Treffer live mitfühlen -------------------------------------------
  function myStakes(round) {
    const x = round?.payouts?.[String(state.me.id)];
    return x ? { stakes: x.stakes, wins: x.wins } : null;
  }

  function slotEvent(type, e) {
    const mine = myStakes(e.round);
    if (type === "spin" && gainRound !== `${e.round.n}`) { gainRound = `${e.round.n}`; clearGain(); }
    if (type === "spin") { spinBase = 0; spinX = 1; if (mine && Object.keys(mine.stakes).length) winbar(false); }
    if ((type === "spin" && paying) || (type === "tally" && !paying)) { paying = type === "tally"; renderBanner(); }
    if (!mine) return;
    if (type === "pattern" && mine.stakes[String(e.p.id)]) {
      // Jedes Muster deines Symbols: Einsatz × Punkte × Quote, der Faktor kommt danach obendrauf
      spinBase += mine.stakes[String(e.p.id)] * e.p.v * (state.pick?.layout?.q || 1);
      winbar(true);
      buzz(18);
      if (soundOn) slotSfx.tick(Math.min(10, (e.k ?? 0) + 2));
      bump(document.querySelector(`.card[data-id="${e.p.id}"]`));
    } else if (type === "mult" && spinBase > 0) {
      // Faktor fällt: dein Gewinn vervielfacht sich sichtbar
      spinX = e.spin.mult.slice(0, e.k + 1).reduce((m, [, , v]) => m * v, 1);
      spinX = Math.min(spinX, e.spin.x);
      winbar(true, true);
      buzz([30, 30, 60]);
    } else if (type === "tally") {
      const w = mine.wins[e.i] || 0;
      if (!w) return;
      gain += w; spinBase = 0; spinX = 1;
      winbar(true, false, true);
      buzz(e.spin.tier >= 3 ? [60, 40, 60, 40, 160] : [40, 30, 80]);
      shake.add(Math.min(0.6, 0.15 + e.spin.tier * 0.12));
      const c = center($("live"));
      particles.burst(c.x, c.y, { n: 14 + e.spin.tier * 10, kind: "chip", speed: 10, up: 8 });
      pop(`+${fmt(w)}`, $("live"), { color: "var(--gold-hi)", size: "2.6rem" });
      if (soundOn) slotSfx.win(e.spin.tier >= 3);
    }
  }

  /** Gewinnleiste: bisher in dieser Runde + laufender Spin (vor Faktor) × Faktor. */
  function winbar(bump, slam = false, done = false) {
    const el = $("gain"), now = Math.round(spinBase * spinX), total = gain + now;
    el.hidden = false;
    el.classList.toggle("hit", total > 0);
    el.classList.toggle("done", done);
    el.innerHTML = `<span class="lbl">${done ? "Gewonnen" : "Dein Gewinn"}<small>${done ? "kommt aufs Konto" : spinX > 1 ? "Faktor zählt für deine Treffer" : "Einsatz × Punkte × Quote"}</small></span>`
      + (spinX > 1 && !done ? `<span class="x${slam ? " slam" : ""}">×${spinX}</span>` : "")
      + `<span class="val${bump ? " bump" : ""}">${total ? `+${fmt(total)}` : "0"}</span>`;
  }
  function clearGain() { gain = 0; spinBase = 0; spinX = 1; $("gain").hidden = true; }

  function verdict(p) {
    const v = $("verdict");
    const isMe = p.winner_id === state.me.id;
    let body = "", cls = "";
    if (p.mode === "slots") {
      const net = p.payouts?.net?.[String(state.me.id)];
      const pts = p.payouts?.totals?.[String(state.me.id)] || 0;
      if (net !== undefined) {
        cls = net > 0 ? " hit" : " miss";
        body = `<p class="head">${net > 0 ? "Im Plus!" : net < 0 ? "Diesmal nicht" : "Plus minus null"}</p>
          <p class="amt" id="vAmt">${net > 0 ? "+" : net < 0 ? "−" : ""}${fmt(Math.abs(net))}</p><p class="sub">Chips aus dieser Session</p>`;
      }
      if (pts) body += `<p class="sub">Dein Symbol holte ${fmt(pts)} ${pts === 1 ? "Punkt" : "Punkte"}.</p>`;
      // Endstand: gezogen ist, wer über alle Runden die meisten Punkte hat
      const top = Object.entries(p.payouts?.totals || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (top.length) body += `<ol class="v-stand"><li class="h">Punkte über ${p.layout.rounds === 1 ? "den Spin" : `alle ${p.layout.rounds} Runden`}</li>`
        + top.map(([id, v]) => `<li class="${+id === p.winner_id ? "w" : ""}"><span>${esc(p.layout.names[id] ?? "?")}</span><b>${fmt(v)}</b></li>`).join("") + `</ol>`;
    } else {
      const on = p.tips?.[String(state.me.id)];
      if (on) {
        const hit = (p.payouts?.hits || []).includes(state.me.id);
        cls = hit ? " hit" : " miss";
        body = hit ? `<p class="head">Richtig getippt!</p><p class="amt" id="vAmt">+${fmt(p.payouts.bonus)}</p>`
          : `<p class="head">Daneben</p><p class="sub">Dein Tipp war ${esc(p.layout.names[String(on)] ?? "?")}.</p>`;
      }
    }
    v.className = "verdict panel" + cls + (isMe ? " me" : "");
    v.innerHTML = `<p class="k">${isMe ? "Dich hat’s erwischt" : "Gezogen"}</p><p class="nm">${esc(p.winner)}</p>${body}`;
    v.hidden = false;
    return cls;
  }

  async function celebrate(p) {
    if (verdictFor === p.id) return;
    verdictFor = p.id;
    await sleep(60);
    const cls = verdict(p);
    const isMe = p.winner_id === state.me.id;
    const c = center($("verdict"));
    if (cls === " hit") {
      buzz([60, 50, 60, 50, 220]);
      shake.add(0.6);
      particles.burst(c.x, c.y, { n: 120, speed: 14, up: 8 });
      particles.burst(c.x, c.y, { n: 30, kind: "chip", speed: 12, up: 10 });
      if (soundOn) sound.kaching(true);
      const el = $("vAmt");
      if (el) {
        const to = parseInt(el.textContent.replace(/\D/g, ""), 10) || 0;
        await countTo(el, 0, to, 1100, { format: (x) => "+" + fmt(x), onStep: (_, u) => { if (soundOn && u > 0 && u < 1) sound.score(Math.floor(u * 8)); } });
        bump(el);
      }
    } else if (cls === " miss") {
      buzz(200);
      shake.add(0.35);
      if (soundOn) sound.lose();
    } else {
      buzz(isMe ? [80, 60, 80] : 40);
      particles.burst(c.x, c.y, { n: 40, speed: 10 });
    }
    if (isMe) { shake.add(0.5); particles.rain(60); }
  }

  // ---------------------------------------------------------------------------
  // Tippen und Setzen: sofort zeigen, kurz gebündelt senden
  function queue() {
    pending++;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(send, 240);
  }

  function tip(on) {
    if (!bettingOpen()) return;
    myOn = on === myOn ? null : on;
    buzz(myOn ? 12 : 6);
    if (soundOn) sound.chip(myOn ? 2 : 1);
    renderCards(); renderSlip();
    queue();
  }

  function wager(on, stake, { from } = {}) {
    if (!bettingOpen()) return;
    const k = String(on), before = myW[k] || 0;
    stake = Math.max(0, Math.min(before + free(), Math.round(stake)));
    const delta = stake - before;
    if (stake) myW[k] = stake; else delete myW[k];
    renderCards(); renderSlip();
    $("chips").textContent = fmt(free());
    if (delta > 0) {
      buzz(10);
      if (soundOn) sound.chip(Math.min(5, 1 + Math.floor(delta / 100)));
      const card = document.querySelector(`.card[data-id="${on}"]`);
      pop(`+${fmt(delta)}`, from || card || $("slip"), { size: "2.2rem" });
      bump(card?.querySelector(".mine"));
    } else if (delta < 0) {
      buzz(6);
      if (soundOn) sound.chip(1);
    }
    queue();
  }

  async function send() {
    sendTimer = null;
    try {
      if (slots()) await api(`/api/d/${code}/wager`, { token, wagers: myW });
      else await api(`/api/d/${code}/tip`, { token, entrant_id: myOn });
    } catch (err) {
      toast(err.message); buzz([40, 40, 40]); shake.add(0.25);
      pending = 0;
      try { render(await api(`/api/d/${code}/state?token=${encodeURIComponent(token)}`)); } catch {}
      return;
    }
    // Während der Anfrage schon wieder getippt: der nächste Versand ist geplant, lokalen Stand behalten
    if (!sendTimer) pending = 0;
  }

  function setupInput() {
    $("cards").onclick = (e) => {
      const b = e.target.closest(".card");
      if (!b || b.disabled) return;
      const id = +b.dataset.id;
      bump(b);
      if (!slots()) { tip(id); return; }
      if (sel !== id) {            // erst wählen; beim ersten Mal gleich 50 drauf
        sel = id;
        if (!myW[String(id)] && free() > 0) wager(id, Math.min(50, free()), { from: b });
        else { renderCards(); renderSlip(); buzz(8); }
        return;
      }
      wager(id, (myW[String(id)] || 0) + Math.min(50, free()), { from: b });
    };
    $("slipLine").onclick = (e) => {
      if (!e.target.closest("[data-repeat]") || !repeatable() || !bettingOpen()) return;
      myW = { ...lastW };
      sel = +Object.keys(myW)[0];
      renderCards(); renderSlip(); $("chips").textContent = fmt(free());
      buzz([20, 30, 20]); if (soundOn) sound.chip(4);
      pop(`${fmt(sum(myW))}`, $("slip"), { size: "2.2rem" });
      queue();
    };
    $("slipChips").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      if (b.dataset.clear !== undefined) {
        if (!slots()) { tip(null); return; }
        myW = {}; renderCards(); renderSlip(); $("chips").textContent = fmt(free());
        buzz(6); if (soundOn) sound.chip(1); queue(); return;
      }
      if (!sel) {
        toast("Erst ein Symbol antippen");
        $("cards").querySelectorAll(".card").forEach((c) => bump(c));
        buzz(30);
        return;
      }
      const now = myW[String(sel)] || 0;
      if (b.dataset.all !== undefined) { wager(sel, now + free(), { from: b }); shake.add(0.3); buzz([30, 30, 60]); return; }
      wager(sel, now + +b.dataset.add, { from: b });
    };
    const sb = $("sndBtn");
    sb.setAttribute("aria-pressed", soundOn);
    if (soundOn) sound.unlock();
    sb.onclick = () => {
      soundOn = !soundOn;
      store.set("psound", soundOn ? "1" : "0");
      sb.setAttribute("aria-pressed", soundOn);
      if (soundOn) { sound.unlock(); sound.setEnabled(true); sound.chip(2); }
    };
    // iOS & Co. lassen Ton erst nach einer Berührung zu
    document.addEventListener("pointerdown", () => { if (soundOn) sound.unlock(); }, { once: true });
  }

  boot().catch((e) => toast(e.message, 10000));
}
