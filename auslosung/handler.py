"""HTTP-Handler (Seiten, Statisches, JSON-API, Event-Stream) und Server, nur Standardbibliothek."""
from __future__ import annotations

import json
import queue
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .admin import admin_route
from .app import App, Client
from .game.draws import Draws
from .game.rules import DrawError, now_ms
from .web import assets, pages


class Handler(BaseHTTPRequestHandler):
    app: App
    server_version = "Auslosung/4.0"

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
                return self.send_json({"draws": self.draws.recent()})
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
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with self.app.lock:
            self.app.clients.add(c)
        self.app.broadcast(draw["code"])
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
            self.close_connection = True

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if admin_route(self, "POST", parts, {}):
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 10_000:
                raise DrawError("Anfrage zu groß")
            data = json.loads(self.rfile.read(n) or b"{}")
            if parts == ["api", "draws"]:
                d = self.draws.create(data.get("title", ""))
                return self.send_json({"code": d["code"], "host_key": d["host_key"]})
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
        except (ValueError, json.JSONDecodeError):
            self.send_json({"error": "Ungültige Anfrage"}, 400)

    def action(self, draw: dict, action: str, data: dict):
        d = self.draws
        if action == "join":
            return {"token": d.join(draw, data.get("name", ""))["token"]}
        if action == "bet":
            me = d.by_token(draw, data.get("token"))
            if not me:
                raise PermissionError("Unbekannt – bitte neu eintragen")
            return d.bet(draw, me, data.get("entrant_id"), data.get("stake"))
        if data.get("host_key") != draw["host_key"]:     # ab hier nur der Host
            raise PermissionError("Nur der Host darf das")
        if action == "add":
            d.join(draw, data.get("name", ""), by_host=True)
        elif action == "remove":
            d.remove(draw, data.get("entrant_id"))
        elif action == "mode":
            d.set_mode(draw, data.get("mode", ""))
        elif action == "pick":
            p = d.pick(d.get(draw["code"]))
            # Bei „Nichts geht mehr“ ziehen und senden, nach dem Ende noch einmal
            for at in (p["locks_at"] + 60, p["ends_at"] + 200):
                timer = threading.Timer(max(0, at - now_ms()) / 1000, self.app.broadcast, args=(draw["code"],))
                timer.daemon = True
                timer.start()
        elif action == "reset":
            d.reset(draw)
        elif action == "bank":
            d.reset_bank(draw)
        else:
            raise LookupError("Unbekannte Aktion")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# =============================================================================
# 4  Selbsttest
