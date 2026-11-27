"""Slot-Modus: Walzen, Muster, Kaskade, Zeitplan und Gewinntabelle (rein, ohne Datenbank).

Jeder Name im Topf ist ein Symbol auf der Walze (Bild + Akzentfarbe + Name).
Alle Namen haben dasselbe Gewicht und zählen gleich viel, deshalb hat jeder
dieselbe Chance, gezogen zu werden. Sonderzellen sind neutral:

  W     Joker     ersetzt jeden Namen in einem Muster
  x2…   Faktor    vervielfacht die Punkte des ganzen Spins (nur mit Treffer)
  N     Niete     blockiert; ab drei Nieten ist der Spin „Pleite“ (0 Punkte)

Ablauf einer Runde: Spin → Glück (Zellen kopieren einen Nachbarn) → Muster,
klein nach groß → Faktoren → Abrechnung. In der letzten Runde einer Session wird
nachgedreht, bis genau ein Name vorn liegt.

Wetten: Einsatz auf einen Namen. Jedes Muster dieses Namens zahlt
Einsatz × Musterwert × Faktor × Quote. Die Quote gleicht die Tischgröße aus
(mit vielen Namen trifft jeder seltener), damit eine Wette im Mittel etwa
den Einsatz zurückbringt: viele kleine Treffer, ab und zu ein großer.

Alles hier ist eine reine Funktion des Zufallsgenerators `rng`: im Spiel
`secrets.SystemRandom()`, in Tests und bei der Kalibrierung ein fester Seed.
"""
from __future__ import annotations

import math
import random
from functools import lru_cache

COLS, ROWS = 5, 3
CELLS = [(c, r) for c in range(COLS) for r in range(ROWS)]
SESSION_ROUNDS = (1, 3, 5, 7)
MAX_NAMES = 40

# -- Aussehen: neutraler Bildvorrat, den die Namen reihum bekommen -------------------
SYMBOLS = ("cherry", "lemon", "bell", "horseshoe", "bar", "chip", "diamond", "seven")
ACCENTS = 8                                   # Farben in slots.css (--acc-0 … --acc-7)
BASE_ACCENT = (2, 3, 7, 0, 5, 1, 6, 4)        # Farbe je Bild, die sich gut abhebt


def skin_of(k: int) -> tuple[str, int]:
    """k-te Kombination aus Bild und Farbe. Die ersten 64 sind paarweise verschieden."""
    sym, lap = k % len(SYMBOLS), k // len(SYMBOLS)
    return SYMBOLS[sym], (BASE_ACCENT[sym] + lap) % ACCENTS


def assign_skins(entrants: list[dict]) -> dict[int, list]:
    """{id: [bild, farbe]} für alle Einträge in Reihenfolge.

    Gespeicherte Kombinationen (`symbol`, `accent` aus einer Gruppe) bleiben,
    solange sie eindeutig sind; alle anderen bekommen die nächste freie.
    """
    out, used = {}, set()
    for e in entrants:
        combo = (e.get("symbol"), e.get("accent"))
        if combo[0] in SYMBOLS and isinstance(combo[1], int) and 0 <= combo[1] < ACCENTS and combo not in used:
            out[e["id"]] = list(combo)
            used.add(combo)
    k = 0
    for e in entrants:
        if e["id"] in out:
            continue
        while skin_of(k) in used and k < len(SYMBOLS) * ACCENTS:
            k += 1
        combo = skin_of(k) if k < len(SYMBOLS) * ACCENTS else skin_of(len(out))
        out[e["id"]] = list(combo)
        used.add(combo)
    return out


# -- Muster ---------------------------------------------------------------------------
# kind: (Name, Punkte). Waagerechte zählen als längster Lauf, alles andere als feste Form.
PATTERNS = {
    "row3": ("Dreier", 1),
    "col": ("Säule", 2),
    "diag": ("Schräge", 2),
    "row4": ("Vierer", 3),
    "vee": ("Tal", 5),
    "peak": ("Gipfel", 5),
    "row5": ("Fünfer", 8),
    "ring": ("Auge", 10),
    "full": ("Volles Haus", 30),
}
SHAPES: list[tuple[str, list[tuple[int, int]]]] = (
    [("col", [(c, 0), (c, 1), (c, 2)]) for c in range(COLS)]
    + [("diag", [(c, 0), (c + 1, 1), (c + 2, 2)]) for c in range(COLS - 2)]
    + [("diag", [(c, 2), (c + 1, 1), (c + 2, 0)]) for c in range(COLS - 2)]
    + [("vee", [(0, 0), (1, 1), (2, 2), (3, 1), (4, 0)]),
       ("peak", [(0, 2), (1, 1), (2, 0), (3, 1), (4, 2)])]
    + [("ring", [(c + dc, dr) for dc in range(3) for dr in range(3) if (dc, dr) != (1, 1)]) for c in range(COLS - 2)]
    + [("full", list(CELLS))]
)

