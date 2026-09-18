const SHIFT_LABELS = {
  morning: 'MORNING SHIFT',
  afternoon: 'AFTERNOON SHIFT',
  night: 'NIGHT SHIFT'
};

const STATUS_LABELS = {
  received: 'Received',
  pending: 'Pending Dispatch',
  dispatched: 'Dispatched'
};

const STORAGE_KEY = 'laundry-tracking-state-v2';
// Single shared login account for all workers (no profiles, no registration).
// A successful sign-in is remembered on this device; clearing site data or a
// fresh install simply shows the sign-in screen again.
const AUTH_KEY = 'laundry-auth-v1';
// Backend origin, set by config.js. Empty string = same origin (the backend
// serves the frontend itself); a URL = cross-origin PWA → backend API (CORS).
const API_BASE = String(window.LAUNDRY_API_BASE || '').replace(/\/+$/, '');
const todayIso = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let state = {
  tab: 'main',
  view: 'shifts',
  selectedShift: null,
  selectedDate: null,
  records: [],
  locks: [],
  syncEvents: [],
  online: navigator.onLine,
  syncing: false,
  notice: ''
};

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    state = { ...state, ...saved, online: navigator.onLine, syncing: false };
  } catch {
    saveLocal();
  }
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    tab: state.tab,
    view: state.view,
    selectedShift: state.selectedShift,
    selectedDate: state.selectedDate,
    records: state.records,
    locks: state.locks,
    syncEvents: state.syncEvents,
    notice: state.notice
  }));
}

async function api(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!response.ok && response.status !== 202) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed.');
  }
  return response.json();
}

async function hydrateFromServer() {
  try {
    const db = await api('api/records');
    mergeServerState(db);
    state.notice = '';
    saveLocal();
    render();
  } catch {
    state.notice = 'Offline mode. Changes will stay on this device until the server is reachable.';
    render();
  }
}

function mergeServerState(db) {
  const byId = new Map(state.records.map((record) => [record.id, record]));
  for (const record of db.records || []) {
    const local = byId.get(record.id);
    if (!local || new Date(record.updatedAt || 0) >= new Date(local.updatedAt || 0)) {
      byId.set(record.id, record);
    }
  }
  state.records = Array.from(byId.values());
  state.locks = db.locks || state.locks;
  state.syncEvents = db.syncEvents || state.syncEvents;
}

function isLocked(date, shift) {
  const historical = date < todayIso();
  const manual = state.locks.some((lock) => lock.date === date && lock.shift === shift);
  return historical || manual;
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function recordsFor(shift, date) {
  return state.records.filter((record) => record.shift === shift && record.date === date);
}

function datesFor(shift) {
  const dates = new Set(state.records.filter((record) => record.shift === shift).map((record) => record.date));
  dates.add(todayIso());
  return Array.from(dates).sort((a, b) => b.localeCompare(a));
}

function createRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: uid(),
    date: state.selectedDate,
    shift: state.selectedShift,
    material: '',
    quantity: 0,
    laundryPersonnel: '',
    verifiedBy: '',
    status: currentSheetStatus(),
    syncStatus: 'pending',
    syncError: '',
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function currentSheetStatus() {
  const rows = recordsFor(state.selectedShift, state.selectedDate);
  return rows[0]?.status || 'received';
}

function setView(view, extra = {}) {
  state = { ...state, view, ...extra };
  saveLocal();
  render();
}

function setTab(tab) {
  state.tab = tab;
  state.view = tab === 'main' ? 'shifts' : 'tracking';
  saveLocal();
  render();
}

async function persistRecords(records) {
  const now = new Date().toISOString();
  const byId = new Map(state.records.map((record) => [record.id, record]));
  for (const record of records) {
    byId.set(record.id, { ...record, updatedAt: now, syncStatus: 'pending' });
  }
  state.records = Array.from(byId.values());
  saveLocal();
  render();

  try {
    const result = await api('api/records', {
      method: 'PUT',
      body: JSON.stringify({ records })
    });
    mergeServerState({ records: result.records || [] });
    state.notice = result.sync?.status === 'synced'
      ? 'Saved and synchronized with Google Sheets.'
      : `Saved locally. Sync pending: ${result.sync?.error || 'Google Sheets is not available.'}`;
  } catch (error) {
    state.notice = `Saved on this device. Sync pending: ${error.message}`;
  }
  saveLocal();
  render();
}

let saveTimer;
function queueRecordSave(record) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistRecords([record]), 350);
}

