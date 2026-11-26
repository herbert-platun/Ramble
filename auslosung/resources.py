"""Zugriff auf die Dateien im Paket (Vorlagen, statische Dateien, Migrationen).

Normal liegen sie neben dem Code. In der gebündelten Einzeldatei (tools/bundle.py)
stecken sie im Modul `auslosung._bundle` als {Pfad: Inhalt}; dann wird nur daraus gelesen.
"""
from __future__ import annotations

import posixpath
from pathlib import Path

ROOT = Path(__file__).resolve().parent

try:
    from ._bundle import FILES as _FILES          # nur in der gebündelten Fassung vorhanden
except ImportError:
    _FILES = None


def _clean(rel: str) -> str | None:
    """Relativer POSIX-Pfad ohne Ausbruch aus dem Paket, sonst None."""
    rel = posixpath.normpath(rel.replace("\\", "/")).lstrip("/")
    if rel in (".", "") or rel == ".." or rel.startswith("../"):
        return None
    return rel


def read(rel: str) -> bytes | None:
    """Inhalt von `rel` (relativ zum Paket), None wenn es die Datei nicht gibt."""
    rel = _clean(rel)
    if rel is None:
        return None
    if _FILES is not None:
        return _FILES.get(rel)
    path = (ROOT / rel).resolve()
    if ROOT not in path.parents or not path.is_file():
        return None
    return path.read_bytes()


def text(rel: str) -> str:
    data = read(rel)
    if data is None:
        raise FileNotFoundError(rel)
    return data.decode("utf-8")


def files(folder: str) -> list[str]:
    """Alle Dateien unter `folder`, sortiert, als Pfade relativ zum Paket."""
    folder = _clean(folder) or ""
    prefix = folder.rstrip("/") + "/"
    if _FILES is not None:
        return sorted(p for p in _FILES if p.startswith(prefix))
    base = ROOT / folder
    if not base.is_dir():
        return []
    return sorted(p.relative_to(ROOT).as_posix() for p in base.rglob("*")
                  if p.is_file() and "__pycache__" not in p.parts)
