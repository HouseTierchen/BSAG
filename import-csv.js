'use strict';

/*
 * Importer fuer die bestehende CNC-Programm-Excel (als CSV exportiert).
 *
 * Liest die gewohnte Spaltenstruktur ein und erzeugt daraus die data.json
 * fuer den Leitstand. So landen eure laufenden Auftraege direkt im Board.
 *
 * Aufruf:
 *   node import-csv.js <pfad-zur-datei.csv>
 *
 * Hinweis: data.json ist in .gitignore -> echte Kundendaten landen NICHT im Git.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');

/* Stationen passend zum heutigen Ablauf (CNC-zentriert).
 * 511 / 512 = die beiden CNC-Maschinen, KLM = Kantenleimmaschine. */
const STATIONS = [
  { id: 'warte',     name: 'Warteschlange',       machine: 'bereit zur Bearbeitung', color: '#0ea5e9' },
  { id: 'cnc511',    name: 'CNC 511',             machine: 'HOMAG CNC 511',     color: '#6366f1' },
  { id: 'cnc512',    name: 'CNC 512',             machine: 'HOMAG CNC 512',     color: '#8b5cf6' },
  { id: 'klm',       name: 'Kantenleimen',        machine: 'KLM',               color: '#ec4899' },
  { id: 'fertig',    name: 'Fertig (CNC)',        machine: 'erledigt',          color: '#16a34a' },
];

/* ---------------------------------------------------------------------------
 * Minimaler CSV-Parser (mit Anfuehrungszeichen-Unterstuetzung)
 * ------------------------------------------------------------------------- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignorieren
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* "5.6.26" / "26.6.26" / "01.06.2026" -> "2026-06-05" */
function parseDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  y = y.length === 2 ? '20' + y : y;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const isTrue = (v) => String(v).trim().toUpperCase() === 'WAHR';

function priorityFor(order) {
  if (order.flags.fertig) return 'normal';
  if (!order.due) return 'normal';
  const days = Math.ceil((new Date(order.due) - new Date()) / 86400000);
  if (days <= 3) return 'hoch';
  if (days <= 10) return 'normal';
  return 'tief';
}

/* ---------------------------------------------------------------------------
 * Hauptlogik
 * ------------------------------------------------------------------------- */
function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Aufruf: node import-csv.js <pfad-zur-datei.csv>');
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));

  // Kopfzeile finden (enthaelt "Auftrags-Nummer")
  const headerIdx = rows.findIndex((r) => r.some((c) => /Auftrags-?Nummer/i.test(c)));
  if (headerIdx < 0) { console.error('Kopfzeile nicht gefunden.'); process.exit(1); }

  // Spaltenindizes (entsprechend eurer Vorlage)
  const C = {
    auftrag: 4, pos: 5, kunde: 6, objekt: 7, beschrieb: 8, aufwand: 9,
    termin: 10, datum: 11, maschinist: 12, bemerkung: 13,
    klm: 14, scd: 15, mueh: 16, huc: 17, hem: 18, teils: 19, fertig: 20,
  };

  const orders = [];
  let lastAuftrag = '';

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (idx) => (r[idx] || '').trim();
    const kunde = get(C.kunde);
    const beschrieb = get(C.beschrieb);

    // Nur echte Auftragszeilen: Kunde + Beschrieb vorhanden, kein "Total"
    if (!kunde || !beschrieb || /^total$/i.test(kunde)) continue;

    let auftrag = get(C.auftrag);
    if (auftrag) lastAuftrag = auftrag; else auftrag = lastAuftrag; // fortlaufende Pos.

    const flags = {
      KLM: isTrue(r[C.klm]), scd: isTrue(r[C.scd]), müh: isTrue(r[C.mueh]),
      huc: isTrue(r[C.huc]), hem: isTrue(r[C.hem]), teils: isTrue(r[C.teils]),
      fertig: isTrue(r[C.fertig]),
    };

    const due = parseDate(get(C.termin));
    const now = Date.now();
    const o = {
      id: crypto.randomUUID(),
      number: auftrag || '—',
      pos: get(C.pos),
      customer: kunde,
      object: get(C.objekt),
      title: beschrieb,
      effort: parseFloat(get(C.aufwand)) || null,
      stationId: flags.fertig ? 'fertig' : 'warte',
      assignee: get(C.maschinist),
      due,
      notes: get(C.bemerkung),
      flags,
      priority: 'normal',
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, stationId: flags.fertig ? 'fertig' : 'warte', by: 'Import', note: 'Aus Excel importiert' }],
    };
    o.priority = priorityFor(o);
    orders.push(o);
  }

  const state = { stations: STATIONS, orders };
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  console.log(`Import fertig: ${orders.length} Auftragspositionen -> ${DATA_FILE}`);
  const fertig = orders.filter((o) => o.flags.fertig).length;
  console.log(`  davon erledigt: ${fertig}, offen: ${orders.length - fertig}`);
}

main();
