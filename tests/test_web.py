import json
import threading
import unittest
import urllib.error
import urllib.request

from auslosung.app import App
from auslosung.handler import Handler, Server
from auslosung.web import assets, pages

from .helpers import fresh


class WebTest(unittest.TestCase):
    def test_pages_and_assets(self):
        for kind in ("lobby", "host", "play"):
            self.assertIn(b"/static/js/main.js", pages.page(kind))
        self.assertIn(b"/static/admin/admin.js", pages.admin_page())
        self.assertIsNotNone(assets.read("js/main.js"))
        self.assertIn(b"@font-face", assets.read("css/fonts.css")[0])
        self.assertIsNone(assets.read("../db.py"))
        self.assertIsNone(assets.read("../../auslosung/db.py"))
        for f in ("js/stages/slots.js", "js/slot-sfx.js", "css/slots.css", "img/symbols.svg"):
            self.assertIsNotNone(assets.read(f), f)
        self.assertIsNone(assets.read("js/stages/roulette.js"))
        for kind in ("host", "play"):
            self.assertIn(b'id="sym-cherry"', pages.page(kind))
        self.assertIn(b"css/slots.css", pages.page("lobby"))

    def test_play_has_desktop_layout(self):
        html = pages.page("play")
        for hook in (b'class="col-stage"', b'class="col-pick"', b'id="banner"', b'id="cards"'):
            self.assertIn(hook, html)
        css = assets.read("css/play.css")[0]
        self.assertIn(b"@media (min-width: 900px)", css)
        self.assertIn(b".col-stage", css)


class ApiTest(unittest.TestCase):
    """Echter Server auf einem freien Port: Fehler müssen als JSON zurückkommen, nie als Abbruch."""

    @classmethod
    def setUpClass(cls):
        draws, cls.db = fresh()
        quiet = type("QuietHandler", (Handler,), {"log_message": lambda *a: None, "app": App(draws, 0, "http://test")})
        cls.httpd = Server(("127.0.0.1", 0), quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def post(self, path, body):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, raw, {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.load(e)

    def test_flow_and_bad_requests(self):
        status, d = self.post("/api/draws", {"title": "Test"})
        self.assertEqual(status, 200)
        code, key = d["code"], d["host_key"]
        self.assertEqual(self.post(f"/api/d/{code}/save", {"host_key": key})[0], 200)
        with urllib.request.urlopen(self.base + "/api/draws", timeout=5) as r:
            self.assertEqual([x["code"] for x in json.load(r)["draws"]], [code])
        for path, body in [(f"/api/d/{code}/join", b'"text"'), (f"/api/d/{code}/join", b"[]"),
                           (f"/api/d/{code}/remove", {"host_key": key, "entrant_id": None}),
                           (f"/api/d/{code}/rounds", {"host_key": key}),
                           ("/api/groups/delete", {}), ("/api/draws", {"group_id": "x"}),
                           (f"/api/d/{code}/join", b"{kaputt")]:
            status, data = self.post(path, body)
            self.assertEqual(status, 400, (path, body))
            self.assertIn("error", data)
        self.assertEqual(self.post(f"/api/d/{code}/pick", {"host_key": "falsch"})[0], 403)
        self.assertEqual(self.post("/api/d/ZZZZ/join", {"name": "Anna"})[0], 404)
