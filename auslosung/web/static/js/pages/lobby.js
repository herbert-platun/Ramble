// Seite: Startseite (Tisch eröffnen, zuletzt besuchte Tische)
import { api, esc, store } from "../core.js";
import { Background } from "../fx.js";
import { Lights } from "../lights.js";

// =============================================================================
// Seite: Startseite
// =============================================================================
export async function lobbyPage() {
      new Background(document.getElementById("bg"));
      new Lights([...document.querySelectorAll(".bulbs")], 22);
      document.getElementById("create").onsubmit = async (e) => {
        e.preventDefault();
        const d = await api("/api/draws", { title: document.getElementById("title").value });
        location.href = `/host/${d.code}#${encodeURIComponent(d.host_key)}`;
      };
      const { draws } = await api("/api/draws");
      if (draws.length) {
        document.getElementById("recent").hidden = false;
        document.getElementById("recentList").innerHTML = draws.map((d) => `<li><a href="/host/${d.code}">
          <span class="code">${d.code}</span><span class="t">${esc(d.title)}<br><small>${d.entrants} ${d.entrants === 1 ? "Name" : "Namen"}</small></span>
          <span class="go">${store.get("host:" + d.code) ? "Öffnen" : "Ansehen"} →</span></a></li>`).join("");
      }

}
