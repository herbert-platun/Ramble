"""Konstanten, Fehlerklasse und reine Rechenfunktionen des Spiels (ohne Datenbank)."""
from __future__ import annotations

import time

MODES = ("wheel", "roulette", "plinko")
DURATION = {"wheel": 9500, "roulette": 11000}
PLINKO_MIN_COLUMNS = 8

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CALLS = 7000        # „Letzte Einsätze“, nur wenn jemand mit Handy dabei ist
LOCK = 1700         # „Nichts geht mehr“ bis zum Start der Animation
START_CHIPS = 1000
BAILOUT = 200       # wer pleite ist, bekommt das von der Bank
MAX_STREAK_BONUS = 4


class DrawError(Exception):
    """Fehler, die dem Nutzer angezeigt werden dürfen."""


def now_ms() -> int:
    return int(time.time() * 1000)


def clean_name(name: str) -> str:
    name = " ".join((name or "").split())[:24]
    if len(name) < 2:
        raise DrawError("Bitte mindestens zwei Zeichen als Name")
    return name


def streak_mult(streak: int) -> float:
    """Serienbonus: ×1, ×1,5, ×2 … bis ×3."""
    return 1 + 0.5 * min(streak, MAX_STREAK_BONUS)


def settle_bets(bets: dict[int, tuple[int, int, int]], winner_id: int, quote: int, jackpot: int) -> dict:
    """Rechnet eine Runde ab. bets: {wetter_id: (ziel_id, einsatz, serie)}

    Treffer = Einsatz × Quote × Serie + Anteil am Jackpot (nach Einsatz).
    Verlorene Einsätze füllen den Jackpot.
    """
    hits = {b: s for b, (on, s, _) in bets.items() if on == winner_id and s > 0}
    lost = sum(s for b, (on, s, _) in bets.items() if b not in hits)
    hit_stake = sum(hits.values())
    share = {b: jackpot * s // hit_stake for b, s in hits.items()} if hit_stake else {}
    if share:   # Rundungsrest an den größten Einsatz
        top = max(hits, key=lambda b: (hits[b], -b))
        share[top] += jackpot - sum(share.values())
    out = {}
    for b, (on, stake, streak) in bets.items():
        hit = b in hits
        mult = streak_mult(streak) if hit else 1
        out[b] = {"on": on, "stake": stake, "hit": hit, "streak": streak + 1 if hit else 0,
                  "mult": mult, "win": round(stake * quote * mult) if hit else 0,
                  "jp": share.get(b, 0), "bail": 0}
    return {"bets": out, "quote": quote, "jackpot": jackpot,
            "jackpot_after": jackpot - sum(share.values()) + lost}
