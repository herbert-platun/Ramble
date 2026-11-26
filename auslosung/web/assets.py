"""Statische Dateien aus web/static: Typ, ETag und Versionsnummer für Cache-Busting."""
from __future__ import annotations

import hashlib
import mimetypes

from .. import resources

STATIC = "web/static"

TYPES = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}

_cache: dict[str, tuple[bytes, str, str]] = {}
_version = ""


def read(rel: str) -> tuple[bytes, str, str] | None:
    """(Inhalt, Content-Type, ETag) zu einem Pfad unter static/, sonst None. Kein Ausbruch aus dem Ordner."""
    if rel in _cache:
        return _cache[rel]
    path = resources._clean(f"{STATIC}/{rel}")
    if path is None or not path.startswith(STATIC + "/"):
        return None
    body = resources.read(path)
    if body is None:
        return None
    suffix = "." + path.rsplit(".", 1)[-1] if "." in path.rsplit("/", 1)[-1] else ""
    ctype = TYPES.get(suffix) or mimetypes.guess_type(path)[0] or "application/octet-stream"
    _cache[rel] = (body, ctype, '"' + hashlib.sha1(body).hexdigest()[:16] + '"')
    return _cache[rel]


def text(rel: str) -> str:
    return resources.text(f"{STATIC}/{rel}")


def version() -> str:
    """Kurzer Hash über alle statischen Dateien; hängt als ?v=… an den Adressen."""
    global _version
    if not _version:
        h = hashlib.sha1()
        for p in resources.files(STATIC):
            h.update(p.encode() + resources.read(p))
        _version = h.hexdigest()[:10]
    return _version


def url(rel: str) -> str:
    return f"/static/{rel}?v={version()}"
