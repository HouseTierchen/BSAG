# BSAG Leitstand

Digitaler **Auftrags- und Maschinen-Leitstand** für die Schreinerei – der schönere
Ersatz für die Excel-Tabelle. Auf einen Blick sichtbar: **Welcher Auftrag steht an
welcher Maschine / Station?**

Läuft auf **Tablet** (Werkstatt), **Büro-PC** (Arbeitsvorbereitung) und **Smartphone** –
alle Geräte sehen dieselben Daten **in Echtzeit**.

> Status: **Prototyp / MVP.** Bewusst ohne externe Abhängigkeiten gebaut (nur Node.js),
> damit er sich überall in Minuten starten lässt und einfach zu verstehen ist.

---

## Was kann es?

- **Kanban-Board**: Eine Spalte pro Station/Maschine (Zuschnitt → Kantenanleimen →
  CNC → Bohren → Oberfläche → Montage → QS → Versand → Erledigt).
- **Aufträge als Karten** mit Nummer, Kunde, Bezeichnung, Priorität, Verantwortlichem
  und Liefertermin.
- **Weiterschieben** per Knopf (◀ / ▶) auf dem Tablet oder per **Drag & Drop** am PC.
- **Live-Sync** über alle Geräte (Server-Sent Events) – kein Aktualisieren nötig.
- **Verlauf pro Auftrag**: wer hat ihn wann auf welche Station gesetzt.
- **Termin-Warnungen**: überfällige Aufträge rot, bald fällige gelb.
- **Suchen & Filtern** nach Auftrag, Kunde, Person oder Priorität.

---

## Starten

Voraussetzung: **Node.js ≥ 18** ([nodejs.org](https://nodejs.org)).

```bash
npm start
# oder:  node server.js
```

Dann im Browser öffnen: **http://localhost:3000**

Andere Geräte im selben Netz (z.B. Werkstatt-Tablet) erreichen es über die
IP des Server-Rechners, z.B. `http://192.168.1.50:3000`.

Beim ersten Start werden Beispiel-Stationen und ein paar Demo-Aufträge angelegt
(in `data.json`). Diese Datei ist die Datenbank – einfach löschen, um neu zu starten.

---

## Stationen / Maschinen anpassen

Die Liste der Stationen steht in `server.js` unter `DEFAULT_STATIONS`. Dort tragt ihr
eure echten HOMAG-Maschinen und Handarbeitsplätze ein (Name, Maschine, Farbe).
Nach einer Änderung `data.json` löschen, damit die neuen Stationen übernommen werden.

```js
{ id: 'cnc', name: 'CNC-Bearbeitung', machine: 'HOMAG CENTATEQ', color: '#8b5cf6' }
```

---

## Technik (kurz)

| Teil        | Umsetzung                                             |
|-------------|-------------------------------------------------------|
| Backend     | Node.js (Standardbibliothek, keine Pakete)            |
| Persistenz  | `data.json` (für den Prototyp; später z.B. SQLite)    |
| Live-Updates| Server-Sent Events (`/api/events`)                    |
| Frontend    | Statisches HTML/CSS/JS in `public/` (kein Build)      |
| API         | `GET /api/state`, `POST /api/orders`, `PUT /api/orders/:id`, `POST /api/orders/:id/move`, `DELETE /api/orders/:id` |

---

## Nächste Ausbaustufen (Ideen)

1. **QR-/Barcode-Etiketten** auf den Auftragsmappen → am Tablet scannen, um den
   Auftrag direkt zu öffnen und weiterzuschieben.
2. **HOMAG Connect-API** anbinden (ab productionManager Advanced), damit die Maschinen
   fertige Bauteile **automatisch zurückmelden** – kein manuelles Abhaken mehr.
3. **Benutzer/Anmeldung** statt Name-im-Browser, inkl. Rollen (AV, Werkstatt, Montage).
4. **Robuste Datenbank** (SQLite/Postgres) statt JSON-Datei, inkl. Backups.
5. **Auswertungen**: Durchlaufzeiten je Station, Engpässe, Termintreue.
6. **Import** der bestehenden Excel-Aufträge.

---

## Hinweis zum Kontext

Da ihr HOMAG-Maschinen einsetzt, lohnt sich parallel ein Blick auf den
**HOMAG productionManager** (tapio) – er bietet die automatische Rückmeldung der
Maschinen ab Werk. Dieser Prototyp ist die flexible Eigenbau-Alternative bzw. eine
Ergänzung für Stationen/Prozesse, die HOMAG nicht abdeckt.
