# Spielstatistik-SaaS – Einrichtung & Betrieb

Handball-Spielstatistik-PWA für mehrere Vereine/Mannschaften gleichzeitig.
Ein zentrales Deployment (Cloudflare Worker + D1-Datenbank) bedient alle
Kunden über einen eigenen URL-Pfad -- kein Google Sheet, kein separates
Hosting pro Verein.

Nicht zu verwechseln mit dem älteren Einzelvereins-Projekt
(`ChrisHoerner/Handball-Statistik`, Google Sheets + Apps Script) -- dieses
Repo hier ist der Nachfolger und komplett unabhängig davon.

## Architektur in Kürze

- **Frontend**: `index.html` / `app.js` / `style.css` -- eine PWA, läuft
  offline über IndexedDB, synchronisiert bei Verbindung.
- **Backend**: `src/index.js`, ein Cloudflare Worker. Liefert unter
  `/api/proxy` Login, Kader-/Spiele-/Aktionen-Sync, Auswertung und den
  CSV-Export. Alle anderen Pfade gehen an die statischen Dateien
  (`env.ASSETS.fetch`).
- **Datenbank**: Cloudflare D1 (SQLite), ein einziges Deployment für alle
  Kunden. Schema in `d1-schema.sql`.
- **Hosting**: Cloudflare Workers (nicht klassisches Pages -- Deploy läuft
  über `npx wrangler deploy`, gesteuert durch `wrangler.jsonc`).
- **Deploy**: GitHub-Repo `ChrisHoerner/handball-statistik-saas`, per
  Cloudflare-GitHub-Integration automatisch bei jedem Push auf `main`.

## Mandantenmodell: Verein -> Mannschaft

Ein **Verein** kann mehrere **Mannschaften** haben. Die Mannschaft ist die
eigentliche Dateneinheit -- eigener Kader, eigene Spiele/Aktionen, eigene
Zugangscodes. Der Verein ist nur die Klammer für die URL, keine gemeinsame
Datenbasis mehrerer Mannschaften.

URL-Schema: `https://<worker-domain>/<verein-slug>/<mannschaft-slug>`
Beispiel: `.../suedpfalztiger/damen1`

Der Slug wird beim Login aus der URL gelesen -- es gibt kein zusätzliches
Eingabefeld dafür. Ohne erkannten Slug ist das Login-Formular gesperrt.
Nach dem Login läuft alles über das Session-Token weiter, der Slug wird
nicht mehr gebraucht (auch nicht nach "Zum Startbildschirm hinzufügen").

## Einmalige Einrichtung eines neuen Deployments

Nur nötig, falls das Cloudflare-Projekt komplett neu aufgesetzt wird
(nicht für einen neuen Kunden -- siehe unten).

1. GitHub-Repo mit allen Dateien aus diesem Ordner anlegen.
2. Cloudflare -> Workers & Pages -> "Create an app" -> "Continue with
   GitHub" -> Repo auswählen. Build-Befehl leer lassen, Bereitstellungsbefehl
   `npx wrangler deploy` (Standard).
3. D1-Datenbank anlegen: Cloudflare -> Speicher und Datenbanken -> D1 ->
   "Create Database".
4. Die erzeugte `database_id` in `wrangler.jsonc` unter `d1_databases`
   eintragen (siehe Beispiel in der Datei).
5. Schema anwenden:
   ```
   npx wrangler d1 execute <db-name> --remote --file=./d1-schema.sql
   ```
   Achtung: `d1-schema.sql` beginnt mit `DROP TABLE IF EXISTS` für alle
   Tabellen -- bei einem bestehenden Deployment mit echten Kundendaten
   NICHT einfach erneut ausführen, sondern eine echte Migration schreiben.
6. Mindestens einen Test-Kunden seeden (siehe `seed.sql` als Vorlage).
7. Push nach `main` -> Cloudflare deployt automatisch. Danach unter
   Workers & Pages -> Projekt -> Einstellungen -> Bindungen prüfen, dass
   `DB` (D1) und `ASSETS` (statische Dateien) beide gelistet sind -- ohne
   `main`-Skript in `wrangler.jsonc` sind Bindings grundsätzlich nicht
   möglich (siehe Kopf-Kommentar in `wrangler.jsonc`).

## Neuen Kunden (Verein + Mannschaft) anlegen

Kein Formular dafür -- läuft über direkte SQL-Befehle gegen D1:

```sql
INSERT INTO vereine (slug, name) VALUES ('<verein-slug>', '<Vereinsname>');
INSERT INTO mannschaften (verein_id, slug, name)
  VALUES ((SELECT id FROM vereine WHERE slug = '<verein-slug>'), '<mannschaft-slug>', '<Mannschaftsname>');

INSERT INTO zugangscodes (mannschaft_id, code_hash, rolle, anzeige_name) VALUES
  ((SELECT id FROM mannschaften WHERE slug = '<mannschaft-slug>' AND verein_id = (SELECT id FROM vereine WHERE slug = '<verein-slug>')),
   '<sha256-hash-admin-code>', 'admin', 'Admin'),
  ((SELECT id FROM mannschaften WHERE slug = '<mannschaft-slug>' AND verein_id = (SELECT id FROM vereine WHERE slug = '<verein-slug>')),
   '<sha256-hash-nutzer-code>', 'nutzer', 'Nutzer 1');
```

Codes werden nie im Klartext gespeichert (SHA-256-Hash). Slugs nur
Kleinbuchstaben/Zahlen/Bindestrich, keine Umlaute (URL-Pfad).

Ausführen mit:
```
npx wrangler d1 execute <db-name> --remote --file=./<neue-datei>.sql
```

Ein zweites Team desselben Vereins ist danach nur eine weitere
`mannschaften`-Zeile mit demselben `verein_id` -- kein neues Deployment,
kein neuer Verein-Eintrag nötig.

## Vor dem ersten Spiel (pro Mannschaft)

1. Admin loggt sich unter `.../<verein-slug>/<mannschaft-slug>` ein.
2. Tab **Einstellungen**: Runde eintragen (z. B. `2026/27 Rückrunde`),
   speichern.
3. Tab **Kader**: Spielerinnen anlegen (Name, Rückennummer, Position) --
   läuft komplett in der App, kein externes Sheet mehr nötig. Läuft auch
   offline, synchronisiert bei Verbindung.
4. "Zum Startbildschirm hinzufügen" auf den Geräten der Helferinnen.

## Am Spieltag

Wie beim Vorgänger-System: Spiel anlegen, Kader für dieses Spiel wählen,
Live-Erfassung (Zonen-Kacheln Außen/Kreis/6m/9m/7m/Konter, je
Treffer/Fehlwurf bzw. Parade/Gegentor bei Torhüterinnen), Aktionen landen
sofort lokal, Sync automatisch bei Verbindung. Statusleiste zeigt
ausstehende Einträge.

## Auswertung

Pro Spielerin oder Team-gesamt, je Spiel oder ganze Runde -- Kartenansicht
je Zone mit Aufschlüsselung 1. Halbzeit / 2. Halbzeit / Gesamt und Quote.
CSV-Export der aktuell angezeigten Auswertung sowie der Rohaktionen eines
einzelnen Spiels.

## Eigene Daten (Datenhoheit)

Einstellungen -> "Alle Daten exportieren (CSV)" (nur Admin): lädt Kader,
Kader_Runde, Spiele und Aktionen der eigenen Mannschaft komplett als vier
CSV-Dateien herunter -- unabhängig vom Anbieter, jederzeit möglich.

## Zugangscode selbst ändern

Konto-Tab, nach dem Login: "Code ändern". Codes sind pro **Rolle**
vergeben, nicht pro Person -- der neue Code gilt für alle, die die
bisherige Rolle nutzen. Codes sind nirgends im Klartext einsehbar (auch
nicht vom Betreiber) -- bei Verlust nur Zurücksetzen möglich (neuer Hash
per SQL, siehe oben).

## Bekannte Einschränkungen (bewusst, siehe Chat-Notizen)

- **Einsatzzeit** (Ein-/Auswechslung): Tabelle `einsatz` existiert im
  Schema, die App schreibt aktuell nichts hinein.
- **Rückgängig nach erfolgtem Sync**: löscht nur lokal, warnt davor --
  die Zeile in D1 muss von Hand gelöscht werden (`DELETE FROM aktionen
  WHERE id = '<AktionID>'`).
- **Kunden-Anlage** ist reines SQL, keine Admin-Oberfläche.
- **Bezahlmodell** ist bewusst nicht Teil dieser Architektur.
- Nach jeder Code-Änderung an `app.js`/`style.css`/`sw.js` muss die
  Cache-Version in `sw.js` (`CACHE_NAME`) erhöht werden, sonst bekommen
  Nutzerinnen die neuen Dateien nicht automatisch -- Fallback: Konto-Tab
  -> "App-Version aktualisieren".

## Dateiübersicht

| Datei | Zweck |
|---|---|
| `index.html`, `app.js`, `style.css`, `manifest.json`, `sw.js`, `icons/` | Frontend (PWA) |
| `src/index.js` | Cloudflare Worker (Backend) |
| `wrangler.jsonc` | Deploy-/Binding-Konfiguration |
| `d1-schema.sql` | Vollständiges Datenbankschema (DROP + CREATE) |
| `seed.sql` | Beispiel/Test-Kunde (Verein+Mannschaft "test/test") |