function updateRecord(id, field, value) {
  if (isLocked(state.selectedDate, state.selectedShift)) return;
  const record = state.records.find((item) => item.id === id);
  if (!record) return;
  record[field] = field === 'quantity' ? Math.max(0, Number(value || 0)) : value;
  record.updatedAt = new Date().toISOString();
  record.syncStatus = 'pending';
  saveLocal();
  renderTotalsOnly();
  queueRecordSave(record);
}

async function deleteRecord(id) {
  if (isLocked(state.selectedDate, state.selectedShift)) return;
  state.records = state.records.filter((record) => record.id !== id);
  saveLocal();
  render();
  try {
    await api(`api/records/${id}`, { method: 'DELETE' });
    state.notice = 'Row deleted.';
  } catch (error) {
    state.notice = `Row removed on this device. Server delete failed: ${error.message}`;
  }
  saveLocal();
  render();
}

async function addRow() {
  if (isLocked(state.selectedDate, state.selectedShift)) return;
  const record = createRecord();
  await persistRecords([record]);
}

async function createDate(date) {
  state.selectedDate = date;
  state.view = 'sheet';
  const existing = recordsFor(state.selectedShift, date);
  if (!existing.length) {
    await persistRecords([createRecord({ date })]);
  } else {
    saveLocal();
    render();
  }
}

async function closeShift() {
  if (!state.selectedDate || !state.selectedShift) return;
  try {
    const result = await api('api/locks', {
      method: 'POST',
      body: JSON.stringify({ date: state.selectedDate, shift: state.selectedShift })
    });
    state.locks = result.locks || state.locks;
    state.notice = 'Shift closed. This sheet is now read-only.';
  } catch {
    const key = `${state.selectedDate}:${state.selectedShift}`;
    if (!state.locks.some((lock) => lock.key === key)) {
      state.locks.push({ key, date: state.selectedDate, shift: state.selectedShift, lockedAt: new Date().toISOString(), reason: 'Offline shift close' });
    }
    state.notice = 'Shift closed on this device. Server lock will sync when reachable.';
  }
  saveLocal();
  render();
}

async function changeSheetStatus(status) {
  const rows = recordsFor(state.selectedShift, state.selectedDate);
  rows.forEach((record) => {
    record.status = status;
    record.syncStatus = 'pending';
    record.updatedAt = new Date().toISOString();
  });
  await persistRecords(rows);
}

async function retrySync() {
  state.syncing = true;
  render();
  try {
    const result = await api('api/sync/retry', { method: 'POST', body: '{}' });
    mergeServerState({ records: result.records || [] });
    state.notice = result.sync?.status === 'synced'
      ? 'Pending records synchronized.'
      : `Sync still pending: ${result.sync?.error || 'Google Sheets is not available.'}`;
  } catch (error) {
    state.notice = `Sync failed: ${error.message}`;
  }
  state.syncing = false;
  saveLocal();
  render();
}

function trackingRows() {
  const grouped = new Map();
  for (const record of state.records) {
    const material = record.material.trim();
    if (!material) continue;
    const row = grouped.get(material.toLowerCase()) || {
      material,
      received: 0,
      pending: 0,
      dispatched: 0,
      available: 0,
      total: 0
    };
    const qty = Number(record.quantity || 0);
    row[record.status] += qty;
    row.total += qty;
    row.available = row.received - row.dispatched;
    grouped.set(material.toLowerCase(), row);
  }
  return Array.from(grouped.values()).sort((a, b) => a.material.localeCompare(b.material));
}

