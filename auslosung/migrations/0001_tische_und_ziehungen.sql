CREATE TABLE draws (
    id         INTEGER PRIMARY KEY,
    code       TEXT    NOT NULL UNIQUE,              -- kurzer Code für QR und URL
    title      TEXT    NOT NULL,                     -- z. B. "Wer holt den Kuchen?"
    mode       TEXT    NOT NULL DEFAULT 'wheel'
               CHECK (mode IN ('wheel', 'roulette', 'plinko')),
    host_key   TEXT    NOT NULL,                     -- berechtigt zum Ziehen
    created_at INTEGER NOT NULL
);
CREATE TABLE entrants (
    id         INTEGER PRIMARY KEY,
    draw_id    INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL COLLATE NOCASE,
    token      TEXT    UNIQUE,                       -- NULL = am großen Bildschirm eingetragen
    tip_id     INTEGER REFERENCES entrants(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (draw_id, name)
);
CREATE INDEX entrants_draw ON entrants(draw_id);
CREATE TABLE picks (
    id         INTEGER PRIMARY KEY,
    draw_id    INTEGER NOT NULL REFERENCES draws(id) ON DELETE CASCADE,
    mode       TEXT    NOT NULL,
    winner_id  INTEGER REFERENCES entrants(id) ON DELETE SET NULL,
    winner     TEXT    NOT NULL,                     -- Name bleibt, auch wenn der Eintrag fehlt
    slot       INTEGER NOT NULL,                     -- Feld, auf dem die Animation landet
    layout     TEXT    NOT NULL,                     -- JSON: Belegung der Felder, Plinko-Weg
    tips       TEXT    NOT NULL,                     -- JSON: {wetter_id: ziel_id}
    started_at INTEGER NOT NULL,
    ends_at    INTEGER NOT NULL,
    cleared    INTEGER NOT NULL DEFAULT 0            -- 1 = wieder im Topf
);
CREATE INDEX picks_draw ON picks(draw_id, id DESC);
