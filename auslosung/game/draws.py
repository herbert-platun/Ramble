"""Tische, Gruppen, Teilnehmer, Tipps, Wetten, Ziehung und Abrechnung (alles, was die Datenbank anfasst).

Ablauf einer Ziehung (Server-Millisekunden):
  pick()      Host drückt „Ziehen“. Topf wird eingefroren, Name steht noch NICHT fest.
  locks_at    „Nichts geht mehr“: settle() zieht mit `secrets` (jeder im Topf hat
              dieselbe Chance, Tipps und Einsätze ändern daran nichts) und rechnet ab.
  started_at  Animation beginnt und landet dort, wo der Server entschieden hat.
  ends_at     Ergebnis.
Weil erst bei locks_at gezogen wird, steht der Name vorher nirgends im Netzwerkverkehr.

Slots laufen als Session aus mehreren Runden (Tabelle rounds). Jede Runde hat ihr
eigenes Fenster für Einsätze (calls_at … locks_at) und wird erst bei ihrem locks_at
gedreht. Gezogen ist am Ende, wer über alle Runden die meisten Punkte hat.
"""
from __future__ import annotations

import json
import secrets

from ..db import Database
from . import slots
from .plinko import plinko_duration, plinko_path, plinko_shape
from .rules import (CALLS, CODE_ALPHABET, DURATION, LOCK, MODES, SLOT_BREAK, SLOT_CALLS, START_CHIPS, TIP_BONUS,
                    DrawError, clean_name, now_ms)

FAR = 6 * 3600 * 1000       # vorläufiges Ende einer Slot-Session, bis die letzte Runde feststeht
UNSAVED_TTL = 12 * 3600 * 1000   # so lange bleibt ein ungespeicherter Tisch ohne Aktivität


def clean_group(name: str) -> str:
    name = " ".join(str(name or "").split())[:40]
    if len(name) < 2:
        raise DrawError("Die Gruppe braucht einen Namen")
    return name


def session_points(results: list[dict]) -> dict[int, int]:
    """Punkte je Name über alle gedrehten Runden einer Session."""
    out: dict[int, int] = {}
    for res in results:
        for i, v in res["pts"].items():
            out[int(i)] = out.get(int(i), 0) + v
    return out


def session_balance(books: list[dict]) -> dict:
    """Chip-Bilanz einer Session je Wetter aus den Auszahlungen aller Runden.

    {"net": {id: gewonnen − gesetzt}, "staked": {id: gesetzt}, "won": {id: gewonnen}}
    """
    staked: dict[int, int] = {}
    won: dict[int, int] = {}
    for book in books:
        for b, x in book.items():
            b = int(b)
            staked[b] = staked.get(b, 0) + sum(x["stakes"].values())
            won[b] = won.get(b, 0) + x["win"]
    return {"net": {b: won[b] - staked[b] for b in staked}, "staked": staked, "won": won}


