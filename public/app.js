import { enqueueMutation, readMutationQueue, removeQueuedMutation } from './sync-queue.js';

const SHIFTS = [
  { key: 'morning', label: 'Shift 1 (Morning)', time: 'Morning shift' },
  { key: 'afternoon', label: 'Shift 2 (Afternoon)', time: 'Afternoon shift' },
  { key: 'evening', label: 'Shift 3 (Straight Day Shift)', time: 'Straight day shift' },
  { key: 'night', label: 'Shift 4 (Night)', time: 'Night shift' }
];
const DAILY_REGISTER_SHIFTS = [SHIFTS[3], SHIFTS[1], SHIFTS[2], SHIFTS[0]];

// NOTE: Shift 3's storage key stays 'evening' everywhere (records, locks,
// database enum, printed row ids) so existing rows keep working — only the
// user-facing label changed to "Shift 3 (Straight Day Shift)".

const MATERIALS = [
  { key: 'shirts', label: 'Shirts', colors: ['White', 'Blue', 'Brown', 'Grey'] },
  { key: 'trousers', label: 'Trousers', colors: ['Grey', 'Blue', 'Brown'] },
  { key: 'overcoats', label: 'Overcoats', colors: ['White', 'Blue Black', 'Cereals High Hygiene'] },
  { key: 'towels', label: 'Towels', colors: ['White', 'Blue', 'Green', 'Yellow'] },
  { key: 'tablecloths', label: 'Table Clothes', colors: ['White', 'Cream', 'Blue'] },
  { key: 'bedsheets', label: 'Bed Sheets', colors: ['White', 'Cream', 'Blue', 'Green'] }
];

// Retired categories: never rendered as editable sections, never counted in
// any total — but historical rows stay readable in Daily Records / print.
const RETIRED_MATERIALS = new Set(['Uniforms']);
const isRetiredMaterial = (label) => RETIRED_MATERIALS.has(String(label || '').trim());

const STATUS_LABELS = {
  received: 'Received',
  pending: 'Pending Dispatch',
  dispatched: 'Dispatched'
};

const STORAGE_KEY = 'laundry-tracking-state-v4';
const LEGACY_STORAGE_KEYS = ['laundry-tracking-state-v3', 'laundry-tracking-state-v2'];
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
  dailyForms: [],
  formModal: null,
  online: navigator.onLine,
  apiConnected: false,
  syncing: false,
  notice: ''
};

const tableDraft = new Map();
let saveTimer;
let mutationRetryTimer = null;
let mutationRetryDelay = 1000;
let serverReconnectTimer = null;
let serverReconnectDelay = 1000;
let supabaseClient = null;
let realtimeChannel = null;
let realtimeStartPromise = null;
let hydratePromise = null;
let realtimeRenderTimer = null;

function loadLocal() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_STORAGE_KEYS) {
        raw = localStorage.getItem(legacyKey);
        if (raw) break;
      }
    }
    const saved = JSON.parse(raw || '{}');
    state = { ...state, ...saved, tab: saved.tab || 'daily', selectedDate: saved.selectedDate || todayIso(), dailyForms: Array.isArray(saved.dailyForms) ? saved.dailyForms : [], formModal: null, online: navigator.onLine, syncing: false };
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
    dailyForms: state.dailyForms,
    notice: state.notice
  }));
}

const isValidFormDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(new Date(`${value}T12:00:00`).getTime());

function formExists(date) {
  if (!isValidFormDate(date)) return false;
  if ((state.dailyForms || []).some((form) => form && form.date === date)) return true;
  return (state.records || []).some((record) => record && record.date === date);
}

function registerDailyForm(date) {
  if (!isValidFormDate(date)) return;
  if (!formExists(date)) {
    state.dailyForms = [...(state.dailyForms || []), { date, createdAt: new Date().toISOString() }];
  }
}

async function api(path, options = {}) {
  const url = API_BASE ? `${API_BASE}/${path.replace(/^\/+/, '')}` : path;
  let response;
  try {
    response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
  } catch (error) {
    state.apiConnected = false;
    throw error;
  }
  state.apiConnected = true;
  if (!response.ok && response.status !== 202) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Request failed.');
  }
  return response.json();
}

