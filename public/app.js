'use strict';

/*
 * Frontend fuer den BSAG Leitstand.
 * Reines Vanilla-JS, kein Framework, kein Build. Laeuft auf Tablet, PC, Handy.
 */

let stations = [];
let orders = [];
let editingId = null;

/*
 * Bedeutung der Haekchen-Spalten aus der Excel.
 * type: 'prozess' = Maschine/Arbeitsschritt, 'person' = Mitarbeiter, 'status' = Zustand.
 * Namen hier ergaenzen, sobald bekannt (z.B. müh/huc/hem).
 */
const FLAG_META = [
  { key: 'KLM',   label: 'Kantenleimen',   type: 'prozess' },
  { key: 'scd',   label: 'Schmid Daniel',       type: 'person' },
  { key: 'müh',   label: 'Mühlethalter Herbert', type: 'person' },
  { key: 'huc',   label: 'Hunn Celin',          type: 'person' },
  { key: 'hem',   label: 'Heuberger Markus',    type: 'person' },
  { key: 'teils', label: 'teilweise',      type: 'status' },
];
const flagLabel = (k) => (FLAG_META.find((f) => f.key === k) || {}).label || k;

const $ = (sel) => document.querySelector(sel);
const board = $('#board');
const statusEl = $('#status');

/* ----------------------------------------------------------------------------
 * Initiales Laden + Live-Verbindung
 * -------------------------------------------------------------------------- */
let me = null; // angemeldeter Benutzer { name, role, username }

async function init() {
  if (!(await loadMe())) { showLogin(); return; }
  const res = await fetch('/api/state');
  const state = await res.json();
  stations = state.stations;
  orders = state.orders;
  render();
  connectLive();
  fillStationSelect();
  applyRole();
}

/* ---- Anmeldung (ohne Passwort) ---- */
async function loadMe() {
  try {
    const r = await fetch('/api/me');
    if (!r.ok) return false;
    me = await r.json();
    showUserChip();
    return true;
  } catch (e) { return false; }
}

const ROLE_LABEL = { leitung: 'Leitung', av: 'AV', maschinist: 'Maschinist', montage: 'Montage' };

function showUserChip() {
  const chip = $('#userChip');
  chip.textContent = `${me.name} · ${ROLE_LABEL[me.role] || me.role}`;
  chip.classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
}

async function showLogin() {
  const dlg = $('#loginDialog');
  let users = [];
  try { users = await (await fetch('/api/users')).json(); } catch (e) { users = []; }
  $('#loginUsers').innerHTML = users.map((u) =>
    `<button class="btn login-user" data-u="${esc(u.username)}">
       <span class="lu-name">${esc(u.name)}</span>
       <span class="lu-role">${ROLE_LABEL[u.role] || u.role}</span>
     </button>`).join('');
  $('#loginUsers').querySelectorAll('.login-user').forEach((b) => b.addEventListener('click', async () => {
    await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: b.dataset.u }) });
    location.reload();
  }));
  dlg.showModal();
}

// Rollen: Leitung/AV duerfen Stammdaten; Maschinist/Montage nur Ablauf/Status/Zeit.
function applyRole() {
  const master = me && (me.role === 'leitung' || me.role === 'av');
  $('#newOrderBtn').classList.toggle('hidden', !master);
  $('#editFromDetail').classList.toggle('hidden', !master);
}

$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

function connectLive() {
  const es = new EventSource('/api/events');
  es.onopen = () => { statusEl.classList.remove('offline'); statusEl.title = 'Live verbunden'; };
  es.onerror = () => { statusEl.classList.add('offline'); statusEl.title = 'Verbindung unterbrochen – neu verbinden…'; };
  es.addEventListener('order:created', (e) => { upsert(JSON.parse(e.data)); render(); });
  es.addEventListener('order:updated', (e) => { upsert(JSON.parse(e.data)); render(); refreshDetail(); });
  es.addEventListener('order:deleted', (e) => {
    const { id } = JSON.parse(e.data);
    orders = orders.filter((o) => o.id !== id);
    render();
  });
}

function upsert(order) {
  const i = orders.findIndex((o) => o.id === order.id);
  if (i >= 0) orders[i] = order; else orders.push(order);
}

/* ----------------------------------------------------------------------------
 * Filter
 * -------------------------------------------------------------------------- */
