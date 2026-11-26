# Ramble · Auslosung

Zufallsgenerator in Casino-Style: Namen in den Topf, Chips auf den Tisch, Rad drehen.

Alle scannen den QR-Code am großen Bildschirm und tragen sich ein, jeder setzt seine
1.000 Chips auf den Namen, den es trifft. Gezogen wird per Glücksrad, Roulette oder
Plinko; wer richtig liegt, teilt sich den Jackpot. Python 3.10+, **keine Abhängigkeiten**.

## Starten

```sh
python3 -m auslosung                      # Port 8000, Datenbank ./auslosung.db
python3 -m auslosung --port 8080          # anderer Port
python3 -m auslosung --db pfad.db         # andere Datenbankdatei
python3 -m auslosung --url https://…      # Adresse im QR-Code (z. B. hinter einem Reverse Proxy)

python3 -m auslosung --admin              # Verwaltung unter /admin (Schlüssel steht in der Konsole)
python3 -m auslosung --admin --admin-key WORT --admin-lan
                                          # fester Schlüssel, auch von anderen Geräten erreichbar
```

Optional installieren: `pip install .` stellt den Befehl `auslosung` bereit.

## Tests

```sh
python3 -m unittest
```

## Aufbau

```
auslosung/
  cli.py            Kommandozeile, startet den Server
  app.py            Zustand für alle Geräte, Verteilung per Server-Sent Events
  handler.py        HTTP: Seiten, statische Dateien, JSON-API, Event-Stream
  admin.py          Verwaltung (nur mit --admin): Datenbank-Manager, SQL nur lesend
  db.py             SQLite-Schicht (Verbindung pro Thread, WAL, Migrationen)
  migrations/       NNNN_name.sql, Version in PRAGMA user_version – Nummern nie ändern
  game/
    rules.py        Konstanten, Fehlerklasse, Abrechnung der Wetten (rein, ohne DB)
    plinko.py       Form des Bretts, Dauer, zufälliger Weg zum Zielfach
    draws.py        Tische, Teilnehmer, Wetten, Ziehung (alles mit Datenbank)
  web/
    pages.py        HTML aus templates/ zusammensetzen
    assets.py       statische Dateien: Typ, ETag, Versions-Hash
    templates/      layout.html, lobby/host/play.html, admin.html, admin_guide.html
    static/
      css/          fonts, base, host, play, lobby
      fonts/        Jersey 10, Pixelify Sans (woff2, SIL OFL 1.1)
      js/           ES-Module
        main.js       Einstieg, wählt die Seite nach <body data-page>
        core.js       API, Server-Uhr, Event-Stream, Toast, Hilfen
        fx.js         Hintergrund-Shader, Partikel, Wackeln, Zähler
        audio.js      8-Bit-Klang und Musik (Web Audio)
        lights.js     Glühbirnen-Ketten
        stages/       Bühnen: stage (Basis), wheel, roulette, plinko
        pages/        lobby, host (großer Bildschirm), play (Handy)
      admin/        eigenes CSS/JS der Verwaltung
      vendor/       qrcode.js (qrcode-generator von Kazuhiko Arase, MIT)
tests/              unittest: Spiel, Verwaltung, Seiten
```

## Ablauf einer Ziehung

1. **Ziehen:** Der Host drückt „Ziehen“, der Topf wird eingefroren, der Name steht noch nicht fest.
2. **Nichts geht mehr** (`locks_at`): Der Server zieht mit `secrets` (jeder im Topf hat dieselbe
   Chance, Einsätze ändern daran nichts) und rechnet die Wetten ab.
3. **Animation** (`started_at`): landet dort, wo der Server entschieden hat.
4. **Ergebnis** (`ends_at`).

Weil erst bei `locks_at` gezogen wird, steht der Name vorher nirgends im Netzwerkverkehr.

## Lizenz

Siehe [LICENSE](LICENSE). Schriften: SIL Open Font License 1.1. QR-Bibliothek: MIT.
