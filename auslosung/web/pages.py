"""HTML-Seiten aus den Vorlagen in templates/. Platzhalter heißen {{name}}."""
from __future__ import annotations

from pathlib import Path

from . import assets

TEMPLATES = Path(__file__).resolve().parent / "templates"
KINDS = ("lobby", "host", "play")
SHARED_CSS = ("css/fonts.css", "css/base.css", "css/host.css", "css/play.css", "css/lobby.css")


def _render(name: str, **values: str) -> bytes:
    html = (TEMPLATES / name).read_text(encoding="utf-8")
    for key, value in values.items():
        html = html.replace("{{" + key + "}}", value)
    return html.encode()


def _styles(*files: str) -> str:
    return "\n".join(f'  <link rel="stylesheet" href="{assets.url(f)}">' for f in files)


def _module(rel: str) -> str:
    return f'  <script type="module" src="{assets.url(rel)}"></script>'


def page(kind: str) -> bytes:
    """lobby (Startseite), host (großer Bildschirm) oder play (Handy)."""
    if kind not in KINDS:
        raise KeyError(kind)
    viewport = "width=device-width, initial-scale=1" + (", viewport-fit=cover" if kind == "play" else "")
    qr = f'  <script src="{assets.url("vendor/qrcode.js")}"></script>\n' if kind == "host" else ""
    body = (TEMPLATES / f"{kind}.html").read_text(encoding="utf-8").rstrip("\n")
    return _render("layout.html", viewport=viewport, kind=kind, body=body, styles=_styles(*SHARED_CSS),
                   scripts=qr + _module("js/main.js"))


def admin_page() -> bytes:
    guide = (TEMPLATES / "admin_guide.html").read_text(encoding="utf-8").rstrip("\n")
    return _render("admin.html", styles=_styles(*SHARED_CSS, "admin/admin.css"), guide=guide,
                   scripts=_module("js/main.js") + "\n" + _module("admin/admin.js"))
