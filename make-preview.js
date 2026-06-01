'use strict';

/*
 * Erzeugt eine eigenstaendige Vorschau-Datei (vorschau.html).
 *
 * Diese eine Datei enthaelt alles (HTML, CSS, JS + aktuelle Daten) und laeuft
 * OHNE Server direkt im Browser – einfach doppelklicken. Aenderungen werden
 * lokal im Browser gespeichert (localStorage), es gibt keine Live-Synchro
 * zwischen Geraeten. Zum echten Mehrgeraete-Betrieb dient server.js.
 *
 * Aufruf:  node make-preview.js   (liest die aktuelle Datenbank)
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Daten aus der Datenbank laden
const db = require('./db');
db.open();
const state = { stations: db.getStations(), orders: db.getOrders() };
if (!state.orders.length) {
  console.error('Datenbank leer – bitte zuerst "node import-csv.js <datei.csv>" ausfuehren oder den Server einmal starten.');
  process.exit(1);
}

const css = read('public/styles.css');
const appjs = read('public/app.js');
let html = read('public/index.html');

/* In-Browser-Ersatz fuer Server + Live-Verbindung: localStorage statt API. */
const shim = `
/* ---- Vorschau-Modus: ersetzt Server-API durch localStorage ---- */
const __KEY = 'bsag_preview_v8';
const __INITIAL = ${JSON.stringify(state)};
let __store = (() => { try { return JSON.parse(localStorage.getItem(__KEY)) || __INITIAL; } catch (e) { return __INITIAL; } })();
const __save = () => localStorage.setItem(__KEY, JSON.stringify(__store));

const __sse = [];
class __FakeES {
  constructor() { this._l = {}; this.onopen = null; this.onerror = null; __sse.push(this); setTimeout(() => this.onopen && this.onopen(), 0); }
  addEventListener(t, fn) { (this._l[t] = this._l[t] || []).push(fn); }
}
function __emit(type, data) { for (const es of __sse) (es._l[type] || []).forEach((fn) => fn({ data: JSON.stringify(data) })); }
window.EventSource = __FakeES;

function __resp(data, status) { return Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: async () => data }); }
function __find(id) { return __store.orders.find((o) => o.id === id); }

window.fetch = async (url, opts) => {
  opts = opts || {};
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  const now = Date.now();

  // Vorschau ist immer als "Leitung" angemeldet (keine echte Anmeldung noetig)
  if (url === '/api/me' && method === 'GET') return __resp({ name: 'Vorschau', role: 'leitung', username: 'vorschau' });
  if (url === '/api/users' && method === 'GET') return __resp([{ username: 'vorschau', name: 'Vorschau', role: 'leitung' }]);
  if (url === '/api/login' && method === 'POST') return __resp({ name: 'Vorschau', role: 'leitung', username: 'vorschau' });
  if (url === '/api/logout' && method === 'POST') return __resp({ ok: true });

  if (url === '/api/state' && method === 'GET') return __resp(__store);

  if (url === '/api/orders' && method === 'POST') {
    const stationId = body.stationId && __store.stations.some((s) => s.id === body.stationId) ? body.stationId : __store.stations[0].id;
    const order = {
      id: crypto.randomUUID(), number: String(body.number), pos: body.pos || '', customer: body.customer || '',
      object: body.object || '', title: body.title, effort: body.effort != null ? body.effort : null, stationId,
      priority: body.priority || 'normal', assignee: body.assignee || '', due: body.due || null, notes: body.notes || '',
      flags: body.flags || {}, createdAt: now, updatedAt: now,
      history: [{ at: now, stationId, by: body.by || 'Unbekannt', note: 'Auftrag angelegt' }],
    };
    __store.orders.push(order); __save(); __emit('order:created', order); return __resp(order, 201);
  }

  let m = url.match(/^\\/api\\/orders\\/([^/]+)\\/move$/);
  if (m && method === 'POST') {
    const o = __find(m[1]); if (!o) return __resp({ error: 'nicht gefunden' }, 404);
    o.stationId = body.stationId; o.updatedAt = now;
    o.history.push({ at: now, stationId: body.stationId, by: body.by || 'Unbekannt', note: body.note || 'Station gewechselt' });
    __save(); __emit('order:updated', o); return __resp(o);
  }

  m = url.match(/^\\/api\\/orders\\/([^/]+)$/);
  if (m) {
    const o = __find(m[1]); if (!o) return __resp({ error: 'nicht gefunden' }, 404);
    if (method === 'PUT') {
      for (const f of ['number','pos','customer','object','title','effort','priority','assignee','due','notes','flags','timeLogs'])
        if (body[f] !== undefined) o[f] = body[f];
      o.updatedAt = now; __save(); __emit('order:updated', o); return __resp(o);
    }
    if (method === 'DELETE') {
      __store.orders = __store.orders.filter((x) => x.id !== o.id); __save(); __emit('order:deleted', { id: o.id }); return __resp({ ok: true });
    }
  }
  return __resp({ error: 'unbekannt' }, 404);
};

/* Kleiner Hinweis-Balken + Zuruecksetzen-Knopf */
window.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#fef3c7;color:#92400e;font-size:14px;padding:8px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px';
  bar.innerHTML = '<span>Vorschau-Modus – Aenderungen werden nur in diesem Browser gespeichert (keine Live-Synchro zwischen Geraeten).</span>';
  const btn = document.createElement('button');
  btn.textContent = 'Vorschau zuruecksetzen';
  btn.style.cssText = 'background:#fde68a;border:1px solid #f59e0b;color:#92400e;border-radius:8px;padding:7px 12px;cursor:pointer;white-space:nowrap;font-weight:600';
  btn.onclick = () => { localStorage.removeItem(__KEY); location.reload(); };
  bar.appendChild(btn);
  document.body.insertBefore(bar, document.body.firstChild);
});
`;

html = html
  .replace('<link rel="stylesheet" href="/styles.css" />', `<style>\n${css}\n</style>`)
  .replace('<script src="/app.js"></script>', `<script>\n${shim}\n</script>\n<script>\n${appjs}\n</script>`);

fs.writeFileSync(path.join(ROOT, 'vorschau.html'), html);
console.log(`vorschau.html erstellt (${state.orders.length} Auftraege eingebettet).`);
