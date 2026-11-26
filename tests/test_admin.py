import unittest

from auslosung.admin import Admin
from auslosung.db import MIGRATIONS
from auslosung.game.rules import DrawError

from .helpers import fresh


class AdminTest(unittest.TestCase):
    def setUp(self):
        self.s, self.db = fresh()
        self.a = Admin(self.db, self.s)
        self.d = self.s.create("Kuchendienst")

    def tearDown(self):
        self.db.close()

    def test_sql_read_only(self):
        r = self.a.query("SELECT code, title FROM draws")
        self.assertEqual(r["rows"], [[self.d["code"], "Kuchendienst"]])
        for bad in ("DELETE FROM draws", "UPDATE draws SET title = 'x'", "DROP TABLE draws",
                    "SELECT 1; DELETE FROM draws", "PRAGMA user_version = 9"):
            with self.assertRaises(DrawError):
                self.a.query(bad)
        self.assertEqual(self.db.value("SELECT COUNT(*) FROM draws"), 1)
        self.assertEqual(self.db.value("PRAGMA user_version"), max(n for n, _ in MIGRATIONS))

    def test_edit_and_delete(self):
        a = self.s.join(self.d, "Anna")
        self.s.join(self.d, "Ben")
        self.a.set_chips(self.d["code"], a["id"], 4321)
        self.a.rename_entrant(self.d["code"], a["id"], "Annika")
        with self.assertRaises(DrawError):
            self.a.rename_entrant(self.d["code"], a["id"], "ben")
        self.a.rename(self.d["code"], "Neue Frage")
        e = self.a.draw(self.d["code"])
        self.assertEqual(e["draw"]["title"], "Neue Frage")
        self.assertEqual(e["entrants"][0]["chips"], 4321)
        self.assertNotIn("token", self.a.export(self.d["code"])["entrants"][0])
        self.a.delete_draw(self.d["code"])
        self.assertEqual(self.db.value("SELECT COUNT(*) FROM entrants"), 0)

    def test_purge_and_backup(self):
        old = self.s.create("Alt")
        self.db.execute("UPDATE draws SET created_at = 0 WHERE id = ?", old["id"])
        self.assertEqual(self.a.purge(30), 1)
        self.assertIsNotNone(self.s.get(self.d["code"]))
        self.assertTrue(self.a.backup().startswith(b"SQLite format 3"))
        self.assertEqual(self.a.integrity()["integrity"], ["ok"])