class Draws:
    def __init__(self, db: Database):
        self.db = db

    # -- Tisch --------------------------------------------------------------
    def create(self, title: str, group_id=None) -> dict:
        title = " ".join(str(title or "").split())[:60] or "Wer wird gezogen?"
        self.purge_unsaved()
        t = now_ms()
        with self.db.transaction() as tx:
            group = tx.one("SELECT * FROM groups WHERE id = ?", int(group_id)) if group_id else None
            if group_id and not group:
                raise DrawError("Diese Gruppe gibt es nicht mehr")
            while True:
                code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(4))
                if not tx.value("SELECT 1 FROM draws WHERE code = ?", code):
                    break
            did = tx.insert("INSERT INTO draws(code, title, host_key, created_at, group_id) VALUES (?,?,?,?,?)",
                            code, title, secrets.token_urlsafe(18), t, group and group["id"])
            if group:
                for m in tx.all("SELECT * FROM members WHERE group_id = ? ORDER BY id", group["id"]):
                    tx.execute("INSERT INTO entrants(draw_id, name, token, created_at, chips, member_id)"
                               " VALUES (?,?,NULL,?,?,?)", did, m["name"], t, START_CHIPS, m["id"])
                tx.execute("UPDATE groups SET used_at = ? WHERE id = ?", t, group["id"])
                self._store_skins(tx, did)
        return self.get(code)

    def get(self, code: str) -> dict | None:
        return self.db.one("SELECT * FROM draws WHERE code = ?", (code or "").upper())

    def recent(self) -> list[dict]:
        """Gespeicherte Tische für die Startseite. Ungespeicherte tauchen dort nicht auf."""
        return self.db.all("SELECT d.code, d.title, d.created_at, d.mode, g.name AS grp,"
                           " (SELECT COUNT(*) FROM entrants e WHERE e.draw_id = d.id) AS entrants"
                           " FROM draws d LEFT JOIN groups g ON g.id = d.group_id WHERE d.saved = 1"
                           " ORDER BY d.id DESC LIMIT 12")

    def set_saved(self, draw: dict, saved: bool) -> None:
        self.db.execute("UPDATE draws SET saved = ? WHERE id = ?", int(saved), draw["id"])

    def purge_unsaved(self, idle_ms: int = UNSAVED_TTL) -> int:
        """Ungespeicherte Tische löschen, an denen seit `idle_ms` nichts passiert ist."""
        cutoff = now_ms() - idle_ms
        return self.db.execute(
            "DELETE FROM draws WHERE saved = 0 AND created_at < ? AND NOT EXISTS"
            " (SELECT 1 FROM picks p WHERE p.draw_id = draws.id AND p.ends_at >= ?)"
            " AND NOT EXISTS (SELECT 1 FROM entrants e WHERE e.draw_id = draws.id AND e.created_at >= ?)",
            cutoff, cutoff, cutoff).rowcount

    def set_mode(self, draw: dict, mode: str) -> None:
        if mode not in MODES:
            raise DrawError("Unbekannte Art der Ziehung")
        self._not_drawing(draw)
        with self.db.transaction() as tx:
            if mode != "slots":        # Einsätze gibt es nur bei Slots, Tipps nur sonst
                self._refund_wagers(tx, draw)
            else:
                tx.execute("UPDATE entrants SET tip_id = NULL WHERE draw_id = ?", draw["id"])
            tx.execute("UPDATE draws SET mode = ? WHERE id = ?", mode, draw["id"])

    def set_rounds(self, draw: dict, rounds) -> None:
        rounds = int(rounds)
        if rounds not in slots.SESSION_ROUNDS:
            raise DrawError("1, 3, 5 oder 7 Runden")
        self._not_drawing(draw)
        self.db.execute("UPDATE draws SET rounds = ? WHERE id = ?", rounds, draw["id"])

    # -- Gruppen ------------------------------------------------------------
    def groups(self) -> list[dict]:
        out = self.db.all("SELECT id, name, used_at FROM groups ORDER BY used_at DESC, id DESC")
        names: dict[int, list[str]] = {}
        for m in self.db.all("SELECT group_id, name FROM members ORDER BY id"):
            names.setdefault(m["group_id"], []).append(m["name"])
        for g in out:
            g["members"] = names.get(g["id"], [])
        return out

    def delete_group(self, group_id) -> None:
        """Gruppe weg; Tische und ihre Namen bleiben, nur die Verbindung fällt."""
        if not self.db.execute("DELETE FROM groups WHERE id = ?", int(group_id)).rowcount:
            raise DrawError("Diese Gruppe gibt es nicht mehr")

    def save_group(self, draw: dict, name: str) -> dict:
        """Namen dieses Tischs als Gruppe speichern. Gleicher Gruppenname: wird überschrieben."""
        name = clean_group(name)
        t = now_ms()
        with self.db.transaction() as tx:
            draw = tx.one("SELECT * FROM draws WHERE id = ?", draw["id"])
            entrants = self._entrants(tx, draw)
            if not entrants:
                raise DrawError("Erst Namen eintragen, dann speichern")
            group = tx.one("SELECT * FROM groups WHERE name = ? COLLATE NOCASE", name)
            if not group and draw["group_id"]:
                group = tx.one("SELECT * FROM groups WHERE id = ?", draw["group_id"])
            if group:
                gid = group["id"]
                if tx.value("SELECT 1 FROM groups WHERE name = ? COLLATE NOCASE AND id != ?", name, gid):
                    raise DrawError(f"Eine Gruppe „{name}“ gibt es schon")
                tx.execute("UPDATE groups SET name = ?, used_at = ? WHERE id = ?", name, t, gid)
            else:
                gid = tx.insert("INSERT INTO groups(name, created_at, used_at) VALUES (?,?,?)", name, t, t)
            members = {m["id"]: m for m in tx.all("SELECT * FROM members WHERE group_id = ?", gid)}
            by_name = {m["name"].casefold(): m for m in members.values()}
            skins = slots.assign_skins(entrants)
            keep = set()
            for e in entrants:
                m = members.get(e["member_id"]) or by_name.get(e["name"].casefold())
                sym, acc = skins[e["id"]]
                if m and m["id"] not in keep:
                    tx.execute("UPDATE members SET name = ?, symbol = ?, accent = ? WHERE id = ?",
                               e["name"], sym, acc, m["id"])
                    mid = m["id"]
                else:
                    tx.execute("DELETE FROM members WHERE group_id = ? AND name = ? COLLATE NOCASE", gid, e["name"])
                    mid = tx.insert("INSERT INTO members(group_id, name, symbol, accent, created_at) VALUES (?,?,?,?,?)",
                                    gid, e["name"], sym, acc, t)
                keep.add(mid)
                tx.execute("UPDATE entrants SET member_id = ? WHERE id = ?", mid, e["id"])
            for mid in set(members) - keep:
                tx.execute("DELETE FROM members WHERE id = ?", mid)
            tx.execute("UPDATE draws SET group_id = ? WHERE id = ?", gid, draw["id"])
        return {"id": gid, "name": name, "members": len(keep)}

    # -- Teilnehmer ---------------------------------------------------------
    def join(self, draw: dict, name: str, by_host: bool = False) -> dict:
        """Neuer Name. Vom Handy mit einem Namen, den der Host schon eingetragen hat
        (oder der aus der Gruppe kommt): Das Handy übernimmt diesen Eintrag."""
        name = clean_name(name)
        with self.db.transaction() as tx:
            same = tx.one("SELECT * FROM entrants WHERE draw_id = ? AND name = ? COLLATE NOCASE", draw["id"], name)
            if same and (by_host or same["token"]):
                raise DrawError(f"„{same['name']}“ ist schon {'mit einem Handy dabei' if same['token'] else 'im Topf'}")
            if same:
                tx.execute("UPDATE entrants SET token = ? WHERE id = ?", secrets.token_urlsafe(24), same["id"])
                return tx.one("SELECT * FROM entrants WHERE id = ?", same["id"]) | {"claimed": True}
            if tx.value("SELECT COUNT(*) FROM entrants WHERE draw_id = ?", draw["id"]) >= 200:
                raise DrawError("Der Topf ist voll")
            gid = tx.value("SELECT group_id FROM draws WHERE id = ?", draw["id"])
            member = gid and tx.value("SELECT id FROM members WHERE group_id = ? AND name = ? COLLATE NOCASE", gid, name)
            eid = tx.insert("INSERT INTO entrants(draw_id, name, token, created_at, chips, member_id) VALUES (?,?,?,?,?,?)",
                            draw["id"], name, None if by_host else secrets.token_urlsafe(24), now_ms(), START_CHIPS,
                            member or None)
            self._store_skins(tx, draw["id"])
            return tx.one("SELECT * FROM entrants WHERE id = ?", eid)

    def by_token(self, draw: dict, token: str | None) -> dict | None:
        if not token:
            return None
        return self.db.one("SELECT * FROM entrants WHERE token = ? AND draw_id = ?", token, draw["id"])

    def remove(self, draw: dict, entrant_id: int) -> None:
        self._not_drawing(draw)
        eid = int(entrant_id)
        with self.db.transaction() as tx:
            self._store_skins(tx, draw["id"])      # alle anderen behalten ihr Symbol
            # Wer auf diesen Namen gesetzt hat, bekommt den Einsatz zurück
            for w in tx.all("SELECT w.* FROM wagers w JOIN entrants e ON e.id = w.entrant_id"
                            " WHERE e.draw_id = ? AND (w.on_id = ? OR w.entrant_id = ?)", draw["id"], eid, eid):
                tx.execute("UPDATE entrants SET chips = chips + ? WHERE id = ?", w["stake"], w["entrant_id"])
            tx.execute("DELETE FROM entrants WHERE id = ? AND draw_id = ?", eid, draw["id"])

    def _entrants(self, q, draw: dict) -> list[dict]:
        return self._entrants_of(q, draw["id"])

    @staticmethod
    def _entrants_of(q, draw_id: int) -> list[dict]:
        # Gruppenmitglieder tragen ihr Symbol über Tische hinweg, sonst gilt das am Eintrag gespeicherte
        return q.all("SELECT e.id, e.name, e.token IS NOT NULL AS phone, e.tip_id, e.chips, e.member_id,"
                     " COALESCE(m.symbol, e.symbol) AS symbol, COALESCE(m.accent, e.accent) AS accent,"
                     " e.symbol AS own_symbol"
                     " FROM entrants e LEFT JOIN members m ON m.id = e.member_id"
                     " WHERE e.draw_id = ? ORDER BY e.id", draw_id)

    def _store_skins(self, tx, draw_id: int) -> None:
        """Bild und Farbe für jeden Eintrag festhalten, der noch keine hat. Bestehende bleiben."""
        entrants = self._entrants_of(tx, draw_id)
        skins = slots.assign_skins(entrants)
        for e in entrants:
            if not e["own_symbol"]:
                tx.execute("UPDATE entrants SET symbol = ?, accent = ? WHERE id = ?", *skins[e["id"]], e["id"])

    def entrants(self, draw: dict) -> list[dict]:
        return self._entrants(self.db, draw)

    def wagers(self, draw: dict) -> dict[int, dict[int, int]]:
        """Offene Slot-Einsätze {wetter_id: {name_id: chips}}."""
        return self._wagers(self.db, draw["id"])

    @staticmethod
    def _wagers(q, draw_id: int) -> dict[int, dict[int, int]]:
        out: dict[int, dict[int, int]] = {}
        for w in q.all("SELECT w.* FROM wagers w JOIN entrants e ON e.id = w.entrant_id WHERE e.draw_id = ?", draw_id):
            out.setdefault(w["entrant_id"], {})[w["on_id"]] = w["stake"]
        return out

    def picked_ids(self, draw: dict) -> set[int]:
        return self._picked(self.db, draw["id"])

    @staticmethod
    def _picked(q, draw_id: int) -> set[int]:
        """Wer schon gezogen ist und bis „Alle zurück in den Topf“ draußen bleibt."""
        return {r["winner_id"] for r in q.all("SELECT winner_id FROM picks WHERE draw_id = ? AND cleared = 0"
                                              " AND locked = 1 AND winner_id IS NOT NULL", draw_id)}

    # -- Tipps und Einsätze -------------------------------------------------
    def _window(self, tx, draw: dict) -> set[int]:
        """Namen, auf die man gerade tippen oder setzen darf. Wirft, wenn nichts mehr geht."""
        t = now_ms()
        pick = tx.one("SELECT * FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
        if pick and pick["ends_at"] > t:
            open_ = False
            if pick["mode"] == "slots":
                r = tx.one("SELECT * FROM rounds WHERE pick_id = ? ORDER BY n DESC LIMIT 1", pick["id"])
                open_ = bool(r) and not r["locked"] and r["calls_at"] <= t < r["locks_at"]
            else:
                open_ = not pick["locked"] and t < pick["locks_at"]
            if not open_:
                raise DrawError("Nichts geht mehr")
            return set(json.loads(pick["layout"])["slots"])
        return {r["id"] for r in tx.all("SELECT id FROM entrants WHERE draw_id = ?", draw["id"])} - self._picked(tx, draw["id"])

    def tip(self, draw: dict, me: dict, entrant_id) -> dict:
        """Glücksrad und Plinko: kostenloser Tipp. Richtig getippt bringt TIP_BONUS Chips."""
        with self.db.transaction() as tx:
            draw = tx.one("SELECT * FROM draws WHERE id = ?", draw["id"])
            if draw["mode"] == "slots":
                raise DrawError("Bei Slots wird mit Chips gesetzt")
            pool = self._window(tx, draw)
            eid = None if entrant_id is None else int(entrant_id)
            if eid is not None and eid not in pool:
                raise DrawError("Dieser Name ist nicht mehr im Topf")
            tx.execute("UPDATE entrants SET tip_id = ? WHERE id = ?", eid, me["id"])
            return {"on": eid}

    def wager(self, draw: dict, me: dict, stakes: dict) -> dict:
        """Slots: setzt alle eigenen Einsätze der nächsten Runde auf einmal ({name_id: chips})."""
        try:
            if not isinstance(stakes or {}, dict):
                raise TypeError
            stakes = {int(k): int(v) for k, v in (stakes or {}).items() if int(v) > 0}
        except (TypeError, ValueError):
            raise DrawError("Ungültiger Einsatz") from None
        with self.db.transaction() as tx:
            draw = tx.one("SELECT * FROM draws WHERE id = ?", draw["id"])
            if draw["mode"] != "slots":
                raise DrawError("Einsätze gibt es nur bei Slots")
            pool = self._window(tx, draw)
            if set(stakes) - pool:
                raise DrawError("Dieser Name ist nicht mehr im Topf")
            held = tx.value("SELECT COALESCE(SUM(stake), 0) FROM wagers WHERE entrant_id = ?", me["id"])
            total = tx.value("SELECT chips FROM entrants WHERE id = ?", me["id"]) + held
            if sum(stakes.values()) > total:
                raise DrawError("So viele Chips hast du nicht")
            tx.execute("DELETE FROM wagers WHERE entrant_id = ?", me["id"])
            for on, stake in stakes.items():
                tx.execute("INSERT INTO wagers(entrant_id, on_id, stake) VALUES (?,?,?)", me["id"], on, stake)
            left = total - sum(stakes.values())
            tx.execute("UPDATE entrants SET chips = ? WHERE id = ?", left, me["id"])
            return {"chips": left, "wagers": {str(k): v for k, v in stakes.items()}}

    def _refund_wagers(self, tx, draw: dict) -> None:
        for w in tx.all("SELECT w.entrant_id, SUM(w.stake) AS s FROM wagers w JOIN entrants e ON e.id = w.entrant_id"
                        " WHERE e.draw_id = ? GROUP BY w.entrant_id", draw["id"]):
            tx.execute("UPDATE entrants SET chips = chips + ? WHERE id = ?", w["s"], w["entrant_id"])
        tx.execute("DELETE FROM wagers WHERE entrant_id IN (SELECT id FROM entrants WHERE draw_id = ?)", draw["id"])

    def reset_bank(self, draw: dict) -> None:
        """Neues Spiel: alle Konten zurück auf Start, Tipps und Einsätze weg."""
        self._not_drawing(draw)
        with self.db.transaction() as tx:
            tx.execute("DELETE FROM wagers WHERE entrant_id IN (SELECT id FROM entrants WHERE draw_id = ?)", draw["id"])
            tx.execute("UPDATE entrants SET chips = ?, stake = 0, tip_id = NULL, streak = 0 WHERE draw_id = ?",
                       START_CHIPS, draw["id"])

    # -- Ziehen -------------------------------------------------------------
    def latest(self, draw: dict) -> dict | None:
        p = self.db.one("SELECT * FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
        if p:
            p["layout"] = json.loads(p["layout"])
            p["tips"] = json.loads(p["tips"])
            p["payouts"] = json.loads(p["payouts"] or "{}")
            if p["mode"] == "slots":
                p["rounds"] = self.db.all("SELECT * FROM rounds WHERE pick_id = ? ORDER BY n", p["id"])
                for r in p["rounds"]:
                    r["result"] = json.loads(r["result"]) if r["result"] else None
                    r["payouts"] = json.loads(r["payouts"] or "{}")
        return p

    def winners(self, draw: dict) -> list[dict]:
        return self.db.all("SELECT id, mode, winner, winner_id, ends_at FROM picks WHERE draw_id = ?"
                           " AND cleared = 0 AND locked = 1 ORDER BY id", draw["id"])

    def skins(self, draw: dict, entrants: list[dict] | None = None) -> dict[int, list]:
        """Bild und Farbe für jeden Namen am Tisch, stabil über Ziehungen hinweg."""
        return slots.assign_skins(entrants if entrants is not None else self.entrants(draw))

    def pick(self, draw: dict) -> dict:
        """Startet eine Ziehung: Topf einfrieren, letzte Einsätze laufen lassen."""
        with self.db.transaction() as tx:
            last = tx.one("SELECT ends_at FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
            t = now_ms()
            if last and last["ends_at"] > t:
                raise DrawError("Es wird gerade gezogen")
            draw = tx.one("SELECT * FROM draws WHERE id = ?", draw["id"])
            picked = self._picked(tx, draw["id"])
            everyone = self._entrants(tx, draw)
            pool = [e for e in everyone if e["id"] not in picked]
            if len(pool) < 2:
                raise DrawError("Für eine Ziehung braucht es mindestens zwei Namen im Topf")
            mode = draw["mode"]
            slots_ = [e["id"] for e in pool]          # ein Feld pro Name, in Eintragsreihenfolge
            layout = {"slots": slots_, "names": {e["id"]: e["name"] for e in pool}}
            calls = (SLOT_CALLS if mode == "slots" else CALLS) if any(e["phone"] for e in everyone) else 0
            locks_at = t + calls
            started_at = locks_at + LOCK
            if mode == "slots":
                if len(pool) > slots.MAX_NAMES:
                    raise DrawError(f"Slots gehen mit höchstens {slots.MAX_NAMES} Namen")
                skins = slots.assign_skins(everyone)
                for e in everyone:          # Gruppenmitglieder behalten ihr Bild für das nächste Mal
                    if e["member_id"]:
                        tx.execute("UPDATE members SET symbol = ?, accent = ? WHERE id = ? AND symbol IS NULL",
                                   *skins[e["id"]], e["member_id"])
                layout.update(skins={e["id"]: skins[e["id"]] for e in pool}, rounds=draw["rounds"],
                              calls=calls, q=slots.quote(len(pool)))
                ends_at = t + FAR
            else:
                duration = DURATION.get(mode)
                if mode == "plinko":
                    per, rows = plinko_shape(len(slots_))
                    layout.update(per=per, rows=rows)
                    duration = plinko_duration(rows)
                ends_at = started_at + duration
            pid = tx.insert("INSERT INTO picks(draw_id, mode, winner_id, winner, slot, layout, tips, started_at,"
                            " ends_at, locks_at, locked) VALUES (?,?,NULL,'',0,?,'{}',?,?,?,0)",
                            draw["id"], mode, json.dumps(layout), started_at, ends_at, locks_at)
            if mode == "slots":
                tx.execute("INSERT INTO rounds(pick_id, n, calls_at, locks_at, started_at, ends_at)"
                           " VALUES (?,1,?,?,?,?)", pid, t, locks_at, started_at, started_at)
        if not calls:
            self.settle(draw)
        return self.db.one("SELECT * FROM picks WHERE id = ?", pid)

    def settle(self, draw: dict) -> bool:
        """„Nichts geht mehr“: ziehen und abrechnen, sobald locks_at erreicht ist. Idempotent."""
        with self.db.transaction() as tx:
            p = tx.one("SELECT * FROM picks WHERE draw_id = ? AND locked = 0 ORDER BY id DESC LIMIT 1", draw["id"])
            if not p:
                return False
            if p["mode"] == "slots":
                return self._settle_slots(tx, p)
            if p["locks_at"] > now_ms():
                return False
            layout = json.loads(p["layout"])
            slots_ = layout["slots"]
            winner_id = secrets.choice(slots_)
            slot = slots_.index(winner_id)
            winner = layout["names"][str(winner_id)]
            if p["mode"] == "plinko":
                column = slot * layout["per"] + secrets.randbelow(layout["per"])
                layout.update(plinko_path(len(slots_) * layout["per"], column, layout["rows"]))
            tippers = tx.all("SELECT id, tip_id FROM entrants WHERE draw_id = ? AND tip_id IS NOT NULL", draw["id"])
            tips = {t["id"]: t["tip_id"] for t in tippers}
            hits = [b for b, on in tips.items() if on == winner_id]
            for b in hits:
                tx.execute("UPDATE entrants SET chips = chips + ? WHERE id = ?", TIP_BONUS, b)
            tx.execute("UPDATE entrants SET tip_id = NULL WHERE draw_id = ?", draw["id"])
            tx.execute("UPDATE picks SET winner_id = ?, winner = ?, slot = ?, layout = ?, tips = ?, payouts = ?,"
                       " locked = 1 WHERE id = ?", winner_id, winner, slot, json.dumps(layout), json.dumps(tips),
                       json.dumps({"hits": hits, "bonus": TIP_BONUS}), p["id"])
        return True

    def _settle_slots(self, tx, p: dict) -> bool:
        """Dreht alle Runden, deren locks_at erreicht ist, und legt jeweils die nächste an."""
        layout = json.loads(p["layout"])
        rng = secrets.SystemRandom()
        done = False
        while True:
            r = tx.one("SELECT * FROM rounds WHERE pick_id = ? ORDER BY n DESC LIMIT 1", p["id"])
            if r["locked"] or r["locks_at"] > now_ms():
                return done
            done = True
            rounds = [json.loads(x["result"]) for x in tx.all("SELECT result FROM rounds WHERE pick_id = ? AND locked = 1"
                                                               " ORDER BY n", p["id"])]
            final = r["n"] >= layout["rounds"]
            res = slots.play_round(rng, layout["slots"], session_points(rounds), final=final)
            ends = r["started_at"] + slots.timeline(res, final)
            payouts = self._pay_round(tx, p["draw_id"], res, layout["q"])
            tx.execute("UPDATE rounds SET locked = 1, result = ?, payouts = ?, ends_at = ? WHERE id = ?",
                       json.dumps(res), json.dumps(payouts), ends, r["id"])
            if final:
                self._finish_session(tx, p, layout, rounds + [res], ends)
                return True
            brk = SLOT_BREAK if layout["calls"] else 0      # ohne Handys geht es gleich weiter
            tx.execute("INSERT INTO rounds(pick_id, n, calls_at, locks_at, started_at, ends_at) VALUES (?,?,?,?,?,?)",
                       p["id"], r["n"] + 1, ends, ends + brk, ends + brk + LOCK, ends + brk + LOCK)

    def _pay_round(self, tx, draw_id: int, res: dict, q: float) -> dict[int, dict]:
        """Zahlt alle offenen Einsätze einer gedrehten Runde aus. {wetter_id: {stakes, wins, win}}

        Nur der reguläre Spin zahlt. Nachdrehen bei Gleichstand entscheidet allein über die Punkte,
        sonst brächte eine Wette in der letzten Runde mehr als RTP (bis über 120 %).
        """
        payouts = {}
        for b, st in self._wagers(tx, draw_id).items():
            wins = [slots.spin_payout(st, s, q) if k == 0 else 0 for k, s in enumerate(res["spins"])]
            tx.execute("UPDATE entrants SET chips = chips + ? WHERE id = ?", sum(wins), b)
            payouts[b] = {"stakes": st, "wins": wins, "win": sum(wins)}
        tx.execute("DELETE FROM wagers WHERE entrant_id IN (SELECT id FROM entrants WHERE draw_id = ?)", draw_id)
        return payouts

    def _finish_session(self, tx, p: dict, layout: dict, results: list[dict], ends: int) -> None:
        """Letzte Runde gedreht: Gewinner eintragen und die Bilanz der Session festhalten."""
        winner_id = results[-1]["leader"]
        books = [json.loads(x["payouts"]) for x in tx.all("SELECT payouts FROM rounds WHERE pick_id = ?", p["id"])]
        tx.execute("UPDATE picks SET winner_id = ?, winner = ?, slot = ?, locked = 1, ends_at = ?, payouts = ? WHERE id = ?",
                   winner_id, layout["names"][str(winner_id)], layout["slots"].index(winner_id), ends,
                   json.dumps({"totals": session_points(results)} | session_balance(books)), p["id"])

    def wakeups(self, draw: dict) -> list[int]:
        """Kommende Zeitpunkte, zu denen sich der Zustand ändert (für die Timer des Servers)."""
        t = now_ms()
        p = self.db.one("SELECT * FROM picks WHERE draw_id = ? ORDER BY id DESC LIMIT 1", draw["id"])
        if not p:
            return []
        times = [p["ends_at"]] + ([] if p["locked"] else [p["locks_at"]])
        if p["mode"] == "slots":
            for r in self.db.all("SELECT * FROM rounds WHERE pick_id = ?", p["id"]):
                times += [r["calls_at"], r["ends_at"]] + ([] if r["locked"] else [r["locks_at"]])
            times = [x for x in times if x - t < FAR // 2]
        return sorted(x for x in times if x > t)

    def reset(self, draw: dict) -> None:
        """Alle Gezogenen kommen zurück in den Topf."""
        self._not_drawing(draw)
        self.db.execute("UPDATE picks SET cleared = 1 WHERE draw_id = ?", draw["id"])

    def _not_drawing(self, draw: dict) -> None:
        end = self.db.value("SELECT MAX(ends_at) FROM picks WHERE draw_id = ?", draw["id"])
        if end and end > now_ms():
            raise DrawError("Bitte warten, bis die Ziehung vorbei ist")
