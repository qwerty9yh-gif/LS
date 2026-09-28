// Temporary local-dev smoke test (JSON fallback mode, no DATABASE_URL).
const base = 'http://127.0.0.1:4199';
const j = async (method, url, body) => {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};

const created = await j('PUT', '/api/records', {
  records: [{
    id: 'smoke-1', date: '2026-09-28', shift: 'morning', material: 'Towels', color: 'White',
    rowKey: 'r1', quantity: 5, laundryPersonnel: 'Ana', verifiedBy: 'Bo', status: 'received',
  }],
});
console.log('PUT /api/records ->', created.status, 'records:', created.data?.records?.length,
  'syncStatus:', created.data?.records?.[0]?.syncStatus);

const list = await j('GET', '/api/records');
console.log('GET /api/records ->', list.status,
  'recs:', list.data.records.length,
  'locks:', list.data.locks.length,
  'events:', list.data.syncEvents.length,
  'forms:', list.data.dailyForms.length);
const smoke = list.data.records.find((r) => r.id === 'smoke-1');
console.log('stored record ->', JSON.stringify(smoke));

const form1 = await j('POST', '/api/daily-forms', { date: '2026-09-28' });
const form2 = await j('POST', '/api/daily-forms', { date: '2026-09-28' });
console.log('POST /api/daily-forms ->', form1.status, form1.data, '| repeat ->', form2.status, form2.data?.exists);

const forms = await j('GET', '/api/daily-forms');
console.log('GET /api/daily-forms ->', forms.status, 'forms:', forms.data.forms.length);

const lock = await j('POST', '/api/locks', { date: '2026-09-28', shift: 'morning' });
console.log('POST /api/locks ->', lock.status, 'locks:', lock.data?.locks?.length);

const bad = await j('PUT', '/api/records', { records: [{ id: 'bad', date: 'not-a-date', shift: 'morning' }] });
console.log('PUT invalid ->', bad.status, bad.data?.error);

const del = await j('DELETE', '/api/records/smoke-1');
console.log('DELETE /api/records/smoke-1 ->', del.status, del.data);

const after = await j('GET', '/api/records');
console.log('GET after delete ->', after.status, 'recs:', after.data.records.length,
  'still present:', after.data.records.some((r) => r.id === 'smoke-1'));

const login = await j('POST', '/api/auth/login', { email: 'a@b.co', password: 'x' });
console.log('POST /api/auth/login (no DB) ->', login.status, login.data);

const spa = await fetch(base + '/some/deep/route');
console.log('SPA fallback ->', spa.status, (spa.headers.get('content-type') || '').slice(0, 20));
