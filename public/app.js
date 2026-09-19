const SHIFTS = [
  { key: 'morning', label: 'Shift 1 (Morning)', time: 'Morning shift' },
  { key: 'afternoon', label: 'Shift 2 (Afternoon)', time: 'Afternoon shift' },
  { key: 'evening', label: 'Shift 3 (Evening)', time: 'Evening shift' },
  { key: 'night', label: 'Shift 4 (Night)', time: 'Night shift' }
];

const MATERIALS = [
  { key: 'shirts', label: 'Shirts', colors: ['White', 'Blue', 'Brown', 'Grey'] },
  { key: 'uniforms', label: 'Uniforms', colors: ['Grey', 'White'] },
  { key: 'trousers', label: 'Trousers', colors: ['Grey', 'Blue', 'Brown'] },
  { key: 'overcoats', label: 'Overcoats', colors: ['White', 'Blue Black', 'Cereals High Hygiene'] }
];

const STATUS_LABELS = {
  received: 'Received',
  pending: 'Pending Dispatch',
  dispatched: 'Dispatched'
};

const STORAGE_KEY = 'laundry-tracking-state-v3';
const LEGACY_STORAGE_KEY = 'laundry-tracking-state-v2';
const AUTH_KEY = 'laundry-auth-v1';
const API_BASE = String(window.LAUNDRY_API_BASE || '').replace(/\/+$/, '');
const todayIso = () => new Date().toISOString().slice(0, 10);
const slug = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'row';
const rowId = (date, shift, material, color, index = 0) => `daily-${date}-${shift}-${slug(material)}-${slug(color)}-${index}`;

let state = {
  tab: 'daily',
  selectedDate: todayIso(),
  records: [],
  locks: [],
  syncEvents: [],
  online: navigator.onLine,
  syncing: false,
  notice: ''
};

const tableDraft = new Map();
let saveTimer;

function loadLocal() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || '{}');
    state = { ...state, ...saved, tab: saved.tab || 'daily', selectedDate: saved.selectedDate || todayIso(), online: navigator.onLine, syncing: false };
  } catch {
    saveLocal();
  }
}

function saveLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    tab: state.tab,
    selectedDate: state.selectedDate,
    records: state.records,
    locks: state.locks,
    syncEvents: state.syncEvents,
    notice: state.notice
  }));
}

