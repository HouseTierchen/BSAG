'use strict';

/*
 * BSAG Leitstand – digitaler Auftrags-/Maschinen-Tracker fuer die Schreinerei.
 *
 * Bewusst ohne externe Abhaengigkeiten (nur Node.js Standardbibliothek):
 *   - kein "npm install", kein Build-Step
 *   - Persistenz in einer einfachen JSON-Datei (data.json)
 *   - Live-Updates an alle Geraete via Server-Sent Events (SSE)
 *
 * Starten:  node server.js   (oder: npm start)
 * Danach im Browser oeffnen:  http://<server-ip>:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data.json');

/* ----------------------------------------------------------------------------
 * Stammdaten: typische Stationen/Maschinen einer Schreinerei mit HOMAG-Park.
 * "machine" verweist auf die konkrete Maschine (oder Handarbeitsplatz).
 * -------------------------------------------------------------------------- */
/* CNC 511 / 512 sind Alternativen: ein Auftrag laeuft auf EINER CNC und geht
 * danach weiter (Bankraum / sonstiges). "next" steuert die "Weiter"-Knoepfe. */
const DEFAULT_STATIONS = [
  { id: 'warte',    name: 'Warteschlange', machine: 'bereit zur Bearbeitung',       color: '#0ea5e9', next: ['cnc511', 'cnc512'] },
  { id: 'cnc511',   name: 'CNC 511',       machine: 'HOMAG CNC 511',                color: '#6366f1', next: ['kante', 'bankraum'] },
  { id: 'cnc512',   name: 'CNC 512',       machine: 'HOMAG CNC 512',                color: '#8b5cf6', next: ['kante', 'bankraum'] },
  { id: 'kante',    name: 'Kantenleimen',  machine: 'Kantenleimmaschine (KLM)',     color: '#0ea5a4', next: ['bankraum', 'fertig'] },
  { id: 'bankraum', name: 'Bankraum',      machine: 'Montage / Weiterverarbeitung', color: '#f59e0b', next: ['kante', 'fertig'] },
  { id: 'fertig',   name: 'Fertig',        machine: 'erledigt',                     color: '#16a34a', next: [] },
];

/* Beispiel-Auftraege, damit das Board beim ersten Start nicht leer ist. */
function seedOrders() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const mk = (o) => ({
    id: crypto.randomUUID(),
    number: o.number,
    customer: o.customer,
    title: o.title,
    stationId: o.stationId,
    requires512: !!o.requires512,
    priority: o.priority || 'normal',     // 'hoch' | 'normal' | 'tief'
    assignee: o.assignee || '',
    due: o.due || null,                    // ISO-Datum (YYYY-MM-DD)
    notes: o.notes || '',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, stationId: o.stationId, by: 'System', note: 'Auftrag angelegt' }],
  });
  return [
    mk({ number: '2026-041', customer: 'Familie Meier',   title: 'Kueche Eiche massiv',       stationId: 'cnc511',   priority: 'hoch',   assignee: 'Reto',  due: isoIn(2) }),
    mk({ number: '2026-039', customer: 'Architekt Huber',  title: 'Empfangstheke Praxis',      stationId: 'cnc512',   priority: 'normal', assignee: 'Sandra', due: isoIn(5), requires512: true }),
    mk({ number: '2026-044', customer: 'Restaurant Krone', title: '12x Tischplatten Nussbaum', stationId: 'warte',    priority: 'normal', assignee: '',      due: isoIn(8) }),
    mk({ number: '2026-035', customer: 'Familie Bolliger', title: 'Garderobe Flur',            stationId: 'bankraum', priority: 'tief',   assignee: 'Marco', due: isoIn(1) }),
    mk({ number: '2026-046', customer: 'Buero Lehmann',    title: 'Sideboard 3m',              stationId: 'warte',    priority: 'normal', assignee: '',      due: isoIn(12) }),
    mk({ number: '2026-030', customer: 'Hotel Bahnhof',    title: 'Rezeption Umbau',           stationId: 'fertig',   priority: 'hoch',   assignee: 'Reto',  due: isoIn(-1) }),
  ];
}

