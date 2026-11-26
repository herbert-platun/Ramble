// Seite: Handy (eintragen, Chips setzen, Ziehung live verfolgen)
import { STAGES } from "../stages/index.js";
import { sound } from "../audio.js";
import { api, esc, live, serverNow, stagePhase, store, syncClock, toast } from "../core.js";
import { Background, bump, center, countTo, fmt, particles, pop, shake, sleep } from "../fx.js";

// =============================================================================
// Seite: Handy
// =============================================================================
export function playPage() {
  const $ = (id) => document.getElementById(id);
  const code = location.pathname.split("/").pop().toUpperCase();
  const KEY = "tok:" + code;
  let token = store.get(KEY), state, stage, stageMode, phase = null;
  let myOn = null, myStake = 0, pending = 0, sendTimer = null;
  let shownTotal = null, verdictFor = null, lastSecond = null, seenRunning = null;
  let soundOn = store.get("psound") === "1";

  new Background($("bg"), { scale: 6 });
  particles.attach($("fx"));
  shake.attach($("app"));

  const buzz = (p) => { try { navigator.vibrate?.(p); } catch {} };
  const fresh = (p) => p && serverNow() - p.ends_at < 10 * 60_000;
  const multOf = (streak) => 1 + 0.5 * Math.min(streak, 4);
  const dec = (x) => String(x).replace(".", ",");

  async function boot() {
    const s = await api(`/api/d/${code}/state${token ? "?token=" + encodeURIComponent(token) : ""}`);
    syncClock(s.now);
    $("drawTitle").textContent = s.draw.title;
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
        token = (await api(`/api/d/${code}/join`, { name })).token;
        store.set(KEY, token); store.set("lastName", name);
        $("join").hidden = true;
        buzz([20, 40, 20]);
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
    if (phase && phase !== "done") seenRunning = s.pick.id;
    if (phase === "done") verdictFor = s.pick.id;     // altes Ergebnis nicht neu feiern
    render(s);
    live(`/api/d/${code}/events?token=${encodeURIComponent(token)}`, render);
    setupInput();
    requestAnimationFrame(loop);
  }

  function render(s) {
    if (!s.me) { store.del(KEY); location.reload(); return; }
    state = s;
    if (!pending) { myOn = s.me.on; myStake = s.me.stake || 0; }
    $("who").textContent = s.me.name;
    $("drawTitle").textContent = s.draw.title;
    renderHud();
    renderCards();
    renderSlip();
    renderLive();
    renderBanner();
  }

  const total = () => state.me.chips + (state.me.stake || 0);
  const bettingOpen = () => { const ph = stagePhase(state.pick); return !ph || ph === "done" || ph === "calls"; };

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
    const p = state.pick, now = stagePhase(p);
    if (now !== phase || (p && now !== "done" && p.id !== seenRunning)) {
      const from = phase;
      phase = now;
      if (now && now !== "done") seenRunning = p.id;
      if (now === "calls") { buzz([60, 40, 60]); lastSecond = null; }
      if (now === "lock") { buzz(120); shake.add(0.5); if (soundOn) sound.slam(); }
      if (now === "done" && from && from !== "done") celebrate(p);
      renderCards(); renderSlip(); renderLive(); renderBanner();
    }
    if (now === "calls") {
      const left = Math.ceil((p.locks_at - serverNow()) / 1000);
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
    let html;
    if (ph === "calls") {
      const left = Math.max(0, Math.ceil((p.locks_at - serverNow()) / 1000));
      html = `<div class="b calls"><span class="big">Letzte<br>Einsätze</span><span class="n">${left}</span></div>`;
    } else if (ph === "lock" || ph === "spin") {
      const mine = p.payouts?.bets?.[String(state.me.id)];
      html = `<div class="b lock"><span class="big">Nichts geht mehr</span><span>${mine ? `${fmt(mine.stake)} auf ${esc(p.layout.names[String(mine.on)] ?? "?")}` : "ohne Einsatz"}</span></div>`;
    } else if (n < 2) {
      html = `<div class="b info">Sobald mindestens zwei Namen im Topf sind, geht es los.</div>`;
    } else {
      html = `<div class="b info"><span>Quote <b>×${n}</b>: Wer richtig liegt, bekommt das ${n}-fache. Treffer in Folge geben Bonus, Verlierer füttern den Jackpot.</span></div>`;
    }
    if ($("banner")._h !== html) { $("banner").innerHTML = html; $("banner")._h = html; }
  }

  let counting = false;
  function renderHud() {
    const t = total(), free = t - myStake, el = $("chips");
    if (shownTotal !== null && t !== shownTotal) {
      // Konto hat sich von außen geändert (Gewinn, Bank, Rettung): hochzählen
      counting = true;
      const up = t > shownTotal;
      countTo(el, Math.max(0, shownTotal - myStake), free, 900,
        { onStep: (_, u) => { if (soundOn && u > 0 && u < 1 && up) sound.score(Math.floor(u * 6)); } })
        .then(() => { counting = false; el.textContent = fmt(total() - myStake); });
      bump(el);
    } else if (!counting) el.textContent = fmt(free);
    shownTotal = t;
    const players = state.entrants.filter((e) => e.phone).sort((a, b) => (b.chips + b.stake) - (a.chips + a.stake));
    const rank = players.findIndex((e) => e.id === state.me.id) + 1;
    const st = state.me.streak;
    $("rank").innerHTML = `${players.length > 1 ? `Platz ${rank} von ${players.length}` : "Allein am Tisch"}${st ? `<span class="st">Serie ×${dec(multOf(st))}</span>` : ""}`;
  }

  function renderCards() {
    const open = bettingOpen();
    const list = pool();
    const ph = stagePhase(state.pick);
    const locked = ph === "lock" || ph === "spin";
    const on = locked ? (state.pick.payouts?.bets?.[String(state.me.id)]?.on ?? null) : myOn;
    const stake = locked ? (state.pick.payouts?.bets?.[String(state.me.id)]?.stake ?? 0) : myStake;
    const max = Math.max(1, ...list.map((e) => e.backed || 0));
    const html = list.length ? list.map((e, i) => {
      const others = (e.backers || 0) - (e.id === state.me.on && state.me.stake ? 1 : 0);
      return `<button class="card" role="radio" data-id="${e.id}" aria-checked="${e.id === on}" ${open ? "" : "disabled"} style="--i:${i}">
        ${e.id === on && stake ? `<span class="mine">${fmt(stake)}</span>` : ""}
        <span class="nm">${esc(e.name)}${e.id === state.me.id ? ` <small>(du)</small>` : ""}</span>
        <span class="crowd"><span>${others > 0 ? `${others} ${others === 1 ? "andere Wette" : "andere Wetten"}` : e.id === on && stake ? "nur du" : "noch frei"}</span><span class="t">${e.backed ? fmt(e.backed) : ""}</span></span>
        <span class="heat"><i style="width:${((e.backed || 0) / max) * 100}%"></i></span>
      </button>`;
    }).join("") : `<p class="note">Noch ist der Topf leer.</p>`;
    const c = $("cards");
    if (c._h !== html) {
      const first = !c._h;
      c.innerHTML = html; c._h = html;
      if (!first) c.querySelectorAll(".card").forEach((b) => { b.style.animation = "none"; });
    }
    c.classList.toggle("locked", !open);
  }

  function renderSlip() {
    const open = bettingOpen();
    const slip = $("slip");
    slip.classList.toggle("locked", !open);
    const n = pool().length;
    const t = total(), free = t - myStake;
    slip.querySelectorAll("[data-add]").forEach((b) => { b.disabled = !open || free < 1; });
    slip.querySelector("[data-all]").disabled = !open || free < 1;
    slip.querySelector("[data-clear]").disabled = !open || !myStake;
    const target = myOn && (state.entrants.find((e) => e.id === myOn)?.name ?? state.pick?.layout.names[String(myOn)]);
    const mult = multOf(state.me.streak);
    let html;
    if (!open) html = `<span class="on">Einsätze sind gesperrt</span>`;
    else if (!myOn) html = `<span class="on">Tipp einen Namen an, dann Chips drauf</span>`;
    else {
      const win = Math.round(myStake * n * mult);
      html = `<span class="on">auf <b>${esc(target ?? "?")}</b></span>
        <span class="calc"><span class="bx s">${fmt(myStake)}</span><span class="op">×</span><span class="bx q">${n}</span>
        ${mult > 1 ? `<span class="op">×</span><span class="bx m">${dec(mult)}</span>` : ""}<span class="op">=</span><span class="bx w">${fmt(win)}</span></span>`;
    }
    if ($("slipLine")._h !== html) { $("slipLine").innerHTML = html; $("slipLine")._h = html; }
  }

  function renderLive() {
    const p = state.pick, ph = stagePhase(p);
    const show = ph === "lock" || ph === "spin" || (ph === "done" && fresh(p));
    $("live").hidden = !show;
    if (show) {
      if (stageMode !== p.mode) {
        stage?.destroy();
        const old = $("canvas"), c = old.cloneNode(); old.replaceWith(c);
        stage = new STAGES[p.mode](c, p.mode, { sound: false });
        stage.onLand = () => buzz(30);
        stageMode = p.mode;
      }
      stage.show({ slots: p.layout.slots, names: p.layout.names, layout: p.layout, pick: p.locked ? p : null });
    }
    const v = $("verdict");
    if (ph === "done" && fresh(p) && p.locked) {
      if (v.dataset.pick !== String(p.id) || v.hidden) {
        v.dataset.pick = p.id;
        verdict(p, false);
      }
    } else v.hidden = true;
  }

  function verdict(p, animate) {
    const v = $("verdict");
    const mine = p.payouts?.bets?.[String(state.me.id)];
    const isMe = p.winner_id === state.me.id;
    v.className = "verdict panel" + (mine ? (mine.hit ? " hit" : " miss") : "") + (isMe ? " me" : "");
    let body = "";
    if (mine?.hit) {
      const gain = mine.win + mine.jp;
      body = `<p class="head">Treffer!</p><p class="amt" id="vAmt">+${fmt(animate ? 0 : gain)}</p>
        <p class="sub">${fmt(mine.stake)} × ${p.payouts.quote}${mine.mult > 1 ? ` × ${dec(mine.mult)}` : ""}${mine.jp ? ` + Jackpot ${fmt(mine.jp)}` : ""}</p>`;
    } else if (mine) {
      const tipped = p.layout.names[String(mine.on)] ?? "?";
      body = `<p class="head">Daneben</p><p class="amt">−${fmt(mine.stake)}</p>
        <p class="sub">Dein Tipp war ${esc(tipped)}.${mine.bail ? ` Die Bank hat Mitleid: ${fmt(mine.bail)} Chips geschenkt.` : " Dein Einsatz liegt jetzt im Jackpot."}</p>`;
    }
    v.innerHTML = `<p class="k">${isMe ? "Dich hat’s erwischt" : "Gezogen"}</p><p class="nm">${esc(p.winner)}</p>${body}`;
    v.hidden = false;
    return mine;
  }

  async function celebrate(p) {
    if (verdictFor === p.id) return;
    verdictFor = p.id;
    await sleep(60);
    const mine = verdict(p, true);
    const isMe = p.winner_id === state.me.id;
    const c = center($("verdict"));
    if (mine?.hit) {
      buzz([60, 50, 60, 50, 220]);
      shake.add(0.6);
      particles.burst(c.x, c.y, { n: 120, speed: 14, up: 8 });
      particles.burst(c.x, c.y, { n: 30, kind: "chip", speed: 12, up: 10 });
      if (soundOn) sound.kaching(true);
      const el = $("vAmt");
      await countTo(el, 0, mine.win + mine.jp, 1100, { format: (x) => "+" + fmt(x), onStep: (_, u) => { if (soundOn && u > 0 && u < 1) sound.score(Math.floor(u * 8)); } });
      bump(el);
    } else if (mine) {
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
  // Setzen: sofort zeigen, kurz gebündelt senden
  function change(on, stake, { from } = {}) {
    if (!bettingOpen()) return;
    const t = total();
    stake = on === null ? 0 : Math.max(0, Math.min(t, Math.round(stake)));
    const delta = stake - (on === myOn ? myStake : 0);
    myOn = stake ? on : null;
    myStake = stake;
    pending++;
    renderCards(); renderSlip();
    $("chips").textContent = fmt(t - myStake);
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
    clearTimeout(sendTimer);
    sendTimer = setTimeout(send, 220);
  }

  async function send() {
    try {
      await api(`/api/d/${code}/bet`, { token, entrant_id: myStake ? myOn : null, stake: myStake });
    } catch (err) {
      toast(err.message); buzz([40, 40, 40]); shake.add(0.25);
      pending = 0;
      render(await api(`/api/d/${code}/state?token=${encodeURIComponent(token)}`));
      return;
    }
    pending = 0;
  }

  function setupInput() {
    $("cards").onclick = (e) => {
      const b = e.target.closest(".card");
      if (!b || b.disabled) return;
      const id = +b.dataset.id;
      if (id === myOn) { change(null, 0); return; }               // nochmal tippen: zurücknehmen
      const t = total();
      change(id, myStake || Math.min(100, t), { from: b });
      bump(b);
    };
    $("slipChips").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b || b.disabled) return;
      if (b.dataset.clear !== undefined) { change(null, 0); return; }
      if (!myOn) {
        toast("Erst einen Namen antippen");
        $("cards").querySelectorAll(".card").forEach((c) => bump(c));
        buzz(30);
        return;
      }
      if (b.dataset.all !== undefined) { change(myOn, total(), { from: b }); shake.add(0.3); buzz([30, 30, 60]); return; }
      change(myOn, myStake + +b.dataset.add, { from: b });
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