async function hydrateFromServer() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const db = await api('api/records');
      clearTimeout(serverReconnectTimer);
      serverReconnectDelay = 1000;
      mergeServerState(db);
      state.notice = '';
    } catch {
      state.apiConnected = false;
      clearTimeout(serverReconnectTimer);
      serverReconnectTimer = setTimeout(() => hydrateFromServer(), serverReconnectDelay);
      serverReconnectDelay = Math.min(serverReconnectDelay * 2, 30000);
    }
    saveLocal();
    render();
    if (navigator.onLine) await flushMutationQueue();
  })();
  try {
    await hydratePromise;
  } finally {
    hydratePromise = null;
  }
}

function mergeServerState(db) {
  const queue = readMutationQueue();
  const queuedRecordIds = new Set(queue
    .filter((mutation) => mutation.type === 'save-records')
    .flatMap((mutation) => mutation.records.map((record) => record.id)));
  const queuedDeleteIds = new Set(queue
    .filter((mutation) => mutation.type === 'delete-record')
    .map((mutation) => mutation.id));
  const localById = new Map(state.records.map((record) => [record.id, normalizeRecord(record)]));
  const byId = new Map((db.records || []).map((record) => {
    const normalized = normalizeRecord(record);
    return [normalized.id, normalized];
  }));
  for (const id of queuedRecordIds) {
    const local = localById.get(id);
    if (local) byId.set(id, local);
  }
  for (const id of queuedDeleteIds) byId.delete(id);
  state.records = Array.from(byId.values());
  state.locks = db.locks || state.locks;
  state.syncEvents = db.syncEvents || state.syncEvents;
  // Merge explicit daily forms from the server with local ones, plus every
  // date that already has records (pre-existing days count as existing forms).
  const formsByDate = new Map((state.dailyForms || []).map((form) => [form?.date, form]));
  for (const form of db.dailyForms || db.forms || []) {
    if (form?.date && !formsByDate.has(form.date)) formsByDate.set(form.date, form);
  }
  for (const record of state.records) {
    if (record?.date && !formsByDate.has(record.date)) {
      formsByDate.set(record.date, { date: record.date, createdAt: record.createdAt || null });
    }
  }
  state.dailyForms = Array.from(formsByDate.values())
    .filter((form) => isValidFormDate(form?.date))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function normalizeRecord(record) {
  const material = record.material || '';
  const rawShift = String(record.shift || 'morning');
  const compactShift = rawShift.toLowerCase().replace(/[\s_\-]+/g, '');
  // Legacy clients may still send the old "Evening" label or a "straight"
  // alias for Shift 3 — always normalize to the 'evening' storage key.
  const shift = compactShift === 'straight' || compactShift === 'straightday' || compactShift === 'straightdayshift'
    ? 'evening'
    : record.shift || 'morning';
  return {
    ...record,
    shift,
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
  const dates = new Set([
    ...(state.dailyForms || []).map((form) => form?.date).filter(isValidFormDate),
    ...state.records.map((record) => record.date)
  ]);
  dates.add(state.selectedDate || todayIso());
  dates.add(todayIso());
  return Array.from(dates).filter(isValidFormDate).sort((a, b) => b.localeCompare(a));
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
    // Retired categories (e.g. historical Uniforms) are NEVER part of the
    // editable register or any total — they live in archivedRows() instead.
    if (isRetiredMaterial(record.material)) return false;
    if (record.color) return false;
    return !MATERIALS.some((material) => material.label === record.material);
  });
  rows.push(...legacy);
  return rows;
}

function archivedRows(date, shift) {
  // Historical rows for retired categories (Uniforms) only. Shown read-only
  // under "Archived Records" so old data is never lost, but excluded from
  // every total and monthly aggregation. (Other unknown colourless legacy
  // rows remain editable via canonicalRows.)
  return recordsForShift(date, shift).filter((record) => isRetiredMaterial(record.material));
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
  enqueueMutation({ type: 'save-records', records: records.map((record) => ({ ...record, updatedAt: now })) });
  saveLocal();
  if (navigator.onLine) await flushMutationQueue();
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
  enqueueMutation({ type: 'delete-record', id });
  saveLocal();
  render();
  if (navigator.onLine) await flushMutationQueue();
}

let mutationFlushPromise = null;

