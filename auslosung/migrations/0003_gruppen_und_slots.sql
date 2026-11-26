-- Gruppen: feste Namenslisten, die unabhängig von Tischen bleiben und wiederverwendet werden.
-- Slots: Sessions aus 1, 3, 5 oder 7 Runden mit Wetten je Runde.
-- Roulette und Jackpot entfallen; offene Einsätze gehen an ihre Besitzer zurück.
CREATE TABLE groups (
    id         INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    used_at    INTEGER NOT NULL                      -- zuletzt für einen Tisch genommen
);
CREATE TABLE members (
    id         INTEGER PRIMARY KEY,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL COLLATE NOCASE,
    symbol     TEXT,                                 -- Slot-Bild, bleibt über Tische hinweg gleich
    accent     INTEGER,                              -- Slot-Farbe 0–7
    created_at INTEGER NOT NULL,
    UNIQUE (group_id, name)
);

CREATE TABLE draws_new (
    id         INTEGER PRIMARY KEY,
    code       TEXT    NOT NULL UNIQUE,
    title      TEXT    NOT NULL,
    mode       TEXT    NOT NULL DEFAULT 'wheel' CHECK (mode IN ('wheel', 'plinko', 'slots')),
    rounds     INTEGER NOT NULL DEFAULT 3 CHECK (rounds IN (1, 3, 5, 7)),   -- Slots: Runden je Session
    group_id   INTEGER REFERENCES groups(id) ON DELETE SET NULL,
    host_key   TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);
INSERT INTO draws_new(id, code, title, mode, host_key, created_at)
    SELECT id, code, title, CASE mode WHEN 'roulette' THEN 'wheel' ELSE mode END, host_key, created_at FROM draws;
DROP TABLE draws;
ALTER TABLE draws_new RENAME TO draws;
UPDATE picks SET mode = 'wheel' WHERE mode = 'roulette';

-- Glücksrad und Plinko: ein kostenloser Tipp in tip_id. stake und streak bleiben ungenutzt stehen.
ALTER TABLE entrants ADD COLUMN member_id INTEGER REFERENCES members(id) ON DELETE SET NULL;
UPDATE entrants SET chips = chips + stake, stake = 0, tip_id = NULL, streak = 0;
CREATE INDEX entrants_member ON entrants(member_id);

-- Slots: offene Einsätze für die nächste Runde, mehrere Namen pro Handy
CREATE TABLE wagers (
    entrant_id INTEGER NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
    on_id      INTEGER NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
    stake      INTEGER NOT NULL CHECK (stake > 0),
    PRIMARY KEY (entrant_id, on_id)
);

-- Slots: eine Zeile pro Runde einer Session (picks.mode = 'slots')
CREATE TABLE rounds (
    id         INTEGER PRIMARY KEY,
    pick_id    INTEGER NOT NULL REFERENCES picks(id) ON DELETE CASCADE,
    n          INTEGER NOT NULL,                     -- 1 … Runden der Session
    calls_at   INTEGER NOT NULL,                     -- ab hier Einsätze für diese Runde
    locks_at   INTEGER NOT NULL,                     -- „Nichts geht mehr“, dann wird gedreht
    started_at INTEGER NOT NULL,
    ends_at    INTEGER NOT NULL,
    locked     INTEGER NOT NULL DEFAULT 0,
    result     TEXT,                                 -- JSON: Spins, Muster, Punkte, Zeitplan
    payouts    TEXT    NOT NULL DEFAULT '{}',        -- JSON: {wetter_id: {stakes, wins, win, bail}}
    UNIQUE (pick_id, n)
);