function renderTotalsOnly() {
  const el = document.querySelector('[data-sheet-total]');
  if (el) el.textContent = String(recordsFor(state.selectedShift, state.selectedDate).reduce((sum, record) => sum + Number(record.quantity || 0), 0));
}

function isAuthenticated() {
  return Boolean(localStorage.getItem(AUTH_KEY));
}

function renderLogin(root) {
  root.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="login-form">
        <div class="splash-mark">LT</div>
        <h1>Laundry Tracking</h1>
        <p class="login-hint">Sign in to continue</p>
        <label class="login-label" for="login-email">Email</label>
        <input id="login-email" type="email" autocomplete="username" required>
        <label class="login-label" for="login-password">Password</label>
        <input id="login-password" type="password" autocomplete="current-password" required>
        <p class="login-error" id="login-error" hidden></p>
        <button type="submit" class="login-btn">Sign In</button>
      </form>
    </div>
  `;
  const form = document.getElementById('login-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const button = form.querySelector('.login-btn');
    const errorEl = document.getElementById('login-error');
    button.disabled = true;
    errorEl.hidden = true;
    try {
      const result = await api('api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      localStorage.setItem(AUTH_KEY, JSON.stringify({ email: result.user.email }));
      render();
      hydrateFromServer();
    } catch (err) {
      errorEl.textContent = err.message || 'Sign in failed.';
      errorEl.hidden = false;
      button.disabled = false;
    }
  });
}

function render() {
  const root = document.getElementById('app-shell');
  if (!isAuthenticated()) {
    renderLogin(root);
    return;
  }
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">LT</div>
          <div>
            <h1>Laundry Tracking</h1>
            <p class="subtle">${state.online ? 'Online' : 'Offline'}${installModeText()}</p>
          </div>
        </div>
        <button class="pill" data-action="retry-sync">${state.syncing ? 'Syncing...' : 'Sync'}</button>
      </header>
      <main class="main">
        <nav class="tabs" aria-label="Main navigation">
          <button class="tab ${state.tab === 'main' ? 'active' : ''}" data-tab="main"><span class="tab-icon">01</span><span>Shifts</span></button>
          <button class="tab ${state.tab === 'tracking' ? 'active' : ''}" data-tab="tracking"><span class="tab-icon">02</span><span>Tracking</span></button>
        </nav>
        ${state.notice ? `<p class="sync-note">${escapeHtml(state.notice)}</p>` : ''}
        ${state.tab === 'tracking' ? renderTracking() : renderMain()}
      </main>
    </div>
  `;
  bindEvents(root);
}

function installModeText() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return standalone ? ' • App mode' : ' • Installable PWA';
}

function renderMain() {
  if (state.view === 'dates') return renderDates();
  if (state.view === 'sheet') return renderSheet();
  const stats = dashboardStats();
  return `
    <section class="dashboard-intro">
      <div>
        <p class="eyebrow">OPERATIONS OVERVIEW</p>
        <h2>Good day, team.</h2>
        <p class="subtle">Keep today's laundry flow moving.</p>
      </div>
      <div class="date-badge"><span>Today</span><strong>${formatDate(todayIso()).split(',')[0]}</strong></div>
    </section>
    <section class="dashboard-metrics" aria-label="Today's summary">
      ${metric('Orders today', stats.orders)}
      ${metric('Pending', stats.pending)}
      ${metric('Ready', stats.ready)}
      ${metric('Revenue', stats.revenue)}
      ${metric('Units processed', stats.units)}
    </section>
    <section class="section-heading">
      <div>
        <p class="eyebrow">QUICK ACTIONS</p>
        <h2>Open a shift</h2>
      </div>
      <span class="subtle">${stats.activeShifts} active</span>
    </section>
    <section class="shift-grid">
      ${Object.entries(SHIFT_LABELS).map(([shift, label]) => `
        <button class="shift-card" data-shift="${shift}">
          <span class="shift-icon">${shift === 'morning' ? 'AM' : shift === 'afternoon' ? 'PM' : 'N'}</span>
          <strong>${label}</strong>
          <span>${datesFor(shift).length} available date${datesFor(shift).length === 1 ? '' : 's'}</span>
          <span class="shift-arrow" aria-hidden="true">&#8594;</span>
        </button>
      `).join('')}
    </section>
  `;
}

