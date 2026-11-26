"""Kommandozeile: Server starten."""
from __future__ import annotations

import argparse
import secrets
from pathlib import Path

from .admin import Admin
from .app import App
from .db import Database
from .game.draws import Draws
from .handler import Handler, Server

DEFAULT_DB = Path.cwd() / "auslosung.db"


def main(argv=None):
    ap = argparse.ArgumentParser(prog="auslosung", description="Auslosung – Las-Vegas-Auslosung mit Wetten")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="Datenbankdatei (Standard: auslosung.db im aktuellen Ordner)")
    ap.add_argument("--url", help="Adresse im QR-Code, z. B. https://los.example.org")
    ap.add_argument("--admin", action="store_true", help="Verwaltung unter /admin einschalten")
    ap.add_argument("--admin-key", help="fester Schlüssel für die Verwaltung (sonst bei jedem Start neu)")
    ap.add_argument("--admin-lan", action="store_true", help="Verwaltung auch von anderen Geräten erreichbar")
    args = ap.parse_args(argv)

    db = Database(args.db)
    db.migrate()
    app = App(Draws(db), args.port, args.url)
    if args.admin_key or args.admin_lan:
        args.admin = True
    if args.admin:
        app.admin = Admin(db, app.draws)
        app.admin_key = args.admin_key or secrets.token_urlsafe(16)
        app.admin_lan = args.admin_lan
    Handler.app = app
    httpd = Server((args.host, args.port), Handler)
    print(f"\n  ★ Auslosung läuft\n"
          f"    Auf diesem Rechner: http://localhost:{args.port}/\n"
          f"    Im WLAN:            {args.url or f'http://{app.lan}:{args.port}'}/\n")
    if app.admin:
        where = f"http://{app.lan}:{args.port}" if app.admin_lan else f"http://localhost:{args.port}"
        print(f"  ⚙ Verwaltung:         {where}/admin#{app.admin_key}\n"
              f"    {'auch von anderen Geräten erreichbar' if app.admin_lan else 'nur von diesem Rechner aus'}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print()
