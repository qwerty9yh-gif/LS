import { enqueueMutation, readMutationQueue, removeQueuedMutation } from './sync-queue.js';
import { DEFAULT_SHIFT_ORDER, SHIFT_KEYS, isCompleteShiftOrder, moveShift, normalizeShiftOrder, placeShift } from './shift-order.js';
import { DEFAULT_MATERIAL_COLORS, applyMaterialColorMutation, isRetiredMaterialColor, normalizeMaterialColors } from './material-colors.js';
import { buildMonthlyRevenue, formatCents, paginateInvoiceLines } from './billing.js';
import { buildMonthlyDailyReport } from './monthly-report.js';
import {
  createDailyMonthlyReportPdf,
  createInvoicePdf,
  createMonthlyRevenuePdf,
  createPdfFilename,
  savePdfFile,
} from './pdf-reports.js';

const SHIFTS = [
  { key: 'morning', label: 'Morning', time: 'Morning shift' },
  { key: 'afternoon', label: 'Afternoon', time: 'Afternoon shift' },
  { key: 'evening', label: 'Straight Day', time: 'Straight day shift' },
  { key: 'night', label: 'Night', time: 'Night shift' }
];
// The 'evening' key remains the stored Straight Day shift for existing rows.

const MATERIALS = [
  { key: 'shirts', label: 'Shirts' },
  { key: 'trousers', label: 'Trousers' },
  { key: 'overcoats', label: 'Overcoats' },
  { key: 'towels', label: 'Towels' },
  { key: 'tablecloths', label: 'Table Clothes' },
  { key: 'bedsheets', label: 'Bed Sheets' }
];

// Retired categories: never rendered as editable sections, never counted in
// any total — but historical rows stay readable in Daily Records / print.
const RETIRED_MATERIALS = new Set(['Uniforms']);
const isRetiredMaterial = (label) => RETIRED_MATERIALS.has(String(label || '').trim());