function currentFilter() {
  return {
    q: $('#search').value.trim().toLowerCase(),
    priority: $('#priorityFilter').value,
  };
}

function matches(o, f) {
  if (f.priority && o.priority !== f.priority) return false;
  if (!f.q) return true;
  return [o.number, o.customer, o.title, o.assignee, o.notes]
    .join(' ').toLowerCase().includes(f.q);
}

/* ----------------------------------------------------------------------------
 * Rendern
 * -------------------------------------------------------------------------- */
function render() {
  const f = currentFilter();
  board.innerHTML = '';
  for (const st of stations) {
    const list = orders
      .filter((o) => o.stationId === st.id && matches(o, f))
      .sort(sortOrders);

    const col = document.createElement('section');
    col.className = 'column';
    col.dataset.station = st.id;

    col.innerHTML = `
      <div class="column-head">
        <div class="name">
          <span class="dot" style="background:${st.color}"></span>
          <span>${esc(st.name)}</span>
          <span class="count">${list.length}</span>
        </div>
        <div class="machine">${esc(st.machine)}</div>
      </div>
      <div class="cards"></div>`;

    const cardsEl = col.querySelector('.cards');
    for (const o of list) cardsEl.appendChild(cardEl(o));

    // Drag&Drop-Ziel (Desktop)
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      if (id) moveOrder(id, st.id);
    });

    board.appendChild(col);
  }
}

function sortOrders(a, b) {
  const rank = { hoch: 0, normal: 1, tief: 2 };
  if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
  if (a.due && b.due) return a.due.localeCompare(b.due);
  if (a.due) return -1;
  if (b.due) return 1;
  return 0;
}

// Moegliche Folge-Stationen aus dem Fluss-Graph (Kontur-Auftraege ohne CNC 511).
function nextStations(o) {
  const st = stations.find((s) => s.id === o.stationId);
  const ids = (st && st.next) || [];
  return ids
    .filter((id) => !(o.requires512 && id === 'cnc511'))
    .map((id) => stations.find((s) => s.id === id))
    .filter(Boolean);
}

function cardEl(o) {
  const el = document.createElement('article');
  el.className = `card prio-${o.priority}`;
  el.draggable = true;
  el.dataset.id = o.id;

  const nexts = nextStations(o);
  const moveButtons = nexts.length
    ? `<div class="move">${nexts.map((s) => `<button class="mv" data-to="${s.id}">${esc(s.name)} ▶</button>`).join('')}</div>`
    : '';

  el.innerHTML = `
    <div class="row1">
      <span class="number">${esc(o.number)}${o.pos ? ` · Pos ${esc(o.pos)}` : ''}</span>
      ${o.assignee ? `<span class="tag">${esc(o.assignee)}</span>` : ''}
    </div>
    <div class="title">${esc(o.title)}</div>
    <div class="customer">${esc(o.customer || '—')}${o.object ? ` · ${esc(o.object)}` : ''}</div>
    <div class="meta">
      <span class="tag">${prioLabel(o.priority)}</span>
      ${dueTag(o.due)}
      ${o.effort ? `<span class="tag">⏱ ${esc(o.effort)}h</span>` : ''}
      ${o.requires512 ? '<span class="tag tag-512">🔒 nur 512 · Kontur</span>' : ''}
      ${openLog(o) ? '<span class="tag tag-run">⏱ läuft</span>' : ''}
      ${flagTags(o.flags)}
    </div>
    ${moveButtons}`;

  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', o.id));
  el.addEventListener('click', (e) => {
    if (e.target.closest('.move')) return;
    openDetail(o.id);
  });
  el.querySelectorAll('.mv').forEach((b) => b.addEventListener('click', () => moveOrder(o.id, b.dataset.to)));
  return el;
}

function prioLabel(p) {
  return { hoch: '🔴 Hoch', normal: '🔵 Normal', tief: '⚪ Tief' }[p] || p;
}

// Aktive Haekchen (KLM, Beteiligte, teilweise) kompakt als Marker auf der Karte.
function flagTags(flags) {
  if (!flags) return '';
  return FLAG_META
    .filter((f) => flags[f.key])
    .map((f) => `<span class="tag flag-${f.type}" title="${esc(f.label)}">✓ ${esc(f.key)}</span>`)
    .join('');
}

