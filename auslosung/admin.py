"""Verwaltung (nur mit --admin): Datenbank-Manager unter /admin und /api/admin/…

Bewusst getrennt vom Spiel: eigene Klasse, eigenes HTML, CSS und JavaScript
(web/static/admin/). Ohne --admin gibt es keine einzige Route davon.

  --admin            Verwaltung einschalten (nur von diesem Rechner aus)
  --admin-key KEY    fester Schlüssel; sonst wird bei jedem Start einer erzeugt
  --admin-lan        Verwaltung auch von anderen Geräten im Netz erreichbar

Die Seite bekommt den Schlüssel einmalig im URL-Fragment (/admin#SCHLÜSSEL) und
schickt ihn danach als Kopfzeile X-Admin-Key mit. SQL-Abfragen laufen über eine
eigene, nur lesende Verbindung.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import tempfile
import time
from pathlib import Path
from http import HTTPStatus
from typing import TYPE_CHECKING

from .db import MIGRATIONS, Database
from .game.draws import Draws
from .game.rules import DrawError, clean_name, now_ms
from .web import pages

if TYPE_CHECKING:
    from .handler import Handler


class Admin:
    READ_ONLY_START = ("select", "with", "pragma", "explain", "values")

    def __init__(self, db: Database, draws: Draws):
        self.db, self.draws = db, draws

    # -- Überblick ----------------------------------------------------------
    def overview(self) -> dict:
        path = Path(self.db.path)
        size = lambda p: p.stat().st_size if p.exists() else 0
        v = self.db.value
        return {
            "path": str(path.resolve()),
            "size": size(path), "wal": size(Path(str(path) + "-wal")),
            "version": v("PRAGMA user_version"), "latest": max(n for n, _ in MIGRATIONS),
            "sqlite": sqlite3.sqlite_version,
            "pages": v("PRAGMA page_count"), "free_pages": v("PRAGMA freelist_count"),
            "counts": {t: v(f"SELECT COUNT(*) FROM {t}") for t in ("draws", "entrants", "picks")},
            "phones": v("SELECT COUNT(*) FROM entrants WHERE token IS NOT NULL"),
            "chips": v("SELECT COALESCE(SUM(chips + stake), 0) FROM entrants WHERE token IS NOT NULL"),
            "jackpots": v("SELECT COALESCE(SUM(jackpot), 0) FROM draws"),
            "first": v("SELECT MIN(created_at) FROM draws"),
            "last": v("SELECT MAX(t) FROM (SELECT MAX(created_at) t FROM draws UNION ALL SELECT MAX(ends_at) FROM picks)"),
        }

    def integrity(self) -> dict:
        return {"integrity": [r["integrity_check"] for r in self.db.all("PRAGMA integrity_check")],
                "foreign_keys": self.db.all("PRAGMA foreign_key_check")}

    def vacuum(self) -> dict:
        before = Path(self.db.path).stat().st_size
        with self.db._write_lock:
            self.db.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.db.conn.execute("VACUUM")
        return {"before": before, "after": Path(self.db.path).stat().st_size}

    def backup(self) -> bytes:
        """Konsistente Kopie der laufenden Datenbank (SQLite-Backup-API)."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "backup.db"
            dst = sqlite3.connect(target)
            with self.db._write_lock:
                self.db.conn.backup(dst)
            dst.close()
            return target.read_bytes()

    # -- Tische -------------------------------------------------------------
    def list_draws(self, q: str = "") -> list[dict]:
        like = f"%{q.strip()}%"
        return self.db.all(
            "SELECT d.id, d.code, d.title, d.mode, d.jackpot, d.created_at,"
            " (SELECT COUNT(*) FROM entrants e WHERE e.draw_id = d.id) AS entrants,"
            " (SELECT COUNT(*) FROM entrants e WHERE e.draw_id = d.id AND e.token IS NOT NULL) AS phones,"
            " (SELECT COUNT(*) FROM picks p WHERE p.draw_id = d.id) AS picks,"
            " MAX(d.created_at, COALESCE((SELECT MAX(ends_at) FROM picks p WHERE p.draw_id = d.id), 0)) AS active_at"
            " FROM draws d WHERE d.code LIKE ? OR d.title LIKE ? ORDER BY active_at DESC LIMIT 500", like, like)

    def draw(self, code: str) -> dict:
        d = self._get(code)
        picks = []
        for p in self.db.all("SELECT * FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 200", d["id"]):
            bets = json.loads(p["payouts"] or "{}").get("bets", {})
            picks.append({k: p[k] for k in ("id", "mode", "winner", "started_at", "ends_at", "cleared", "locked")}
                         | {"bets": len(bets), "staked": sum(b["stake"] for b in bets.values()),
                            "paid": sum(b["win"] + b["jp"] for b in bets.values()),
                            "hits": sum(1 for b in bets.values() if b["hit"])})
        return {"draw": {k: d[k] for k in ("code", "title", "mode", "jackpot", "created_at", "host_key")},
                "entrants": self.db.all("SELECT id, name, token IS NOT NULL AS phone, chips, stake, tip_id, streak,"
                                        " created_at FROM entrants WHERE draw_id = ? ORDER BY id", d["id"]),
                "picks": picks}

    def export(self, code: str) -> dict:
        d = self._get(code)
        rows = lambda t: self.db.all(f"SELECT * FROM {t} WHERE draw_id = ? ORDER BY id", d["id"])
        entrants = [{k: v for k, v in e.items() if k != "token"} | {"phone": e["token"] is not None}
                    for e in rows("entrants")]
        picks = [p | {k: json.loads(p[k]) for k in ("layout", "tips", "payouts")} for p in rows("picks")]
        return {"exported_at": now_ms(), "draw": {k: v for k, v in d.items() if k != "host_key"},
                "entrants": entrants, "picks": picks}

    def rename(self, code: str, title: str) -> None:
        title = " ".join((title or "").split())[:60]
        if not title:
            raise DrawError("Die Frage darf nicht leer sein")
        self.db.execute("UPDATE draws SET title = ? WHERE id = ?", title, self._get(code)["id"])

    def set_chips(self, code: str, entrant_id, chips) -> None:
        d = self._get(code)
        self.draws._not_drawing(d)
        chips = int(chips)
        if not 0 <= chips <= 10_000_000:
            raise DrawError("Chips zwischen 0 und 10 Millionen")
        self.db.execute("UPDATE entrants SET chips = ? WHERE id = ? AND draw_id = ?", chips, int(entrant_id), d["id"])

    def rename_entrant(self, code: str, entrant_id, name: str) -> None:
        d = self._get(code)
        name = clean_name(name)
        if self.db.value("SELECT 1 FROM entrants WHERE draw_id = ? AND name = ? COLLATE NOCASE AND id != ?",
                         d["id"], name, int(entrant_id)):
            raise DrawError(f"„{name}“ gibt es an diesem Tisch schon")
        self.db.execute("UPDATE entrants SET name = ? WHERE id = ? AND draw_id = ?", name, int(entrant_id), d["id"])

    def delete_draw(self, code: str) -> None:
        d = self._get(code)
        self.draws._not_drawing(d)
        self.db.execute("DELETE FROM draws WHERE id = ?", d["id"])     # Namen und Ziehungen fallen mit

    def purge(self, days) -> int:
        """Tische löschen, an denen seit `days` Tagen nichts passiert ist."""
        days = int(days)
        if days < 1:
            raise DrawError("Mindestens einen Tag")
        cutoff = now_ms() - days * 86_400_000
        old = [r["code"] for r in self.list_draws() if r["active_at"] < cutoff]
        for code in old:
            self.delete_draw(code)
        return len(old)

    def query(self, sql: str, limit: int = 500) -> dict:
        """Nur lesende Abfrage über eine eigene Verbindung, höchstens 3 Sekunden."""
        sql = (sql or "").strip().rstrip(";").strip()
        first = sql.split(None, 1)[0].lower() if sql else ""
        if first not in self.READ_ONLY_START:
            raise DrawError("Nur lesende Abfragen: SELECT, WITH, PRAGMA, EXPLAIN")
        conn = sqlite3.connect(f"file:{Path(self.db.path).resolve()}?mode=ro", uri=True, timeout=3)
        try:
            conn.execute("PRAGMA query_only = ON")
            deadline = time.monotonic() + 3
            conn.set_progress_handler(lambda: time.monotonic() > deadline, 10_000)
            t0 = time.perf_counter()
            try:
                cur = conn.execute(sql)
            except sqlite3.Error as e:
                raise DrawError(f"SQL: {e}") from None
            cols = [c[0] for c in cur.description or []]
            rows = cur.fetchmany(limit + 1)
            return {"columns": cols, "rows": [list(r) for r in rows[:limit]], "truncated": len(rows) > limit,
                    "ms": round((time.perf_counter() - t0) * 1000, 1)}
        finally:
            conn.close()

    def _get(self, code: str) -> dict:
        d = self.draws.get(code)
        if not d:
            raise LookupError("Diesen Tisch gibt es nicht")
        return d


