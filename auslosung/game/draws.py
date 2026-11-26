"""Tische, Teilnehmer, Wetten, Ziehung und Abrechnung (alles, was die Datenbank anfasst).

Ablauf einer Ziehung (Server-Millisekunden):
  pick()      Host drückt „Ziehen“. Topf wird eingefroren, Name steht noch NICHT fest.
  locks_at    „Nichts geht mehr“: settle() zieht mit `secrets` (jeder im Topf hat
              dieselbe Chance, Einsätze ändern daran nichts) und rechnet ab.
  started_at  Animation beginnt und landet dort, wo der Server entschieden hat.
  ends_at     Ergebnis.
Weil erst bei locks_at gezogen wird, steht der Name vorher nirgends im Netzwerkverkehr.
"""
from __future__ import annotations

import json
import secrets

from ..db import Database
from .plinko import plinko_duration, plinko_path, plinko_shape
from .rules import (BAILOUT, CALLS, CODE_ALPHABET, DURATION, LOCK, MODES, START_CHIPS,
                    DrawError, clean_name, now_ms, settle_bets)


class Draws:
    def __init__(self, db: Database):
        self.db = db

    # -- Tisch --------------------------------------------------------------
    def create(self, title: str) -> dict:
        title = " ".join((title or "").split())[:60] or "Wer wird gezogen?"
        with self.db.transaction() as tx:
            while True:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
                if not tx.value("SELECT 1 FROM draws WHERE code = ?", code):
                    break
            tx.insert("INSERT INTO draws(code, title, host_key, created_at) VALUES (?,?,?,?)",
                      code, title, secrets.token_urlsafe(18), now_ms())
        return self.get(code)

    def get(self, code: str) -> dict | None:
        return self.db.one("SELECT * FROM draws WHERE code = ?", (code or "").upper())

    def recent(self) -> list[dict]:
        return self.db.all("SELECT d.code, d.title, d.created_at,"
                           " (SELECT COUNT(*) FROM entrants e WHERE e.draw_id = d.id) AS entrants"
                           " FROM draws d ORDER BY d.id DESC LIMIT 8")

    def set_mode(self, draw: dict, mode: str) -> None:
        if mode not in MODES:
            raise DrawError("Unbekannte Art der Ziehung")
        self._not_drawing(draw)
        self.db.execute("UPDATE draws SET mode = ? WHERE id = ?", mode, draw["id"])

    # -- Teilnehmer ---------------------------------------------------------
    def join(self, draw: dict, name: str, by_host: bool = False) -> dict:
        name = clean_name(name)
        with self.db.transaction() as tx:
            if tx.value("SELECT 1 FROM entrants WHERE draw_id = ? AND name = ? COLLATE NOCASE", draw["id"], name):
                raise DrawError(f"„{name}“ ist schon im Topf")
            if tx.value("SELECT COUNT(*) FROM entrants WHERE draw_id = ?", draw["id"]) >= 200:
                raise DrawError("Der Topf ist voll")
            eid = tx.insert("INSERT INTO entrants(draw_id, name, token, created_at, chips) VALUES (?,?,?,?,?)",
                            draw["id"], name, None if by_host else secrets.token_urlsafe(24), now_ms(), START_CHIPS)
        return self.db.one("SELECT * FROM entrants WHERE id = ?", eid)

    def by_token(self, draw: dict, token: str | None) -> dict | None:
        if not token:
            return None
        return self.db.one("SELECT * FROM entrants WHERE token = ? AND draw_id = ?", token, draw["id"])

    def remove(self, draw: dict, entrant_id: int) -> None:
        self._not_drawing(draw)
        eid = int(entrant_id)
        with self.db.transaction() as tx:
            # Wer auf diesen Namen gesetzt hat, bekommt den Einsatz zurück
            tx.execute("UPDATE entrants SET chips = chips + stake, stake = 0, tip_id = NULL"
                       " WHERE draw_id = ? AND tip_id = ?", draw["id"], eid)
            tx.execute("DELETE FROM entrants WHERE id = ? AND draw_id = ?", eid, draw["id"])

    def entrants(self, draw: dict) -> list[dict]:
        return self.db.all("SELECT id, name, token IS NOT NULL AS phone, tip_id, stake, chips, streak"
                           " FROM entrants WHERE draw_id = ? ORDER BY id", draw["id"])

    def picked_ids(self, draw: dict) -> set[int]:
        return {r["winner_id"] for r in self.db.all(
            "SELECT winner_id FROM picks WHERE draw_id = ? AND cleared = 0 AND locked = 1"
            " AND winner_id IS NOT NULL", draw["id"])}

    # -- Wetten -------------------------------------------------------------
    def bet(self, draw: dict, me: dict, entrant_id, stake) -> dict:
        """Setzt `stake` Chips auf `entrant_id`. Ohne Ziel oder mit 0 wird zurückgenommen."""
        with self.db.transaction() as tx:
            me = tx.one("SELECT * FROM entrants WHERE id = ?", me["id"])
            pick = tx.one("SELECT * FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
            t = now_ms()
            calls = bool(pick) and not pick["locked"] and t < pick["locks_at"]
            if pick and pick["ends_at"] > t and not calls:
                raise DrawError("Nichts geht mehr")
            total = me["chips"] + me["stake"]
            stake = int(stake or 0)
            if entrant_id is None or stake <= 0:
                tx.execute("UPDATE entrants SET chips = ?, stake = 0, tip_id = NULL WHERE id = ?", total, me["id"])
                return {"chips": total, "stake": 0}
            eid = int(entrant_id)
            if calls:
                pool = set(json.loads(pick["layout"])["slots"])
            else:
                picked = {r["winner_id"] for r in tx.all(
                    "SELECT winner_id FROM picks WHERE draw_id = ? AND cleared = 0 AND locked = 1", draw["id"])}
                pool = {r["id"] for r in tx.all("SELECT id FROM entrants WHERE draw_id = ?", draw["id"])} - picked
            if eid not in pool:
                raise DrawError("Dieser Name ist nicht mehr im Topf")
            if stake > total:
                raise DrawError("So viele Chips hast du nicht")
            tx.execute("UPDATE entrants SET chips = ?, stake = ?, tip_id = ? WHERE id = ?",
                       total - stake, stake, eid, me["id"])
            return {"chips": total - stake, "stake": stake}

    def reset_bank(self, draw: dict) -> None:
        """Neues Spiel: alle Konten zurück auf Start, Jackpot leer."""
        self._not_drawing(draw)
        with self.db.transaction() as tx:
            tx.execute("UPDATE entrants SET chips = ?, stake = 0, tip_id = NULL, streak = 0 WHERE draw_id = ?",
                       START_CHIPS, draw["id"])
            tx.execute("UPDATE draws SET jackpot = 0 WHERE id = ?", draw["id"])

    # -- Ziehen -------------------------------------------------------------
    def latest(self, draw: dict) -> dict | None:
        p = self.db.one("SELECT * FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
        if p:
            p["layout"] = json.loads(p["layout"])
            p["tips"] = json.loads(p["tips"])
            p["payouts"] = json.loads(p["payouts"] or "{}")
        return p

    def winners(self, draw: dict) -> list[dict]:
        return self.db.all("SELECT id, winner, winner_id, ends_at FROM picks WHERE draw_id = ?"
                           " AND cleared = 0 AND locked = 1 ORDER BY id", draw["id"])

    def pick(self, draw: dict) -> dict:
        """Startet eine Ziehung: Topf einfrieren, letzte Einsätze laufen lassen."""
        with self.db.transaction() as tx:
            last = tx.one("SELECT ends_at FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
            t = now_ms()
            if last and last["ends_at"] > t:
                raise DrawError("Es wird gerade gezogen")
            draw = tx.one("SELECT * FROM draws WHERE id = ?", draw["id"])
            picked = {r["winner_id"] for r in tx.all(
                "SELECT winner_id FROM picks WHERE draw_id = ? AND cleared = 0 AND locked = 1", draw["id"])}
            everyone = tx.all("SELECT * FROM entrants WHERE draw_id = ? ORDER BY id", draw["id"])
            pool = [e for e in everyone if e["id"] not in picked]
            if len(pool) < 2:
                raise DrawError("Für eine Ziehung braucht es mindestens zwei Namen im Topf")
            mode = draw["mode"]
            slots = [e["id"] for e in pool]          # ein Feld pro Name, in Eintragsreihenfolge
            layout = {"slots": slots, "names": {e["id"]: e["name"] for e in pool}}
            duration = DURATION.get(mode)
            if mode == "plinko":
                per, rows = plinko_shape(len(slots))
                layout.update(per=per, rows=rows)
                duration = plinko_duration(rows)
            calls = CALLS if any(e["token"] for e in everyone) else 0
            locks_at = t + calls
            started_at = locks_at + LOCK
            pid = tx.insert("INSERT INTO picks(draw_id, mode, winner_id, winner, slot, layout, tips, started_at,"
                            " ends_at, locks_at, locked) VALUES (?,?,NULL,'',0,?,'{}',?,?,?,0)",
                            draw["id"], mode, json.dumps(layout), started_at, started_at + duration, locks_at)
        if not calls:
            self.settle(draw)
        return self.db.one("SELECT * FROM picks WHERE id = ?", pid)

    def settle(self, draw: dict) -> bool:
        """„Nichts geht mehr“: ziehen und abrechnen, sobald locks_at erreicht ist. Idempotent."""
        with self.db.transaction() as tx:
            p = tx.one("SELECT * FROM picks WHERE draw_id = ? AND locked = 0 ORDER BY id DESC LIMIT 1", draw["id"])
            if not p or p["locks_at"] > now_ms():
                return False
            layout = json.loads(p["layout"])
            slots = layout["slots"]
            winner_id = secrets.choice(slots)
            slot = slots.index(winner_id)
            winner = layout["names"][str(winner_id)]
            if p["mode"] == "plinko":
                column = slot * layout["per"] + secrets.randbelow(layout["per"])
                layout.update(plinko_path(len(slots) * layout["per"], column, layout["rows"]))
            bettors = tx.all("SELECT id, tip_id, stake, streak, chips FROM entrants"
                             " WHERE draw_id = ? AND tip_id IS NOT NULL AND stake > 0", draw["id"])
            jackpot = tx.value("SELECT jackpot FROM draws WHERE id = ?", draw["id"]) or 0
            result = settle_bets({b["id"]: (b["tip_id"], b["stake"], b["streak"]) for b in bettors},
                                 winner_id, len(slots), jackpot)
            for b in bettors:
                r = result["bets"][b["id"]]
                chips = b["chips"] + r["win"] + r["jp"]
                if chips <= 0:
                    r["bail"] = chips = BAILOUT
                tx.execute("UPDATE entrants SET chips = ?, stake = 0, tip_id = NULL, streak = ? WHERE id = ?",
                           chips, r["streak"], b["id"])
            tx.execute("UPDATE draws SET jackpot = ? WHERE id = ?", result["jackpot_after"], draw["id"])
            tx.execute("UPDATE picks SET winner_id = ?, winner = ?, slot = ?, layout = ?, tips = ?, payouts = ?,"
                       " locked = 1 WHERE id = ?", winner_id, winner, slot, json.dumps(layout),
                       json.dumps({b["id"]: b["tip_id"] for b in bettors}), json.dumps(result), p["id"])
        return True

    def reset(self, draw: dict) -> None:
        """Alle Gezogenen kommen zurück in den Topf."""
        self._not_drawing(draw)
        self.db.execute("UPDATE picks SET cleared = 1 WHERE draw_id = ?", draw["id"])

    def _not_drawing(self, draw: dict) -> None:
        end = self.db.value("SELECT MAX(ends_at) FROM picks WHERE draw_id = ?", draw["id"])
        if end and end > now_ms():
            raise DrawError("Bitte warten, bis die Ziehung vorbei ist")
