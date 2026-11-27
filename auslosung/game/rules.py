"""Konstanten, Fehlerklasse und reine Rechenfunktionen des Spiels (ohne Datenbank)."""
from __future__ import annotations

import time

MODES = ("wheel", "plinko", "slots")
DURATION = {"wheel": 9500}

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CALLS = 7000        # „Letzte Einsätze“, nur wenn jemand mit Handy dabei ist
LOCK = 1700         # „Nichts geht mehr“ bis zum Start der Animation
SLOT_CALLS = 10000  # Slots: Einsätze vor der ersten Runde
SLOT_BREAK = 14000  # Slots: Pause zwischen zwei Runden, mit Rückblick und Zwischenstand
START_CHIPS = 1000
TIP_BONUS = 200     # Glücksrad und Plinko: richtiger Tipp, kostet nichts


class DrawError(Exception):
    """Fehler, die dem Nutzer angezeigt werden dürfen."""


def now_ms() -> int:
    return int(time.time() * 1000)


def clean_name(name: str) -> str:
    name = " ".join(str(name or "").split())[:24]
    if len(name) < 2:
        raise DrawError("Bitte mindestens zwei Zeichen als Name")
    return name
