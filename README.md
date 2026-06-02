# BSAG Leitstand

Digitaler **Auftrags- und Maschinen-Leitstand** für die Schreinerei – der schönere
Ersatz für die Excel-Tabelle. Auf einen Blick sichtbar: **Welcher Auftrag steht an
welcher Maschine / Station?**

Läuft auf **Tablet** (Werkstatt), **Büro-PC** (Arbeitsvorbereitung) und **Smartphone** –
alle Geräte sehen dieselben Daten **in Echtzeit**.

---

## Funktionen

- **Kanban-Board** mit echtem Maschinenfluss:
  `Warteschlange → CNC 511 / CNC 512 → Kantenleimen / Bankraum → Fertig`
  (511/512 sind Alternativen; nach der CNC wählt man per „Weiter"-Knopf das Ziel).
- **Automatische Maschinen-Zuteilung:** Aufträge mit „Kontur/Konturkante" gehen auf
  **CNC 512** und sind für 511 gesperrt.
- **Auftragsdaten** wie in der Excel: Auftrags-Nr., Pos, Kunde, Objekt, Beschrieb,
  Aufwand (h), Termin Rampe, Maschinist, Bemerkung.
- **Status-Häkchen** (KLM, Schmid Daniel, Mühlethalter Herbert, Hunn Celin,
  Heuberger Markus, teilweise) – direkt am Tablet antippbar.
- **Zeiterfassung** je Auftrag (Start/Stopp) → **Ist vs. Soll**-Stunden.
- **Auswertung / KPIs:** Termintreue, Ø Durchlaufzeit, Stunden Ist/Soll,
  offene Last je Station.
- **Excel/CSV-Import direkt in der Oberfläche** (Knopf „⬆ Import", Leitung/AV) –
  `.xlsx` oder CSV hochladen, von überall, ohne SSH.
- **CSV-Export** für den Abgleich zurück in die Excel.
- **Tagesrapport (A5 quer)** nach Vorlage Bolliger Söhne AG: druckt pro Mitarbeiter
  und Tag die erfassten Stunden je Auftrag – direkt auf den Netzwerkdrucker.
- **Live-Sync** über alle Geräte, **Verlauf** je Auftrag, **Termin-Warnungen**,
  Suche/Filter, grosse fingerfreundliche Kacheln, helles Design.
- **SQLite-Datenbank** mit **automatischem Backup** (kein externes Paket nötig).
- **Anmeldung ohne Passwort** (Benutzer auswählen) mit **Rollen** (Leitung, AV,
  Maschinist, Montage) – steuert, wer Stammdaten ändern darf.
- **QR-/Barcode-Scan** der Auftragsmappe (Kamera) zum schnellen Öffnen eines Auftrags.
- **Auto-Bereinigung:** erledigte Aufträge werden nach **7 Tagen** automatisch entfernt
  (Backups bleiben erhalten).

---

## Schnellstart (lokal)

Voraussetzung: **Node.js ≥ 22** ([nodejs.org](https://nodejs.org)).

```bash
node server.js        # bzw. npm start
```
Im Browser öffnen: **http://localhost:3000**
Andere Geräte im selben Netz: `http://<rechner-ip>:3000`.

Beim ersten Start wird – falls vorhanden – eine bestehende `data.json` einmalig in
die Datenbank übernommen, sonst werden Demo-Aufträge angelegt.

---

## Betrieb auf der Synology DS1522+ (empfohlen)

Die DS1522+ kann die App dauerhaft per **Container Manager (Docker)** betreiben.

1. Diesen Projektordner auf die NAS kopieren (z.B. via File Station).
2. **Container Manager → Projekt → erstellen**, Pfad auf den Ordner mit der
   `docker-compose.yml` zeigen lassen, Projekt starten.
3. Im Browser **http://\<NAS-IP\>:3000** öffnen.

Die Daten liegen dauerhaft im Unterordner **`./data`** (`data.sqlite` + `backups/`)
und überleben Updates/Neustarts des Containers. Port/Speicherort sind über die
Umgebungsvariablen `PORT` und `DATA_DIR` einstellbar.

Alternativ per Kommandozeile:
```bash
docker compose up -d --build
```

---

## Excel-Abgleich

Die App läuft **parallel zur Excel**. Am einfachsten geht der Abgleich direkt in der
Oberfläche über den Knopf **„⬆ Import"** (Leitung/AV): `.xlsx` oder CSV hochladen –
von jedem Gerät, ohne SSH. Alternativ per Kommandozeile:

```bash
node import-csv.js <pfad-zur-datei.csv>
```
Dabei werden **beschreibende Felder** (Kunde, Objekt, Beschrieb, Aufwand, Termin)
aus der Excel aktualisiert, während der **Werkstatt-Status** (Station, Häkchen,
Verlauf, Zeiten) in der App erhalten bleibt. Neue Positionen werden ergänzt.
Den **CSV-Export** aus der App (Knopf „⬇ Export") kann man umgekehrt in Excel öffnen.

> Bei laufendem Server diesen nach einem Abgleich kurz neu starten.

---

## Anmeldung & Rollen

Beim Öffnen wählt man **ohne Passwort** aus, wer man ist. Die Benutzer werden beim
ersten Start angelegt (Leitung, AV, Schmid Daniel, Mühlethalter Herbert, Hunn Celin,
Heuberger Markus, Montage) und lassen sich in der Datenbank anpassen.

- **Leitung / AV:** Aufträge anlegen, bearbeiten, löschen – alles.
- **Maschinist / Montage:** verschieben, Häkchen setzen, Zeiterfassung.

Erledigte Aufträge werden **nach 7 Tagen automatisch** aus dem Board entfernt
(die nächtlichen Backups enthalten sie weiterhin).

## Stationen / Maschinen anpassen

Die Stationen inkl. Fluss (`next`) stehen in `db.js`-Seed bzw. in `server.js`
(`DEFAULT_STATIONS`) und `import-csv.js` (`STATIONS`). Dort tragt ihr eure realen
Maschinen ein (Name, Maschine, Farbe, mögliche Folge-Stationen).

---

## Vorschau ohne Server

`vorschau.html` ist eine eigenständige Datei (per Doppelklick im Browser, auch am
Handy) zum Ausprobieren – Änderungen bleiben nur im jeweiligen Browser.
Neu erzeugen mit:
```bash
node make-preview.js
```

---

## Technik (kurz)

| Teil         | Umsetzung                                                        |
|--------------|------------------------------------------------------------------|
| Backend      | Node.js 22 (Standardbibliothek, keine externen Pakete)           |
| Datenbank    | eingebettetes **SQLite** (`node:sqlite`) + automatische Backups  |
| Live-Updates | Server-Sent Events (`/api/events`)                               |
| Frontend     | statisches HTML/CSS/JS in `public/` (kein Build)                 |
| Betrieb      | Docker / Synology Container Manager (`docker-compose.yml`)       |

---

## HOMAG-Anbindung (optional, standardmäßig aus)

Die HOMAG-Anbindung ist **komplett optional** und **standardmäßig deaktiviert** –
die App läuft ohne sie ganz normal. Eingebaut ist ein token-geschützter Endpunkt,
an den HOMAG-Maschinen bzw. der productionManager fertige Teile melden können,
sodass der Auftrag von selbst weiterrückt:

```
POST /api/homag/feedback
Header: x-homag-token: <TOKEN>
Body:   { "orderNumber": "2600931", "pos": "30", "event": "completed", "machine": "CNC 512" }
```
- `event: "completed"` → eine Station weiter; `"finished"` → auf „Fertig".
- **Einschalten** durch Setzen von **beidem**: `HOMAG_ENABLED=true` **und**
  `HOMAG_WEBHOOK_TOKEN=<geheim>`. Fehlt eines, ist die Anbindung aus (503).
- Die produktive **Connect-API** (Aufträge/Status von tapio abrufen) braucht
  zusätzlich `HOMAG_CLIENT_ID`/`HOMAG_CLIENT_SECRET` aus eurem tapio-Konto und
  productionManager *Advanced* – Platzhalter in `homag.js`.

## Nächste mögliche Ausbaustufen

1. **Material-/Startbereit-Status** und Benachrichtigungen bei Überfälligkeit.
2. **Reihenfolge je Maschine** manuell planen (Drag-Sortierung).
3. **Produktive HOMAG Connect-API** anbinden (sobald tapio-Zugang vorliegt).
4. **Anhänge** (Werkstattzeichnung/PDF, CNC-Programm) je Auftrag.
