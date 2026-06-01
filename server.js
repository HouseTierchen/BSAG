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
const DEFAULT_STATIONS = [
  { id: 'zuschnitt', name: 'Zuschnitt',           machine: 'HOMAG SAWTEQ',          color: '#0ea5e9' },
  { id: 'kante',     name: 'Kantenanleimen',      machine: 'HOMAG EDGETEQ',         color: '#6366f1' },
  { id: 'cnc',       name: 'CNC-Bearbeitung',     machine: 'HOMAG CENTATEQ',        color: '#8b5cf6' },
  { id: 'bohren',    name: 'Bohren / Beschlag',   machine: 'HOMAG DRILLTEQ',        color: '#a855f7' },
  { id: 'oberflaeche', name: 'Oberflaeche',       machine: 'Lackiererei',           color: '#ec4899' },
  { id: 'montage',   name: 'Montage / Korpus',    machine: 'Bankraum',              color: '#f59e0b' },
  { id: 'qs',        name: 'Qualitaetskontrolle', machine: 'Pruefplatz',            color: '#14b8a6' },
  { id: 'versand',   name: 'Versand / Montage',   machine: 'Auslieferung',          color: '#22c55e' },
  { id: 'fertig',    name: 'Erledigt',            machine: 'Archiv',                color: '#16a34a' },
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
    priority: o.priority || 'normal',     // 'hoch' | 'normal' | 'tief'
    assignee: o.assignee || '',
    due: o.due || null,                    // ISO-Datum (YYYY-MM-DD)
    notes: o.notes || '',
    createdAt: now,
    updatedAt: now,
    history: [{ at: now, stationId: o.stationId, by: 'System', note: 'Auftrag angelegt' }],
  });
  return [
    mk({ number: '2026-041', customer: 'Familie Meier',  title: 'Kueche Eiche massiv',        stationId: 'cnc',        priority: 'hoch',   assignee: 'Reto',  due: isoIn(2) }),
    mk({ number: '2026-039', customer: 'Architekt Huber', title: 'Empfangstheke Praxis',      stationId: 'kante',      priority: 'normal', assignee: 'Sandra', due: isoIn(5) }),
    mk({ number: '2026-044', customer: 'Restaurant Krone', title: '12x Tischplatten Nussbaum', stationId: 'zuschnitt', priority: 'normal', assignee: '',      due: isoIn(8) }),
    mk({ number: '2026-035', customer: 'Familie Bolliger', title: 'Garderobe Flur',           stationId: 'oberflaeche', priority: 'tief',  assignee: 'Marco', due: isoIn(1) }),
    mk({ number: '2026-046', customer: 'Buero Lehmann',   title: 'Sideboard 3m',              stationId: 'zuschnitt',  priority: 'normal', assignee: '',      due: isoIn(12) }),
    mk({ number: '2026-030', customer: 'Hotel Bahnhof',   title: 'Rezeption Umbau',           stationId: 'montage',    priority: 'hoch',   assignee: 'Reto',  due: isoIn(-1) }),
  ];
}

function isoIn(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/* ----------------------------------------------------------------------------
 * Persistenz
 * -------------------------------------------------------------------------- */
let state = loadState();

function loadState() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.stations) parsed.stations = DEFAULT_STATIONS;
    if (!parsed.orders) parsed.orders = [];
    return parsed;
  } catch (e) {
    const fresh = { stations: DEFAULT_STATIONS, orders: seedOrders() };
    saveState(fresh);
    return fresh;
  }
}

function saveState(s = state) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
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

/* ----------------------------------------------------------------------------
 * Server / Routing
 * -------------------------------------------------------------------------- */
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  const method = req.method;

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
    try {
      const b = await readBody(req);
      if (!b.title || !b.number) return send(res, 400, { error: 'Nummer und Titel sind erforderlich' });
      const now = Date.now();
      const stationId = b.stationId && state.stations.some((s) => s.id === b.stationId) ? b.stationId : state.stations[0].id;
      const order = {
        id: crypto.randomUUID(),
        number: String(b.number),
        pos: b.pos || '',
        customer: b.customer || '',
        object: b.object || '',
        title: b.title,
        effort: b.effort != null ? b.effort : null,
        stationId,
        priority: b.priority || 'normal',
        assignee: b.assignee || '',
        due: b.due || null,
        notes: b.notes || '',
        flags: b.flags || {},
        createdAt: now,
        updatedAt: now,
        history: [{ at: now, stationId, by: b.by || 'Unbekannt', note: 'Auftrag angelegt' }],
      };
      state.orders.push(order);
      saveState();
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
    const now = Date.now();
    order.stationId = b.stationId;
    order.updatedAt = now;
    order.history.push({ at: now, stationId: b.stationId, by: b.by || 'Unbekannt', note: b.note || 'Station gewechselt' });
    saveState();
    broadcast('order:updated', order);
    return send(res, 200, order);
  }

  const idMatch = url.match(/^\/api\/orders\/([^/]+)$/);
  if (idMatch) {
    const order = findOrder(idMatch[1]);
    if (!order) return send(res, 404, { error: 'Auftrag nicht gefunden' });

    if (method === 'PUT') {
      const b = await readBody(req);
      for (const f of ['number', 'pos', 'customer', 'object', 'title', 'effort', 'priority', 'assignee', 'due', 'notes', 'flags']) {
        if (b[f] !== undefined) order[f] = b[f];
      }
      order.updatedAt = Date.now();
      saveState();
      broadcast('order:updated', order);
      return send(res, 200, order);
    }

    if (method === 'DELETE') {
      state.orders = state.orders.filter((o) => o.id !== order.id);
      saveState();
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
});
