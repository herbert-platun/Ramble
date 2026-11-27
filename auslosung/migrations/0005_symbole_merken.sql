-- Slots: Bild und Farbe bleiben am Eintrag hängen. Vorher wurden sie bei jedem Abruf
-- nach Reihenfolge verteilt, und wer nach einem entfernten Namen kam, bekam ein neues Symbol.
ALTER TABLE entrants ADD COLUMN symbol TEXT;
ALTER TABLE entrants ADD COLUMN accent INTEGER;
