'use strict';

/*
 * Gemeinsames Import-Modul fuer CSV und Excel (.xlsx) – ohne externe Pakete.
 * Wird sowohl vom CLI (import-csv.js) als auch vom Web-Upload (server.js) genutzt.
 *
 * - .xlsx wird per eingebautem zlib (ZIP/Deflate) gelesen, sharedStrings + erstes
 *   Tabellenblatt in ein Raster (rows[][]) umgewandelt.
 * - Spaltenzuordnung wie in der Bolliger-Vorlage (Kopfzeile enthaelt "Auftrags-Nummer").
 * - merge(): Abgleich gegen bestehende Auftraege (Werkstatt-Status bleibt erhalten).
 */

const zlib = require('zlib');
const crypto = require('crypto');

/* ---------- CSV ---------- */
function detectDelimiter(text) {
  const line = text.split('\n').find((l) => /Auftrags-?Nummer/i.test(l)) || text.split('\n')[0] || '';
  return (line.split(';').length > line.split(',').length) ? ';' : ',';
}
function parseCsv(text, delim) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* ignorieren */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------- XLSX (ZIP + XML) ---------- */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Keine gueltige Excel-/ZIP-Datei');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    const lhNameLen = buf.readUInt16LE(localOff + 26);
    const lhExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? comp : zlib.inflateRawSync(comp);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
function decodeXml(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#10;/g, '\n').replace(/&apos;/g, "'");
}
function colToIdx(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

function xlsxToRows(buf) {
  const files = readZip(buf);
  const ssXml = files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : '';
  const sis = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')));
  const sheetName = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('Kein Tabellenblatt gefunden');
  const sheet = files[sheetName].toString('utf8');
  const rows = [];
  const re = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m;
  while ((m = re.exec(sheet))) {
    const col = colToIdx(m[1]); const row = +m[2] - 1; const attrs = m[3]; const inner = m[4] || '';
    const v = inner.match(/<v>([\s\S]*?)<\/v>/);
    const t = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
    let val = '';
    if (/t="s"/.test(attrs)) val = sis[+(v ? v[1] : -1)] || '';
    else if (/t="inlineStr"/.test(attrs)) val = decodeXml(t ? t[1] : '');
    else val = v ? v[1] : '';
    (rows[row] = rows[row] || [])[col] = val;
  }
  return rows.map((r) => { r = r || []; for (let i = 0; i < r.length; i++) if (r[i] == null) r[i] = ''; return r; });
}

/* ---------- Datei -> Raster ---------- */
function fileToRows(name, buf) {
  if (/\.xlsx$/i.test(name || '') || (buf[0] === 0x50 && buf[1] === 0x4b)) return xlsxToRows(buf); // 'PK' = ZIP/xlsx
  const text = buf.toString('utf8');
  return parseCsv(text, detectDelimiter(text));
}

/* ---------- Raster -> Auftraege ---------- */
function parseDate(s) {
  if (s == null) return null;
  s = String(s).trim(); if (!s) return null;
  if (/^\d+(\.0+)?$/.test(s)) { // Excel-Datumsserie
    const n = Math.round(parseFloat(s));
    if (n >= 20000 && n <= 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
  }
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m; y = y.length === 2 ? '20' + y : y;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
const isTrue = (v) => ['wahr', 'true', '1', 'x', 'ja'].includes(String(v == null ? '' : v).trim().toLowerCase());
function priorityFor(o) {
  if (o.flags.fertig || !o.due) return 'normal';
  const days = Math.ceil((new Date(o.due) - new Date()) / 86400000);
  if (days <= 3) return 'hoch';
  if (days <= 10) return 'normal';
  return 'tief';
}

function rowsToOrders(rows) {
  const headerIdx = rows.findIndex((r) => (r || []).some((c) => /Auftrags-?Nummer/i.test(c || '')));
  if (headerIdx < 0) throw new Error('Kopfzeile mit "Auftrags-Nummer" nicht gefunden. Bitte die CNC-Liste/Vorlage verwenden.');
  const C = { auftrag: 4, pos: 5, kunde: 6, objekt: 7, beschrieb: 8, aufwand: 9, termin: 10, datum: 11, maschinist: 12, bemerkung: 13, klm: 14, scd: 15, mueh: 16, huc: 17, hem: 18, teils: 19, fertig: 20 };
  const out = []; let lastAuftrag = '';
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || []; const get = (idx) => String(r[idx] == null ? '' : r[idx]).trim();
    const kunde = get(C.kunde); const beschrieb = get(C.beschrieb);
    if (!kunde || !beschrieb || /^total$/i.test(kunde)) continue;
    let auftrag = get(C.auftrag); if (auftrag) lastAuftrag = auftrag; else auftrag = lastAuftrag;
    const flags = { KLM: isTrue(r[C.klm]), scd: isTrue(r[C.scd]), 'müh': isTrue(r[C.mueh]), huc: isTrue(r[C.huc]), hem: isTrue(r[C.hem]), teils: isTrue(r[C.teils]), fertig: isTrue(r[C.fertig]) };
    const req512 = /kontur/i.test([beschrieb, get(C.objekt), get(C.bemerkung)].join(' '));
    const now = Date.now();
    const o = {
      id: crypto.randomUUID(), number: auftrag || '—', pos: get(C.pos), customer: kunde,
      object: get(C.objekt), title: beschrieb, effort: parseFloat(get(C.aufwand)) || null,
      stationId: flags.fertig ? 'fertig' : 'warte', requires512: req512, assignee: get(C.maschinist),
      due: parseDate(get(C.termin)), notes: get(C.bemerkung), flags, priority: 'normal',
      createdAt: now, updatedAt: now,
      history: [{ at: now, stationId: flags.fertig ? 'fertig' : 'warte', by: 'Import', note: req512 ? 'Importiert – Konturkante (nur 512)' : 'Aus Excel importiert' }],
    };
    o.priority = priorityFor(o);
    out.push(o);
  }
  return out;
}

/* ---------- Abgleich gegen bestehende Auftraege ---------- */
function merge(existing, incoming) {
  const byKey = new Map(existing.map((o) => [`${o.number}|${o.pos || ''}`, o]));
  const now = Date.now(); const results = []; let added = 0; let updated = 0;
  for (const inc of incoming) {
    const cur = byKey.get(`${inc.number}|${inc.pos || ''}`);
    if (cur) {
      cur.customer = inc.customer; cur.object = inc.object; cur.title = inc.title;
      cur.effort = inc.effort; cur.due = inc.due;
      if (!cur.assignee) cur.assignee = inc.assignee;
      if (!cur.notes) cur.notes = inc.notes;
      cur.requires512 = cur.requires512 || inc.requires512;
      cur.updatedAt = now;
      cur.history.push({ at: now, stationId: cur.stationId, by: 'Import', note: 'Abgleich aus Excel' });
      results.push({ order: cur, isNew: false }); updated++;
    } else {
      results.push({ order: inc, isNew: true }); added++;
    }
  }
  return { results, added, updated };
}

module.exports = { fileToRows, rowsToOrders, merge, parseCsv, detectDelimiter, xlsxToRows };