function orderedDailyShifts() {
  const shiftsByKey = new Map(SHIFTS.map((shift) => [shift.key, shift]));
  return normalizeShiftOrder(state.shiftOrder).map((key) => shiftsByKey.get(key));
}

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
  materialColors: normalizeMaterialColors(DEFAULT_MATERIAL_COLORS),
  shiftOrder: [...DEFAULT_SHIFT_ORDER],
  unitPrices: [],
  priceDraft: {},
  invoices: [],
  companyInfo: {},
  selectedMonth: todayIso().slice(0, 7),
  invoiceFormModal: null,
  invoicePreview: null,
  formModal: null,
  colorModal: null,
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
let materialColorPollTimer = null;
let pdfExportInProgress = false;
let brandLogoDataPromise = null;

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
    state = {
      ...state,
      ...saved,
      tab: saved.tab || 'daily',
      selectedDate: saved.selectedDate || todayIso(),
      dailyForms: Array.isArray(saved.dailyForms) ? saved.dailyForms : [],
      materialColors: normalizeMaterialColors(saved.materialColors),
      shiftOrder: normalizeShiftOrder(saved.shiftOrder),
      unitPrices: Array.isArray(saved.unitPrices) ? saved.unitPrices : [],
      priceDraft: {},
      invoices: Array.isArray(saved.invoices) ? saved.invoices : [],
      companyInfo: saved.companyInfo || {},
      selectedMonth: /^\d{4}-\d{2}$/.test(saved.selectedMonth)
        ? saved.selectedMonth
        : String(saved.selectedDate || todayIso()).slice(0, 7),
      invoiceFormModal: null,
      invoicePreview: null,
      formModal: null,
      colorModal: null,
      online: navigator.onLine,
      syncing: false
    };
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
    materialColors: state.materialColors,
    shiftOrder: state.shiftOrder,
    unitPrices: state.unitPrices,
    invoices: state.invoices,
    companyInfo: state.companyInfo,
    selectedMonth: state.selectedMonth,
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
    const error = new Error(body.error || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function hydrateFromServer() {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const [db, billing, invoices] = await Promise.all([
        api('api/records'),
        api('api/billing'),
        api('api/invoices'),
      ]);
      clearTimeout(serverReconnectTimer);
      serverReconnectDelay = 1000;
      mergeServerState(db);
      state.unitPrices = billing.unitPrices || [];
      state.priceDraft = {};
      state.companyInfo = billing.companyInfo || {};
      state.invoices = invoices.invoices || [];
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
  const queuedShiftOrder = queue.filter((mutation) => mutation.type === 'set-shift-order').at(-1);
  const queuedColorMutations = queue.filter((mutation) => mutation.type.endsWith('-material-color'));
  const queuedColorRenames = queuedColorMutations.filter((mutation) => mutation.type === 'rename-material-color');
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
  state.records = Array.from(byId.values()).map((record) => queuedColorRenames.reduce((current, mutation) =>
    current.material === mutation.material && current.color === mutation.from
      ? { ...current, color: mutation.to }
      : current, record));
  state.materialColors = queuedColorMutations.reduce((colors, mutation) =>
    applyMaterialColorMutation(colors, mutation),
  normalizeMaterialColors(Array.isArray(db.materialColors) ? db.materialColors : state.materialColors));
  if (!queuedShiftOrder && Array.isArray(db.shiftOrder)) {
    state.shiftOrder = normalizeShiftOrder(db.shiftOrder);
  }
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

function materialColorsFor(material) {
  return normalizeMaterialColors(state.materialColors).filter((row) => row.material === material);
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
  const shiftRecords = recordsForShift(date, shift);
  const rows = [];
  for (const material of MATERIALS) {
    materialColorsFor(material.label).forEach((color, index) => {
      const existing = shiftRecords.find((record) => record.material === material.label
        && record.color === color.label
        && !String(record.rowKey || '').includes(':extra:'));
      const id = existing?.id || rowId(date, shift, material.label, color.label, index);
      rows.push({
        id,
        date,
        shift,
        material: material.label,
        color: color.label,
        rowKey: existing?.rowKey || `${material.key}:${slug(color.label)}:${index}`,
        fixed: true,
        ...(existing || map.get(id) || {})
      });
    });
    const extras = shiftRecords
      .filter((record) => record.material === material.label && !rows.some((row) => row.id === record.id))
      .sort((a, b) => (a.rowKey || a.color).localeCompare(b.rowKey || b.color));
    rows.push(...extras.map((record) => ({
      ...record,
      fixed: Boolean(record.color) && !materialColorsFor(material.label).some((color) => color.label === record.color),
    })));
  }
  const legacy = shiftRecords.filter((record) => {
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

function isValidColorLabel(material, label) {
  return MATERIALS.some((item) => item.label === material)
    && Boolean(label)
    && label.length <= 50
    && !isRetiredMaterialColor(material, label)
    && !/[\u0000-\u001f]/.test(label);
}

async function persistMaterialColorMutation(mutation) {
  enqueueMutation(mutation);
  saveLocal();
  render();
  if (navigator.onLine) await flushMutationQueue();
}

async function addMaterialColor(material) {
  state.colorModal = { mode: 'create', material, label: '', error: '' };
  render();
}

async function renameMaterialColor(material, from) {
  state.colorModal = { mode: 'rename', material, from, label: from, error: '' };
  render();
}

async function deleteMaterialColor(material, label) {
  if (materialColorsFor(material).length <= 1) {
    state.notice = 'Each material must keep at least one color.';
    return render();
  }
  state.colorModal = { mode: 'delete', material, label, error: '' };
  render();
}

async function saveMaterialColor() {
  const modal = state.colorModal;
  const label = String(modal?.label || '').trim();
  if (!modal || modal.mode === 'delete') return;
  if (!isValidColorLabel(modal.material, label)) {
    state.colorModal = { ...modal, error: 'Enter a color label with 1 to 50 characters.' };
    return render();
  }
  if (materialColorsFor(modal.material).some((row) => row.label !== modal.from
    && row.label.toLocaleLowerCase() === label.toLocaleLowerCase())) {
    state.colorModal = { ...modal, error: 'That color already exists for this material.' };
    return render();
  }
  state.colorModal = null;
  state.notice = '';
  if (modal.mode === 'create') {
    const displayOrder = Math.max(0, ...materialColorsFor(modal.material).map((row) => row.displayOrder)) + 1;
    state.materialColors = normalizeMaterialColors([...state.materialColors, { material: modal.material, label, displayOrder }]);
    return persistMaterialColorMutation({ type: 'create-material-color', material: modal.material, label });
  }
  if (label === modal.from) return render();
  state.materialColors = normalizeMaterialColors(state.materialColors.map((row) =>
    row.material === modal.material && row.label === modal.from ? { ...row, label } : row));
  state.records = state.records.map((record) =>
    record.material === modal.material && record.color === modal.from ? { ...record, color: label } : record);
  for (const [id, record] of tableDraft) {
    if (record.material === modal.material && record.color === modal.from) tableDraft.set(id, { ...record, color: label });
  }
  return persistMaterialColorMutation({ type: 'rename-material-color', material: modal.material, from: modal.from, to: label });
}

async function confirmDeleteMaterialColor() {
  const modal = state.colorModal;
  if (modal?.mode !== 'delete') return;
  state.materialColors = state.materialColors.filter((row) => row.material !== modal.material || row.label !== modal.label);
  state.colorModal = null;
  state.notice = '';
  await persistMaterialColorMutation({ type: 'delete-material-color', material: modal.material, label: modal.label });
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
        } else if (mutation.type === 'set-shift-order') {
          const order = [...DEFAULT_SHIFT_ORDER];
          const result = await api('api/shift-order', {
            method: 'PUT',
            body: JSON.stringify({ order })
          });
          state.shiftOrder = normalizeShiftOrder(result.order || order);
        } else if (mutation.type.endsWith('-material-color')) {
          let result;
          if (mutation.type === 'create-material-color') {
            result = await api('api/material-colors', {
              method: 'POST',
              body: JSON.stringify({ material: mutation.material, label: mutation.label })
            });
          } else if (mutation.type === 'rename-material-color') {
            result = await api('api/material-colors', {
              method: 'PUT',
              body: JSON.stringify({ material: mutation.material, from: mutation.from, to: mutation.to })
            });
          } else {
            result = await api(`api/material-colors/${encodeURIComponent(mutation.material)}/${encodeURIComponent(mutation.label)}`, { method: 'DELETE' });
          }
          const laterColorMutation = readMutationQueue().some((item) => item.id !== mutation.id
            && item.type.endsWith('-material-color') && item.material === mutation.material);
          if (!laterColorMutation && Array.isArray(result.materialColors)) {
            state.materialColors = normalizeMaterialColors(result.materialColors);
          }
        }
        removeQueuedMutation(mutation.id);
        saveLocal();
      } catch (error) {
        if (mutation.type.endsWith('-material-color') && error.status >= 400 && error.status < 500) {
          removeQueuedMutation(mutation.id);
          try {
            const db = await api('api/records');
            mergeServerState(db);
          } catch {
            state.materialColors = state.materialColors.filter((row) => row.material !== mutation.material);
          }
          state.notice = error.message;
          saveLocal();
          render();
          continue;
        }
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
        <img class="splash-mark" src="./brand-logo.png" alt="MK Business Company Ltd.">
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
          <img class="brand-mark" src="./brand-logo.png" alt="MK Business Company Ltd.">
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
          <button class="tab ${state.tab === 'monthly' ? 'active' : ''}" data-tab="monthly">MONTHLY REVENUE</button>
          <button class="tab ${state.tab === 'prices' ? 'active' : ''}" data-tab="prices">Unit Price Settings</button>
        </nav>
        <p class="sync-note no-print" data-notice>${escapeHtml(state.notice || '')}</p>
        ${state.tab === 'records' ? renderRecordsPage()
          : state.tab === 'monthly' ? renderMonthlyPage()
            : state.tab === 'prices' ? renderUnitPricePage()
              : renderDailyPage()}
      </main>
      ${renderColorModal()}
      ${renderInvoiceFormModal()}
      ${renderInvoicePreview()}
    </div>
    <div id="daily-print-document" aria-hidden="true"></div>
  `;
  bindEvents(root);
  if (state.colorModal && state.colorModal.mode !== 'delete') root.querySelector('[data-color-label]')?.focus();
  if (state.invoiceFormModal) root.querySelector('[data-bill-to-name]')?.focus();
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
          <button class="primary-button" data-action="daily-print">Daily Print</button>
        </div>
        <div class="shift-list" data-shift-list>
          ${orderedDailyShifts().map((shift) => renderShiftBlock(shift)).join('')}
        </div>
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

function renderColorModal() {
  const modal = state.colorModal;
  if (!modal) return '';
  const deleting = modal.mode === 'delete';
  const title = deleting ? `Delete ${modal.label}?` : modal.mode === 'rename' ? 'Rename color' : 'Add color';
  return `
    <div class="modal-overlay" data-color-modal-overlay tabindex="-1">
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="color-modal-title">
        <h3 id="color-modal-title">${escapeHtml(title)}</h3>
        <p class="subtle">${deleting
          ? 'The color label will be removed. Existing records and quantities will be kept.'
          : `Color for ${escapeHtml(modal.material)}`}</p>
        ${deleting ? '' : `
          <label class="modal-label" for="color-modal-input">Color label</label>
          <input id="color-modal-input" data-color-label maxlength="50" value="${escapeAttr(modal.label)}" autocomplete="off">
        `}
        ${modal.error ? `<p class="login-error">${escapeHtml(modal.error)}</p>` : ''}
        <div class="modal-actions">
          <button class="mini-button" data-action="color-cancel">Cancel</button>
          <button class="${deleting ? 'danger-button' : 'primary-button'}" data-action="${deleting ? 'color-delete-confirm' : 'color-save'}">${deleting ? 'Delete Color' : 'Save Color'}</button>
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
            <td colspan="2" class="shift-heading">
              <div class="shift-heading-content">
                <span>${shift.label}</span>
              </div>
            </td>
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
        <button class="mini-button no-print" data-add-color="${escapeAttr(material.label)}">Add Color</button>
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
  const colorIsManaged = materialColorsFor(row.material).some((item) => item.label === row.color);
  const isRetiredHistory = isRetiredMaterialColor(row.material, row.color);
  const colorLabel = colorIsManaged
    ? `<span class="color-label-controls"><button class="color-label-button no-print" data-color-edit-material="${escapeAttr(row.material)}" data-color-edit-label="${escapeAttr(row.color)}">${escapeHtml(row.color)}</button><button class="color-delete-button no-print" data-color-delete-material="${escapeAttr(row.material)}" data-color-delete-label="${escapeAttr(row.color)}" aria-label="Delete ${escapeAttr(row.color)} from ${escapeAttr(row.material)}" title="Delete color">×</button></span>`
    : `<span class="retired-color-label">${escapeHtml(row.color || 'Unlabelled')}${isRetiredHistory ? ' · historical' : ''}</span>`;
  return `
    <tr data-date="${row.date}" data-shift="${row.shift}" data-material="${escapeAttr(row.material)}" data-color="${escapeAttr(row.color)}" data-row-key="${escapeAttr(row.rowKey)}">
      <td></td>
      <td class="color-cell">
        ${colorLabel}
      </td>
      <td>
        <input data-row-id="${escapeAttr(row.id)}" data-field="quantity" type="number" min="0" inputmode="numeric" value="${quantityValue(row.quantity)}" ${locked || isRetiredHistory ? 'readonly' : ''}>
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
                  <button class="mini-button" data-print-date="${date}">Print This Day</button>
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
  const month = state.selectedMonth;
  const revenue = buildMonthlyRevenue({
    records: state.records,
    materialColors: state.materialColors,
    unitPrices: state.unitPrices,
    month,
  });
  return `
    <section class="billing-page">
      <div class="register-toolbar billing-toolbar no-print">
        <div>
          <h2>MONTHLY REVENUE</h2>
          <p class="subtle">Revenue from saved laundry records for the selected month.</p>
        </div>
        <label>Month <input type="month" data-month-picker value="${month}"></label>
        <div class="monthly-export-actions">
          <button type="button" class="primary-button" data-pdf-export data-action="export-monthly-revenue">Export PDF</button>
          <button type="button" class="primary-button" data-action="open-invoice-form">Generate Monthly Invoice</button>
          <button type="button" class="primary-button" data-pdf-export data-action="export-daily-monthly-report">Export Daily Monthly Report (PDF)</button>
        </div>
      </div>
      <div class="table-wrap billing-table-wrap">
        <table class="records-table billing-table" aria-label="Monthly revenue">
          <thead><tr><th>Item</th><th>Color</th><th>Monthly Quantity</th><th>Unit Price</th><th>Total Amount</th></tr></thead>
          <tbody>
            ${revenue.lines.map((line) => `
              <tr>
                <td>${escapeHtml(line.material)}</td>
                <td>${escapeHtml(line.color)}</td>
                <td>${line.quantity}</td>
                <td>${line.unitPriceCents === null ? '—' : formatCents(line.unitPriceCents)}</td>
                <td>${line.amountCents === null ? 'Set a unit price' : formatCents(line.amountCents)}</td>
              </tr>`).join('')}
            <tr class="grand-total-row"><th colspan="4">Grand Monthly Total</th><td>${formatCents(revenue.grandTotalCents)}</td></tr>
          </tbody>
        </table>
      </div>
      ${!revenue.complete ? '<p class="billing-warning">Set a unit price for each active item/color with a recorded quantity to complete the monthly total.</p>' : ''}
      <section class="saved-invoices no-print">
        <h3>Generated Invoices</h3>
        ${state.invoices.length ? `
          <div class="table-wrap billing-table-wrap">
            <table class="records-table">
              <thead><tr><th>Invoice Number</th><th>Billing Period</th><th>Bill To</th><th>Total</th><th>Preview</th></tr></thead>
              <tbody>${state.invoices.map((invoice) => `
                <tr>
                  <td>${escapeHtml(invoice.invoiceNumber)}</td>
                  <td>${escapeHtml(invoice.month)}</td>
                  <td>${escapeHtml(invoice.billTo?.recipientName || '')}</td>
                  <td>${formatCents(invoice.grandTotalCents)}</td>
                  <td><button type="button" class="mini-button" data-preview-invoice="${escapeAttr(invoice.invoiceNumber)}">Open Invoice</button></td>
                </tr>`).join('')}</tbody>
            </table>
          </div>` : '<p class="subtle">No monthly invoices have been generated yet.</p>'}
      </section>
    </section>
  `;
}

function renderUnitPricePage() {
  return `
    <section class="billing-page">
      <div class="page-head">
        <div>
          <h2>Unit Price Settings</h2>
          <p class="subtle">Set the current price for each active laundry item and color. Saved invoices keep their original price snapshot.</p>
        </div>
        <button type="button" class="primary-button" data-action="save-unit-prices">Save Unit Prices</button>
      </div>
      <div class="table-wrap billing-table-wrap">
        <table class="records-table billing-table" aria-label="Unit price settings">
          <thead><tr><th>Item</th><th>Color</th><th>Unit Price</th></tr></thead>
          <tbody>${normalizeMaterialColors(state.materialColors).map((row) => {
            const key = `${row.material}\u0000${row.label}`;
            const current = state.unitPrices.find((price) => price.material === row.material && price.color === row.label)?.unitPrice ?? '';
            const value = Object.hasOwn(state.priceDraft, key) ? state.priceDraft[key] : current;
            return `<tr>
              <td>${escapeHtml(row.material)}</td>
              <td>${escapeHtml(row.label)}</td>
              <td><label class="price-input-label"><span class="visually-hidden">Unit price for ${escapeHtml(row.material)} ${escapeHtml(row.label)}</span><input data-unit-price="${escapeAttr(JSON.stringify([row.material, row.label]))}" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeAttr(value)}" aria-label="${escapeAttr(`${row.material} ${row.label} unit price`)}"></label></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
      <p class="subtle billing-help">Prices are saved for future invoices. Previously generated invoices never change.</p>
    </section>
  `;
}

async function getBrandLogoData() {
  if (!brandLogoDataPromise) {
    brandLogoDataPromise = (async () => {
      const response = await fetch('./brand-logo.png');
      if (!response.ok) throw new Error('The laundry logo could not be loaded for the document.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      return `data:image/png;base64,${btoa(binary)}`;
    })();
  }
  return brandLogoDataPromise;
}

function pdfLibrary() {
  const Constructor = window.jspdf?.jsPDF;
  if (!Constructor) throw new Error('The PDF generator is not ready. Reload the app and try again.');
  return Constructor;
}

async function freshExportRecords() {
  await persistDraft();
  if (navigator.onLine) {
    const result = await api('api/records');
    if (!Array.isArray(result.records)) throw new Error('The server did not return a valid records list.');
    mergeServerState(result);
    saveLocal();
  }
  if (!Array.isArray(state.records)) throw new Error('Laundry records are unavailable.');
  return state.records;
}

async function runPdfExport(label, filename, createDocument, { refreshRecords = false } = {}) {
  if (pdfExportInProgress) {
    state.notice = 'A PDF is already being prepared. Please wait for it to finish.';
    renderStatusOnly();
    return;
  }
  pdfExportInProgress = true;
  document.querySelectorAll('[data-pdf-export]').forEach((button) => { button.disabled = true; });
  state.notice = `Preparing ${label}…`;
  renderStatusOnly();
  try {
    const records = refreshRecords ? await freshExportRecords() : null;
    const logoData = await getBrandLogoData();
    const doc = createDocument({
      jsPDF: pdfLibrary(),
      records,
      logoData,
      companyName: state.companyInfo?.name || 'MK Business Company Ltd.',
      companyInfo: state.companyInfo || {},
    });
    const result = await savePdfFile(doc, filename);
    state.notice = result === 'cancelled'
      ? `${label} sharing was cancelled.`
      : `${label} ${result === 'shared' ? 'is ready to save or share.' : 'download started.'}`;
  } catch (error) {
    state.notice = `${label} could not be generated: ${error.message}`;
  } finally {
    pdfExportInProgress = false;
    document.querySelectorAll('[data-pdf-export]').forEach((button) => { button.disabled = false; });
    renderStatusOnly();
  }
}

function exportMonthlyRevenue() {
  const month = state.selectedMonth;
  const filename = createPdfFilename(null, month);
  return runPdfExport('Monthly Revenue PDF', filename, ({ jsPDF, records, logoData, companyName, companyInfo }) => {
    const revenue = buildMonthlyRevenue({
      records,
      materialColors: state.materialColors,
      unitPrices: state.unitPrices,
      month,
    });
    return createMonthlyRevenuePdf({
      jsPDF, revenue, month, logoData, companyName, companyInfo,
    });
  }, { refreshRecords: true });
}

function exportDailyMonthlyReport() {
  const month = state.selectedMonth;
  const filename = createPdfFilename({ month });
  return runPdfExport('Daily Monthly Report PDF', filename, ({ jsPDF, records, logoData, companyName, companyInfo }) => {
    const report = buildMonthlyDailyReport({
      month,
      records,
      shiftOrder: state.shiftOrder,
    });
    return createDailyMonthlyReportPdf({
      jsPDF, report, logoData, companyName, companyInfo,
    });
  }, { refreshRecords: true });
}

function downloadInvoicePdf() {
  const invoice = state.invoicePreview;
  if (!invoice) {
    state.notice = 'Open an invoice before downloading its PDF.';
    renderStatusOnly();
    return;
  }
  const filename = `Laundry_Invoice_${String(invoice.invoiceNumber).replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  return runPdfExport('Invoice PDF', filename, ({ jsPDF, logoData, companyInfo }) =>
    createInvoicePdf({ jsPDF, invoice, logoData, companyInfo: invoice.companyInfo || companyInfo }));
}

function dailyPrintMarkup(date) {
  const records = state.records
    .filter((record) => String(record.date || '').slice(0, 10) === date)
    .map(normalizeRecord);
  const brandName = state.companyInfo?.name || 'MK Business Company Ltd.';
  if (!records.length) {
    return `<article class="daily-print-page">
      <header class="daily-print-brand"><img src="./brand-logo.png" alt="${escapeAttr(brandName)}"><div><h1>${escapeHtml(brandName)}</h1><h2>Daily Register — ${escapeHtml(formatDate(date))}</h2></div></header>
      <p class="daily-print-empty">No records are available for ${escapeHtml(formatDate(date))}.</p>
    </article>`;
  }
  const rowsByShift = new Map(orderedDailyShifts().map((shift) => [shift.key,
    records.filter((record) => record.shift === shift.key)]));
  const sections = orderedDailyShifts().filter((shift) => rowsByShift.get(shift.key).length).map((shift) => `
    <section class="daily-print-shift">
      <h3>${escapeHtml(shift.label)} Shift</h3>
      <table class="daily-print-table">
        <thead><tr><th>Date / Shift</th><th>Material</th><th>Quantity</th><th>Name &amp; Signature — Laundry Personnel</th><th>Verified By</th><th>Status</th></tr></thead>
        <tbody>${rowsByShift.get(shift.key).map((record) => `
          <tr>
            <td>${escapeHtml(formatDate(date))}<br>${escapeHtml(shift.label)}</td>
            <td>${escapeHtml(record.material)}${record.color ? `<br>${escapeHtml(record.color)}` : ''}</td>
            <td>${escapeHtml(quantityValue(record.quantity) || '—')}</td>
            <td>Name: ${escapeHtml(record.laundryPersonnel || '—')}<br>Signature: ${escapeHtml(record.signature || '—')}</td>
            <td>${escapeHtml(record.verifiedBy || '—')}</td>
            <td>${escapeHtml(STATUS_LABELS[record.status] || record.status || '—')}</td>
          </tr>`).join('')}</tbody>
      </table>
    </section>`).join('');
  return `<article class="daily-print-page">
    <header class="daily-print-brand"><img src="./brand-logo.png" alt="${escapeAttr(brandName)}"><div><h1>${escapeHtml(brandName)}</h1><h2>Daily Register — ${escapeHtml(formatDate(date))}</h2></div></header>
    ${sections}
    <p class="daily-print-total">Overall Daily Total — ${escapeHtml(formatDate(date))}: <strong>${dailyTotal(date)}</strong></p>
  </article>`;
}

async function printDailyRecords(date) {
  if (!isValidFormDate(date)) throw new Error('A valid date is required to print the daily register.');
  await persistDraft();
  if (navigator.onLine) {
    const result = await api('api/records');
    if (!Array.isArray(result.records)) throw new Error('The server did not return a valid records list.');
    mergeServerState(result);
    saveLocal();
  }
  const printRoot = document.getElementById('daily-print-document');
  if (!printRoot) throw new Error('The daily print document could not be rendered.');
  printRoot.innerHTML = dailyPrintMarkup(date);
  document.body.classList.add('printing-daily-register');

  try {
    await document.fonts?.ready;
    await Promise.all(Array.from(printRoot.querySelectorAll('img'), (image) => image.decode()));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const restore = () => {
      document.body.classList.remove('printing-daily-register');
      printRoot.replaceChildren();
    };
    window.addEventListener('afterprint', restore, { once: true });
    window.print();
  } catch (error) {
    document.body.classList.remove('printing-daily-register');
    printRoot.replaceChildren();
    throw error;
  }
}

async function printInvoice() {
  if (!state.invoicePreview) throw new Error('Open an invoice before printing it.');
  await document.fonts?.ready;
  const logo = document.querySelector('.invoice-preview .invoice-brand-title img');
  if (logo) await logo.decode();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
}

function renderInvoiceFormModal() {
  const modal = state.invoiceFormModal;
  if (!modal) return '';
  const billTo = modal.billTo || {};
  const value = (field) => escapeAttr(billTo[field] || '');
  return `
    <div class="modal-overlay invoice-form-overlay" data-invoice-modal-overlay>
      <form class="modal-card invoice-form-card" data-invoice-form role="dialog" aria-modal="true" aria-labelledby="invoice-form-title">
        <h3 id="invoice-form-title">Generate Monthly Invoice</h3>
        <p class="subtle">Invoice period: <strong>${escapeHtml(modal.month)}</strong>. Bill-to information and current prices are saved with this invoice.</p>
        <div class="invoice-form-grid">
          <label class="modal-label">Recipient name <input data-bill-to-name name="recipientName" autocomplete="name" maxlength="200" required value="${value('recipientName')}"></label>
          <label class="modal-label">Company name <input name="companyName" autocomplete="organization" maxlength="200" value="${value('companyName')}"></label>
          <label class="modal-label invoice-form-wide">Street / address <input name="street" autocomplete="street-address" maxlength="200" value="${value('street')}"></label>
          <label class="modal-label">City <input name="city" autocomplete="address-level2" maxlength="200" value="${value('city')}"></label>
          <label class="modal-label">Phone <input name="phone" type="tel" autocomplete="tel" maxlength="200" value="${value('phone')}"></label>
          <label class="modal-label invoice-form-wide">Email <input name="email" type="email" autocomplete="email" maxlength="200" value="${value('email')}"></label>
        </div>
        <p class="billing-help">Invoice pages use the full available page height. The supplied company branding is included in the invoice design.</p>
        <p class="login-error invoice-form-error" data-invoice-error>${escapeHtml(modal.error || '')}</p>
        <div class="modal-actions">
          <button type="button" class="mini-button" data-action="cancel-invoice-form">Cancel</button>
          <button type="submit" class="primary-button">Create Invoice Preview</button>
        </div>
      </form>
    </div>
  `;
}

function invoicePages(invoice) {
  return paginateInvoiceLines(invoice);
}

function renderInvoicePreview() {
  const invoice = state.invoicePreview;
  if (!invoice) return '';
  const pages = invoicePages(invoice);
  const billTo = invoice.billTo || {};
  const billToFields = [
    ['Name', billTo.recipientName],
    ['Company', billTo.companyName],
    ['Street', billTo.street],
    ['City', billTo.city],
    ['Phone', billTo.phone],
    ['Email', billTo.email],
  ].filter(([, value]) => value);
  return `
    <section class="invoice-preview" aria-label="Invoice preview">
      <div class="invoice-preview-toolbar no-print">
        <div>
          <h2>Invoice Preview</h2>
          <p class="subtle">A4 pages • full-height invoice layout • ${pages.length} page${pages.length === 1 ? '' : 's'}</p>
        </div>
        <div class="invoice-preview-actions">
          <button type="button" class="mini-button" data-action="close-invoice-preview">Close Preview</button>
          <button type="button" class="primary-button" data-pdf-export data-action="download-invoice-pdf">Download Invoice PDF</button>
          <button type="button" class="primary-button" data-action="print-invoice">Print / Save as PDF</button>
        </div>
      </div>
      <div class="invoice-document">
        ${pages.map((pageLines, pageIndex) => {
          const first = pageIndex === 0;
          const last = pageIndex === pages.length - 1;
          return `
            <article class="invoice-page ${first ? 'invoice-page-first' : 'invoice-page-continuation'}">
              <div class="invoice-page-content">
                <header class="invoice-page-header">
                  ${first ? `<div class="invoice-brand-title"><img src="./brand-logo.png" alt="MK Business Company Ltd."><div><p class="invoice-eyebrow">MONTHLY LAUNDRY STATEMENT</p><h1>INVOICE</h1></div></div>` : `<strong class="invoice-continuation-title">Monthly Laundry Invoice</strong>`}
                  <div class="invoice-identifiers">
                    <div><span>Invoice Number</span><strong>${escapeHtml(invoice.invoiceNumber)}</strong></div>
                    <div><span>Customer ID</span><strong>${escapeHtml(invoice.invoiceNumber)}</strong></div>
                    <div><span>Date</span><strong>${escapeHtml(formatDate(String(invoice.generatedAt).slice(0, 10)))}</strong></div>
                    <div><span>Billing Period</span><strong>${escapeHtml(invoice.month)}</strong></div>
                  </div>
                </header>
                ${first ? `
                  <section class="invoice-bill-to" aria-label="Bill To information">
                    <h2>Bill To</h2>
                    <div class="invoice-bill-to-details">
                      ${billToFields.map(([label, value]) => `
                        <p><strong>${label}:</strong> <span>${escapeHtml(value)}</span></p>`).join('')}
                    </div>
                  </section>` : ''}
                <table class="invoice-table">
                  <thead><tr><th>Item</th><th>Color</th><th>Quantity</th><th>Unit Price</th><th>Amount</th></tr></thead>
                  <tbody>${pageLines.map((line) => `
                    <tr>
                      <td>${escapeHtml(line.item)}</td>
                      <td>${escapeHtml(line.color)}</td>
                      <td>${line.quantity}</td>
                      <td>${formatCents(line.unitPriceCents)}</td>
                      <td>${formatCents(line.amountCents)}</td>
                    </tr>`).join('')}
                    ${!pageLines.length ? '<tr><td colspan="5" class="invoice-empty">No active laundry items were recorded for this month.</td></tr>' : ''}
                    ${last ? `<tr class="invoice-grand-total"><th colspan="4">Grand Monthly Total</th><td>${formatCents(invoice.grandTotalCents)}</td></tr>` : ''}
                  </tbody>
                </table>
                <footer class="invoice-page-footer">
                  <span>${escapeHtml(invoice.invoiceNumber)} · ${escapeHtml(invoice.month)}</span>
                  <span>Page ${pageIndex + 1} of ${pages.length}</span>
                </footer>
              </div>
            </article>`;
        }).join('')}
      </div>
    </section>
  `;
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

async function persistShiftOrder(order) {
  if (!isCompleteShiftOrder(order) || order.every((key, index) => key === state.shiftOrder[index])) return;
  const firstRects = captureShiftRects();
  state.shiftOrder = [...order];
  enqueueMutation({ type: 'set-shift-order', order: [...order] });
  saveLocal();
  render();
  animateShiftOrderChange(firstRects);
  if (navigator.onLine) await flushMutationQueue();
}

function shiftOrderFromList(list) {
  return Array.from(list.children)
    .map((block) => block.dataset.shiftBlock)
    .filter(Boolean);
}

function captureShiftRects() {
  return new Map(Array.from(document.querySelectorAll('[data-shift-block]'), (block) => [
    block.dataset.shiftBlock,
    block.getBoundingClientRect(),
  ]));
}

function animateShiftOrderChange(firstRects) {
  for (const block of document.querySelectorAll('[data-shift-block]')) {
    const key = block.dataset.shiftBlock;
    const first = firstRects.get(key);
    if (!first) continue;
    const deltaY = first.top - block.getBoundingClientRect().top;
    if (Math.abs(deltaY) < 1) continue;
    block.style.transition = 'none';
    block.style.transform = `translateY(${deltaY}px)`;
    requestAnimationFrame(() => {
      block.style.transition = 'transform 180ms ease';
      block.style.transform = '';
    });
  }
}

function bindShiftDrag(root) {
  const list = root.querySelector('[data-shift-list]');
  if (!list) return;
  root.querySelectorAll('[data-shift-drag]').forEach((handle) => {
    handle.addEventListener('pointerdown', (startEvent) => {
      if (!startEvent.isPrimary || startEvent.button !== 0) return;
      startEvent.preventDefault();
      const movingKey = handle.dataset.shiftDrag;
      const pointerId = startEvent.pointerId;
      const initialOrder = shiftOrderFromList(list);
      let targetKey = null;
      let placeAfter = false;
      let highlightedTarget = null;
      handle.setPointerCapture(pointerId);
      handle.setAttribute('aria-grabbed', 'true');
      handle.closest('[data-shift-block]')?.classList.add('is-dragging');

      const updateDropTarget = (event) => {
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-shift-block]');
        if (!target || !list.contains(target) || target.dataset.shiftBlock === movingKey) {
          highlightedTarget?.classList.remove('shift-drop-before', 'shift-drop-after');
          highlightedTarget = null;
          targetKey = null;
          return;
        }
        const targetRect = target.getBoundingClientRect();
        placeAfter = event.clientY > targetRect.top + targetRect.height / 2;
        highlightedTarget?.classList.remove('shift-drop-before', 'shift-drop-after');
        highlightedTarget = target;
        highlightedTarget.classList.add(placeAfter ? 'shift-drop-after' : 'shift-drop-before');
        targetKey = target.dataset.shiftBlock;
      };
      const finish = (commit) => {
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerCancel);
        highlightedTarget?.classList.remove('shift-drop-before', 'shift-drop-after');
        handle.setAttribute('aria-grabbed', 'false');
        handle.closest('[data-shift-block]')?.classList.remove('is-dragging');
        if (commit && targetKey) persistShiftOrder(placeShift(initialOrder, movingKey, targetKey, placeAfter));
      };
      const onPointerMove = (event) => {
        if (event.pointerId !== pointerId) return;
        if (event.clientY < 48) window.scrollBy(0, -18);
        else if (event.clientY > window.innerHeight - 48) window.scrollBy(0, 18);
        updateDropTarget(event);
      };
      const onPointerUp = (event) => {
        if (event.pointerId === pointerId) {
          updateDropTarget(event);
          finish(true);
        }
      };
      const onPointerCancel = (event) => {
        if (event.pointerId === pointerId) finish(false);
      };
      handle.addEventListener('pointermove', onPointerMove);
      handle.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerCancel);
    });
  });
}

async function saveUnitPrices(root) {
  const unitPrices = Array.from(root.querySelectorAll('[data-unit-price]'))
    .filter((input) => input.value.trim() !== '')
    .map((input) => {
      const [material, color] = JSON.parse(input.dataset.unitPrice);
      return { material, color, unitPrice: input.value.trim() };
    });
  try {
    const result = await api('api/unit-prices', {
      method: 'PUT',
      body: JSON.stringify({ unitPrices }),
    });
    state.unitPrices = result.unitPrices || [];
    state.priceDraft = {};
    state.notice = 'Unit prices saved.';
    saveLocal();
    render();
  } catch (error) {
    state.notice = `Unit prices were not saved: ${error.message}`;
    renderStatusOnly();
  }
}

async function createMonthlyInvoice(form) {
  const data = new FormData(form);
  const billTo = Object.fromEntries(['recipientName', 'companyName', 'street', 'city', 'phone', 'email']
    .map((field) => [field, String(data.get(field) || '').trim()]));
  const draft = {
    month: state.invoiceFormModal.month,
    billTo,
    topSafeMm: 0,
    bottomSafeMm: 0,
    error: '',
  };
  state.invoiceFormModal = draft;
  try {
    const result = await api('api/invoices', {
      method: 'POST',
      body: JSON.stringify(draft),
    });
    state.invoicePreview = result.invoice;
    state.invoices = [result.invoice, ...state.invoices.filter((invoice) =>
      invoice.invoiceNumber !== result.invoice.invoiceNumber)];
    state.invoiceFormModal = null;
    state.notice = '';
    saveLocal();
    render();
  } catch (error) {
    state.invoiceFormModal = { ...draft, error: error.message };
    render();
  }
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
      state.selectedMonth = input.value || todayIso().slice(0, 7);
      saveLocal();
      render();
    });
  });
  root.querySelectorAll('[data-unit-price]').forEach((input) => {
    input.addEventListener('input', () => {
      const [material, color] = JSON.parse(input.dataset.unitPrice);
      state.priceDraft[`${material}\u0000${color}`] = input.value;
      saveLocal();
    });
  });
  root.querySelector('[data-invoice-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.currentTarget.reportValidity()) createMonthlyInvoice(event.currentTarget);
  });
  root.querySelector('[data-invoice-form]')?.addEventListener('input', () => {
    const error = root.querySelector('[data-invoice-error]');
    if (error) error.textContent = '';
  });
  root.querySelectorAll('[data-preview-invoice]').forEach((button) => {
    button.addEventListener('click', () => {
      state.invoicePreview = state.invoices.find((invoice) =>
        invoice.invoiceNumber === button.dataset.previewInvoice) || null;
      render();
    });
  });
  root.querySelectorAll('[data-invoice-modal-overlay]').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        state.invoiceFormModal = null;
        render();
      }
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        state.invoiceFormModal = null;
        render();
      }
    });
  });
  root.querySelectorAll('[data-row-id]').forEach((input) => {
    input.addEventListener('input', () => updateTableCell(input.dataset.rowId, input.dataset.field, input.value));
  });
  root.querySelectorAll('[data-shift-field]').forEach((input) => {
    input.addEventListener('input', () => updateShiftField(input.dataset.shift, input.dataset.shiftField, input.value));
  });
  root.querySelectorAll('[data-add-color]').forEach((button) => {
    button.addEventListener('click', () => addMaterialColor(button.dataset.addColor));
  });
  root.querySelectorAll('[data-color-edit-material]').forEach((button) => {
    button.addEventListener('click', () => renameMaterialColor(button.dataset.colorEditMaterial, button.dataset.colorEditLabel));
  });
  root.querySelectorAll('[data-color-delete-material]').forEach((button) => {
    button.addEventListener('click', () => deleteMaterialColor(button.dataset.colorDeleteMaterial, button.dataset.colorDeleteLabel));
  });
  root.querySelector('[data-color-label]')?.addEventListener('input', (event) => {
    if (state.colorModal) state.colorModal = { ...state.colorModal, label: event.currentTarget.value, error: '' };
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
    button.addEventListener('click', async () => {
      try {
        await printDailyRecords(button.dataset.printDate);
      } catch (error) {
        state.notice = `Daily print could not be prepared: ${error.message}`;
        renderStatusOnly();
      }
    });
  });
  root.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', async () => {
      const action = element.dataset.action;
      if (action === 'save-unit-prices') await saveUnitPrices(root);
      if (action === 'export-monthly-revenue') await exportMonthlyRevenue();
      if (action === 'export-daily-monthly-report') await exportDailyMonthlyReport();
      if (action === 'download-invoice-pdf') await downloadInvoicePdf();
      if (action === 'daily-print') {
        try {
          await printDailyRecords(state.selectedDate);
        } catch (error) {
          state.notice = `Daily print could not be prepared: ${error.message}`;
          renderStatusOnly();
        }
      }
      if (action === 'open-invoice-form') {
        state.invoiceFormModal = { month: state.selectedMonth, billTo: {}, topSafeMm: 0, bottomSafeMm: 0, error: '' };
        render();
      }
      if (action === 'cancel-invoice-form') {
        state.invoiceFormModal = null;
        render();
      }
      if (action === 'close-invoice-preview') {
        state.invoicePreview = null;
        render();
      }
      if (action === 'print-invoice') {
        try {
          await printInvoice();
        } catch (error) {
          state.notice = `Invoice print could not be prepared: ${error.message}`;
          renderStatusOnly();
        }
      }
      if (action === 'color-cancel') {
        state.colorModal = null;
        render();
      }
      if (action === 'color-save') await saveMaterialColor();
      if (action === 'color-delete-confirm') await confirmDeleteMaterialColor();
      if (action === 'shift-move-up' || action === 'shift-move-down') {
        await persistShiftOrder(moveShift(state.shiftOrder, element.dataset.shift, action === 'shift-move-up' ? -1 : 1));
      }
      if (action === 'print') {
        try {
          await printDailyRecords(state.selectedDate);
        } catch (error) {
          state.notice = `Daily print could not be prepared: ${error.message}`;
          renderStatusOnly();
        }
      }
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
  root.querySelectorAll('[data-color-modal-overlay]').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) { state.colorModal = null; render(); }
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { state.colorModal = null; render(); }
      if (event.key === 'Enter' && state.colorModal?.mode !== 'delete') saveMaterialColor();
    });
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
  bindShiftDrag(root);
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

function applyRealtimeShiftOrder(payload) {
  if (readMutationQueue().some((mutation) => mutation.type === 'set-shift-order')) return;
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!row?.shift || !SHIFT_KEYS.includes(row.shift)) return;
  const positions = new Map(state.shiftOrder.map((shift, index) => [shift, index]));
  if (payload.eventType === 'DELETE') {
    positions.set(row.shift, DEFAULT_SHIFT_ORDER.indexOf(row.shift));
  } else {
    const displayOrder = Number(row.display_order);
    if (Number.isInteger(displayOrder) && displayOrder > 0) positions.set(row.shift, displayOrder - 1);
  }
  state.shiftOrder = normalizeShiftOrder(SHIFT_KEYS.slice().sort((left, right) =>
    (positions.get(left) ?? Number.MAX_SAFE_INTEGER) - (positions.get(right) ?? Number.MAX_SAFE_INTEGER)));
  scheduleRealtimeRender();
}

function applyRealtimeMaterialColor(payload) {
  const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
  if (!row?.material) return;
  if (readMutationQueue().some((mutation) => mutation.type.endsWith('-material-color') && mutation.material === row.material)) return;
  if (payload.eventType === 'DELETE') {
    state.materialColors = state.materialColors.filter((item) => item.material !== row.material || item.label !== row.label);
  } else {
    const previousLabel = payload.old?.label;
    state.materialColors = state.materialColors.filter((item) =>
      item.material !== row.material || (item.label !== row.label && item.label !== previousLabel));
    state.materialColors = normalizeMaterialColors([...state.materialColors, {
      material: row.material,
      label: row.label,
      displayOrder: row.display_order,
    }]);
  }
  scheduleRealtimeRender();
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
  let record = normalizeRecord({
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
  for (const mutation of readMutationQueue().filter((item) => item.type === 'rename-material-color')) {
    if (record.material === mutation.material && record.color === mutation.from) record = { ...record, color: mutation.to };
  }
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
        .on('postgres_changes', { event: '*', schema: 'public', table: 'shift_orders' }, applyRealtimeShiftOrder)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'material_colors' }, applyRealtimeMaterialColor)
        .subscribe((status) => {
          state.realtimeConnected = status === 'SUBSCRIBED';
          if (state.realtimeConnected) clearTimeout(materialColorPollTimer);
          else scheduleMaterialColorPolling();
          renderStatusOnly();
          if (status === 'SUBSCRIBED') hydrateFromServer();
        });
    } catch {
      state.realtimeConnected = false;
      scheduleMaterialColorPolling();
    }
  })();
  try {
    await realtimeStartPromise;
  } finally {
    realtimeStartPromise = null;
  }
}

function scheduleMaterialColorPolling() {
  clearTimeout(materialColorPollTimer);
  if (!navigator.onLine || state.realtimeConnected) return;
  materialColorPollTimer = setTimeout(async () => {
    try {
      const result = await api('api/material-colors');
      const pending = readMutationQueue().filter((mutation) => mutation.type.endsWith('-material-color'));
      const latest = pending.reduce((rows, mutation) => applyMaterialColorMutation(rows, mutation),
        normalizeMaterialColors(result.materialColors));
      if (JSON.stringify(latest) !== JSON.stringify(state.materialColors)) {
        const db = await api('api/records');
        mergeServerState(db);
        saveLocal();
        if (!document.hidden) render();
      }
    } catch {
      state.apiConnected = false;
    }
    scheduleMaterialColorPolling();
  }, 5000);
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
  scheduleMaterialColorPolling();
  hydrateFromServer();
});

window.addEventListener('offline', () => {
  state.online = false;
  state.apiConnected = false;
  clearTimeout(materialColorPollTimer);
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
scheduleMaterialColorPolling();
hydrateFromServer();