function isoIn(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ----------------------------------------------------------------------------
 * Persistenz (SQLite via db.js) – mit In-Memory-Spiegel fuer schnelle Lesezugriffe
 * -------------------------------------------------------------------------- */
const db = require('./db');
const homag = require('./homag');

let state = loadState();

function loadState() {
  db.open();
  // Erststart: Stationen anlegen (ggf. aus alter data.json uebernehmen)
  const legacy = readLegacyJson();
  if (db.counts().stations === 0) {
    db.setStations(legacy && legacy.stations ? legacy.stations : DEFAULT_STATIONS);
  }
  if (db.counts().orders === 0) {
    const orders = legacy && legacy.orders ? legacy.orders : seedOrders();
    orders.forEach((o) => db.upsertOrder(o));
    if (legacy) console.log(`Migration: ${orders.length} Auftraege aus data.json uebernommen.`);
  }
  seedUsers();                                   // Anmelde-Benutzer (ohne Passwort)
  db.backup();                                   // Sicherung beim Start
  setInterval(() => db.backup(), 6 * 60 * 60 * 1000); // alle 6h
  return { stations: db.getStations(), orders: db.getOrders() };
}

function readLegacyJson() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { return null; }
}

// Einzelnen Auftrag dauerhaft sichern (write-through in die DB).
function persist(order) {
  db.upsertOrder(order);
}

/* ----------------------------------------------------------------------------
 * Benutzer / Anmeldung / Rollen
 *   Rollen: 'leitung', 'av' (duerfen Auftraege anlegen/aendern/loeschen),
 *           'maschinist', 'montage' (duerfen verschieben, Haekchen, Zeiten).
 * -------------------------------------------------------------------------- */
const SESSION_MS = 12 * 60 * 60 * 1000;       // 12h
const sessions = new Map();                    // token -> { userId, expires }

function newSession(userId) {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, { userId, expires: Date.now() + SESSION_MS });
  return t;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function userFromReq(req) {
  const t = parseCookies(req).bsag_session;
  if (!t) return null;
  const s = sessions.get(t);
  if (!s || s.expires < Date.now()) { if (s) sessions.delete(t); return null; }
  return db.getUserById(s.userId) || null;
}
const canMaster = (u) => !!u && (u.role === 'leitung' || u.role === 'av');

function seedUsers() {
  if (db.countUsers() > 0) return;
  // Anmeldung ohne Passwort: man waehlt einfach aus, wer man ist.
  [
    ['leitung', 'Leitung', 'leitung'],
    ['av', 'Arbeitsvorbereitung', 'av'],
    ['scd', 'Schmid Daniel', 'maschinist'],
    ['müh', 'Mühlethalter Herbert', 'maschinist'],
    ['huc', 'Hunn Celin', 'maschinist'],
    ['hem', 'Heuberger Markus', 'maschinist'],
    ['montage', 'Montage', 'montage'],
  ].forEach(([username, name, role]) => {
    db.upsertUser({ id: crypto.randomUUID(), username, name, role, salt: '', hash: '' });
  });
  console.log('Benutzer angelegt (Anmeldung ohne Passwort): Leitung, AV, Schmid Daniel, Mühlethalter Herbert, Hunn Celin, Heuberger Markus, Montage.');
}

/* Erledigte Auftraege nach 7 Tagen automatisch entfernen (Backups bleiben). */
function fertigTime(o) {
  const f = [...(o.history || [])].reverse().find((h) => h.stationId === 'fertig');
  return f ? f.at : (o.updatedAt || 0);
}
function cleanupFinished() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const remove = state.orders.filter((o) => o.stationId === 'fertig' && fertigTime(o) < cutoff);
  if (!remove.length) return;
  const ids = new Set(remove.map((o) => o.id));
  remove.forEach((o) => db.deleteOrder(o.id));
  state.orders = state.orders.filter((o) => !ids.has(o.id));
  remove.forEach((o) => broadcast('order:deleted', { id: o.id }));
  console.log(`Auto-Bereinigung: ${remove.length} erledigte Auftraege (>7 Tage) entfernt.`);
}

/* ----------------------------------------------------------------------------
 * Live-Updates (SSE)
 * -------------------------------------------------------------------------- */
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