async function flushMutationQueue() {
  if (!navigator.onLine || mutationFlushPromise) return mutationFlushPromise;
  state.syncing = true;
  renderStatusOnly();
  mutationFlushPromise = (async () => {
    while (navigator.onLine) {
      const mutation = readMutationQueue()[0];
      if (!mutation) break;
      try {
        if (mutation.type === 'save-records') {
          const result = await api('api/records', {
            method: 'PUT',
            body: JSON.stringify({ records: mutation.records })
          });
          const remaining = readMutationQueue().filter((item) => item.id !== mutation.id);
          const editedAgain = new Set(remaining
            .filter((item) => item.type === 'save-records')
            .flatMap((item) => item.records.map((record) => record.id)));
          for (const item of remaining) {
            if (item.type === 'delete-record') editedAgain.add(item.id);
          }
          for (const record of result.records || []) {
            if (!editedAgain.has(record.id)) updateLocalRecord(normalizeRecord(record));
          }
        } else if (mutation.type === 'delete-record') {
          await api(`api/records/${encodeURIComponent(mutation.id)}`, { method: 'DELETE' });
          state.records = state.records.filter((record) => record.id !== mutation.id);
        } else if (mutation.type === 'create-daily-form') {
          const result = await api('api/daily-forms', {
            method: 'POST',
            body: JSON.stringify({ date: mutation.date })
          });
          if (result.form) registerDailyForm(result.form.date);
        }
        removeQueuedMutation(mutation.id);
        saveLocal();
      } catch {
        if (navigator.onLine) {
          clearTimeout(mutationRetryTimer);
          mutationRetryTimer = setTimeout(() => flushMutationQueue(), mutationRetryDelay);
          mutationRetryDelay = Math.min(mutationRetryDelay * 2, 30000);
        }
        break;
      }
    }
  })();
  try {
    await mutationFlushPromise;
  } finally {
    mutationFlushPromise = null;
    state.syncing = false;
    state.online = navigator.onLine;
    if (!readMutationQueue().length) mutationRetryDelay = 1000;
    saveLocal();
    renderStatusOnly();
    renderCalculatedTotals();
  }
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
  const status = document.querySelector('[data-sync-status]');
  if (status) status.textContent = `${syncStatusLabel()}${installModeText()}`;
}

function syncStatusLabel() {
  if (!navigator.onLine) return 'Offline';
  if (state.syncing || readMutationQueue().length) return 'Syncing…';
  if (window.LAUNDRY_SUPABASE_URL && window.LAUNDRY_SUPABASE_ANON_KEY) {
    return state.realtimeConnected ? 'Connected' : 'Offline';
  }
  return state.apiConnected ? 'Connected' : 'Offline';
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
            <p class="subtle" data-sync-status>${syncStatusLabel()}${installModeText()}</p>
          </div>
        </div>
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
  const dates = allDates();
  const idx = dates.indexOf(state.selectedDate);
  const prevDate = idx >= 0 ? dates[idx + 1] || null : null;
  const nextDate = idx > 0 ? dates[idx - 1] || null : null;
  return `
    <section class="daily-shell">
      <div class="register-toolbar no-print form-toolbar">
        <div class="form-toolbar-left">
          <button class="primary-button new-form-button" data-action="open-new-form">+ New Daily Form</button>
          <button class="mini-button" data-action="new-today">Today</button>
        </div>
        <div class="form-toolbar-right">
          <button class="mini-button" data-action="prev-day" ${prevDate ? '' : 'disabled'} aria-label="Previous day">←</button>
          <label class="day-picker-label">Form date <input type="date" data-date-picker value="${state.selectedDate}"></label>
          <button class="mini-button" data-action="next-day" ${nextDate ? '' : 'disabled'} aria-label="Next day">→</button>
        </div>
      </div>
      <div class="print-area">
        <div class="register-title">
          <h2>Daily Register — ${formatDate(state.selectedDate)}</h2>
          <div>Date: <strong>${formatDate(state.selectedDate)}</strong></div>
        </div>
        <div class="no-print" style="margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <span class="subtle">Viewing form for <strong>${formatDate(state.selectedDate)}</strong> · ${dates.length} saved form${dates.length === 1 ? '' : 's'} · editing one day never affects another.</span>
          <span style="flex:1"></span>
          <button class="primary-button" data-action="print">Print This Day</button>
        </div>
        ${DAILY_REGISTER_SHIFTS.map((shift) => renderShiftBlock(shift)).join('')}
        <table class="overall-table" aria-label="Overall daily total">
          <tbody>
            <tr>
              <th>Overall Daily Total — ${formatDate(state.selectedDate)}</th>
              <td data-daily-total>${dailyTotal(state.selectedDate)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    ${renderFormModal()}
  `;
}