WILD, BUST = "W", "N"
MULTS = {"x2": 2, "x3": 3, "x5": 5}
MAX_MULT = 20

# Zellgewichte (Anteil je Zelle); der Rest sind Namen, alle gleich wahrscheinlich
P_WILD, P_BUST, P_MULT = 0.045, 0.05, 0.04
MULT_WEIGHTS = (("x2", 70), ("x3", 24), ("x5", 6))
BUST_LIMIT = 3              # so viele Nieten im Bild: Pleite
P_LUCKY = 0.2               # Glücks-Spin: 3–5 Zellen kopieren einen Namen nebenan
RTP = 0.96                  # Wetten bringen im Mittel so viel vom Einsatz zurück


def stickiness(n: int) -> tuple[float, float]:
    """Wahrscheinlichkeit, dass eine Namenszelle den linken bzw. oberen Nachbarn wiederholt.

    Wie gestapelte Symbole auf echten Walzenstreifen. Je mehr Namen, desto mehr
    Klumpen, damit auch an großen Tischen die meisten Spins etwas treffen.
    """
    h = max(0.0, 0.42 * (1 - math.exp(-(n - 2.5) / 2)))
    return h, h * 0.55


def is_name(v) -> bool:
    return isinstance(v, int)


def roll_grid(rng: random.Random, ids: list[int]) -> list[list]:
    """grid[spalte][zeile]: Name (int) oder Sonderzelle (str)."""
    sh, sv = stickiness(len(ids))
    grid = [[None] * ROWS for _ in range(COLS)]
    for c in range(COLS):
        for r in range(ROWS):
            x = rng.random()
            if x < P_WILD:
                v = WILD
            elif x < P_WILD + P_BUST:
                v = BUST
            elif x < P_WILD + P_BUST + P_MULT:
                v = rng.choices([m for m, _ in MULT_WEIGHTS], [w for _, w in MULT_WEIGHTS])[0]
            else:
                left = grid[c - 1][r] if c else None
                up = grid[c][r - 1] if r else None
                y = rng.random()
                if is_name(left) and y < sh:
                    v = left
                elif is_name(up) and y < sh + sv:
                    v = up
                else:
                    v = rng.choice(ids)
            grid[c][r] = v
    return grid


def apply_luck(rng: random.Random, grid: list[list]) -> list[list]:
    """Glück: ein Name im Bild wächst um 3–5 Nachbarzellen. Liefert [[c, r, id], …] in Reihenfolge."""
    present = sorted({v for col in grid for v in col if is_name(v)})
    if not present:
        return []
    target = rng.choice(present)
    k = rng.randint(3, 5)
    morphs = []
    for _ in range(k):
        mine = {(c, r) for c, r in CELLS if grid[c][r] == target}
        options = sorted({(c + dc, r + dr) for c, r in mine for dc, dr in ((1, 0), (-1, 0), (0, 1), (0, -1))
                          if 0 <= c + dc < COLS and 0 <= r + dr < ROWS} - mine)
        # Joker und Faktoren bleiben, Nieten und fremde Namen dürfen kippen
        options = [(c, r) for c, r in options if grid[c][r] not in MULTS and grid[c][r] != WILD]
        if not options:
            break
        c, r = rng.choice(options)
        grid[c][r] = target
        morphs.append([c, r, target])
    return morphs


def _owner(grid, cells) -> int | None:
    """Einziger Name in den Zellen (Joker zählen mit), sonst None."""
    names = {grid[c][r] for c, r in cells if is_name(grid[c][r])}
    if len(names) != 1:
        return None
    if any(not is_name(grid[c][r]) and grid[c][r] != WILD for c, r in cells):
        return None
    return names.pop()


