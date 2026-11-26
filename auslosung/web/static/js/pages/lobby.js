// Seite: Startseite (Tisch eröffnen, mit oder ohne Gruppe; gespeicherte Tische; Gruppen)
import { api, esc, store, toast } from "../core.js";
import { Background } from "../fx.js";
import { Lights } from "../lights.js";

// =============================================================================
// Seite: Startseite
// =============================================================================
export async function lobbyPage() {
  const $ = (id) => document.getElementById(id);
  new Background($("bg"));
  new Lights([...document.querySelectorAll(".bulbs")], 22);
  let group = null;

  $("create").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api("/api/draws", { title: $("title").value, group_id: group });
      location.href = `/host/${d.code}#${encodeURIComponent(d.host_key)}`;
    } catch (err) { toast(err.message); }
  };

  async function load() {
    const { draws, groups } = await api("/api/draws");
    $("recent").hidden = !draws.length;
    $("recentList").innerHTML = draws.map((d) => `<li><a href="/host/${d.code}">
      <span class="code">${d.code}</span><span class="t">${esc(d.title)}<br><small>${d.entrants} ${d.entrants === 1 ? "Name" : "Namen"}${d.grp ? ` · ${esc(d.grp)}` : ""}</small></span>
      <span class="go">${store.get("host:" + d.code) ? "Öffnen" : "Ansehen"} →</span></a></li>`).join("");

    if (!groups.some((g) => g.id === group)) group = null;
    $("groupPick").hidden = !groups.length;
    const opt = (id, label, sub) => `<button type="button" class="gopt" data-g="${id ?? ""}" aria-pressed="${id === group}">
      <b>${label}</b>${sub ? `<small>${sub}</small>` : ""}</button>`;
    $("groupOpts").innerHTML = opt(null, "Ohne", "leerer Topf")
      + groups.map((g) => opt(g.id, esc(g.name), `${g.members.length} ${g.members.length === 1 ? "Name" : "Namen"}`)).join("");

    $("saved").hidden = !groups.length;
    $("groupList").innerHTML = groups.map((g) => `<li class="grow"><span class="t"><b>${esc(g.name)}</b><br>
      <small>${esc(g.members.slice(0, 8).join(", "))}${g.members.length > 8 ? ` und ${g.members.length - 8} weitere` : ""}</small></span>
      <button type="button" class="del" data-del="${g.id}" aria-label="Gruppe ${esc(g.name)} löschen">Löschen</button></li>`).join("");
  }

  $("groupOpts").onclick = (e) => {
    const b = e.target.closest("[data-g]");
    if (!b) return;
    group = b.dataset.g ? +b.dataset.g : null;
    $("groupOpts").querySelectorAll("[data-g]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  };
  $("groupList").onclick = async (e) => {
    const b = e.target.closest("[data-del]");
    if (!b) return;
    if (!b.dataset.armed) {           // zweimal klicken, damit es kein Versehen ist
      b.dataset.armed = "1"; b.textContent = "Wirklich?";
      setTimeout(() => { delete b.dataset.armed; b.textContent = "Löschen"; }, 3000);
      return;
    }
    try { await api("/api/groups/delete", { id: +b.dataset.del }); toast("Gruppe gelöscht. Tische bleiben."); }
    catch (err) { toast(err.message); }
    load();
  };
  await load();
}
