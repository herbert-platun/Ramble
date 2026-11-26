import unittest

from auslosung.web import assets, pages


class WebTest(unittest.TestCase):
    def test_pages_and_assets(self):
        for kind in ("lobby", "host", "play"):
            self.assertIn(b"/static/js/main.js", pages.page(kind))
        self.assertIn(b"/static/admin/admin.js", pages.admin_page())
        self.assertIsNotNone(assets.read("js/main.js"))
        self.assertIn(b"@font-face", assets.read("css/fonts.css")[0])
        self.assertIsNone(assets.read("../db.py"))