function dueTag(due) {
  if (!due) return '';
  const days = Math.ceil((new Date(due) - new Date()) / 86400000);
  let cls = '';
  let label = `📅 ${formatDate(due)}`;
  if (days < 0) { cls = 'due-overdue'; label = `⚠ ${formatDate(due)} (ueberfaellig)`; }
  else if (days <= 2) { cls = 'due-soon'; label = `📅 ${formatDate(due)} (${days}T)`; }
  return `<span class="tag ${cls}">${label}</span>`;
}

/* ----------------------------------------------------------------------------
 * Aktionen
 * -------------------------------------------------------------------------- */
async function moveOrder(id, stationId) {
  const o = orders.find((x) => x.id === id);
  // Kontur-Auftraege duerfen nicht auf CNC 511.
  if (o && o.requires512 && stationId === 'cnc511') {
    alert('Dieser Auftrag enthält "Kontur" und kann nur auf der CNC 512 gefertigt werden.');
    return;
  }
  const by = rememberName();
  await fetch(`/api/orders/${id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stationId, by }),
  });
}

function rememberName() {
  // angemeldeter Benutzer hat Vorrang (Server setzt 'by' ohnehin verbindlich)
  if (me && me.name) return me.name;
  let name = localStorage.getItem('bsag_user');
  if (!name) {
    name = prompt('Dein Name (wird im Verlauf festgehalten):') || 'Unbekannt';
    localStorage.setItem('bsag_user', name);
  }
  return name;
}

/* ----------------------------------------------------------------------------
 * Auftrag anlegen / bearbeiten
 * -------------------------------------------------------------------------- */
const dialog = $('#orderDialog');

function fillStationSelect() {
  $('#f_station').innerHTML = stations
    .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
    .join('');
}

function openNew() {
  editingId = null;
  $('#dialogTitle').textContent = 'Neuer Auftrag';
  $('#orderForm').reset();
  $('#deleteBtn').classList.add('hidden');
  dialog.showModal();
}

function openEdit(o) {
  editingId = o.id;
  $('#dialogTitle').textContent = `Auftrag ${o.number}`;
  $('#f_number').value = o.number;
  $('#f_pos').value = o.pos || '';
  $('#f_customer').value = o.customer || '';
  $('#f_object').value = o.object || '';
  $('#f_title').value = o.title;
  $('#f_station').value = o.stationId;
  $('#f_priority').value = o.priority;
  $('#f_assignee').value = o.assignee || '';
  $('#f_effort').value = o.effort != null ? o.effort : '';
  $('#f_due').value = o.due || '';
  $('#f_notes').value = o.notes || '';
  $('#deleteBtn').classList.remove('hidden');
  dialog.showModal();
}

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    number: $('#f_number').value.trim(),
    pos: $('#f_pos').value.trim(),
    customer: $('#f_customer').value.trim(),
    object: $('#f_object').value.trim(),
    title: $('#f_title').value.trim(),
    stationId: $('#f_station').value,
    priority: $('#f_priority').value,
    assignee: $('#f_assignee').value.trim(),
    effort: $('#f_effort').value ? parseFloat($('#f_effort').value) : null,
    due: $('#f_due').value || null,
    notes: $('#f_notes').value.trim(),
    by: rememberName(),
  };
  if (editingId) {
    await fetch(`/api/orders/${editingId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } else {
    await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  dialog.close();
});

$('#deleteBtn').addEventListener('click', async () => {
  if (editingId && confirm('Auftrag wirklich loeschen?')) {
    await fetch(`/api/orders/${editingId}`, { method: 'DELETE' });
    dialog.close();
    detailDialog.close();
  }
});

$('#cancelBtn').addEventListener('click', () => dialog.close());
$('#newOrderBtn').addEventListener('click', openNew);

/* ----------------------------------------------------------------------------
 * Detail / Verlauf
 * -------------------------------------------------------------------------- */
const detailDialog = $('#detailDialog');
let detailId = null;

function openDetail(id) {
  detailId = id;
  refreshDetail();
  detailDialog.showModal();
}

function refreshDetail() {
  if (!detailDialog.open && detailId === null) return;
  const o = orders.find((x) => x.id === detailId);
  if (!o) return;
  const st = stations.find((s) => s.id === o.stationId);
  const history = [...o.history].reverse().map((h) => {
    const s = stations.find((x) => x.id === h.stationId);
    return `<li><span class="when">${formatDateTime(h.at)}</span>
      <span><strong>${esc(s ? s.name : '?')}</strong> – ${esc(h.note)} <em>(${esc(h.by)})</em></span></li>`;
  }).join('');

  $('#detailContent').innerHTML = `
    <h2 class="detail-title">${esc(o.title)}</h2>
    <div class="detail-sub">${esc(o.number)}${o.pos ? ` · Pos ${esc(o.pos)}` : ''} · ${esc(o.customer || '—')}</div>
    <dl class="detail-grid">
      <dt>Objekt</dt><dd>${esc(o.object || '—')}</dd>
      <dt>Station</dt><dd>
        <select class="station-move">
          ${stations.map((s) => `<option value="${s.id}" ${s.id === o.stationId ? 'selected' : ''} ${o.requires512 && s.id === 'cnc511' ? 'disabled' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </dd>
      <dt>Prioritaet</dt><dd>${prioLabel(o.priority)}</dd>
      <dt>Aufwand</dt><dd>${o.effort ? esc(o.effort) + ' h' : '—'}</dd>
      <dt>Maschine</dt><dd>${o.requires512 ? '🔒 nur CNC 512 (Kontur)' : 'CNC 511 oder 512'}</dd>
      <dt>Maschinist</dt><dd>${esc(o.assignee || '—')}</dd>
      <dt>Termin Rampe</dt><dd>${o.due ? formatDate(o.due) : '—'}</dd>
      <dt>Bemerkung</dt><dd>${esc(o.notes || '—')}</dd>
    </dl>
    <div class="flags-edit">
      <h3>Maschine · Beteiligte · Status <span class="hint">(antippen zum Abhaken)</span></h3>
      <div class="flag-toggles">
        ${FLAG_META.map((f) => `
          <label class="flag-toggle flag-${f.type}">
            <input type="checkbox" data-flag="${esc(f.key)}" ${o.flags && o.flags[f.key] ? 'checked' : ''} />
            <span>${esc(f.label)}</span>
          </label>`).join('')}
      </div>
    </div>
    <div class="time-box">
      <h3>Zeiterfassung</h3>
      <div class="time-row">
        <span>Soll: <strong>${o.effort ? fmtH(o.effort * 3600) : '—'}</strong></span>
        <span>Ist: <strong>${fmtH(istSeconds(o))}</strong></span>
        <button class="btn time-btn ${openLog(o) ? 'danger' : 'primary'}">${openLog(o) ? '⏹ Arbeit stoppen' : '▶ Arbeit starten'}</button>
      </div>
    </div>
    <div class="history">
      <h3>Verlauf</h3>
      <ul>${history}</ul>
    </div>`;

  const tbtn = $('#detailContent').querySelector('.time-btn');
  if (tbtn) tbtn.addEventListener('click', () => (openLog(o) ? stopWork(o) : startWork(o)));

  // Haekchen anklickbar machen -> speichert sofort fuer alle Geraete
  $('#detailContent').querySelectorAll('input[data-flag]').forEach((cb) => {
    cb.addEventListener('change', () => toggleFlag(o, cb.dataset.flag, cb.checked));
  });
  // Station frei umstellen (Korrekturen / zurueck)
  const sel = $('#detailContent').querySelector('.station-move');
  if (sel) sel.addEventListener('change', () => { const v = sel.value; sel.value = o.stationId; moveOrder(o.id, v); });
}

async function toggleFlag(order, key, value) {
  const flags = { ...(order.flags || {}), [key]: value };
  await fetch(`/api/orders/${order.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ flags, by: rememberName() }),
  });
}

