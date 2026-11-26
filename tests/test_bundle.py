import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import bundle  # noqa: E402

CHECK = """
import runpy, sys
runpy.run_path(sys.argv[1], run_name="bundle")
from auslosung import resources
from auslosung.db import Database
from auslosung.game.draws import Draws
from auslosung.web import assets, pages
assert resources._FILES is not None, "liest nicht aus dem Bundle"
assert b"main.js" in pages.page("host") and assets.read("fonts/jersey-400.woff2")
db = Database(":memory:"); db.migrate()
d = Draws(db).create("Bundle"); print(d["code"])
"""


class BundleTest(unittest.TestCase):
    def test_single_file_runs_without_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = bundle.build(Path(tmp) / "auslosung.py")
            r = subprocess.run([sys.executable, "-I", "-c", CHECK, str(out)], cwd=tmp,
                               capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(len(r.stdout.strip()), 4)
