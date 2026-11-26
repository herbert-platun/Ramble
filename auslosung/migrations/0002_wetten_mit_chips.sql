-- Wetten mit Chips: Einsatz liegt in stake auf tip_id, Abrechnung bei locks_at
ALTER TABLE draws ADD COLUMN jackpot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entrants ADD COLUMN chips  INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE entrants ADD COLUMN stake  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entrants ADD COLUMN streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE picks ADD COLUMN locks_at INTEGER;
ALTER TABLE picks ADD COLUMN locked   INTEGER NOT NULL DEFAULT 1;
ALTER TABLE picks ADD COLUMN payouts  TEXT NOT NULL DEFAULT '{}';
UPDATE picks SET locks_at = started_at;
