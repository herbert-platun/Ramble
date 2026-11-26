"""Kleine SQLite-Schicht: eine Verbindung pro Thread, WAL, Migrationen in PRAGMA user_version.

Zeitstempel sind Unix-Millisekunden. Die erreichte Schemaversion steht in
PRAGMA user_version, es gibt keine Verwaltungstabelle. Die Migrationen liegen als
NNNN_name.sql in auslosung/migrations/; Nummern nie ändern, damit bestehende
Datenbanken älterer Fassungen nahtlos weitergeführt werden.
"""
from __future__ import annotations

import re
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import resources

def load_migrations() -> list[tuple[int, str]]:
    """[(Nummer, SQL)] aus migrations/NNNN_name.sql, aufsteigend sortiert."""
    found = []
    for rel in resources.files("migrations"):
        m = re.match(r"(\d+)_.*\.sql$", rel.rsplit("/", 1)[-1])
        if m:
            found.append((int(m.group(1)), resources.text(rel)))
    return sorted(found)


MIGRATIONS = load_migrations()


def _dict_factory(cursor: sqlite3.Cursor, row: tuple) -> dict:
    return {col[0]: row[i] for i, col in enumerate(cursor.description)}


class Database:
    """Eine Verbindung pro Thread, WAL-Modus, Schreibzugriffe serialisiert."""

    def __init__(self, path: str | Path, migrations=None):
        self.path = str(path)
        self.migrations = MIGRATIONS if migrations is None else migrations
        self._local = threading.local()
        self._write_lock = threading.RLock()

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            conn.row_factory = _dict_factory
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def all(self, sql: str, *params: Any) -> list[dict]:
        return self.conn.execute(sql, params).fetchall()

    def one(self, sql: str, *params: Any) -> dict | None:
        return self.conn.execute(sql, params).fetchone()

    def value(self, sql: str, *params: Any) -> Any:
        row = self.conn.execute(sql, params).fetchone()
        return None if row is None else next(iter(row.values()))

    def execute(self, sql: str, *params: Any) -> sqlite3.Cursor:
        with self._write_lock:
            return self.conn.execute(sql, params)

    @contextmanager
    def transaction(self) -> Iterator["Tx"]:
        """BEGIN IMMEDIATE … COMMIT, bei Ausnahme ROLLBACK. Verschachtelbar."""
        with self._write_lock:
            depth = getattr(self._local, "depth", 0)
            conn = self.conn
            conn.execute("BEGIN IMMEDIATE" if depth == 0 else f"SAVEPOINT sp{depth}")
            self._local.depth = depth + 1
            try:
                yield Tx(conn)
            except BaseException:
                if depth == 0:
                    conn.execute("ROLLBACK")
                else:
                    conn.execute(f"ROLLBACK TO sp{depth}")
                    conn.execute(f"RELEASE sp{depth}")
                raise
            else:
                conn.execute("COMMIT" if depth == 0 else f"RELEASE sp{depth}")
            finally:
                self._local.depth = depth

    def migrate(self) -> list[int]:
        current = self.value("PRAGMA user_version") or 0
        applied = []
        for number, sql in self.migrations:
            if number <= current:
                continue
            with self._write_lock:
                # Fremdschlüssel aus, damit Tabellen umgebaut werden können, ohne dass
                # ON DELETE CASCADE beim Kopieren Zeilen mitnimmt; danach prüfen.
                self.conn.execute("PRAGMA foreign_keys = OFF")
                try:
                    self.conn.executescript(f"BEGIN;\n{sql}\nPRAGMA user_version = {number};\nCOMMIT;")
                    broken = self.conn.execute("PRAGMA foreign_key_check").fetchall()
                finally:
                    self.conn.execute("PRAGMA foreign_keys = ON")
                if broken:
                    raise RuntimeError(f"Migration {number}: Fremdschlüssel verletzt: {broken[:3]}")
            applied.append(number)
        return applied


class Tx:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def execute(self, sql: str, *params: Any) -> sqlite3.Cursor:
        return self.conn.execute(sql, params)

    def insert(self, sql: str, *params: Any) -> int:
        return self.conn.execute(sql, params).lastrowid

    def all(self, sql: str, *params: Any) -> list[dict]:
        return self.conn.execute(sql, params).fetchall()

    def one(self, sql: str, *params: Any) -> dict | None:
        return self.conn.execute(sql, params).fetchone()

    def value(self, sql: str, *params: Any) -> Any:
        row = self.conn.execute(sql, params).fetchone()
        return None if row is None else next(iter(row.values()))

