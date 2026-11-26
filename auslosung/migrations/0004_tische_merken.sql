-- Startseite: nur Tische, die der Host ausdrücklich gespeichert hat. Ungespeicherte
-- Tische verfallen, wenn eine Weile nichts mehr passiert (Draws.purge_unsaved).
ALTER TABLE draws ADD COLUMN saved INTEGER NOT NULL DEFAULT 0;
