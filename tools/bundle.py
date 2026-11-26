#!/usr/bin/env python3
"""Baut dist/auslosung.py: eine einzige, portable Python-Datei mit allem darin.

Code, Vorlagen, CSS/JS, Schriften und Migrationen liegen als ZIP (Base64) in der
Datei. Beim Start lädt ein kleiner Importer die Module direkt aus dem Speicher,
ausgepackt wird nichts. Nur Standardbibliothek, Python 3.10+.

    python3 tools/bundle.py                # schreibt dist/auslosung.py
    python3 tools/bundle.py -o pfad.py
    python3 dist/auslosung.py --port 8080  # wie python3 -m auslosung
"""
from __future__ import annotations

import argparse
import base64
import io
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "auslosung"

STUB = '''#!/usr/bin/env python3
# Auslosung {version} – gebündelte Einzeldatei, gebaut mit tools/bundle.py.
# Start: python3 auslosung.py [--port 8000] [--db auslosung.db] [--admin]   (Python 3.10+)
# Lizenz: GPL-3.0 (siehe Repository). Schriften: SIL OFL 1.1. qrcode.js: MIT.
import base64 as _b64, importlib.abc as _abc, importlib.util as _util, io as _io, sys as _sys, zipfile as _zip

_DATA = """
{data}
"""


class _BundleImporter(_abc.MetaPathFinder, _abc.Loader):
    def __init__(self, blob):
        zf = _zip.ZipFile(_io.BytesIO(blob))
        self.src = {{n: zf.read(n) for n in zf.namelist()}}
        self.files = {{n[len("auslosung/"):]: d for n, d in self.src.items() if not n.endswith(".py")}}

    def _path(self, name):
        base = name.replace(".", "/")
        for p in (base + ".py", base + "/__init__.py"):
            if p in self.src:
                return p
        return None

    def find_spec(self, name, path=None, target=None):
        if name == "auslosung._bundle":
            return _util.spec_from_loader(name, self)
        p = name.split(".")[0] == "auslosung" and self._path(name)
        if not p:
            return None
        spec = _util.spec_from_loader(name, self, origin="<bundle>/" + p, is_package=p.endswith("__init__.py"))
        spec.has_location = False
        return spec

    def create_module(self, spec):
        return None

    def exec_module(self, module):
        if module.__name__ == "auslosung._bundle":
            module.FILES = self.files
            return
        p = self._path(module.__name__)
        module.__file__ = "<bundle>/" + p
        exec(compile(self.src[p], module.__file__, "exec"), module.__dict__)


_sys.meta_path.insert(0, _BundleImporter(_b64.b64decode(_DATA)))

if __name__ == "__main__":
    from auslosung.cli import main
    main()
'''


def collect() -> list[tuple[str, bytes]]:
    out = []
    for p in sorted(PKG.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or p.suffix in (".pyc", ".pyo"):
            continue
        out.append((p.relative_to(ROOT).as_posix(), p.read_bytes()))
    return out


def build(target: Path) -> Path:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name, data in collect():
            info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))   # fest: gleiche Eingabe, gleiche Datei
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, data)
    b64 = base64.b64encode(buf.getvalue()).decode()
    data = "\n".join(b64[i:i + 100] for i in range(0, len(b64), 100))
    version = re.search(r'__version__ = "([^"]+)"', (PKG / "__init__.py").read_text()).group(1)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(STUB.format(version=version, data=data), encoding="utf-8")
    target.chmod(0o755)
    return target


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-o", "--out", default=str(ROOT / "dist" / "auslosung.py"))
    path = build(Path(ap.parse_args().out))
    print(f"{path} ({path.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
