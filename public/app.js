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
async function init() {
  const res = await fetch('/api/state');
  const state = await res.json();
  stations = state.stations;
  orders = state.orders;
  render();
  connectLive();
  fillStationSelect();
}

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

function cardEl(o) {
  const idx = stations.findIndex((s) => s.id === o.stationId);
  const prev = stations[idx - 1];
  const next = stations[idx + 1];

  const el = document.createElement('article');
  el.className = `card prio-${o.priority}`;
  el.draggable = true;
  el.dataset.id = o.id;

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
      ${flagTags(o.flags)}
    </div>
    <div class="move">
      <button class="prev" ${prev ? '' : 'disabled'} title="Zurueck">◀ ${prev ? esc(prev.name) : ''}</button>
      <button class="next" ${next ? '' : 'disabled'} title="Weiter">${next ? esc(next.name) : ''} ▶</button>
    </div>`;

  el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', o.id));
  el.addEventListener('click', (e) => {
    if (e.target.closest('.move')) return;
    openDetail(o.id);
  });
  el.querySelector('.prev').addEventListener('click', () => prev && moveOrder(o.id, prev.id));
  el.querySelector('.next').addEventListener('click', () => next && moveOrder(o.id, next.id));
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
  const by = rememberName();
  await fetch(`/api/orders/${id}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stationId, by }),
  });
}

function rememberName() {
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
      <dt>Station</dt><dd>${esc(st ? `${st.name} (${st.machine})` : '?')}</dd>
      <dt>Prioritaet</dt><dd>${prioLabel(o.priority)}</dd>
      <dt>Aufwand</dt><dd>${o.effort ? esc(o.effort) + ' h' : '—'}</dd>
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
    <div class="history">
      <h3>Verlauf</h3>
      <ul>${history}</ul>
    </div>`;

  // Haekchen anklickbar machen -> speichert sofort fuer alle Geraete
  $('#detailContent').querySelectorAll('input[data-flag]').forEach((cb) => {
    cb.addEventListener('change', () => toggleFlag(o, cb.dataset.flag, cb.checked));
  });
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

init();
