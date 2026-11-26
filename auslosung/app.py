"""Zustand für alle Geräte und Verteilung per Server-Sent Events."""
from __future__ import annotations

import json
import queue
import socket
import threading
from typing import TYPE_CHECKING

from .game.draws import Draws
from .game.rules import BAILOUT, START_CHIPS, now_ms

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
        self.admin: Admin | None = None          # nur mit --admin, siehe Abschnitt 7
        self.admin_key = ""
        self.admin_lan = False

    def public(self, draw: dict) -> dict:
        """Zustand für alle Geräte. Bis zum Ergebnis zeigen Konten den Stand vor der Abrechnung."""
        d = self.draws
        d.settle(draw)                              # falls der Timer verpasst wurde
        draw = d.get(draw["code"])
        entrants = d.entrants(draw)
        pick = d.latest(draw)
        jackpot = draw["jackpot"]
        t = now_ms()
        if pick and pick["locked"] and t < pick["ends_at"]:
            bets = pick["payouts"].get("bets", {})
            for e in entrants:
                b = bets.get(str(e["id"]))
                if b:
                    e["chips"] -= b["win"] + b["jp"] + b["bail"]
                    e["tip_id"], e["stake"] = b["on"], b["stake"]
                    e["streak"] = b["streak"] - 1 if b["hit"] else e["streak"]
            jackpot = pick["payouts"].get("jackpot", jackpot)
        backers: dict[int, list[int]] = {}
        for e in entrants:
            if e["tip_id"] and e["stake"]:
                b = backers.setdefault(e["tip_id"], [0, 0])
                b[0] += 1
                b[1] += e["stake"]
        if pick:
            keep = ["id", "mode", "locked", "locks_at", "started_at", "ends_at"]
            layout = pick["layout"]
            if pick["locked"]:
                keep += ["winner_id", "winner", "slot"]
            else:     # Weg der Plinko-Kugel gibt es erst nach dem Ziehen
                layout = {k: layout[k] for k in ("slots", "names", "per", "rows") if k in layout}
            out = {k: pick[k] for k in keep} | {"layout": layout}
            if pick["locked"]:
                out["payouts"] = pick["payouts"]
            pick = out
        with self.lock:
            online = sum(1 for c in self.clients if c.code == draw["code"])
        return {
            "now": t,
            "draw": {k: draw[k] for k in ("code", "title", "mode")} | {"jackpot": jackpot},
            "entrants": [{"id": e["id"], "name": e["name"], "phone": bool(e["phone"]),
                          "chips": e["chips"], "streak": e["streak"],
                          "on": e["tip_id"] if e["stake"] else None, "stake": e["stake"],
                          "backers": backers.get(e["id"], [0, 0])[0],
                          "backed": backers.get(e["id"], [0, 0])[1]} for e in entrants],
            "picked": sorted(d.picked_ids(draw)),
            "pick": pick,
            "winners": d.winners(draw),
            "online": online,
            "rules": {"start": START_CHIPS, "bailout": BAILOUT},
        }

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
