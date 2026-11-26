import unittest
from collections import Counter

from auslosung.game.plinko import PLINKO_MIN_COLUMNS, plinko_hop, plinko_path, plinko_shape
from auslosung.game.rules import BAILOUT, DrawError, settle_bets

from .helpers import finish, fresh, lock_now


class GameTest(unittest.TestCase):
    def setUp(self):
        self.s, self.db = fresh()
        self.d = self.s.create("Kuchendienst")

    def tearDown(self):
        self.db.close()

    def test_needs_two(self):
        self.s.join(self.d, "Anna")
        with self.assertRaises(DrawError):
            self.s.pick(self.d)

    def test_duplicate_name(self):
        self.s.join(self.d, "Anna")
        with self.assertRaises(DrawError):
            self.s.join(self.d, "  anna ")

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

    def test_winner_unknown_during_last_calls(self):
        a = self.s.join(self.d, "Anna")
        self.s.join(self.d, "Ben")
        self.s.pick(self.d)
        p = self.s.latest(self.d)
        self.assertEqual(p["locked"], 0)
        self.assertIsNone(p["winner_id"])
        self.assertFalse(self.s.settle(self.d))
        self.s.bet(self.d, a, a["id"], 100)          # in den letzten Sekunden geht noch was
        p = lock_now(self.s, self.db, self.d)
        self.assertIn(str(a["id"]), p["payouts"]["bets"])
        with self.assertRaises(DrawError):
            self.s.bet(self.d, a, a["id"], 50)

    def test_bet_moves_chips(self):
        a = self.s.join(self.d, "Anna")
        b = self.s.join(self.d, "Ben")
        chips = lambda: self.db.value("SELECT chips FROM entrants WHERE id = ?", a["id"])
        self.s.bet(self.d, a, b["id"], 300)
        self.assertEqual(chips(), 700)
        self.s.bet(self.d, a, b["id"], 1000)
        self.assertEqual(chips(), 0)
        with self.assertRaises(DrawError):
            self.s.bet(self.d, a, b["id"], 1001)
        self.s.bet(self.d, a, None, 0)
        self.assertEqual(chips(), 1000)

    def test_remove_refunds(self):
        a = self.s.join(self.d, "Anna")
        b = self.s.join(self.d, "Ben")
        self.s.bet(self.d, a, b["id"], 250)
        self.s.remove(self.d, b["id"])
        self.assertEqual(self.db.value("SELECT chips FROM entrants WHERE id = ?", a["id"]), 1000)

    def test_payout_and_jackpot(self):
        ps = [self.s.join(self.d, n) for n in ("Anna", "Ben", "Cem")]
        stake = {ps[0]["id"]: 100, ps[1]["id"]: 200, ps[2]["id"]: 1000}
        for p in ps:
            self.s.bet(self.d, p, p["id"], stake[p["id"]])
        self.s.pick(self.d)
        w = lock_now(self.s, self.db, self.d)["winner_id"]
        chips = {r["id"]: r["chips"] for r in self.s.entrants(self.d)}
        self.assertEqual(self.db.value("SELECT jackpot FROM draws"), sum(stake.values()) - stake[w])
        self.assertEqual(chips[w], 1000 - stake[w] + stake[w] * 3)
        for i in stake:
            if i != w:
                self.assertEqual(chips[i], 1000 - stake[i] if stake[i] < 1000 else BAILOUT)

    def test_settle_math(self):
        r = settle_bets({1: (9, 100, 0), 2: (9, 300, 2), 3: (8, 50, 1)}, 9, 4, 1001)
        self.assertEqual(r["bets"][1]["win"], 400)
        self.assertEqual(r["bets"][2]["win"], 300 * 4 * 2)
        self.assertEqual(r["bets"][1]["jp"] + r["bets"][2]["jp"], 1001)
        self.assertEqual(r["bets"][2]["jp"], 751)
        self.assertEqual(r["bets"][3]["streak"], 0)
        self.assertEqual(r["jackpot_after"], 50)
        self.assertEqual(settle_bets({1: (8, 100, 0)}, 9, 4, 500)["jackpot_after"], 600)