function dashboardStats() {
  const todayRecords = state.records.filter((record) => record.date === todayIso());
  return {
    orders: todayRecords.length,
    pending: todayRecords.filter((record) => record.status === 'pending').length,
    ready: todayRecords.filter((record) => record.status === 'dispatched').length,
    revenue: '--',
    units: todayRecords.reduce((sum, record) => sum + Number(record.quantity || 0), 0),
    activeShifts: new Set(todayRecords.map((record) => record.shift)).size
  };
}

function renderDates() {
  const dates = datesFor(state.selectedShift);
  return `
    <section>
      <div class="page-head">
        <div>
          <h2>${SHIFT_LABELS[state.selectedShift]}</h2>
          <p class="subtle">Select a date to open that shift sheet.</p>
        </div>
        <button class="icon-button" data-action="back-shifts" aria-label="Back">←</button>
      </div>
      <div class="date-tools">
        <input type="date" id="new-date" value="${todayIso()}">
        <button class="primary-button" data-action="create-date">Open Date</button>
      </div>
      <div class="date-list">
        ${dates.map((date) => `
          <button class="date-row" data-date="${date}">
            <span>
              <strong>${formatDate(date)}</strong>
              <span class="subtle">${isLocked(date, state.selectedShift) ? 'Locked read-only' : 'Editable'}</span>
            </span>
            <span>→</span>
          </button>
        `).join('')}
      </div>
    </section>
  `;
}

function renderSheet() {
  const rows = recordsFor(state.selectedShift, state.selectedDate);
  const locked = isLocked(state.selectedDate, state.selectedShift);
  const total = rows.reduce((sum, record) => sum + Number(record.quantity || 0), 0);
  return `
    <section>
      <div class="page-head">
        <div>
          <h2>${SHIFT_LABELS[state.selectedShift]}</h2>
          <p class="subtle">${formatDate(state.selectedDate)}${locked ? ' • Locked read-only' : ' • Editable'}</p>
        </div>
        <button class="icon-button" data-action="back-dates" aria-label="Back">←</button>
      </div>
      <div class="sheet-meta">
        <div class="status-line">
          <label class="select-wrap">
            Record status
            <select data-action="sheet-status" ${locked ? 'disabled' : ''}>
              ${Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}" ${currentSheetStatus() === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <span class="pill">${rows.filter((record) => record.syncStatus !== 'synced').length} pending sync</span>
        </div>
        <div class="sheet-tools">
          <button class="primary-button" data-action="add-row" ${locked ? 'disabled' : ''}>Add Row</button>
          <button class="danger-button" data-action="close-shift" ${locked ? 'disabled' : ''}>Close Shift</button>
        </div>
      </div>
      <div class="table-wrap">
        <table aria-label="Laundry shift spreadsheet">
          <thead>
            <tr>
              <th>MATERIAL</th>
              <th>QUANTITY</th>
              <th>LAUNDRY PERSONNEL</th>
              <th>VERIFIED BY</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((record) => `
              <tr class="${locked ? 'locked' : ''}">
                <td><input data-id="${record.id}" data-field="material" value="${escapeAttr(record.material)}" ${locked ? 'readonly' : ''}></td>
                <td><input data-id="${record.id}" data-field="quantity" type="number" min="0" inputmode="numeric" value="${Number(record.quantity || 0)}" ${locked ? 'readonly' : ''}></td>
                <td><input data-id="${record.id}" data-field="laundryPersonnel" value="${escapeAttr(record.laundryPersonnel)}" ${locked ? 'readonly' : ''}></td>
                <td><input data-id="${record.id}" data-field="verifiedBy" value="${escapeAttr(record.verifiedBy)}" ${locked ? 'readonly' : ''}></td>
                <td class="row-actions"><button data-delete="${record.id}" ${locked ? 'disabled' : ''} aria-label="Delete row">×</button></td>
              </tr>
            `).join('')}
            <tr class="total-row">
              <td>TOTAL</td>
              <td data-sheet-total>${total}</td>
              <td></td>
              <td></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="sync-note">Changes save automatically. Locked sheets remain available for viewing.</p>
    </section>
  `;
}