async function api(path, options = {}) {
  const url = API_BASE ? `${API_BASE}/${path.replace(/^\/+/, '')}` : path;
  const response = await fetch(url, {
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
  } catch {
    state.notice = 'Offline mode. Changes will stay on this device until the server is reachable.';
  }
  saveLocal();
  render();
}

function mergeServerState(db) {
  const byId = new Map(state.records.map((record) => [record.id, normalizeRecord(record)]));
  for (const record of db.records || []) {
    const normalized = normalizeRecord(record);
    const local = byId.get(normalized.id);
    if (!local || new Date(normalized.updatedAt || 0) >= new Date(local.updatedAt || 0)) {
      byId.set(normalized.id, normalized);
    }
  }
  state.records = Array.from(byId.values());
  state.locks = db.locks || state.locks;
  state.syncEvents = db.syncEvents || state.syncEvents;
}

function normalizeRecord(record) {
  const material = record.material || '';
  return {
    ...record,
    color: record.color || '',
    rowKey: record.rowKey || (record.color ? `${slug(material)}:${slug(record.color)}` : ''),
    quantity: record.quantity === '' || record.quantity === null || record.quantity === undefined ? null : Number(record.quantity),
    signature: record.signature || '',
    status: record.status || 'received'
  };
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function isLocked(date, shift) {
  return state.locks.some((lock) => lock.date === date && lock.shift === shift);
}

function recordsForDate(date) {
  return state.records.filter((record) => record.date === date).map(normalizeRecord);
}

function recordsForShift(date, shift) {
  return recordsForDate(date).filter((record) => record.shift === shift);
}

function recordMap(date) {
  const rows = new Map();
  for (const record of recordsForDate(date)) {
    rows.set(record.id, record);
  }
  return rows;
}

function allDates() {
  const dates = new Set(state.records.map((record) => record.date));
  dates.add(state.selectedDate || todayIso());
  dates.add(todayIso());
  return Array.from(dates).sort((a, b) => b.localeCompare(a));
}

function quantityValue(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function quantityNumber(value) {
  return value === null || value === undefined || value === '' ? 0 : Number(value) || 0;
}

function canonicalRows(date, shift) {
  const map = recordMap(date);
  const rows = [];
  for (const material of MATERIALS) {
    material.colors.forEach((color, index) => {
      const id = rowId(date, shift, material.label, color, index);
      rows.push({
        id,
        date,
        shift,
        material: material.label,
        color,
        rowKey: `${material.key}:${slug(color)}:${index}`,
        fixed: true,
        ...(map.get(id) || {})
      });
    });
    const extras = recordsForShift(date, shift)
      .filter((record) => record.material === material.label && !rows.some((row) => row.id === record.id))
      .sort((a, b) => (a.rowKey || a.color).localeCompare(b.rowKey || b.color));
    rows.push(...extras);
  }
  const legacy = recordsForShift(date, shift).filter((record) => {
    if (record.color) return false;
    return !MATERIALS.some((material) => material.label === record.material);
  });
  rows.push(...legacy);
  return rows;
}

function buildRecordFromInput(input) {
  const existing = state.records.find((record) => record.id === input.id);
  const now = new Date().toISOString();
  return {
    id: input.id,
    date: input.date,
    shift: input.shift,
    material: input.material,
    color: input.color,
    rowKey: input.rowKey,
    quantity: input.quantity === '' ? null : Number(input.quantity),
    laundryPersonnel: input.laundryPersonnel,
    verifiedBy: input.verifiedBy,
    signature: input.signature,
    status: existing?.status || 'received',
    syncStatus: 'pending',
    syncError: '',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    syncedAt: existing?.syncedAt || null
  };
}

function updateLocalRecord(record) {
  const byId = new Map(state.records.map((item) => [item.id, item]));
  byId.set(record.id, record);
  state.records = Array.from(byId.values());
}

function updateTableCell(id, field, value) {
  const input = document.querySelector(`[data-row-id="${cssEscape(id)}"]`);
  if (!input) return;
  const row = input.closest('tr');
  const record = buildRecordFromInput({
    id,
    date: row.dataset.date,
    shift: row.dataset.shift,
    material: row.querySelector('[data-field="material"]')?.value || row.dataset.material,
    color: row.querySelector('[data-field="color"]')?.value || row.dataset.color,
    rowKey: row.dataset.rowKey,
    quantity: field === 'quantity' ? value : row.querySelector('[data-field="quantity"]')?.value || '',
    laundryPersonnel: row.closest('.shift-block').querySelector('[data-shift-field="laundryPersonnel"]')?.value || '',
    verifiedBy: row.closest('.shift-block').querySelector('[data-shift-field="verifiedBy"]')?.value || '',
    signature: row.closest('.shift-block').querySelector('[data-shift-field="signature"]')?.value || ''
  });
  if (field === 'material') record.material = value;
  if (field === 'color') record.color = value;
  tableDraft.set(id, record);
  updateLocalRecord(record);
  renderCalculatedTotals();
  scheduleSave();
}

function updateShiftField(shift, field, value) {
  for (const row of canonicalRows(state.selectedDate, shift)) {
    const record = buildRecordFromInput({
      ...row,
      quantity: quantityValue(row.quantity),
      laundryPersonnel: field === 'laundryPersonnel' ? value : row.laundryPersonnel || '',
      verifiedBy: field === 'verifiedBy' ? value : row.verifiedBy || '',
      signature: field === 'signature' ? value : row.signature || ''
    });
    tableDraft.set(record.id, record);
    updateLocalRecord(record);
  }
  scheduleSave();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persistDraft(), 650);
  saveLocal();
}

async function persistDraft() {
  const records = Array.from(tableDraft.values());
  tableDraft.clear();
  if (!records.length) return;
  await persistRecords(records);
}

async function persistRecords(records) {
  const now = new Date().toISOString();
  for (const record of records) updateLocalRecord({ ...record, updatedAt: now, syncStatus: 'pending' });
  saveLocal();
  try {
    const result = await api('api/records', {
      method: 'PUT',
      body: JSON.stringify({ records })
    });
    mergeServerState({ records: result.records || [] });
    state.notice = result.sync?.status === 'synced'
      ? 'Saved.'
      : 'Saved to PostgreSQL. Google Sheets export is pending.';
  } catch (error) {
    state.notice = `Saved on this device. Server save pending: ${error.message}`;
  }
  saveLocal();
  renderStatusOnly();
}

async function addColorRow(shift, materialLabel) {
  const color = '';
  const existing = canonicalRows(state.selectedDate, shift).filter((row) => row.material === materialLabel).length;
  const id = rowId(state.selectedDate, shift, materialLabel, `extra-${Date.now()}`, existing);
  const shiftRows = recordsForShift(state.selectedDate, shift);
  const template = shiftRows[0] || {};
  const record = buildRecordFromInput({
    id,
    date: state.selectedDate,
    shift,
    material: materialLabel,
    color,
    rowKey: `${slug(materialLabel)}:extra:${existing}`,
    quantity: '',
    laundryPersonnel: template.laundryPersonnel || '',
    verifiedBy: template.verifiedBy || '',
    signature: template.signature || ''
  });
  updateLocalRecord(record);
  await persistRecords([record]);
  render();
}

async function deleteRecord(id) {
  state.records = state.records.filter((record) => record.id !== id);
  tableDraft.delete(id);
  saveLocal();
  render();
  try {
    await api(`api/records/${id}`, { method: 'DELETE' });
    state.notice = 'Row removed.';
  } catch (error) {
    state.notice = `Row removed on this device. Server delete failed: ${error.message}`;
  }
  saveLocal();
  renderStatusOnly();
}

async function retrySync() {
  state.syncing = true;
  renderStatusOnly();
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

function shiftTotal(date, shift) {
  return canonicalRows(date, shift).reduce((sum, row) => sum + quantityNumber(row.quantity), 0);
}

function materialTotal(date, shift, material) {
  return canonicalRows(date, shift)
    .filter((row) => row.material === material)
    .reduce((sum, row) => sum + quantityNumber(row.quantity), 0);
}

function dailyTotal(date) {
  return SHIFTS.reduce((sum, shift) => sum + shiftTotal(date, shift.key), 0);
}

function renderCalculatedTotals() {
  for (const shift of SHIFTS) {
    for (const material of MATERIALS) {
      const el = document.querySelector(`[data-material-total="${shift.key}:${material.label}"]`);
      if (el) el.textContent = String(materialTotal(state.selectedDate, shift.key, material.label));
    }
    const shiftEl = document.querySelector(`[data-shift-total="${shift.key}"]`);
    if (shiftEl) shiftEl.textContent = String(shiftTotal(state.selectedDate, shift.key));
  }
  const dailyEl = document.querySelector('[data-daily-total]');
  if (dailyEl) dailyEl.textContent = String(dailyTotal(state.selectedDate));
}

function renderStatusOnly() {
  const notice = document.querySelector('[data-notice]');
  if (notice) notice.textContent = state.notice;
  const sync = document.querySelector('[data-action="retry-sync"]');
  if (sync) sync.textContent = state.syncing ? 'Syncing...' : 'Sync';
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
  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('.login-btn');
    const errorEl = document.getElementById('login-error');
    button.disabled = true;
    button.textContent = 'Signing in...';
    errorEl.hidden = true;
    try {
      const result = await api('api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value.trim(),
          password: document.getElementById('login-password').value
        })
      });
      localStorage.setItem(AUTH_KEY, JSON.stringify({ email: result.user.email }));
      render();
      hydrateFromServer();
    } catch (err) {
      errorEl.textContent = err.message || 'Sign in failed.';
      errorEl.hidden = false;
      button.textContent = 'Sign In';
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
      <header class="topbar no-print">
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
        <nav class="tabs no-print" aria-label="Main navigation">
          <button class="tab ${state.tab === 'daily' ? 'active' : ''}" data-tab="daily">Daily Register</button>
          <button class="tab ${state.tab === 'records' ? 'active' : ''}" data-tab="records">Daily Records</button>
          <button class="tab ${state.tab === 'monthly' ? 'active' : ''}" data-tab="monthly">Monthly Tracking</button>
        </nav>
        <p class="sync-note no-print" data-notice>${escapeHtml(state.notice || '')}</p>
        ${state.tab === 'records' ? renderRecordsPage() : state.tab === 'monthly' ? renderMonthlyPage() : renderDailyPage()}
      </main>
    </div>
  `;
  bindEvents(root);
}

function installModeText() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  return standalone ? ' - App mode' : ' - Desktop register';
}

function renderDailyPage() {
  return `
    <section class="daily-shell">
      <div class="register-toolbar no-print">
        <label>Date <input type="date" data-date-picker value="${state.selectedDate}"></label>
        <button class="primary-button" data-action="print">Print</button>
      </div>
      <div class="print-area">
        <div class="register-title">
          <h2>Laundry Daily Tracking Table</h2>
          <div>Date: <strong>${formatDate(state.selectedDate)}</strong></div>
        </div>
        ${SHIFTS.map((shift) => renderShiftBlock(shift)).join('')}
        <table class="overall-table" aria-label="Overall daily total">
          <tbody>
            <tr>
              <th>Overall Daily Total</th>
              <td data-daily-total>${dailyTotal(state.selectedDate)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderShiftBlock(shift) {
  const rows = canonicalRows(state.selectedDate, shift.key);
  const locked = isLocked(state.selectedDate, shift.key);
  const shiftMeta = rows.find((row) => row.laundryPersonnel || row.verifiedBy || row.signature) || {};
  return `
    <section class="shift-block ${locked ? 'locked' : ''}" data-shift-block="${shift.key}">
      <table class="laundry-register" aria-label="${shift.label}">
        <colgroup>
          <col class="date-col">
          <col class="material-col">
          <col class="quantity-col">
          <col class="personnel-col">
          <col class="verified-col">
        </colgroup>
        <thead>
          <tr>
            <th>Date / Shift</th>
            <th>Material</th>
            <th>Quantity</th>
            <th>Name & Signature<br><span>Laundry Personnel</span></th>
            <th>Verified By</th>
          </tr>
        </thead>
        <tbody>
          <tr class="shift-meta-row">
            <td>
              <strong>${formatDate(state.selectedDate)}</strong>
              <span>${shift.label}</span>
              <span>${shift.time}</span>
            </td>
            <td colspan="2" class="shift-heading">${shift.label}</td>
            <td>
              <input data-shift="${shift.key}" data-shift-field="laundryPersonnel" value="${escapeAttr(shiftMeta.laundryPersonnel || '')}" placeholder="" ${locked ? 'readonly' : ''}>
              <input data-shift="${shift.key}" data-shift-field="signature" value="${escapeAttr(shiftMeta.signature || '')}" placeholder="Signature" ${locked ? 'readonly' : ''}>
            </td>
            <td><input data-shift="${shift.key}" data-shift-field="verifiedBy" value="${escapeAttr(shiftMeta.verifiedBy || '')}" ${locked ? 'readonly' : ''}></td>
          </tr>
          ${MATERIALS.map((material) => renderMaterialRows(shift, material, rows, locked)).join('')}
          <tr class="shift-total-row">
            <td></td>
            <td>Shift Total</td>
            <td data-shift-total="${shift.key}">${shiftTotal(state.selectedDate, shift.key)}</td>
            <td></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </section>
  `;
}

function renderMaterialRows(shift, material, allRows, locked) {
  const rows = allRows.filter((row) => row.material === material.label);
  return `
    <tr class="material-heading">
      <td></td>
      <td colspan="4">
        <span>${material.label}</span>
        <button class="mini-button no-print" data-add-color="${shift.key}:${material.label}" ${locked ? 'disabled' : ''}>Add Color</button>
      </td>
    </tr>
    ${rows.map((row) => renderColorRow(row, locked)).join('')}
    <tr class="material-total-row">
      <td></td>
      <td>Total ${material.label}</td>
      <td data-material-total="${shift.key}:${material.label}">${materialTotal(state.selectedDate, shift.key, material.label)}</td>
      <td></td>
      <td></td>
    </tr>
  `;
}

function renderColorRow(row, locked) {
  const canDelete = !row.fixed;
  return `
    <tr data-date="${row.date}" data-shift="${row.shift}" data-material="${escapeAttr(row.material)}" data-color="${escapeAttr(row.color)}" data-row-key="${escapeAttr(row.rowKey)}">
      <td></td>
      <td class="color-cell">
        <input data-row-id="${escapeAttr(row.id)}" data-field="color" value="${escapeAttr(row.color)}" ${locked || row.fixed ? 'readonly' : ''}>
      </td>
      <td>
        <input data-row-id="${escapeAttr(row.id)}" data-field="quantity" type="number" min="0" inputmode="numeric" value="${quantityValue(row.quantity)}" ${locked ? 'readonly' : ''}>
      </td>
      <td></td>
      <td class="row-actions">${canDelete ? `<button class="mini-button no-print" data-delete="${escapeAttr(row.id)}" ${locked ? 'disabled' : ''}>Remove</button>` : ''}</td>
    </tr>
  `;
}

function renderRecordsPage() {
  const dates = allDates();
  return `
    <section>
      <div class="page-head">
        <div>
          <h2>Daily Records</h2>
          <p class="subtle">Saved days open back into the full empty-table format.</p>
        </div>
        <button class="primary-button" data-action="new-today">Today</button>
      </div>
      <div class="table-wrap records-wrap">
        <table class="records-table" aria-label="Daily records">
          <thead><tr><th>Date</th><th>Total</th><th>Actions</th></tr></thead>
          <tbody>
            ${dates.map((date) => `
              <tr>
                <td>${formatDate(date)}</td>
                <td>${dailyTotal(date)}</td>
                <td>
                  <button class="mini-button" data-open-date="${date}">Open</button>
                  <button class="mini-button" data-print-date="${date}">Print</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderMonthlyPage() {
  const month = state.selectedDate.slice(0, 7);
  const rows = monthlyRows(month);
  return `
    <section>
      <div class="register-toolbar">
        <label>Month <input type="month" data-month-picker value="${month}"></label>
      </div>
      <div class="table-wrap records-wrap">
        <table class="records-table" aria-label="Monthly tracking">
          <thead><tr><th>Material</th><th>Color</th><th>Monthly Quantity</th></tr></thead>
          <tbody>
            ${rows.map((row) => `<tr><td>${escapeHtml(row.material)}</td><td>${escapeHtml(row.color)}</td><td>${row.total}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function monthlyRows(month) {
  const grouped = new Map();
  for (const record of state.records.map(normalizeRecord)) {
    if (!record.date?.startsWith(month)) continue;
    const material = record.material || 'Unlabelled';
    const color = record.color || '';
    const key = `${material}::${color}`;
    const row = grouped.get(key) || { material, color, total: 0 };
    row.total += quantityNumber(record.quantity);
    grouped.set(key, row);
  }
  for (const material of MATERIALS) {
    for (const color of material.colors) {
      const key = `${material.label}::${color}`;
      if (!grouped.has(key)) grouped.set(key, { material: material.label, color, total: 0 });
    }
  }
  return Array.from(grouped.values()).sort((a, b) => `${a.material}${a.color}`.localeCompare(`${b.material}${b.color}`));
}

function bindEvents(root) {
  root.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      saveLocal();
      render();
    });
  });
  root.querySelectorAll('[data-date-picker]').forEach((input) => {
    input.addEventListener('change', () => {
      state.selectedDate = input.value || todayIso();
      saveLocal();
      render();
    });
  });
  root.querySelectorAll('[data-month-picker]').forEach((input) => {
    input.addEventListener('change', () => {
      state.selectedDate = `${input.value || todayIso().slice(0, 7)}-01`;
      saveLocal();
      render();
    });
  });
  root.querySelectorAll('[data-row-id]').forEach((input) => {
    input.addEventListener('input', () => updateTableCell(input.dataset.rowId, input.dataset.field, input.value));
  });
  root.querySelectorAll('[data-shift-field]').forEach((input) => {
    input.addEventListener('input', () => updateShiftField(input.dataset.shift, input.dataset.shiftField, input.value));
  });
  root.querySelectorAll('[data-add-color]').forEach((button) => {
    button.addEventListener('click', () => {
      const [shift, material] = button.dataset.addColor.split(':');
      addColorRow(shift, material);
    });
  });
  root.querySelectorAll('[data-delete]').forEach((button) => {
    button.addEventListener('click', () => deleteRecord(button.dataset.delete));
  });
  root.querySelectorAll('[data-open-date]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedDate = button.dataset.openDate;
      state.tab = 'daily';
      saveLocal();
      render();
    });
  });
  root.querySelectorAll('[data-print-date]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedDate = button.dataset.printDate;
      state.tab = 'daily';
      saveLocal();
      render();
      requestAnimationFrame(() => window.print());
    });
  });
  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', async () => {
      if (element.dataset.action === 'retry-sync') await retrySync();
      if (element.dataset.action === 'print') window.print();
      if (element.dataset.action === 'new-today') {
        state.selectedDate = todayIso();
        state.tab = 'daily';
        saveLocal();
        render();
      }
    });
  });
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
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