function renderFormModal() {
  const modal = state.formModal;
  if (!modal) return '';
  if (modal.mode === 'duplicate') {
    return `
      <div class="modal-overlay" data-modal-overlay>
        <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="form-modal-title">
          <h3 id="form-modal-title">Form Already Exists</h3>
          <p class="subtle">A form already exists for <strong>${formatDate(modal.date)}</strong>.</p>
          <div class="modal-actions">
            <button class="mini-button" data-action="close-modal">Cancel</button>
            <button class="primary-button" data-action="open-existing-form" data-date="${modal.date}">Open Existing</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="modal-overlay" data-modal-overlay>
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="form-modal-title">
        <h3 id="form-modal-title">Create New Daily Laundry Form</h3>
        <p class="subtle">Pick the official date for this form. A date can only have one form — duplicates are blocked.</p>
        <label class="modal-label">Form date
          <input type="date" data-new-form-date value="${modal.draftDate || todayIso()}" max="9999-12-31">
        </label>
        ${modal.error ? `<p class="login-error">${escapeHtml(modal.error)}</p>` : ''}
        <div class="modal-actions">
          <button class="mini-button" data-action="close-modal">Cancel</button>
          <button class="primary-button" data-action="create-form">Create</button>
        </div>
      </div>
    </div>
  `;
}

function renderShiftBlock(shift) {
  const rows = canonicalRows(state.selectedDate, shift.key);
  const archived = archivedRows(state.selectedDate, shift.key);
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
          ${archived.length ? `
          <tr class="material-heading archived-heading">
            <td></td>
            <td colspan="4"><span>Archived Records (read-only, excluded from totals)</span></td>
          </tr>
          ${archived.map((row) => `
            <tr class="archived-row">
              <td></td>
              <td>${escapeHtml(row.material)} — ${escapeHtml(row.color || '—')}</td>
              <td>${quantityNumber(row.quantity)}</td>
              <td>${escapeHtml(row.laundryPersonnel || '')}</td>
              <td>${escapeHtml(row.verifiedBy || '')}</td>
            </tr>`).join('')}
          ` : ''}
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
    // Retired categories are excluded from Monthly Tracking entirely.
    if (isRetiredMaterial(record.material)) continue;
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

async function createDailyForm(date) {
  if (!isValidFormDate(date)) {
    state.formModal = { mode: 'create', draftDate: date || todayIso(), error: 'A valid date is required.' };
    return render();
  }
  if (formExists(date)) {
    state.formModal = { mode: 'duplicate', date, draftDate: date };
    saveLocal();
    return render();
  }
  registerDailyForm(date);
  state.selectedDate = date;
  state.tab = 'daily';
  state.formModal = null;
  saveLocal();
  enqueueMutation({ type: 'create-daily-form', date });
  if (navigator.onLine) await flushMutationQueue();
  render();
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
      const action = element.dataset.action;
      if (action === 'print') window.print();
      if (action === 'new-today') {
        state.selectedDate = todayIso();
        state.tab = 'daily';
        saveLocal();
        render();
      }
      if (action === 'open-new-form') {
        state.formModal = { mode: 'create', draftDate: todayIso(), date: todayIso() };
        render();
      }
      if (action === 'close-modal') {
        state.formModal = null;
        render();
      }
      if (action === 'create-form') {
        const picker = root.querySelector('[data-new-form-date]');
        const date = picker?.value || todayIso();
        await createDailyForm(date);
      }
      if (action === 'open-existing-form') {
        const date = element.dataset.date;
        if (isValidFormDate(date)) {
          state.selectedDate = date;
          state.tab = 'daily';
          state.formModal = null;
          saveLocal();
          render();
        }
      }
      if (action === 'prev-day' || action === 'next-day') {
        const dates = allDates();
        const idx = dates.indexOf(state.selectedDate);
        let next;
        if (action === 'prev-day' && idx >= 0) next = dates[idx + 1] || null;
        if (action === 'next-day' && idx > 0) next = dates[idx - 1] || null;
        if (next) {
          state.selectedDate = next;
          saveLocal();
          render();
        }
      }
    });
  });
  // Close modal on Escape / overlay click (clicking inside the card is fine).
  root.querySelectorAll('[data-modal-overlay]').forEach((overlay) => {
    const onKey = (e) => { if (e.key === 'Escape') { state.formModal = null; render(); } };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { state.formModal = null; render(); }
    });
    overlay.addEventListener('keydown', onKey);
  });
  if (state.formModal) {
    const picker = root.querySelector('[data-new-form-date]');
    if (picker) picker.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const date = picker.value || todayIso();
        createDailyForm(date);
      }
    });
  }
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

