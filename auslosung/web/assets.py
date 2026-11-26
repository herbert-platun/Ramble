"""Statische Dateien aus web/static: Typ, ETag und Versionsnummer für Cache-Busting."""
from __future__ import annotations

import hashlib
import mimetypes
from pathlib import Path

STATIC = Path(__file__).resolve().parent / "static"

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
    path = (STATIC / rel).resolve()
    if not path.is_file() or STATIC.resolve() not in path.parents:
        return None
    body = path.read_bytes()
    ctype = TYPES.get(path.suffix) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    _cache[rel] = (body, ctype, '"' + hashlib.sha1(body).hexdigest()[:16] + '"')
    return _cache[rel]


def version() -> str:
    """Kurzer Hash über alle statischen Dateien; hängt als ?v=… an den Adressen."""
    global _version
    if not _version:
        h = hashlib.sha1()
        for p in sorted(STATIC.rglob("*")):
            if p.is_file():
                h.update(p.relative_to(STATIC).as_posix().encode() + p.read_bytes())
        _version = h.hexdigest()[:10]
    return _version


def url(rel: str) -> str:
    return f"/static/{rel}?v={version()}"
