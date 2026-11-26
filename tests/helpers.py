"""Gemeinsame Hilfen: frische Datenbank, Ziehung beenden, „Keine Wetten mehr“ erzwingen."""
import os
import tempfile

from auslosung.db import Database
from auslosung.game.draws import Draws


def temp_db() -> str:
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    return path


def fresh():
    db = Database(temp_db())
    db.migrate()
    return Draws(db), db


def finish(db):
    db.execute("UPDATE picks SET ends_at = 0")
    db.execute("UPDATE rounds SET ends_at = 0")


def lock_now(s, db, d):
    """Die laufende Ziehung (bei Slots die aktuelle Runde) sofort ziehen."""
    db.execute("UPDATE picks SET locks_at = 0 WHERE locked = 0")
    db.execute("UPDATE rounds SET calls_at = 0, locks_at = 0 WHERE locked = 0")
    s.settle(d)
    return s.latest(d)


def open_round(db):
    """Bei Slots: die nächste Runde nimmt sofort Einsätze an."""
    db.execute("UPDATE rounds SET calls_at = 0 WHERE locked = 0")


def run_session(s, db, d):
    """Alle Runden einer Slots-Session durchziehen."""
    for _ in range(10):
        p = lock_now(s, db, d)
        if p["locked"]:
            return p
    raise AssertionError("Session endet nicht")