/* ----------------------------------------------------------------------------
 * Hilfsfunktionen
 * -------------------------------------------------------------------------- */
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Body zu gross'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // Verhindert Pfad-Ausbrueche ausserhalb von /public
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Verboten' });
  fs.readFile(filePath, (err, content) => {
    if (err) return send(res, 404, { error: 'Nicht gefunden' });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function findOrder(id) {
  return state.orders.find((o) => o.id === id);
}

// Routing-Regel: "Kontur"/"Konturkante" -> Auftrag muss auf CNC 512.
function requires512(text) {
  return /kontur/i.test(text || '');
}

/* ----------------------------------------------------------------------------
 * Server / Routing
 * -------------------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;
  const me = userFromReq(req);

  // --- HOMAG-Rueckmeldung (Maschine -> Board), token-geschuetzt ---
  if (url === '/api/homag/feedback' && method === 'POST') {
    if (!homag.enabled()) return send(res, 503, { error: 'HOMAG-Anbindung ist deaktiviert (HOMAG_ENABLED + HOMAG_WEBHOOK_TOKEN setzen)' });
    if (!homag.authorized(req)) return send(res, 401, { error: 'ungueltiges HOMAG-Token' });
    const b = await readBody(req);
    const now = () => Date.now();
    const r = homag.applyFeedback(b, {
      findByNumberPos: (num, pos) => state.orders.find((o) => String(o.number) === num && (pos == null || String(o.pos) === pos)),
      advance: (order, machine) => {
        const st = state.stations.find((s) => s.id === order.stationId);
        const nxt = st && st.next && st.next[0];
        if (nxt) order.stationId = nxt;
        order.updatedAt = now();
        order.history.push({ at: order.updatedAt, stationId: order.stationId, by: `HOMAG ${machine}`, note: 'Automatische Rueckmeldung: Bearbeitung fertig' });
        persist(order); broadcast('order:updated', order);
      },
      finish: (order, machine) => {
        order.flags = { ...(order.flags || {}), fertig: true };
        order.stationId = 'fertig';
        order.updatedAt = now();
        order.history.push({ at: order.updatedAt, stationId: 'fertig', by: `HOMAG ${machine}`, note: 'Automatische Rueckmeldung: fertig' });
        persist(order); broadcast('order:updated', order);
      },
      note: (order, machine, text) => {
        order.updatedAt = now();
        order.history.push({ at: order.updatedAt, stationId: order.stationId, by: `HOMAG ${machine}`, note: text });
        persist(order); broadcast('order:updated', order);
      },
    });
    return send(res, r.ok ? 200 : (r.status || 400), r.ok ? { ok: true, order: r.order } : { error: r.message });
  }

  // --- Anmeldung (ohne Passwort: Benutzer auswaehlen) ---
  if (url === '/api/users' && method === 'GET') {
    return send(res, 200, db.listUsers());
  }
  if (url === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const u = db.getUserByName(b.username);
    if (!u) return send(res, 401, { error: 'Unbekannter Benutzer' });
    const token = newSession(u.id);
    return send(res, 200, { name: u.name, role: u.role, username: u.username },
      { 'Set-Cookie': `bsag_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MS / 1000}` });
  }
  if (url === '/api/logout' && method === 'POST') {
    const t = parseCookies(req).bsag_session;
    if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'bsag_session=; HttpOnly; Path=/; Max-Age=0' });
  }
  if (url === '/api/me' && method === 'GET') {
    if (!me) return send(res, 401, { error: 'nicht angemeldet' });
    return send(res, 200, { name: me.name, role: me.role, username: me.username });
  }

  // Alle weiteren /api-Routen erfordern eine Anmeldung.
  if (url.startsWith('/api/') && !me) return send(res, 401, { error: 'nicht angemeldet' });

  // --- Live-Stream (SSE) ---
  if (url === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // --- Gesamtzustand laden ---
  if (url === '/api/state' && method === 'GET') {
    return send(res, 200, state);
  }

  // --- Auftrag anlegen ---
  if (url === '/api/orders' && method === 'POST') {
    if (!canMaster(me)) return send(res, 403, { error: 'Keine Berechtigung (nur Leitung/AV)' });
    try {
      const b = await readBody(req);
      if (!b.title || !b.number) return send(res, 400, { error: 'Nummer und Titel sind erforderlich' });
      const now = Date.now();
      const req512 = requires512([b.title, b.object, b.notes].join(' '));
      let stationId;
      if (b.stationId && state.stations.some((s) => s.id === b.stationId)) stationId = b.stationId;
      else if (req512 && state.stations.some((s) => s.id === 'cnc512')) stationId = 'cnc512';
      else stationId = state.stations[0].id;
      const order = {
        id: crypto.randomUUID(),
        number: String(b.number),
        pos: b.pos || '',
        customer: b.customer || '',
        object: b.object || '',
        title: b.title,
        effort: b.effort != null ? b.effort : null,
        stationId,
        requires512: req512,
        priority: b.priority || 'normal',
        assignee: b.assignee || '',
        due: b.due || null,
        notes: b.notes || '',
        flags: b.flags || {},
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, stationId, by: me.name, note: 'Auftrag angelegt' }],
      };
      state.orders.push(order);
      persist(order);
      broadcast('order:created', order);
      return send(res, 201, order);
    } catch (e) {
      return send(res, 400, { error: 'Ungueltige Daten' });
    }
  }

  // --- Auftrag-Routen mit ID ---
  const moveMatch = url.match(/^\/api\/orders\/([^/]+)\/move$/);
  if (moveMatch && method === 'POST') {
    const order = findOrder(moveMatch[1]);
    if (!order) return send(res, 404, { error: 'Auftrag nicht gefunden' });
    const b = await readBody(req);
    if (!state.stations.some((s) => s.id === b.stationId)) return send(res, 400, { error: 'Unbekannte Station' });
    // Kontur-Auftraege duerfen nicht auf CNC 511.
    if (order.requires512 && b.stationId === 'cnc511') {
      return send(res, 409, { error: 'Kontur-Auftrag: nur auf CNC 512 moeglich.' });
    }
    const now = Date.now();
    order.stationId = b.stationId;
    order.updatedAt = now;
    order.history.push({ at: now, stationId: b.stationId, by: me.name, note: b.note || 'Station gewechselt' });
    persist(order);
    broadcast('order:updated', order);
    return send(res, 200, order);
  }

  const idMatch = url.match(/^\/api\/orders\/([^/]+)$/);
  if (idMatch) {
    const order = findOrder(idMatch[1]);
    if (!order) return send(res, 404, { error: 'Auftrag nicht gefunden' });

    if (method === 'PUT') {
      const b = await readBody(req);
      const masterFields = ['number', 'pos', 'customer', 'object', 'title', 'effort', 'priority', 'assignee', 'due'];
      // Stammdaten duerfen nur Leitung/AV aendern; flags/notes/timeLogs alle.
      if (masterFields.some((f) => b[f] !== undefined) && !canMaster(me)) {
        return send(res, 403, { error: 'Keine Berechtigung zum Bearbeiten der Stammdaten' });
      }
      for (const f of [...masterFields, 'notes', 'flags', 'timeLogs']) {
        if (b[f] !== undefined) order[f] = b[f];
      }
      // Kontur-Erkennung nach Textaenderung neu bestimmen
      order.requires512 = requires512([order.title, order.object, order.notes].join(' '));
      order.updatedAt = Date.now();
      persist(order);
      broadcast('order:updated', order);
      return send(res, 200, order);
    }

    if (method === 'DELETE') {
      if (!canMaster(me)) return send(res, 403, { error: 'Keine Berechtigung (nur Leitung/AV)' });
      state.orders = state.orders.filter((o) => o.id !== order.id);
      db.deleteOrder(order.id);
      broadcast('order:deleted', { id: order.id });
      return send(res, 200, { ok: true });
    }
  }

  // --- Statische Dateien ---
  if (method === 'GET') return serveStatic(req, res);

  return send(res, 404, { error: 'Nicht gefunden' });
});

server.listen(PORT, () => {
  console.log(`BSAG Leitstand laeuft auf http://localhost:${PORT}`);
  cleanupFinished();                                   // erledigte >7 Tage entfernen
  setInterval(cleanupFinished, 60 * 60 * 1000);        // stuendlich pruefen
});