def find_patterns(grid: list[list]) -> list[dict]:
    """Alle Muster, klein nach groß, links nach rechts. {k, id, v, cells}"""
    found, seen = [], set()

    def add(kind, owner, cells):
        key = (owner, tuple(sorted(cells)))
        if key not in seen:
            seen.add(key)
            found.append({"k": kind, "id": owner, "v": PATTERNS[kind][1], "cells": [list(x) for x in cells]})

    for r in range(ROWS):           # längste Läufe je Name, Joker gehören zu jedem Lauf
        for owner in sorted({grid[c][r] for c in range(COLS) if is_name(grid[c][r])}):
            c = 0
            while c < COLS:
                if grid[c][r] == owner or grid[c][r] == WILD:
                    start = c
                    while c < COLS and (grid[c][r] == owner or grid[c][r] == WILD):
                        c += 1
                    run = [(x, r) for x in range(start, c)]
                    if len(run) >= 3 and any(grid[x][r] == owner for x, _ in run):
                        add(f"row{len(run)}", owner, run)
                else:
                    c += 1
    for kind, cells in SHAPES:
        owner = _owner(grid, cells)
        if owner is not None:
            add(kind, owner, cells)
    order = {k: i for i, k in enumerate(PATTERNS)}
    found.sort(key=lambda p: (p["v"], order[p["k"]], min(p["cells"])))
    return found


def spin_mult(grid) -> tuple[list, int]:
    cells = [[c, r, MULTS[grid[c][r]]] for c, r in CELLS if grid[c][r] in MULTS]
    m = 1
    for *_, x in cells:
        m *= x
    return cells, min(m, MAX_MULT)


def tier_of(patterns, score: int) -> int:
    """Sensations-Stufe 0–4 für Licht, Ton und Wackeln."""
    if not score:
        return 0
    best = max(p["v"] for p in patterns)
    if any(p["k"] == "full" for p in patterns) or score >= 60:
        return 4
    if best >= 10 or score >= 24:
        return 3
    if best >= 3 or score >= 10:
        return 2
    return 1


def tease(grid) -> bool:
    """Spannung auf der letzten Walze: in den Spalten 2–4 einer Zeile steht schon ein Name dreimal."""
    return any(_owner(grid, [(1, r), (2, r), (3, r)]) is not None for r in range(ROWS))


def play_spin(rng: random.Random, ids: list[int], lucky: bool | None = None) -> dict:
    grid = roll_grid(rng, ids)
    lucky = rng.random() < P_LUCKY if lucky is None else lucky
    shown = [col[:] for col in grid]          # Bild vor dem Glück: so halten die Walzen an
    morphs = apply_luck(rng, grid) if lucky else []
    busts = sum(1 for c, r in CELLS if grid[c][r] == BUST)
    bust = busts >= BUST_LIMIT
    patterns = [] if bust else find_patterns(grid)
    mcells, mult = spin_mult(grid)
    if not patterns:
        mult = 1
    base: dict[int, int] = {}
    for p in patterns:
        base[p["id"]] = base.get(p["id"], 0) + p["v"]
    pts = {i: v * mult for i, v in base.items()}
    score = sum(pts.values())
    return {"grid": shown, "luck": morphs, "pat": patterns, "mult": mcells if patterns else [],
            "x": mult, "bust": bust, "pts": pts, "tier": tier_of(patterns, score), "tease": tease(shown)}


def leaders(points: dict[int, int]) -> list[int]:
    top = max(points.values(), default=0)
    return sorted(i for i, v in points.items() if v == top and v > 0)


MAX_SPINS = 5


def play_round(rng: random.Random, ids: list[int], totals: dict[int, int] | None = None,
               final: bool = False) -> dict:
    """Eine Runde: ein Spin, in der letzten Runde so lange, bis genau einer vorn liegt.

    totals: Punkte aus den Runden davor. Liefert {spins, pts, winner, leader?, lot?}.
    """
    totals = dict(totals or {})
    spins, pts = [], {}
    while True:
        s = play_spin(rng, ids)
        spins.append(s)
        for i, v in s["pts"].items():
            pts[i] = pts.get(i, 0) + v
        if not final:
            break
        session = {i: totals.get(i, 0) + pts.get(i, 0) for i in ids}
        lead = leaders(session)
        if len(lead) == 1:
            break
        if len(spins) >= MAX_SPINS:     # sehr selten: das Los entscheidet zwischen den Gleichen
            pool = lead or sorted(ids)
            lot = rng.choice(pool)
            pts[lot] = pts.get(lot, 0) + 1
            spins[-1]["lot"] = {"ids": pool, "id": lot}
            break
        s["again"] = "tie" if lead else "blank"
    out = {"spins": spins, "pts": pts}
    lead = leaders(pts)
    out["winner"] = lead[0] if len(lead) == 1 else None
    if final:
        session = {i: totals.get(i, 0) + pts.get(i, 0) for i in ids}
        out["leader"] = leaders(session)[0]
    return out


