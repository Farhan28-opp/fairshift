'use strict';

/**
 * End-to-end acceptance tests for the Fairness Loop, run against the real
 * HTTP API (in-memory store, seeded demo data, controlled clock).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, T0, PHONES } = require('./helpers');
const { computePayslip } = require('../src/domain/payroll');

test('a worker records a shift and can retrieve it', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const murugan = await app.as('murugan');

  let home = (await murugan.get('/api/worker/home')).data;
  if (home.shift) assert.equal((await murugan.post('/api/worker/checkout')).status, 200);

  app.advance(1); // 13:00 IST
  home = (await murugan.get('/api/worker/home')).data;
  assert.equal(home.shift, null);
  assert.equal((await murugan.post('/api/worker/checkin', { method: 'code', code: '000000' })).data.error, 'wrong_code');

  const checkIn = await murugan.post('/api/worker/checkin', { method: 'code', code: home.demo.siteCode });
  assert.equal(checkIn.status, 201);
  assert.equal((await murugan.post('/api/worker/checkin', { method: 'code', code: home.demo.siteCode })).data.error, 'already_checked_in');

  app.advance(3); // 16:00 IST
  const checkOut = await murugan.post('/api/worker/checkout');
  assert.equal(checkOut.status, 200);
  assert.equal(checkOut.data.shift.hours, 3);

  const { shifts } = (await murugan.get('/api/worker/shifts')).data;
  const mine = shifts.find((s) => s.id === checkIn.data.shift.id);
  assert.deepEqual([mine.checkIn, mine.checkOut, mine.hours, mine.status], [T0 + 3_600_000, T0 + 4 * 3_600_000, 3, 'done']);

  // It is in the database, not just in the response.
  const stored = await app.repo.getShift(checkIn.data.shift.id);
  assert.equal(stored.checkOut, T0 + 4 * 3_600_000);
});

test('the worker sees an actual calculated pay breakdown', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const murugan = await app.as('murugan');
  const { payslip, months } = (await murugan.get('/api/worker/payslip')).data;
  assert.equal(payslip.month, '2026-10');
  assert.equal(months.length, 3);

  const user = await app.repo.getUserByPhone(PHONES.murugan);
  const org = await app.repo.getOrg(user.orgId);
  const expected = computePayslip({
    worker: user,
    shifts: await app.repo.shiftsForUser(user.id),
    rules: org.rules,
    month: '2026-10',
    tzOffsetMinutes: org.tz,
    minimumDailyWage: org.minimumDailyWage,
  });
  assert.deepEqual(payslip.lines, expected.lines);
  assert.ok(payslip.lines.find((l) => l.code === 'basic').amount > 0);
  assert.equal(payslip.hourlyRate, Math.round(user.wage.amount / 8));
  assert.equal(payslip.net, payslip.gross - payslip.totalDeductions);
  assert.ok(payslip.records.length >= payslip.daysPresent);
});

test('pay dispute: the worker disputes, the admin investigates with evidence, corrects and resolves, the worker verifies', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const kannan = await app.as('kannan');
  const vikram = await app.as('vikram');

  const home = (await kannan.get('/api/worker/home')).data;
  const [missing] = home.missingCheckouts;
  assert.ok(missing, 'Kannan has a shift with no check-out');
  const before = (await kannan.get('/api/worker/payslip')).data.payslip;
  const basicBefore = before.lines.find((l) => l.code === 'basic');

  const created = await kannan.post('/api/worker/disputes', {
    month: '2026-10',
    lineCode: 'basic',
    reason: 'hours_missing',
    days: [missing.day],
    expectedRupees: 1100,
    message: 'I worked 8 am to 5 pm. The day is not counted.',
  });
  assert.equal(created.status, 201);
  const { ref } = created.data.case;
  assert.match(ref, /^FS-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(created.data.case.status, 'open');

  // The admin finds it in the queue with the evidence attached.
  const queue = (await vikram.get('/api/admin/cases?type=pay&status=active')).data.cases;
  const row = queue.find((c) => c.ref === ref);
  assert.equal(row.reporter.name, 'Kannan Velu');
  let detail = (await vikram.get(`/api/admin/cases/${row.id}`)).data;
  assert.equal(detail.evidence.snapshot.line.code, 'basic');
  const record = detail.evidence.current.records.find((r) => r.day === missing.day);
  assert.equal(record.missingCheckout, true);
  assert.equal(record.disputed, true);

  // Investigate: acknowledge and assign, fix the record, add a correction, resolve.
  const handlers = (await vikram.get('/api/admin/overview')).data.handlers;
  const payroll = handlers.find((h) => h.title === 'payroll_accountant');
  detail = (await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'acknowledge', assigneeId: payroll.id })).data;
  assert.equal(detail.case.status, 'in_review');
  assert.equal(detail.case.assignee.id, payroll.id);

  const fixed = await vikram.post(`/api/admin/cases/${row.id}/shifts`, {
    shiftId: missing.id,
    checkIn: `${missing.day}T08:05`,
    checkOut: `${missing.day}T17:05`,
    reason: 'Gate register shows exit at 5:05 pm',
  });
  assert.equal(fixed.status, 201);
  assert.equal(fixed.data.evidence.current.records.find((r) => r.day === missing.day).hours, 9);
  const shift = await app.repo.getShift(missing.id);
  assert.equal(shift.corrections.length, 1);
  assert.equal(shift.corrections[0].before.checkOut, null);

  const adj = await vikram.post(`/api/admin/cases/${row.id}/adjustments`, { rupees: 100, reason: 'Paid late' });
  assert.equal(adj.status, 201);
  detail = (await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'resolve', outcome: 'upheld', note: 'Check-out added from the gate register.' })).data;
  assert.equal(detail.case.status, 'resolved');

  // The worker sees the corrected payslip and the outcome, and verifies it.
  const after = (await kannan.get('/api/worker/payslip')).data.payslip;
  assert.equal(after.lines.find((l) => l.code === 'basic').hours, basicBefore.hours + 8);
  assert.equal(after.lines.find((l) => l.code === 'adjustment').caseRef, ref);
  assert.equal((await kannan.get('/api/worker/home')).data.missingCheckouts.length, 0);

  const mine = (await kannan.get(`/api/worker/cases/${ref}`)).data.case;
  assert.equal(mine.canVerify, true);
  assert.equal(mine.resolution.outcome, 'upheld');
  const verified = await kannan.post(`/api/worker/cases/${ref}/verify`, { accepted: true });
  assert.equal(verified.data.case.status, 'closed');

  const stored = await app.repo.findCaseByRef(ref);
  assert.deepEqual(
    stored.history.map((h) => h.action),
    ['submitted', 'acknowledged', 'assigned', 'shift_corrected', 'adjustment', 'resolved', 'confirmed'],
  );
});

test('anonymous report: secure access code, later retrieval, updates, and no identity for the admin', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const lakshmi = await app.as('lakshmi');
  const vikram = await app.as('vikram');
  const me = await app.repo.getUserByPhone(PHONES.lakshmi);

  const sent = await lakshmi.post('/api/worker/reports', { category: 'fall', description: 'Railing missing on the 6th floor slab edge', anonymous: true, lang: 'en' });
  assert.equal(sent.status, 201);
  const { ref } = sent.data.case;
  const code = sent.data.accessCode;
  assert.match(code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  // Nothing in the stored record points back to the reporter.
  const stored = await app.repo.findCaseByRef(ref);
  const raw = JSON.stringify(stored);
  assert.equal(stored.reporterId, null);
  for (const secret of [me.id, me.name, me.phone, code, code.replace(/-/g, '')]) assert.ok(!raw.includes(secret), `stored case leaks ${secret}`);
  assert.equal(stored.createdAt % 3_600_000, 0, 'time is rounded to the hour');

  // It is not in the worker's named cases, and cannot be opened through the account.
  assert.ok(!(await lakshmi.get('/api/worker/cases')).data.cases.some((c) => c.ref === ref));
  assert.equal((await lakshmi.get(`/api/worker/cases/${ref}`)).status, 404);

  // Later, from any device, with no sign-in.
  const stranger = app.client();
  let view = await stranger.post('/api/public/cases/lookup', { ref, code });
  assert.equal(view.status, 200);
  assert.equal(view.data.case.status, 'open');
  assert.equal((await stranger.post('/api/public/cases/lookup', { ref, code: 'AAAA-AAAA-AAAA' })).data.error, 'case_not_found');
  assert.equal((await stranger.post('/api/public/cases/lookup', { ref: 'FS-0000-0000', code })).data.error, 'case_not_found');

  // The admin sees the report but no reporter.
  const row = (await vikram.get('/api/admin/cases?type=safety')).data.cases.find((c) => c.ref === ref);
  let detail = (await vikram.get(`/api/admin/cases/${row.id}`)).data;
  assert.equal(detail.case.reporter, null);
  assert.equal(detail.case.anonymous, true);
  assert.ok(!JSON.stringify(detail).includes(me.name));
  assert.ok(!('access' in detail.case));

  const priya = (await vikram.get('/api/admin/overview')).data.handlers.find((h) => h.title === 'safety_officer');
  await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'acknowledge', assigneeId: priya.id });
  await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'message', text: 'Barricade going up today. Which side of the slab?' });

  view = (await stranger.post('/api/public/cases/lookup', { ref, code })).data.case;
  assert.equal(view.status, 'in_review');
  assert.equal(view.assignee.name, 'Priya Natarajan');
  assert.equal(view.messages[0].text, 'Barricade going up today. Which side of the slab?');

  await stranger.post('/api/public/cases/messages', { ref, code, text: 'North side, near the lift.' });
  detail = (await vikram.get(`/api/admin/cases/${row.id}`)).data;
  assert.deepEqual(detail.case.messages.at(-1).actor, { type: 'reporter' });

  // Resolve, the reporter rejects it, resolve again, the reporter confirms.
  await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'resolve', outcome: 'fixed', note: 'Barricade installed.' });
  view = (await stranger.post('/api/public/cases/verify', { ref, code, accepted: false, note: 'Only half the edge is covered.' })).data.case;
  assert.equal(view.status, 'in_review');
  assert.equal(view.reopenCount, 1);
  await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'resolve', outcome: 'fixed', note: 'Whole edge now barricaded.' });
  view = (await stranger.post('/api/public/cases/verify', { ref, code, accepted: true })).data.case;
  assert.equal(view.status, 'closed');
  assert.equal((await stranger.post('/api/public/cases/messages', { ref, code, text: 'thanks' })).data.error, 'case_closed');
});

test('the admin assigns and resolves a safety case, with an auditable history', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const vikram = await app.as('vikram');
  const murugan = await app.as('murugan');

  const sent = await murugan.post('/api/worker/reports', { category: 'ppe', description: 'Helmets are cracked and too few for the new team', anonymous: false, lang: 'en' });
  const { ref } = sent.data.case;
  const row = (await vikram.get('/api/admin/cases')).data.cases.find((c) => c.ref === ref);
  assert.equal(row.reporter.name, 'Murugan Selvam');

  const { handlers } = (await vikram.get('/api/admin/overview')).data;
  const priya = handlers.find((h) => h.title === 'safety_officer');
  await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'acknowledge' });
  await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'assign', assigneeId: priya.id });
  assert.equal((await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'assign', assigneeId: priya.id })).data.error, 'no_change');
  assert.equal((await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'assign', assigneeId: 'org_construction_w1' })).status, 400, 'only admins can be responsible');
  const resolved = (await vikram.post(`/api/admin/cases/${row.id}/actions`, { action: 'resolve', outcome: 'action_taken', note: '20 new helmets issued.' })).data;

  const audit = resolved.case.history.map((h) => [h.action, h.actor.type, h.actor.name || null]);
  assert.deepEqual(audit, [
    ['submitted', 'worker', 'Murugan Selvam'],
    ['acknowledged', 'admin', 'Vikram Rao'],
    ['assigned', 'admin', 'Vikram Rao'],
    ['assigned', 'admin', 'Vikram Rao'],
    ['resolved', 'admin', 'Vikram Rao'],
  ]);
  assert.equal(resolved.case.history[3].to.name, 'Priya Natarajan');
  for (let i = 1; i < resolved.case.history.length; i += 1) assert.ok(resolved.case.history[i].at >= resolved.case.history[i - 1].at, 'history is in time order');

  const workerView = (await murugan.get(`/api/worker/cases/${ref}`)).data.case;
  assert.equal(workerView.status, 'resolved');
  assert.equal(workerView.resolution.note, '20 new helmets issued.');
});

test('dashboard counts and alerts update from persisted records', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const vikram = await app.as('vikram');
  const murugan = await app.as('murugan');
  const kpis = async () => (await vikram.get('/api/admin/overview')).data.radar.kpis;

  const start = await kpis();
  const sent = await murugan.post('/api/worker/reports', { category: 'electrical', description: 'Someone got a shock from the mixer cable', anonymous: false, lang: 'en' });
  assert.equal(sent.data.case.severity, 'critical');
  let now = await kpis();
  assert.equal(now.openSafetyReports, start.openSafetyReports + 1);

  const overview = (await vikram.get('/api/admin/overview')).data;
  const critical = overview.radar.flags.find((f) => f.code === 'CRITICAL_OPEN' && f.caseRef === sent.data.case.ref);
  assert.ok(critical, 'critical report raises a flag');

  // Let the 1-hour acknowledge deadline for critical cases pass: it becomes overdue and is escalated (persisted).
  app.advance(2);
  const vikram2 = await app.as('vikram');
  const later = (await vikram2.get('/api/admin/overview')).data;
  const overdue = later.radar.flags.find((f) => f.code === 'CASE_OVERDUE' && f.caseRef === sent.data.case.ref);
  assert.deepEqual([overdue.stage, overdue.limit, overdue.escalatedTo], ['ack', 1, 'project_director']);
  assert.equal(later.radar.kpis.overdueCases, start.overdueCases + 1);
  const stored = await app.repo.findCaseByRef(sent.data.case.ref);
  assert.equal(stored.history.filter((h) => h.action === 'escalated').length, 1);

  await vikram2.post(`/api/admin/cases/${stored.id}/actions`, { action: 'resolve', outcome: 'fixed', note: 'Cable replaced.' });
  now = (await vikram2.get('/api/admin/overview')).data.radar.kpis;
  assert.equal(now.openSafetyReports, start.openSafetyReports);
  assert.equal(now.awaitingConfirmation, start.awaitingConfirmation + 1);
});

test('every Fairness Radar flag names its rule, value and limit; there are no predictions about people', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const vikram = await app.as('vikram');
  const { radar } = (await vikram.get('/api/admin/overview')).data;
  const codes = new Set(radar.flags.map((f) => f.code));
  for (const code of ['MISSING_CHECKOUT', 'BELOW_MIN_WAGE', 'WEEKLY_HOURS', 'SHORT_REST', 'CASE_OVERDUE', 'PAY_DISPUTE_OPEN']) assert.ok(codes.has(code), `seed shows ${code}`);
  for (const f of radar.flags) {
    assert.ok(['hours', 'attendance', 'pay', 'case'].includes(f.kind));
    assert.ok(['critical', 'warning', 'info'].includes(f.severity));
    if (['hours', 'attendance'].includes(f.kind) || f.code === 'BELOW_MIN_WAGE' || f.code === 'CASE_OVERDUE') {
      assert.equal(typeof f.value, 'number', `${f.code} has a measured value`);
      assert.equal(typeof f.limit, 'number', `${f.code} has a configured limit`);
    }
  }
  const text = JSON.stringify(radar).toLowerCase();
  for (const word of ['risk', 'attrition', 'quit', 'score', 'predict']) assert.ok(!text.includes(word), `no "${word}" in the radar`);
});

test('construction and college modes have different configuration and records', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const vikram = await app.as('vikram');
  const revathi = await app.as('revathi');
  const site = (await vikram.get('/api/admin/overview')).data;
  const college = (await revathi.get('/api/admin/overview')).data;

  assert.equal(site.org.industry, 'construction');
  assert.equal(college.org.industry, 'education');
  assert.deepEqual([site.org.wageType, college.org.wageType], ['daily', 'monthly']);
  assert.notEqual(site.org.rules.maxShiftHours, college.org.rules.maxShiftHours);
  assert.notDeepEqual(site.org.caseRules, college.org.caseRules);
  assert.ok(site.org.categories.some((c) => c.id === 'fall'));
  assert.ok(college.org.categories.some((c) => c.id === 'lighting'));
  assert.ok(site.radar.workers.every((w) => w.wage.type === 'daily'));
  assert.ok(college.radar.workers.every((w) => w.wage.type === 'monthly'));
  assert.ok(college.radar.workers.some((w) => w.jobRole === 'security_guard'));
  const names = (o) => o.radar.workers.map((w) => w.name);
  assert.equal(names(site).filter((n) => names(college).includes(n)).length, 0, 'different people');
  assert.ok(!('checkinSecret' in site.org), 'secrets never leave the server');

  // A college worker cannot file a construction-only category.
  const meena = await app.as('meena');
  assert.equal((await meena.post('/api/worker/reports', { category: 'fall', description: 'Testing the wrong category', anonymous: false })).data.details.field, 'category');

  // The demo industry switch really changes the workplace behind the dashboard.
  assert.equal((await vikram.post('/api/admin/demo/switch', { orgId: 'org_college' })).status, 200);
  const switched = (await vikram.get('/api/admin/overview')).data;
  assert.equal(switched.org.industry, 'education');
  assert.deepEqual(switched.radar.kpis, college.radar.kpis);
});

test('response deadlines are configurable, validated and audited', async (t) => {
  const app = await startApp();
  t.after(app.close);
  const vikram = await app.as('vikram');
  const { org } = (await vikram.get('/api/admin/settings')).data;
  const next = structuredClone(org.caseRules);
  next.deadlines.high = { ack: 2, resolve: 24 };
  next.escalateTo = 'owner';

  const bad = await vikram.put('/api/admin/settings/case-rules', { ...next, deadlines: { ...next.deadlines, low: { ack: 10, resolve: 5 } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.details.field, 'deadlines.low.resolve');

  assert.equal((await vikram.put('/api/admin/settings/case-rules', next)).status, 200);
  const settings = (await vikram.get('/api/admin/settings')).data;
  assert.deepEqual(settings.org.caseRules, next);
  assert.equal(settings.audit[0].action, 'case_rules_updated');
  assert.equal(settings.audit[0].actor, 'Vikram Rao');

  // New cases use the new deadline.
  const murugan = await app.as('murugan');
  const sent = (await murugan.post('/api/worker/reports', { category: 'fall', description: 'Open shaft on level 3 with no cover', anonymous: false })).data.case;
  assert.equal(sent.dueAt - sent.createdAt, 2 * 3_600_000);
});
