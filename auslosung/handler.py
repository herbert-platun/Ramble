"""HTTP-Handler (Seiten, Statisches, JSON-API, Event-Stream) und Server, nur Standardbibliothek."""
from __future__ import annotations

import json
import queue
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import __version__
from .admin import admin_route
from .app import App, Client
from .game.draws import Draws
from .game.rules import DrawError
from .web import assets, pages


class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = f"Auslosung/{__version__}"
    # Verbindung offen halten, sonst kostet jeder Klick einen neuen Verbindungsaufbau
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True      # Kopf und Rumpf nicht auf die Bestätigung warten lassen
    timeout = 60                        # ungenutzte Verbindungen wieder schließen

    def handle_one_request(self):
        self.command = None             # sonst wird das Schließen nach einem POST als Fehler protokolliert
        super().handle_one_request()

    def end_headers(self):
        if self.close_connection:
            self.send_header("Connection", "close")
        super().end_headers()

    def log_message(self, fmt, *args):
        if self.command == "POST":
            sys.stderr.write("· %s\n" % (fmt % args))

    @property
    def draws(self) -> Draws:
        return self.app.draws

    def base_url(self) -> str:
        if self.app.public_url:
            return self.app.public_url.rstrip("/")
        host = self.headers.get("Host", f"localhost:{self.app.port}")
        if host.rsplit(":", 1)[0] in ("localhost", "127.0.0.1", "[::1]", "0.0.0.0"):
            return f"http://{self.app.lan}:{self.app.port}"
        return f"http://{host}"

    def send_body(self, body: bytes, ctype: str, status=200, cache=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, rel: str, query: dict) -> None:
        """Datei aus web/static. Mit ?v=… (Versionshash) unbegrenzt cachebar, sonst mit ETag prüfen lassen."""
        asset = assets.read(rel)
        if asset is None:
            return self.send_error(HTTPStatus.NOT_FOUND)
        body, ctype, etag = asset
        if self.headers.get("If-None-Match") == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", etag)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if "v" in query else "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, data, status=200):
        self.send_body(json.dumps(data).encode(), "application/json; charset=utf-8", status)

    def draw_or_404(self, code: str) -> dict:
        d = self.draws.get(code)
        if not d:
            raise LookupError("Diesen Tisch gibt es nicht")
        return d

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        if admin_route(self, "GET", parts, qs):
            return
        try:
            if not parts:
                return self.send_body(pages.page("lobby"), "text/html; charset=utf-8")
            if parts[0] in ("host", "t") and len(parts) == 2:
                self.draw_or_404(parts[1])
                return self.send_body(pages.page("host" if parts[0] == "host" else "play"), "text/html; charset=utf-8")
            if parts[0] == "static" and len(parts) > 1:
                return self.send_static("/".join(parts[1:]), qs)
            if parts == ["favicon.ico"]:
                return self.send_static("favicon.svg", {"v": 1})
            if parts == ["api", "draws"]:
                return self.send_json({"draws": self.draws.recent(), "groups": self.draws.groups()})
            if len(parts) == 4 and parts[:2] == ["api", "d"]:
                draw = self.draw_or_404(parts[2])
                if parts[3] == "state":
                    return self.send_json(self.app.personal(self.app.public(draw), draw, qs.get("token"),
                                                            self.base_url()))
                if parts[3] == "events":
                    return self.stream(draw, qs.get("token"))
            self.send_error(HTTPStatus.NOT_FOUND)
        except LookupError as e:
            self.send_json({"error": str(e)}, 404)

    def stream(self, draw: dict, token: str | None):
        c = Client(draw["code"], token, self.base_url())
        self.close_connection = True        # ein Stream hat kein Ende, an dem es weitergehen könnte
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with self.app.lock:
            self.app.clients.add(c)
            running = draw["code"] in self.app.timers
        self.app.broadcast(draw["code"])
        if not running:          # z. B. nach einem Neustart mitten in einer Session
            self.app.schedule(draw["code"])
        try:
            self.wfile.write(b"retry: 1500\n\n")
            while True:
                try:
                    self.wfile.write(f"data: {c.q.get(timeout=15)}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except OSError:
            pass
        finally:
            with self.app.lock:
                self.app.clients.discard(c)

    def do_POST(self):
        keep = not self.close_connection
        self.close_connection = True        # erst wieder offen, wenn der Rumpf gelesen ist (read_json)
        self.keep = keep
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if admin_route(self, "POST", parts, {}):
            return
        try:
            data = read_json(self, 10_000)
            if parts == ["api", "draws"]:
                d = self.draws.create(data.get("title", ""), data.get("group_id"))
                return self.send_json({"code": d["code"], "host_key": d["host_key"]})
            if parts == ["api", "groups", "delete"]:
                self.draws.delete_group(data.get("id"))
                return self.send_json({"ok": True})
            if len(parts) != 4 or parts[:2] != ["api", "d"]:
                return self.send_error(HTTPStatus.NOT_FOUND)
            draw = self.draw_or_404(parts[2])
            result = self.action(draw, parts[3], data) or {"ok": True}
            self.app.broadcast(draw["code"])
            self.send_json(result)
        except DrawError as e:
            self.send_json({"error": str(e)}, 400)
        except PermissionError as e:
            self.send_json({"error": str(e)}, 403)
        except LookupError as e:
            self.send_json({"error": str(e)}, 404)
        except (ValueError, TypeError):
            self.send_json({"error": "Ungültige Anfrage"}, 400)

    def action(self, draw: dict, action: str, data: dict):
        d = self.draws
        if action == "join":
            e = d.join(draw, data.get("name", ""))
            return {"token": e["token"], "claimed": bool(e.get("claimed"))}
        if action in ("tip", "wager"):
            me = d.by_token(draw, data.get("token"))
            if not me:
                raise PermissionError("Unbekannt – bitte neu eintragen")
            if action == "tip":
                return d.tip(draw, me, data.get("entrant_id"))
            return d.wager(draw, me, data.get("wagers"))
        if data.get("host_key") != draw["host_key"]:     # ab hier nur der Host
            raise PermissionError("Nur der Host darf das")
        if action == "add":
            d.join(draw, data.get("name", ""), by_host=True)
        elif action == "remove":
            d.remove(draw, data.get("entrant_id"))
        elif action == "mode":
            d.set_mode(draw, data.get("mode", ""))
        elif action == "rounds":
            d.set_rounds(draw, data.get("rounds"))
        elif action == "pick":
            d.pick(d.get(draw["code"]))
            self.app.schedule(draw["code"])
        elif action == "group":
            return d.save_group(draw, data.get("name", ""))
        elif action == "save":
            d.set_saved(draw, bool(data.get("saved", True)))
        elif action == "reset":
            d.reset(draw)
        elif action == "bank":
            d.reset_bank(draw)
        else:
            raise LookupError("Unbekannte Aktion")


def read_json(handler: BaseHTTPRequestHandler, limit: int) -> dict:
    """JSON-Objekt aus dem Rumpf der Anfrage. Alles andere ist eine ungültige Anfrage."""
    n = int(handler.headers.get("Content-Length") or 0)
    if not 0 <= n <= limit:
        raise DrawError("Anfrage zu groß")
    raw = handler.rfile.read(n)
    handler.close_connection = not handler.keep
    data = json.loads(raw or b"{}")
    if not isinstance(data, dict):
        raise ValueError("JSON-Objekt erwartet")
    return data


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

