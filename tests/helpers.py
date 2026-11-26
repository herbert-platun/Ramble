"""Gemeinsame Hilfen: frische Datenbank, Ziehung beenden, „Nichts geht mehr“ erzwingen."""
import tempfile

from auslosung.db import Database
from auslosung.game.draws import Draws


def fresh():
    db = Database(tempfile.NamedTemporaryFile(suffix=".db", delete=False).name)
    db.migrate()
    return Draws(db), db


def finish(db):
    db.execute("UPDATE picks SET ends_at = 0")


def lock_now(s, db, d):
    db.execute("UPDATE picks SET locks_at = 0 WHERE locked = 0")
    s.settle(d)
    return s.latest(d)
