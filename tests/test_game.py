import random
import sqlite3
import unittest
from collections import Counter

from auslosung.db import MIGRATIONS, Database
from auslosung.game import slots
from auslosung.game.draws import Draws
from auslosung.game.plinko import PLINKO_MIN_COLUMNS, plinko_hop, plinko_path, plinko_shape
from auslosung.game.rules import START_CHIPS, TIP_BONUS, DrawError

from .helpers import finish, fresh, lock_now, open_round, run_session, temp_db


class GameTest(unittest.TestCase):
    def setUp(self):
        self.s, self.db = fresh()
        self.d = self.s.create("Kuchendienst")

    def tearDown(self):
        self.db.close()

    def chips(self, e):
        return self.db.value("SELECT chips FROM entrants WHERE id = ?", e["id"])

    def test_only_saved_tables_are_listed_and_kept(self):
        self.assertEqual(self.s.recent(), [])
        self.s.set_saved(self.d, True)
        self.assertEqual([d["code"] for d in self.s.recent()], [self.d["code"]])
        old = self.s.create("Vergessen")
        self.db.execute("UPDATE draws SET created_at = 0")
        self.assertEqual(self.s.purge_unsaved(), 1)          # gespeicherter Tisch bleibt
        self.assertIsNone(self.s.get(old["code"]))
        self.assertIsNotNone(self.s.get(self.d["code"]))
        fresh_one = self.s.create("Gerade benutzt")
        self.db.execute("UPDATE draws SET created_at = 0 WHERE id = ?", fresh_one["id"])
        self.s.join(fresh_one, "Anna")                       # Aktivität hält ihn am Leben
        self.assertEqual(self.s.purge_unsaved(), 0)

    def test_bad_input_is_a_draw_error(self):
        e = self.s.join(self.d, 12345)
        self.assertEqual(e["name"], "12345")
        with self.assertRaises(DrawError):
            self.s.wager(self.d, e, [1, 2])

    def test_needs_two(self):
        self.s.join(self.d, "Anna")
        with self.assertRaises(DrawError):
            self.s.pick(self.d)

    def test_duplicate_name(self):
        self.s.join(self.d, "Anna")
        with self.assertRaises(DrawError):
            self.s.join(self.d, "  anna ")
        self.s.join(self.d, "Ben", by_host=True)
        with self.assertRaises(DrawError):
            self.s.join(self.d, "ben", by_host=True)

    def test_phone_claims_host_entry(self):
        b = self.s.join(self.d, "Ben", by_host=True)
        self.assertIsNone(b["token"])
        c = self.s.join(self.d, "ben")
        self.assertEqual(c["id"], b["id"])
        self.assertTrue(c["claimed"] and c["token"])

    def test_plinko_shape_scales(self):
        for n in range(2, 80):
            per, rows = plinko_shape(n)
            self.assertGreaterEqual(n * per, PLINKO_MIN_COLUMNS)
            self.assertTrue(8 <= rows <= 16 and rows % 2 == 0)
            self.assertGreater(plinko_hop(rows - 2), 0)

    def test_plinko_path_lands(self):
        for cols in (2, 7, 12, 30):
            for rows in (8, 16):
                for target in range(cols):
                    p = plinko_path(cols, target, rows)
                    pos = p["start"]
                    for step in p["path"]:
                        pos += 0.5 if step else -0.5
                        self.assertTrue(0 <= pos <= cols - 1)
                    self.assertEqual(pos, target)

    def test_plinko_pick_lands_in_winner_bin(self):
        self.s.set_mode(self.d, "plinko")
        for n in ["Anna", "Ben", "Cem"]:
            self.s.join(self.d, n)
        for _ in range(20):
            self.s.pick(self.s.get(self.d["code"]))
            p = lock_now(self.s, self.db, self.d)
            L = p["layout"]
            end = L["start"] + sum(0.5 if s else -0.5 for s in L["path"])
            self.assertEqual(int(end) // L["per"], p["slot"])
            self.assertEqual(L["slots"][p["slot"]], p["winner_id"])
            finish(self.db)
            self.s.reset(self.d)

    def test_pick_excludes_winners_and_resets(self):
        for n in ["Anna", "Ben", "Cem"]:
            self.s.join(self.d, n)
        winners = set()
        for _ in range(2):
            self.s.pick(self.s.get(self.d["code"]))
            p = lock_now(self.s, self.db, self.d)
            winners.add(p["winner_id"])
            with self.assertRaises(DrawError):
                self.s.pick(self.d)
            finish(self.db)
        self.assertEqual(len(winners), 2)
        with self.assertRaises(DrawError):
            self.s.pick(self.d)
        self.s.reset(self.d)
        self.s.pick(self.d)

    def test_fair(self):
        for n in ["A1", "B2", "C3"]:
            self.s.join(self.d, n)
        c = Counter()
        for _ in range(900):
            self.s.pick(self.d)
            c[lock_now(self.s, self.db, self.d)["winner"]] += 1
            finish(self.db)
            self.s.reset(self.d)
        self.assertTrue(all(220 < v < 380 for v in c.values()), c)

    def test_host_only_draw_locks_at_once(self):
        for n in ["Anna", "Ben"]:
            self.s.join(self.d, n, by_host=True)
        self.s.pick(self.d)
        self.assertEqual(self.s.latest(self.d)["locked"], 1)

    # -- Tipps (Glücksrad, Plinko) -------------------------------------------------
    def test_tip_is_free_and_pays_bonus(self):
        a, b, c = (self.s.join(self.d, n) for n in ("Anna", "Ben", "Cem"))
        self.s.pick(self.d)
        p = self.s.latest(self.d)
        self.assertIsNone(p["winner_id"])             # in den letzten Sekunden noch offen
        for me in (a, b, c):
            self.s.tip(self.d, me, b["id"])
        self.assertEqual(self.chips(a), START_CHIPS)
        p = lock_now(self.s, self.db, self.d)
        with self.assertRaises(DrawError):
            self.s.tip(self.d, a, c["id"])
        expect = START_CHIPS + (TIP_BONUS if p["winner_id"] == b["id"] else 0)
        self.assertTrue(all(self.chips(e) == expect for e in (a, b, c)))
        self.assertEqual(sorted(p["payouts"]["hits"]), sorted(e["id"] for e in (a, b, c)) if expect > START_CHIPS else [])
        self.assertIsNone(self.db.value("SELECT tip_id FROM entrants WHERE id = ?", a["id"]))

    def test_tip_only_on_pot(self):
        a = self.s.join(self.d, "Anna")
        b = self.s.join(self.d, "Ben")
        self.s.join(self.d, "Cem")
        self.s.pick(self.d)
        w = lock_now(self.s, self.db, self.d)["winner_id"]
        finish(self.db)
        with self.assertRaises(DrawError):
            self.s.tip(self.d, a, w)
        self.s.tip(self.d, a, next(i for i in (a["id"], b["id"]) if i != w))
        self.s.tip(self.d, a, None)
        with self.assertRaises(DrawError):
            self.s.wager(self.d, a, {b["id"]: 10})

    # -- Einsätze (Slots) ------------------------------------------------------------
    def slots_table(self, names=("Anna", "Ben", "Cem"), rounds=3):
        self.s.set_mode(self.d, "slots")
        self.s.set_rounds(self.d, rounds)
        es = [self.s.join(self.d, n) for n in names]
        return [self.s.get(self.d["code"])] + es

    def test_wager_moves_chips(self):
        d, a, b, c = self.slots_table()
        r = self.s.wager(d, a, {b["id"]: 300, c["id"]: 200})
        self.assertEqual(r["chips"], START_CHIPS - 500)
        self.s.wager(d, a, {b["id"]: 1000})            # ersetzt alle Einsätze
        self.assertEqual(self.chips(a), 0)
        with self.assertRaises(DrawError):
            self.s.wager(d, a, {b["id"]: 1001})
        with self.assertRaises(DrawError):
            self.s.wager(d, a, {"x": 5})
        with self.assertRaises(DrawError):
            self.s.tip(d, a, b["id"])
        self.s.wager(d, a, {})
        self.assertEqual(self.chips(a), START_CHIPS)

    def test_refund_on_remove_and_mode_switch(self):
        d, a, b, c = self.slots_table()
        self.s.wager(d, a, {b["id"]: 250, c["id"]: 100})
        self.s.remove(d, b["id"])
        self.assertEqual(self.chips(a), START_CHIPS - 100)
        self.s.set_mode(d, "wheel")
        self.assertEqual(self.chips(a), START_CHIPS)
        self.assertEqual(self.db.value("SELECT COUNT(*) FROM wagers"), 0)

    def test_slots_session(self):
        d, a, b, c = self.slots_table(rounds=3)
        self.s.pick(d)
        p = self.s.latest(d)
        self.assertEqual(len(p["rounds"]), 1)
        self.assertTrue(set(p["layout"]["skins"]) == {str(e["id"]) for e in (a, b, c)})
        self.s.wager(d, a, {b["id"]: 100})
        p = lock_now(self.s, self.db, d)
        self.assertEqual(p["locked"], 0)
        r1 = p["rounds"][0]
        self.assertTrue(r1["locked"] and r1["result"]["spins"])
        pay = r1["payouts"][str(a["id"])]
        self.assertEqual(self.chips(a), START_CHIPS - 100 + pay["win"] + pay["bail"])
        with self.assertRaises(DrawError):            # Runde 2 ist noch nicht offen
            self.s.wager(d, a, {c["id"]: 10})
        open_round(self.db)
        self.s.wager(d, a, {c["id"]: 10})
        p = run_session(self.s, self.db, d)
        self.assertEqual(len(p["rounds"]), 3)
        totals = {int(k): v for k, v in p["payouts"]["totals"].items()}
        self.assertEqual(max(totals.values()), totals[p["winner_id"]])
        self.assertEqual(sum(1 for v in totals.values() if v == totals[p["winner_id"]]), 1)
        self.assertIn(str(a["id"]), p["payouts"]["net"])
        self.assertEqual(self.db.value("SELECT COUNT(*) FROM wagers"), 0)

    def test_tiebreak_spins_pay_nothing(self):
        d, a, b, c = self.slots_table(rounds=1)
        seen = 0
        for _ in range(60):
            self.s.pick(d)
            self.s.wager(d, a, {b["id"]: 10, c["id"]: 10})
            p = run_session(self.s, self.db, d)
            r = p["rounds"][-1]
            wins = r["payouts"][str(a["id"])]["wins"]
            self.assertEqual(len(wins), len(r["result"]["spins"]))
            self.assertTrue(all(w == 0 for w in wins[1:]))
            seen += len(wins) > 1
            finish(self.db)
            self.s.reset(d)
        self.assertGreater(seen, 0)

    def test_slots_fair(self):
        d, *_ = self.slots_table(names=("A1", "B2", "C3"), rounds=1)
        c = Counter()
        for _ in range(600):
            self.s.pick(d)
            c[run_session(self.s, self.db, d)["winner"]] += 1
            finish(self.db)
            self.s.reset(d)
        self.assertTrue(all(140 < v < 260 for v in c.values()), c)

    def test_skins_stay_when_someone_leaves(self):
        d = self.s.create("x")
        es = [self.s.join(d, n, by_host=True) for n in ("Anna", "Ben", "Cleo", "Dana")]
        before = self.s.skins(d)
        self.s.remove(d, es[0]["id"])
        self.s.join(d, "Emil", by_host=True)
        after = self.s.skins(d)
        for e in es[1:]:
            self.assertEqual(before[e["id"]], after[e["id"]])
        self.assertEqual(len({tuple(v) for v in after.values()}), 4)

    # -- Gruppen ---------------------------------------------------------------------
    def test_groups_roundtrip(self):
        for n in ("Anna", "Ben"):
            self.s.join(self.d, n, by_host=True)
        self.s.join(self.d, "Cem")
        g = self.s.save_group(self.d, "Büro")
        self.assertEqual(g["members"], 3)
        d2 = self.s.create("Wer spült?", g["id"])
        names = sorted(e["name"] for e in self.s.entrants(d2))
        self.assertEqual(names, ["Anna", "Ben", "Cem"])
        skins = {e["name"]: e["skin"] if "skin" in e else [e["symbol"], e["accent"]] for e in self.s.entrants(d2)}
        self.assertEqual(len({tuple(v) for v in skins.values()}), 3)
        c = self.s.join(d2, "cem")                     # Handy übernimmt den Gruppenplatz
        self.assertTrue(c.get("claimed"))
        self.assertIsNotNone(c["member_id"])
        dan = self.s.join(d2, "Dan")
        self.assertIsNone(dan["member_id"])
        self.s.remove(d2, self.s.entrants(d2)[0]["id"])  # Anna raus, Dan rein: Gruppe folgt dem Tisch
        self.s.save_group(self.s.get(d2["code"]), "Büro")
        [grp] = self.s.groups()
        self.assertEqual(sorted(grp["members"]), ["Ben", "Cem", "Dan"])
        with self.assertRaises(DrawError):
            self.s.save_group(self.s.create("Leer"), "Büro")
        self.s.delete_group(grp["id"])
        self.assertEqual(self.s.groups(), [])
        self.assertIsNone(self.s.get(d2["code"])["group_id"])
        self.assertEqual(len(self.s.entrants(d2)), 3)

    def test_migrates_old_database(self):
        path = temp_db()
        old = Database(path, migrations=[m for m in MIGRATIONS if m[0] <= 2])
        old.migrate()
        old.execute("INSERT INTO draws(code, title, host_key, mode, created_at, jackpot) VALUES"
                    " ('ABCD', 'Alt', 'k', 'roulette', 0, 70)")
        did = old.value("SELECT id FROM draws")
        old.execute("INSERT INTO entrants(draw_id, name, token, created_at, chips, stake, tip_id)"
                    " VALUES (?, 'Anna', 't', 0, 600, 400, NULL)", did)
        old.close()
        db = Database(path)
        db.migrate()
        self.assertEqual(db.value("SELECT mode FROM draws"), "wheel")
        self.assertEqual(db.value("SELECT chips FROM entrants"), 1000)
        self.assertEqual(db.all("PRAGMA foreign_key_check"), [])
        with self.assertRaises(sqlite3.IntegrityError):
            db.execute("UPDATE draws SET mode = 'roulette'")
        Draws(db).create("Neu")
        db.close()


class SlotsTest(unittest.TestCase):
    def test_skins_unique(self):
        es = [{"id": i, "symbol": None, "accent": None} for i in range(40)]
        skins = slots.assign_skins(es)
        self.assertEqual(len({tuple(v) for v in skins.values()}), 40)
        saved = slots.assign_skins([{"id": 1, "symbol": "seven", "accent": 3}, {"id": 2, "symbol": "seven", "accent": 3}])
        self.assertEqual(saved[1], ["seven", 3])
        self.assertNotEqual(saved[2], ["seven", 3])

    def test_patterns(self):
        A, B, W, N = 1, 2, slots.WILD, slots.BUST
        grid = [[A, B, B], [A, B, N], [W, B, N], [A, N, B], [B, A, A]]
        kinds = {(p["k"], p["id"]) for p in slots.find_patterns(grid)}
        self.assertIn(("row4", A), kinds)
        self.assertIn(("row3", B), kinds)
        full = [[A] * 3 for _ in range(5)]
        self.assertIn("full", {p["k"] for p in slots.find_patterns(full)})

    def test_spin_and_timeline(self):
        rng = random.Random(4)
        ids = [11, 12, 13, 14]
        tiers, blanks = Counter(), 0
        for _ in range(400):
            s = slots.play_spin(rng, ids)
            tiers[s["tier"]] += 1
            blanks += not s["pts"]
            if s["bust"]:
                self.assertEqual(s["pts"], {})
            for p in s["pat"]:
                self.assertIn(p["id"], ids)
        self.assertLess(blanks, 120)                  # Nieten selten, Treffer die Regel
        self.assertGreater(tiers[2] + tiers[3] + tiers[4], 60)
        res = slots.play_round(rng, ids, {11: 5}, final=True)
        dur = slots.timeline(res, True)
        self.assertGreater(dur, 2000)
        self.assertIn("leader", res)
        for s in res["spins"]:
            self.assertTrue(set(s["t"]) >= {"at", "stops", "end"})

    def test_deterministic_and_paying(self):
        self.assertEqual(slots.quote(6), slots.quote(6))
        a = slots.play_round(random.Random(9), [1, 2, 3])
        b = slots.play_round(random.Random(9), [1, 2, 3])
        self.assertEqual(a, b)
        rng, staked, paid = random.Random(1), 0, 0
        q = slots.quote(5)
        for _ in range(3000):
            s = slots.play_spin(rng, [1, 2, 3, 4, 5])
            staked += 100
            paid += slots.spin_payout({1: 100}, s, q)
        self.assertTrue(0.75 < paid / staked < 1.2, paid / staked)


if __name__ == "__main__":
    unittest.main()
