'use strict';

/*
 * HOMAG-Connect-Anbindung (Geruest / vorbereitet).
 *
 * Ziel: HOMAG-Maschinen bzw. der productionManager melden fertige Teile
 * automatisch zurueck -> der Auftrag rueckt im Board von selbst weiter.
 *
 * Diese Datei stellt den EINGEHENDEN Weg bereit (Webhook), den HOMAG Connect
 * bzw. eine Middleware bedienen kann:
 *     POST /api/homag/feedback     Header: x-homag-token: <TOKEN>
 *     Body: { "orderNumber": "2600931", "pos": "30",
 *             "event": "completed" | "finished",
 *             "machine": "CNC 512" }
 *
 * OPTIONAL – standardmaessig AUS. Aktiv nur, wenn BEIDES gesetzt ist:
 *   HOMAG_ENABLED=true   und   HOMAG_WEBHOOK_TOKEN=<geheim>
 * Andernfalls antwortet der Endpunkt mit 503 "nicht konfiguriert" und die
 * App laeuft ganz normal ohne HOMAG weiter.
 *
 * Der AUSGEHENDE Weg (produktive Connect-API von tapio: Auftraege/Status
 * abfragen, Teile melden) benoetigt zusaetzlich Client-ID/Secret aus eurem
 * tapio-Konto und productionManager *Advanced*. Die Stelle dafuer ist unten
 * als Platzhalter markiert. Doku: https://docs.homag.cloud  (Connect-API).
 */

const TOKEN = process.env.HOMAG_WEBHOOK_TOKEN || '';

// Bewusster Ein-Schalter: nur aktiv, wenn ausdruecklich eingeschaltet UND ein
// Token hinterlegt ist. Ohne diese Variablen ist die Anbindung komplett aus.
function enabled() {
  const flag = String(process.env.HOMAG_ENABLED || '').toLowerCase();
  return (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') && !!TOKEN;
}

function authorized(req) {
  return !!TOKEN && req.headers['x-homag-token'] === TOKEN;
}

/*
 * Wandelt eine Rueckmeldung in eine Auftragsaktion um.
 * helpers: { findByNumberPos(num, pos), advance(order, machine),
 *            finish(order, machine), note(order, machine, text) }
 */
function applyFeedback(payload, helpers) {
  const num = String(payload.orderNumber || payload.number || '').trim();
  const pos = payload.pos != null && payload.pos !== '' ? String(payload.pos) : null;
  const order = helpers.findByNumberPos(num, pos);
  if (!order) return { ok: false, status: 404, message: `Auftrag ${num}${pos ? '-' + pos : ''} nicht gefunden` };

  const machine = payload.machine || payload.station || 'HOMAG';
  const event = String(payload.event || 'completed').toLowerCase();

  if (event === 'finished' || event === 'done') {
    helpers.finish(order, machine);           // explizit fertig
  } else if (event === 'completed') {
    helpers.advance(order, machine);          // Bearbeitung fertig -> einen Schritt weiter
  } else {
    helpers.note(order, machine, `Rueckmeldung: ${event}`);
  }
  return { ok: true, order };
}

/* --- Platzhalter fuer den produktiven Connect-API-Abruf (tapio) ---
 * Wird erst aktiv, wenn HOMAG_CLIENT_ID/HOMAG_CLIENT_SECRET vorhanden sind.
 * Hier wuerde man per OAuth ein Token holen und Auftrags-/Statusdaten
 * synchronisieren. Bewusst noch nicht implementiert (Zugangsdaten noetig).
 */
function connectApiConfigured() {
  return !!(process.env.HOMAG_CLIENT_ID && process.env.HOMAG_CLIENT_SECRET);
}

module.exports = { enabled, authorized, applyFeedback, connectApiConfigured };
