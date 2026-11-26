"""Zustand für alle Geräte und Verteilung per Server-Sent Events."""
from __future__ import annotations

import json
import queue
import socket
import threading
from typing import TYPE_CHECKING

from .game.draws import Draws
from .game import slots
from .game.rules import BAILOUT, START_CHIPS, TIP_BONUS, now_ms

if TYPE_CHECKING:
    from .admin import Admin


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


class Client:
    def __init__(self, code: str, token: str | None, base: str):
        self.code, self.token, self.base = code, token, base
        self.q: queue.Queue = queue.Queue(maxsize=16)


class App:
    def __init__(self, draws: Draws, port: int, public_url: str | None):
        self.draws, self.port, self.public_url = draws, port, public_url
        self.lan = lan_ip()
        self.clients: set[Client] = set()
        self.lock = threading.Lock()
        self.admin: Admin | None = None          # nur mit --admin
        self.admin_key = ""
        self.admin_lan = False
        self.timers: dict[str, threading.Timer] = {}

    def schedule(self, code: str) -> None:
        """Ein Timer pro Tisch auf den nächsten Zeitpunkt, an dem sich etwas ändert
        (Nichts geht mehr, Ende einer Runde, Ende der Ziehung). Dann senden und neu planen."""
        draw = self.draws.get(code)
        times = self.draws.wakeups(draw) if draw else []
        with self.lock:
            old = self.timers.pop(code, None)
            if old:
                old.cancel()
            if not times:
                return
            timer = threading.Timer(max(0, times[0] + 80 - now_ms()) / 1000, self._wake, args=(code,))
            timer.daemon = True
            self.timers[code] = timer
            timer.start()

    def _wake(self, code: str) -> None:
        try:
            self.broadcast(code)
        finally:
            self.schedule(code)

    def public(self, draw: dict) -> dict:
        """Zustand für alle Geräte. Bis zum Ergebnis zeigen Konten den Stand vor der Abrechnung."""
        d = self.draws
        d.settle(draw)                              # falls der Timer verpasst wurde
        draw = d.get(draw["code"])
        entrants = d.entrants(draw)
        skins = d.skins(draw, entrants)
        wagers = d.wagers(draw)
        pick = d.latest(draw)
        t = now_ms()
        by_id = {e["id"]: e for e in entrants}
        # Abgerechnet, aber noch nicht zu sehen: Konten und Einsätze so zeigen wie davor
        if pick and pick["mode"] == "slots":
            for r in pick["rounds"]:
                if r["locked"] and t < r["ends_at"]:
                    for b, x in r["payouts"].items():
                        e = by_id.get(int(b))
                        if e:
                            e["chips"] -= x["win"] + x["bail"]
                            wagers[e["id"]] = {int(k): v for k, v in x["stakes"].items()}
        elif pick and pick["locked"] and t < pick["ends_at"]:
            for b, on in pick["tips"].items():
                e = by_id.get(int(b))
                if e:
                    e["tip_id"] = on
                    if int(b) in pick["payouts"].get("hits", []):
                        e["chips"] -= pick["payouts"]["bonus"]
        backers: dict[int, list[int]] = {}
        for e in entrants:
            if e["tip_id"]:
                backers.setdefault(e["tip_id"], [0, 0])[0] += 1
        for b, st in wagers.items():
            for on, stake in st.items():
                x = backers.setdefault(on, [0, 0])
                x[0] += 1
                x[1] += stake
        if pick:
            pick = self._public_pick(pick, t)
        picked = d.picked_ids(draw)
        pool = [e["id"] for e in entrants if e["id"] not in picked]
        rules = {"start": START_CHIPS, "bailout": BAILOUT, "tip": TIP_BONUS}
        if draw["mode"] == "slots" and len(pool) >= 2:
            n = len(pick["layout"]["slots"]) if pick and pick["mode"] == "slots" and t < pick["ends_at"] else len(pool)
            rules["pay"] = slots.paytable(min(n, slots.MAX_NAMES))
        with self.lock:
            online = sum(1 for c in self.clients if c.code == draw["code"])
        group = draw["group_id"] and d.db.one("SELECT id, name FROM groups WHERE id = ?", draw["group_id"])
        return {
            "now": t,
            "draw": {k: draw[k] for k in ("code", "title", "mode", "rounds")}
                    | {"group": group or None, "saved": bool(draw["saved"])},
            "entrants": [{"id": e["id"], "name": e["name"], "phone": bool(e["phone"]), "chips": e["chips"],
                          "skin": skins[e["id"]], "member": bool(e["member_id"]),
                          "on": e["tip_id"], "wagers": {str(k): v for k, v in wagers.get(e["id"], {}).items()},
                          "backers": backers.get(e["id"], [0, 0])[0],
                          "backed": backers.get(e["id"], [0, 0])[1]} for e in entrants],
            "picked": sorted(picked),
            "pick": pick,
            "winners": d.winners(draw),
            "online": online,
            "rules": rules,
        }

    @staticmethod
    def _public_pick(pick: dict, t: int) -> dict:
        keep = ["id", "mode", "locked", "locks_at", "started_at", "ends_at"]
        layout = pick["layout"]
        if pick["locked"]:
            keep += ["winner_id", "winner", "slot"]
        else:     # Weg der Plinko-Kugel gibt es erst nach dem Ziehen
            layout = {k: layout[k] for k in ("slots", "names", "per", "rows", "skins", "rounds", "q") if k in layout}
        out = {k: pick[k] for k in keep} | {"layout": layout}
        if pick["locked"]:
            out["payouts"] = pick["payouts"]
            if pick["mode"] != "slots":
                out["tips"] = pick["tips"]
        if pick["mode"] == "slots":
            out["rounds"] = [{k: r[k] for k in ("n", "calls_at", "locks_at", "started_at", "ends_at", "locked")}
                             | ({"result": r["result"], "payouts": r["payouts"]} if r["locked"] else {})
                             for r in pick["rounds"]]
        return out

    def personal(self, pub: dict, draw: dict, token: str | None, base: str) -> dict:
        s = dict(pub, join_url=f"{base}/t/{draw['code']}")
        me = self.draws.by_token(draw, token)
        if me:
            s["me"] = next((e for e in pub["entrants"] if e["id"] == me["id"]), None)
        return s

    def broadcast(self, code: str) -> None:
        draw = self.draws.get(code)
        if not draw:
            return
        pub = self.public(draw)
        with self.lock:
            targets = [c for c in self.clients if c.code == code]
        for c in targets:
            try:
                c.q.put_nowait(json.dumps(self.personal(pub, draw, c.token, c.base)))
            except queue.Full:
                pass