function queueHasRecordMutation(id) {
  return readMutationQueue().some((mutation) => mutation.type === 'save-records'
    && mutation.records.some((record) => record.id === id));
}

function scheduleRealtimeRender() {
  clearTimeout(realtimeRenderTimer);
  realtimeRenderTimer = setTimeout(() => {
    saveLocal();
    if (!document.hidden) render();
  }, 80);
}

function applyRealtimeRecord(payload) {
  if (payload.eventType === 'DELETE') {
    const id = payload.old?.id;
    if (!id || queueHasRecordMutation(id)) return;
    state.records = state.records.filter((record) => record.id !== id);
    scheduleRealtimeRender();
    return;
  }
  const row = payload.new;
  if (!row?.id || queueHasRecordMutation(row.id)) return;
  const record = normalizeRecord({
    ...row,
    rowKey: row.row_key,
    laundryPersonnel: row.laundry_personnel,
    verifiedBy: row.verified_by,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  });
  const existing = state.records.find((item) => item.id === record.id);
  if (existing && new Date(existing.updatedAt || 0) > new Date(record.updatedAt || 0)) return;
  updateLocalRecord(record);
  if (record.date) registerDailyForm(record.date);
  scheduleRealtimeRender();
}

function applyRealtimeLock(payload) {
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!row) return;
  const date = String(row.date || '').slice(0, 10);
  if (payload.eventType === 'DELETE') {
    state.locks = state.locks.filter((lock) => lock.id !== row.id
      && !(date && lock.date === date && lock.shift === row.shift));
  } else {
    const lock = {
      id: row.id,
      key: `${date}:${row.shift}`,
      date,
      shift: row.shift,
      lockedAt: row.locked_at,
      reason: row.reason,
    };
    state.locks = state.locks.filter((item) => item.key !== lock.key).concat(lock);
  }
  scheduleRealtimeRender();
}

function applyRealtimeDailyForm(payload) {
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  const date = String(row?.date || '').slice(0, 10);
  if (!date) return;
  if (payload.eventType === 'DELETE') {
    state.dailyForms = state.dailyForms.filter((form) => form.date !== date);
  } else {
    const form = { date, createdAt: row.created_at };
    state.dailyForms = state.dailyForms.filter((item) => item.date !== date).concat(form);
  }
  scheduleRealtimeRender();
}

async function startRealtime() {
  if (realtimeChannel) return;
  if (realtimeStartPromise) return realtimeStartPromise;
  const url = String(window.LAUNDRY_SUPABASE_URL || '').trim();
  const anonKey = String(window.LAUNDRY_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anonKey) return;
  realtimeStartPromise = (async () => {
    try {
      const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.117.2');
      supabaseClient ||= createClient(url, anonKey, { auth: { persistSession: false } });
      realtimeChannel = supabaseClient
        .channel('laundry-operational-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'records' }, applyRealtimeRecord)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'locks' }, applyRealtimeLock)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'daily_forms' }, applyRealtimeDailyForm)
        .subscribe((status) => {
          state.realtimeConnected = status === 'SUBSCRIBED';
          renderStatusOnly();
          if (status === 'SUBSCRIBED') hydrateFromServer();
        });
    } catch {
      state.realtimeConnected = false;
    }
  })();
  try {
    await realtimeStartPromise;
  } finally {
    realtimeStartPromise = null;
  }
}

window.addEventListener('online', () => {
  state.online = true;
  state.apiConnected = false;
  clearTimeout(mutationRetryTimer);
  clearTimeout(serverReconnectTimer);
  mutationRetryDelay = 1000;
  serverReconnectDelay = 1000;
  renderStatusOnly();
  startRealtime();
  hydrateFromServer();
});

window.addEventListener('offline', () => {
  state.online = false;
  state.apiConnected = false;
  render();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && navigator.onLine) {
    startRealtime();
    hydrateFromServer();
  }
});

window.addEventListener('pagehide', () => {
  if (realtimeChannel && supabaseClient) {
    supabaseClient.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
});

window.addEventListener('pageshow', () => {
  if (navigator.onLine) {
    startRealtime();
    hydrateFromServer();
  }
});

if ('serviceWorker' in navigator) {
  const serviceWorkerUrl = new URL('./service-worker.js', window.location.href);
  navigator.serviceWorker.register(serviceWorkerUrl);
}

loadLocal();
render();
startRealtime();
hydrateFromServer();
