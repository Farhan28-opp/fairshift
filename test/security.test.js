'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, PHONES } = require('./helpers');

test('every API is closed to signed-out users and to the wrong role', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const anon = app.client();
  assert.equal((await anon.get('/api/worker/home')).status, 401);
  assert.equal((await anon.get('/api/admin/overview')).status, 401);
  assert.equal((await anon.post('/api/worker/reports', {})).status, 401);
  assert.deepEqual((await anon.get('/api/auth/me')).data, { user: null });

  const worker = await app.as('murugan');
  assert.equal((await worker.get('/api/admin/overview')).status, 403);
  assert.equal((await worker.get('/api/admin/cases')).status, 403);
  assert.equal((await worker.put('/api/admin/settings/case-rules', {})).status, 403);

  const admin = await app.as('vikram');
  assert.equal((await admin.get('/api/worker/home')).status, 403);
});

test('administrators only see their own workplace; workers only see their own cases', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const siteCases = await app.repo.casesForOrg('org_construction');
  const kannansCase = siteCases.find((c) => c.reporterId === 'org_construction_w4');

  const revathi = await app.as('revathi'); // college admin
  assert.equal((await revathi.get(`/api/admin/cases/${kannansCase.id}`)).status, 404);
  assert.equal((await revathi.post(`/api/admin/cases/${kannansCase.id}/actions`, { action: 'acknowledge' })).status, 404);
  assert.ok(!(await revathi.get('/api/admin/cases')).data.cases.some((c) => c.id === kannansCase.id));

  const murugan = await app.as('murugan');
  assert.equal((await murugan.get(`/api/worker/cases/${kannansCase.ref}`)).status, 404);
  assert.equal((await murugan.post(`/api/worker/cases/${kannansCase.ref}/verify`, { accepted: true })).status, 404);
  assert.equal((await murugan.post(`/api/worker/cases/${kannansCase.ref}/messages`, { text: 'hi' })).status, 404);
});

test('cross-site and non-JSON writes are rejected', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const murugan = await app.as('murugan');
  const evil = await murugan.post('/api/worker/reports', { category: 'fall', description: 'forged', anonymous: true }, { origin: 'https://evil.example' });
  assert.deepEqual([evil.status, evil.data.error], [403, 'bad_origin']);

  const res = await fetch(`${app.base}/api/worker/reports`, { method: 'POST', headers: { 'content-type': 'text/plain', cookie: murugan.cookie }, body: 'category=fall' });
  assert.equal(res.status, 415);
});

test('session cookies are HttpOnly and SameSite=Strict; responses carry security headers', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const c = app.client();
  const otp = await c.post('/api/auth/request-otp', { phone: PHONES.murugan });
  const res = await fetch(`${app.base}/api/auth/verify-otp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: PHONES.murugan, otp: otp.data.demoOtp }) });
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const page = await fetch(`${app.base}/`);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.equal((await fetch(`${app.base}/api/worker/home`)).headers.get('cache-control'), 'no-store');
});

test('one-time codes: wrong, expired and brute-forced codes are refused', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const c = app.client();
  const { demoOtp } = (await c.post('/api/auth/request-otp', { phone: PHONES.lakshmi })).data;
  const wrong = demoOtp === '000000' ? '111111' : '000000';
  assert.equal((await c.post('/api/auth/verify-otp', { phone: PHONES.lakshmi, otp: wrong })).data.error, 'otp_incorrect');
  for (let i = 0; i < 4; i += 1) await c.post('/api/auth/verify-otp', { phone: PHONES.lakshmi, otp: wrong });
  // Sixth attempt is refused even with the right code.
  assert.equal((await c.post('/api/auth/verify-otp', { phone: PHONES.lakshmi, otp: demoOtp })).data.error, 'too_many_attempts');

  const again = (await c.post('/api/auth/request-otp', { phone: PHONES.lakshmi })).data.demoOtp;
  app.advance(0.1); // 6 minutes later
  assert.equal((await c.post('/api/auth/verify-otp', { phone: PHONES.lakshmi, otp: again })).data.error, 'otp_expired');

  // Unknown numbers get the same answer as known ones (no demo code, no enumeration).
  const unknown = await c.post('/api/auth/request-otp', { phone: '9876543210' });
  assert.deepEqual([unknown.status, unknown.data], [200, { ok: true }]);
  assert.equal((await c.post('/api/auth/request-otp', { phone: '12345' })).data.details.field, 'phone');
});

test('codes and session ids are stored only as hashes', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const c = app.client();
  const { demoOtp } = (await c.post('/api/auth/request-otp', { phone: PHONES.meena })).data;
  const raw = JSON.stringify([...app.store.col('otps').values()]);
  assert.ok(!raw.includes(demoOtp));
  await c.post('/api/auth/verify-otp', { phone: PHONES.meena, otp: demoOtp });
  const sid = c.cookie.split('=')[1];
  assert.ok(!JSON.stringify([...app.store.col('sessions').values()]).includes(sid));
});

test('input validation names the field that is wrong', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const murugan = await app.as('murugan');
  const field = async (path, body) => (await murugan.post(path, body)).data.details?.field;
  assert.equal(await field('/api/worker/reports', { category: 'fall', description: 'x', anonymous: true }), 'description');
  assert.equal(await field('/api/worker/reports', { category: 'fall', description: 'long enough', anonymous: 'yes' }), 'anonymous');
  assert.equal(await field('/api/worker/disputes', { month: '2020-01', lineCode: 'basic', reason: 'other', message: 'hello' }), 'month');
  assert.equal(await field('/api/worker/disputes', { month: '2026-10', lineCode: 'bonus', reason: 'other', message: 'hello' }), 'lineCode');
  assert.equal(await field('/api/worker/disputes', { month: '2026-10', lineCode: 'basic', reason: 'other', days: ['2026-09-30'], message: 'hello' }), 'days');
  assert.equal((await murugan.post('/api/worker/reports', { description: 'a'.repeat(20_000) })).status, 413);
});

test('demo-only endpoints do not exist outside demo mode', async (t) => {
  const app = await startApp({ demoMode: false });
  t.after(app.close);
  const c = app.client();
  assert.equal((await c.get('/api/public/demo')).status, 404);
  const otp = await c.post('/api/auth/request-otp', { phone: PHONES.vikram });
  assert.equal(otp.data.demoOtp, undefined, 'codes are never returned to the browser outside demo mode');
});
