"""Plinko: Form des Bretts, Dauer und ein zufälliger Weg, der im Zielfach endet."""
from __future__ import annotations

import math
import secrets

PLINKO_START, PLINKO_DROP, PLINKO_LAND, PLINKO_HOLD = 400, 600, 450, 400  # wie im JavaScript
PLINKO_MIN_COLUMNS = 8


def plinko_shape(names: int) -> tuple[int, int]:
    """(Spalten je Name, Reihen). Wenige Namen bekommen breite Fächer, viele mehr Reihen."""
    per = max(1, math.ceil(PLINKO_MIN_COLUMNS / names))
    rows = max(8, min(16, round(names * per * 0.6) + 4))
    return per, rows - rows % 2     # gerade, sonst endet die Kugel zwischen zwei Spalten


def plinko_hop(k: int) -> int:
    return 520 - k * 14


def plinko_duration(rows: int) -> int:
    return (PLINKO_START + PLINKO_DROP + sum(plinko_hop(k) for k in range(rows - 1))
            + PLINKO_LAND + PLINKO_HOLD)


def plinko_path(columns: int, target: int, rows: int) -> dict:
    """Ein natürlich wirkender Weg, der in Spalte `target` endet."""
    starts = [c for c in range(columns) if abs(c - target) <= rows / 2]
    pos = float(secrets.choice(starts))
    start, path = pos, []
    for left in range(rows, 0, -1):
        options = [d for d in (-0.5, 0.5)
                   if 0 <= pos + d <= columns - 1 and abs(target - (pos + d)) <= (left - 1) / 2]
        d = secrets.choice(options)
        path.append(1 if d > 0 else 0)
        pos += d
    assert pos == target
    return {"start": start, "path": path}