function renderTracking() {
  const rows = trackingRows();
  const totals = rows.reduce((sum, row) => ({
    received: sum.received + row.received,
    dispatched: sum.dispatched + row.dispatched,
    pending: sum.pending + row.pending,
    available: sum.available + row.available,
    total: sum.total + row.total
  }), { received: 0, dispatched: 0, pending: 0, available: 0, total: 0 });

  return `
    <section>
      <div class="tracking-summary">
        ${metric('Total Available', totals.available)}
        ${metric('Total Dispatched', totals.dispatched)}
        ${metric('Total Pending', totals.pending)}
        ${metric('Total Received', totals.received)}
        ${metric('Current Quantity Remaining', totals.available)}
      </div>
      <div class="table-wrap">
        <table aria-label="Complete tracking">
          <thead>
            <tr>
              <th>MATERIAL</th>
              <th>AVAILABLE</th>
              <th>DISPATCHED</th>
              <th>PENDING</th>
              <th>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map((row) => `
              <tr>
                <td><input readonly value="${escapeAttr(row.material)}"></td>
                <td><input readonly value="${row.available}"></td>
                <td><input readonly value="${row.dispatched}"></td>
                <td><input readonly value="${row.pending}"></td>
                <td><input readonly value="${row.total}"></td>
              </tr>
            `).join('') : `<tr><td colspan="5"><div class="empty">No recorded materials yet.</div></td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`;
}

function bindEvents(root) {
  root.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });
  root.querySelectorAll('[data-shift]').forEach((button) => {
    button.addEventListener('click', () => setView('dates', { selectedShift: button.dataset.shift }));
  });
  root.querySelectorAll('[data-date]').forEach((button) => {
    button.addEventListener('click', () => setView('sheet', { selectedDate: button.dataset.date }));
  });
  root.querySelectorAll('input[data-id]').forEach((input) => {
    input.addEventListener('input', () => updateRecord(input.dataset.id, input.dataset.field, input.value));
  });
  root.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteRecord(button.dataset.delete));
  });
  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', async () => {
      const action = element.dataset.action;
      if (action === 'back-shifts') setView('shifts', { selectedShift: null, selectedDate: null });
      if (action === 'back-dates') setView('dates', { selectedDate: null });
      if (action === 'add-row') await addRow();
      if (action === 'create-date') await createDate(document.getElementById('new-date').value);
      if (action === 'close-shift') await closeShift();
      if (action === 'retry-sync') await retrySync();
    });
  });
  root.querySelectorAll('select[data-action="sheet-status"]').forEach((select) => {
    select.addEventListener('change', () => changeSheetStatus(select.value));
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

window.addEventListener('online', () => {
  state.online = true;
  retrySync();
});

window.addEventListener('offline', () => {
  state.online = false;
  render();
});

if ('serviceWorker' in navigator) {
  const serviceWorkerUrl = new URL('./service-worker.js', window.location.href);
  navigator.serviceWorker.register(serviceWorkerUrl);
}

loadLocal();
render();
hydrateFromServer();
