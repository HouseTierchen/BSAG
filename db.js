'use strict';

/*
 * Datenhaltung fuer den BSAG Leitstand mit eingebetteter SQLite-Datenbank
 * (node:sqlite – Bestandteil von Node 22, kein externes Paket noetig).
 *
 * - Quelle der Wahrheit ist data.sqlite (dauerhaft, mehrbenutzersicher).
 * - Auftraege werden als JSON-Datensatz gespeichert (gleiches Modell wie zuvor),
 *   Stationen separat mit Reihenfolge.
 * - Automatische, rotierende Backups im Ordner backups/.
 */

const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

// DATA_DIR erlaubt es, Datenbank + Backups auf ein persistentes Volume zu legen
// (z.B. auf der Synology DS1522+ ein gemountetes Verzeichnis /data).
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'data.sqlite');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 20;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

function open() {
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
      id TEXT PRIMARY KEY, name TEXT, machine TEXT, color TEXT, nxt TEXT, ord INTEGER
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, data TEXT NOT NULL, updatedAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE, name TEXT, role TEXT, salt TEXT, hash TEXT
    );
  `);
  return db;
}

/* ---- Benutzer ---- */
function countUsers() { return db.prepare('SELECT COUNT(*) c FROM users').get().c; }
function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase());
}
function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function listUsers() {
  return db.prepare('SELECT id, username, name, role FROM users ORDER BY name').all();
}
function upsertUser(u) {
  db.prepare('INSERT OR REPLACE INTO users (id, username, name, role, salt, hash) VALUES (?, ?, ?, ?, ?, ?)')
    .run(u.id, u.username.toLowerCase(), u.name, u.role, u.salt, u.hash);
}

/* ---- Stationen ---- */
function setStations(stations) {
  const del = db.prepare('DELETE FROM stations');
  del.run();
  const ins = db.prepare('INSERT INTO stations (id, name, machine, color, nxt, ord) VALUES (?, ?, ?, ?, ?, ?)');
  stations.forEach((s, i) => ins.run(s.id, s.name, s.machine, s.color, JSON.stringify(s.next || []), i));
}

function getStations() {
  const rows = db.prepare('SELECT * FROM stations ORDER BY ord').all();
  return rows.map((r) => ({ id: r.id, name: r.name, machine: r.machine, color: r.color, next: JSON.parse(r.nxt || '[]') }));
}

/* ---- Auftraege ---- */
function getOrders() {
  return db.prepare('SELECT data FROM orders').all().map((r) => JSON.parse(r.data));
}

function upsertOrder(order) {
  db.prepare('INSERT OR REPLACE INTO orders (id, data, updatedAt) VALUES (?, ?, ?)')
    .run(order.id, JSON.stringify(order), order.updatedAt || Date.now());
}

function deleteOrder(id) {
  db.prepare('DELETE FROM orders WHERE id = ?').run(id);
}

function counts() {
  return {
    stations: db.prepare('SELECT COUNT(*) c FROM stations').get().c,
    orders: db.prepare('SELECT COUNT(*) c FROM orders').get().c,
  };
}

/* ---- Backups ---- */
function backup() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `data-${stamp}.sqlite`));
    // alte Backups aufraeumen
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.sqlite')).sort();
    while (files.length > KEEP_BACKUPS) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) {
    console.error('Backup fehlgeschlagen:', e.message);
  }
}

module.exports = {
  open, setStations, getStations, getOrders, upsertOrder, deleteOrder, counts, backup, DB_FILE,
  countUsers, getUserByName, getUserById, listUsers, upsertUser,
};
