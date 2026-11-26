"""HTML-Seiten aus den Vorlagen in templates/. Platzhalter heißen {{name}}."""
from __future__ import annotations

from .. import resources
from . import assets

KINDS = ("lobby", "host", "play")
SHARED_CSS = ("css/fonts.css", "css/base.css", "css/slots.css", "css/host.css", "css/play.css", "css/lobby.css")


def _template(name: str) -> str:
    return resources.text(f"web/templates/{name}")


def _render(name: str, **values: str) -> bytes:
    html = _template(name)
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
    body = _template(f"{kind}.html").rstrip("\n")
    if kind in ("host", "play"):     # Slot-Symbole als Sprite, damit <use href="#sym-…"> greift
        body = assets.text("img/symbols.svg").strip() + "\n" + body
    return _render("layout.html", viewport=viewport, kind=kind, body=body, styles=_styles(*SHARED_CSS),
                   scripts=qr + _module("js/main.js"))


def admin_page() -> bytes:
    guide = _template("admin_guide.html").rstrip("\n")
    return _render("admin.html", styles=_styles(*SHARED_CSS, "admin/admin.css"), guide=guide,
                   scripts=_module("js/main.js") + "\n" + _module("admin/admin.js"))