$('#closeDetail').addEventListener('click', () => { detailDialog.close(); detailId = null; });
$('#editFromDetail').addEventListener('click', () => {
  const o = orders.find((x) => x.id === detailId);
  if (o) { detailDialog.close(); openEdit(o); }
});

/* ----------------------------------------------------------------------------
 * Utils
 * -------------------------------------------------------------------------- */
$('#search').addEventListener('input', render);
$('#priorityFilter').addEventListener('change', render);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function formatDateTime(ts) {
  return new Date(ts).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* ----------------------------------------------------------------------------
 * Zeiterfassung (Ist vs. Soll) – Zeiten haengen am Auftrag (timeLogs)
 * -------------------------------------------------------------------------- */
function openLog(o) { return (o.timeLogs || []).find((l) => !l.endedAt); }

function istSeconds(o) {
  const now = Date.now();
  return (o.timeLogs || []).reduce((s, l) =>
    s + (l.endedAt ? (l.seconds || 0) : Math.max(0, Math.round((now - l.startedAt) / 1000))), 0);
}
function fmtH(seconds) { return (seconds / 3600).toFixed(1).replace('.', ',') + ' h'; }

function putOrder(id, body) {
  return fetch(`/api/orders/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, by: rememberName() }),
  });
}
async function startWork(o) {
  if (openLog(o)) return;
  const logs = [...(o.timeLogs || []), { stationId: o.stationId, by: rememberName(), startedAt: Date.now(), endedAt: null, seconds: 0 }];
  await putOrder(o.id, { timeLogs: logs });
}
async function stopWork(o) {
  const logs = (o.timeLogs || []).map((l) => {
    if (l.endedAt) return l;
    const end = Date.now();
    return { ...l, endedAt: end, seconds: Math.max(0, Math.round((end - l.startedAt) / 1000)) };
  });
  await putOrder(o.id, { timeLogs: logs });
}

/* ----------------------------------------------------------------------------
 * Auswertung / KPIs (berechnet aus den Auftragsdaten)
 * -------------------------------------------------------------------------- */
function openKpi() {
  const done = orders.filter((o) => o.stationId === 'fertig');
  const open = orders.filter((o) => o.stationId !== 'fertig');

  // Termintreue
  let puenktlich = 0; let spaet = 0;
  for (const o of done) {
    if (!o.due) continue;
    const f = [...o.history].reverse().find((h) => h.stationId === 'fertig');
    if (!f) continue;
    const dueEnd = new Date(o.due + 'T23:59:59').getTime();
    if (f.at <= dueEnd) puenktlich++; else spaet++;
  }
  const treue = (puenktlich + spaet) ? Math.round((100 * puenktlich) / (puenktlich + spaet)) : null;

  // Durchlaufzeit (Anlage -> fertig)
  let dlSum = 0; let dlN = 0;
  for (const o of done) {
    const f = [...o.history].reverse().find((h) => h.stationId === 'fertig');
    const start = o.createdAt || (o.history[0] && o.history[0].at);
    if (f && start) { dlSum += f.at - start; dlN++; }
  }
  const dlTage = dlN ? (dlSum / dlN / 86400000).toFixed(1).replace('.', ',') : '—';

  // Stunden Ist/Soll
  const sollH = orders.reduce((s, o) => s + (o.effort || 0), 0);
  const istH = orders.reduce((s, o) => s + istSeconds(o), 0) / 3600;

  // Offene Last je Station
  const per = stations.map((st) => {
    const list = open.filter((o) => o.stationId === st.id);
    return { st, count: list.length, soll: list.reduce((s, o) => s + (o.effort || 0), 0) };
  });
  const maxSoll = Math.max(1, ...per.map((p) => p.soll));

  const card = (label, value, sub) => `<div class="kpi-card"><div class="kpi-val">${value}</div><div class="kpi-lbl">${label}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;

  $('#kpiContent').innerHTML = `
    <h2 class="detail-title">📊 Auswertung</h2>
    <div class="kpi-grid">
      ${card('Offene Auftraege', open.length, `${done.length} erledigt`)}
      ${card('Termintreue', treue == null ? '—' : treue + '%', `${puenktlich} pünktlich / ${spaet} zu spät`)}
      ${card('Ø Durchlaufzeit', dlTage + ' T', 'Anlage bis fertig')}
      ${card('Stunden Ist / Soll', fmtH(istH * 3600), 'Soll ' + sollH.toFixed(1).replace('.', ',') + ' h')}
    </div>
    <h3 style="margin:18px 0 8px">Offene Last je Station</h3>
    <div class="kpi-bars">
      ${per.map((p) => `
        <div class="kpi-bar-row">
          <span class="kpi-bar-name"><span class="dot" style="background:${p.st.color}"></span>${esc(p.st.name)}</span>
          <span class="kpi-bar-track"><span class="kpi-bar-fill" style="width:${Math.round((p.soll / maxSoll) * 100)}%;background:${p.st.color}"></span></span>
          <span class="kpi-bar-num">${p.count} Auftr. · ${p.soll.toFixed(1).replace('.', ',')} h</span>
        </div>`).join('')}
    </div>`;
  kpiDialog.showModal();
}
const kpiDialog = $('#kpiDialog');
$('#kpiBtn').addEventListener('click', openKpi);
$('#closeKpi').addEventListener('click', () => kpiDialog.close());

/* ----------------------------------------------------------------------------
 * CSV-Export (fuer den Abgleich mit Excel) – UTF-8 mit BOM, Semikolon-getrennt
 * -------------------------------------------------------------------------- */
function exportCsv() {
  const head = ['Auftrags-Nummer', 'Pos', 'Kunde', 'Objekt', 'Beschrieb', 'Aufwand_h', 'Termin', 'Station', 'Maschinist', 'Status', 'Ist_h', 'Bemerkung'];
  const stName = (id) => { const s = stations.find((x) => x.id === id); return s ? s.name : id; };
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = orders.map((o) => [
    o.number, o.pos || '', o.customer || '', o.object || '', o.title || '',
    o.effort != null ? o.effort : '', o.due || '', stName(o.stationId), o.assignee || '',
    Object.entries(o.flags || {}).filter(([, v]) => v).map(([k]) => k).join(' '),
    (istSeconds(o) / 3600).toFixed(2), o.notes || '',
  ].map(cell).join(';'));
  const csv = '﻿' + head.join(';') + '\n' + rows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bsag-auftraege-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}
$('#exportBtn').addEventListener('click', exportCsv);

/* ----------------------------------------------------------------------------
 * Scanner – liest QR/Barcode der Auftragsmappe (BarcodeDetector) + manuelle Suche
 * -------------------------------------------------------------------------- */
const scanDialog = $('#scanDialog');
let scanStream = null;
let scanTimer = null;
let barcodeDetector = null;

// Auftrag anhand des gescannten Codes finden (ID, Nummer oder "Nummer-Pos").
function findByCode(raw) {
  const code = String(raw || '').trim();
  if (!code) return null;
  let o = orders.find((x) => x.id === code);
  if (o) return o;
  const m = code.match(/(\d{4,})(?:[-\s/]\s*(\d+))?/);
  if (m) {
    const num = m[1]; const pos = m[2];
    o = orders.find((x) => String(x.number) === num && (pos == null || String(x.pos) === String(pos)));
    if (o) return o;
    o = orders.find((x) => String(x.number) === num);
    if (o) return o;
  }
  return orders.find((x) => String(x.number).includes(code)) || null;
}

function handleScanResult(text) {
  const o = findByCode(text);
  if (o) { stopScan(); scanDialog.close(); openDetail(o.id); }
  else { $('#scanHint').textContent = `Kein Auftrag zu „${text}" gefunden – bitte erneut versuchen.`; }
}

async function openScan() {
  $('#scanInput').value = '';
  scanDialog.showModal();
  const video = $('#scanVideo');
  const hint = $('#scanHint');
  if (!('BarcodeDetector' in window)) {
    hint.textContent = 'Kamera-Scan wird von diesem Browser nicht unterstützt. Bitte Nummer unten eingeben.';
    video.style.display = 'none';
    return;
  }
  try {
    if (!barcodeDetector) {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      const want = ['qr_code', 'code_128', 'ean_13', 'code_39', 'data_matrix'].filter((f) => formats.includes(f));
      barcodeDetector = new window.BarcodeDetector({ formats: want.length ? want : formats });
    }
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = scanStream; video.style.display = 'block'; await video.play();
    hint.textContent = 'QR-/Barcode der Auftragsmappe in den Rahmen halten…';
    scanTimer = setInterval(async () => {
      try {
        const codes = await barcodeDetector.detect(video);
        if (codes && codes.length) handleScanResult(codes[0].rawValue);
      } catch (e) { /* einzelne Frames ignorieren */ }
    }, 400);
  } catch (e) {
    hint.textContent = `Kamera nicht verfügbar (${e.name || 'Fehler'}). Tipp: Kamera-Scan benötigt HTTPS. Bitte Nummer unten eingeben.`;
    video.style.display = 'none';
  }
}

function stopScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (scanStream) { scanStream.getTracks().forEach((t) => t.stop()); scanStream = null; }
}

$('#scanBtn').addEventListener('click', openScan);
$('#closeScan').addEventListener('click', () => { stopScan(); scanDialog.close(); });
$('#scanLookup').addEventListener('click', () => handleScanResult($('#scanInput').value));
$('#scanInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') handleScanResult($('#scanInput').value); });
scanDialog.addEventListener('close', stopScan);

init();
