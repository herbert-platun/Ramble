// Auslosung · Oberfläche
// Einstiegspunkt für Startseite, großen Bildschirm und Handy. <body data-page>
// entscheidet, welche Seite startet: lobby (Startseite), host (großer Bildschirm),
// play (Handy). Die Verwaltung (/admin) lädt zusätzlich admin/admin.js.
import { lobbyPage } from "./pages/lobby.js";
import { hostPage } from "./pages/host.js";
import { playPage } from "./pages/play.js";

const startPage = { lobby: lobbyPage, host: hostPage, play: playPage }[document.body.dataset.page];
if (startPage) startPage();