def admin_route(handler: "Handler", method: str, parts: list[str], qs: dict) -> bool:
    """Bearbeitet /admin und /api/admin/…; False, wenn die Anfrage nicht dazugehört."""
    is_admin = parts[:1] == ["admin"] or parts[:2] == ["api", "admin"] or parts[:2] == ["static", "admin"]
    if not is_admin:
        return False
    app = handler.app
    local = handler.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
    if not app.admin or (not local and not app.admin_lan):
        handler.send_error(HTTPStatus.NOT_FOUND)
        return True
    if parts == ["admin"]:
        handler.send_body(pages.admin_page(), "text/html; charset=utf-8")
        return True
    if parts[0] == "static":
        handler.send_static("/".join(parts[1:]), qs)
        return True
    if not secrets.compare_digest(handler.headers.get("X-Admin-Key", ""), app.admin_key):
        handler.send_json({"error": "Falscher oder fehlender Schlüssel"}, 403)
        return True
    a: Admin = app.admin
    rest = parts[2:]
    try:
        data = {}
        if method == "POST":
            n = int(handler.headers.get("Content-Length") or 0)
            if n > 100_000:
                raise DrawError("Anfrage zu groß")
            data = json.loads(handler.rfile.read(n) or b"{}")
        if method == "GET":
            if rest == ["overview"]:
                return handler.send_json(a.overview()) or True
            if rest == ["draws"]:
                return handler.send_json({"draws": a.list_draws(qs.get("q", ""))}) or True
            if len(rest) == 2 and rest[0] == "draw":
                return handler.send_json(a.draw(rest[1])) or True
            if len(rest) == 3 and rest[0] == "draw" and rest[2] == "export":
                body = json.dumps(a.export(rest[1]), ensure_ascii=False, indent=1).encode()
                return handler.send_body(body, "application/json; charset=utf-8") or True
            if rest == ["backup"]:
                return handler.send_body(a.backup(), "application/vnd.sqlite3") or True
        else:
            if rest == ["integrity"]:
                return handler.send_json(a.integrity()) or True
            if rest == ["vacuum"]:
                return handler.send_json(a.vacuum()) or True
            if rest == ["purge"]:
                return handler.send_json({"deleted": a.purge(data.get("days", 0))}) or True
            if rest == ["sql"]:
                return handler.send_json(a.query(data.get("sql", ""))) or True
            if len(rest) == 3 and rest[0] == "draw":
                code, action = rest[1], rest[2]
                draw = a._get(code)
                eid = data.get("entrant_id")
                if action == "rename":
                    a.rename(code, data.get("title", ""))
                elif action == "mode":
                    app.draws.set_mode(draw, data.get("mode", ""))
                elif action == "bank":
                    app.draws.reset_bank(draw)
                elif action == "pot":
                    app.draws.reset(draw)
                elif action == "chips":
                    a.set_chips(code, eid, data.get("chips"))
                elif action == "entrant":
                    a.rename_entrant(code, eid, data.get("name", ""))
                elif action == "kick":
                    app.draws.remove(draw, eid)
                elif action == "delete":
                    a.delete_draw(code)
                    return handler.send_json({"ok": True}) or True
                else:
                    raise LookupError("Unbekannte Aktion")
                app.broadcast(draw["code"])          # offene Bildschirme sofort aktualisieren
                return handler.send_json({"ok": True}) or True
        handler.send_error(HTTPStatus.NOT_FOUND)
    except DrawError as e:
        handler.send_json({"error": str(e)}, 400)
    except LookupError as e:
        handler.send_json({"error": str(e)}, 404)
    except (ValueError, TypeError, json.JSONDecodeError):
        handler.send_json({"error": "Ungültige Anfrage"}, 400)
    return True