# -- Quote und Gewinntabelle ------------------------------------------------------------
@lru_cache(maxsize=64)
def quote(n: int) -> float:
    """Auszahlung je Punkt und Chip, damit Wetten im Mittel RTP zurückbringen.

    Fester Seed: gleiche Tischgröße, gleiche Quote, auf jedem Rechner.
    """
    n = max(2, min(MAX_NAMES, n))
    rng = random.Random(7919 * n)
    ids = list(range(n))
    spins, total = 2400, 0
    for _ in range(spins):
        total += sum(play_spin(rng, ids)["pts"].values())
    per_name = total / spins / n
    return round(RTP / per_name, 3) if per_name else 1.0


def paytable(n: int) -> dict:
    """Für Anzeige: Quote und je Muster „Einsatz ×…“."""
    q = quote(n)
    return {"q": q, "rows": [[k, label, v, round(v * q, 2)] for k, (label, v) in PATTERNS.items()],
            "mults": [m for m, _ in MULT_WEIGHTS]}


def spin_payout(stakes: dict[int, int], spin: dict, q: float) -> int:
    """Auszahlung eines Spins für einen Spieler mit Einsätzen {name_id: chips}."""
    return round(sum(stakes.get(int(i), 0) * v for i, v in spin["pts"].items()) * q)


# -- Zeitplan ------------------------------------------------------------------------------
# Millisekunden ab started_at der Runde. Der Server rechnet ihn einmal und schickt
# jedem Gerät dieselben Zeitpunkte, die Bühne spielt nur ab.
#
# Takt: Ausholen, alle Walzen laufen lang genug für Musik und Vorfreude, dann
# fallen sie einzeln mit Luft dazwischen. Nach dem letzten Stopp kurz Stille,
# dann Muster für Muster (jedes weitere etwas später, das baut Spannung auf),
# Faktoren als eigene Schläge, zuletzt das Hochzählen: je größer, desto länger.
LEVER = 450
REEL_MIN, REEL_STAGGER, TEASE = 1850, 430, 2300
AFTER_STOP = 900
MORPH = 720
STEP0, STEP_MAX, STEP_GROW = 850, 1500, 1.2   # jedes weitere Muster lässt länger warten
MULT_STEP, MULT_GROW = 1300, 350              # Faktoren ebenso
BUST_HOLD = 2700
BLANK_HOLD = 1900
ROLL, ROLL_TIER = 900, 450            # Hochzählen der Punkte
TALLY, TALLY_TIER, BIG_HOLD = 1500, 650, 1600
AGAIN = 2100
LOT = 3300
ROUND_END, FINAL_END = 2400, 3400     # danach folgt die Pause mit Rückblick


def timeline(result: dict, final: bool) -> int:
    """Schreibt Zeitpunkte in jeden Spin (spin["t"]) und liefert die Dauer der Runde."""
    t = 0
    for s in result["spins"]:
        tm = {"at": t, "lever": LEVER}
        stop0 = t + LEVER + REEL_MIN
        stops = [stop0 + c * REEL_STAGGER for c in range(COLS)]
        if s["tease"]:
            stops[-1] += TEASE
        tm["stops"] = stops
        t = stops[-1] + AFTER_STOP
        tm["luck"] = []
        for _ in s["luck"]:
            tm["luck"].append(t)
            t += MORPH
        if s["bust"]:
            tm["bust"] = t
            t += BUST_HOLD
        tm["pat"] = []
        for k, _ in enumerate(s["pat"]):
            tm["pat"].append(t)
            t += min(STEP_MAX, round(STEP0 * STEP_GROW ** k))
        tm["mult"] = []
        for k, _ in enumerate(s["mult"]):
            tm["mult"].append(t)
            t += MULT_STEP + MULT_GROW * k
        tm["tally"] = t
        tm["roll"] = ROLL + ROLL_TIER * s["tier"] if s["pat"] else 0
        if s["pat"]:
            t += TALLY + TALLY_TIER * s["tier"] + (BIG_HOLD if s["tier"] >= 3 else 0)
        elif not s["bust"]:
            t += BLANK_HOLD
        if s.get("lot"):
            tm["lot"] = t
            t += LOT
        if s.get("again"):
            tm["again"] = t
            t += AGAIN
        tm["end"] = t
        s["t"] = tm
    result["summary_at"] = t
    t += FINAL_END if final else ROUND_END
    result["dur"] = t
    return t
