'use strict';

/*
 * CLI-Import der CNC-Liste (CSV oder Excel .xlsx) in die Datenbank.
 * Nutzt das gemeinsame Modul importer.js (gleiche Logik wie der Web-Upload).
 *
 * Aufruf:  node import-csv.js <pfad-zur-datei.csv|.xlsx>
 *
 * Abgleich: beschreibende Felder kommen aus der Excel, der Werkstatt-Status
 * (Station, Haekchen, Verlauf, Zeiten) bleibt in der App erhalten.
 */

const fs = require('fs');
const db = require('./db');
const importer = require('./importer');

/* Stationen, falls die Datenbank noch leer ist (sonst kommen sie vom Server). */
const STATIONS = [
  { id: 'warte',    name: 'Warteschlange', machine: 'bereit zur Bearbeitung',       color: '#0ea5e9', next: ['cnc'] },
  { id: 'cnc',      name: 'CNC',           machine: 'HOMAG CNC (511 / 512)',        color: '#6366f1', next: ['kante', 'bankraum'] },
  { id: 'kante',    name: 'Kantenleimen',  machine: 'Kantenleimmaschine (KLM)',     color: '#0ea5a4', next: ['bankraum', 'fertig'] },
  { id: 'bankraum', name: 'Bankraum',      machine: 'Montage / Weiterverarbeitung', color: '#f59e0b', next: ['kante', 'fertig'] },
  { id: 'fertig',   name: 'Fertig',        machine: 'erledigt',                     color: '#16a34a', next: [] },
];

function main() {
  const file = process.argv[2];
  if (!file) { console.error('Aufruf: node import-csv.js <pfad-zur-datei.csv|.xlsx>'); process.exit(1); }

  const buf = fs.readFileSync(file);
  let incoming;
  try {
    incoming = importer.rowsToOrders(importer.fileToRows(file, buf));
  } catch (e) {
    console.error('Import fehlgeschlagen:', e.message);
    process.exit(1);
  }

  db.open();
  if (db.counts().stations === 0) db.setStations(STATIONS);
  const { results, added, updated } = importer.merge(db.getOrders(), incoming);
  results.forEach((r) => db.upsertOrder(r.order));

  console.log(`Excel-Abgleich fertig: ${added} neu, ${updated} aktualisiert (Datenbank ${db.DB_FILE}).`);
  console.log('Hinweis: bei laufendem Server diesen danach neu starten, damit der Abgleich sichtbar wird.');
}

main();
