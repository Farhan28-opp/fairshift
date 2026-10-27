'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  newCase,
  applyAction,
  escalate,
  isOverdue,
  newCaseRef,
  newAccessCode,
  normalizeRef,
  normalizeAccessCode,
  hashAccessCode,
  verifyAccessCode,
  adminView,
  reporterView,
  CaseError,
} = require('../src/domain/cases');
const { INDUSTRIES } = require('../src/config/industries');

const HOUR = 3_600_000;
const T = Date.parse('2026-10-14T06:37:12Z');
const org = { id: 'org1', caseRules: INDUSTRIES.construction.caseRules };
const admin = { type: 'admin', id: 'a1' };
const worker = { type: 'worker', id: 'w1' };
const people = new Map([
  ['a1', { id: 'a1', name: 'Vikram', title: 'site_manager' }],
  ['a2', { id: 'a2', name: 'Priya', title: 'safety_officer' }],
  ['w1', { id: 'w1', name: 'Murugan', jobRole: 'mason' }],
]);

const named = (over = {}) =>
  newCase({ id: 'c1', ref: 'FS-AAAA-BBBB', org, type: 'safety', category: 'heat', severity: 'medium', description: 'No shade', lang: 'en', inputMode: 'text', reporterId: 'w1', now: T, ...over });
const act = (record, action, ctx) => applyAction(record, action, { caseRules: org.caseRules, now: T + HOUR, ...ctx });

test('a new case starts open with the configured acknowledge deadline', () => {
  const c = named();
  assert.equal(c.status, 'open');
  assert.equal(c.dueAt, T + INDUSTRIES.construction.caseRules.deadlines.medium.ack * HOUR);
  assert.deepEqual(c.history.map((h) => h.action), ['submitted']);
});

test('pay disputes use the pay deadline row, not severity', () => {
  const c = named({ type: 'pay', category: 'basic' });
  assert.equal(c.dueAt, T + INDUSTRIES.construction.caseRules.pay.ack * HOUR);
});

test('full lifecycle: acknowledge, assign, message, resolve, confirm; every step is audited', () => {
  let c = named();
  c = act(c, 'acknowledge', { actor: admin });
  assert.equal(c.status, 'in_review');
  assert.equal(c.assigneeId, 'a1', 'someone is always responsible');
  assert.equal(c.dueAt, T + INDUSTRIES.construction.caseRules.deadlines.medium.resolve * HOUR);
  c = act(c, 'assign', { actor: admin, assigneeId: 'a2' });
  c = act(c, 'message', { actor: admin, text: 'Shade net ordered' });
  c = act(c, 'message', { actor: worker, text: 'Thank you' });
  c = act(c, 'resolve', { actor: { type: 'admin', id: 'a2' }, outcome: 'fixed', note: 'Shade net installed' });
  assert.equal(c.status, 'resolved');
  assert.equal(c.dueAt, null);
  c = act(c, 'confirm', { actor: worker });
  assert.equal(c.status, 'closed');
  assert.deepEqual(
    c.history.map((h) => h.action),
    ['submitted', 'acknowledged', 'assigned', 'assigned', 'message', 'message', 'resolved', 'confirmed'],
  );
  assert.equal(c.messages.length, 2);
});

test('the worker can reject a fix: the case reopens with a fresh deadline', () => {
  let c = act(named(), 'resolve', { actor: admin, outcome: 'fixed', note: 'Done' });
  const later = T + 5 * HOUR;
  c = applyAction(c, 'reopen', { actor: worker, now: later, caseRules: org.caseRules, note: 'Still no shade' });
  assert.equal(c.status, 'in_review');
  assert.equal(c.reopenCount, 1);
  assert.equal(c.resolution, null);
  assert.equal(c.dueAt, later + INDUSTRIES.construction.caseRules.deadlines.medium.resolve * HOUR);
  assert.equal(c.verification.accepted, false);
});

test('rules: invalid transitions and wrong roles are refused', () => {
  const c = named();
  const code = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof CaseError);
      return err.code;
    }
    return 'no error';
  };
  assert.equal(code(() => act(c, 'confirm', { actor: worker })), 'invalid_transition', 'cannot confirm before it is resolved');
  assert.equal(code(() => act(c, 'resolve', { actor: worker, outcome: 'fixed', note: 'x' })), 'action_not_allowed', 'workers cannot resolve');
  assert.equal(code(() => act(c, 'confirm', { actor: admin })), 'action_not_allowed', 'admins cannot confirm on the worker’s behalf');
  assert.equal(code(() => act(c, 'resolve', { actor: admin, outcome: 'upheld', note: 'x' })), 'invalid_outcome', 'pay outcomes do not fit safety cases');
  assert.equal(code(() => act(c, 'resolve', { actor: admin, outcome: 'fixed' })), 'note_required');
  const resolved = act(c, 'resolve', { actor: admin, outcome: 'fixed', note: 'Done' });
  assert.equal(code(() => act(resolved, 'reopen', { actor: worker })), 'note_required', 'a reopen needs a reason');
  const closed = act(resolved, 'confirm', { actor: worker });
  assert.equal(code(() => act(closed, 'message', { actor: admin, text: 'hi' })), 'case_closed');
  assert.equal(code(() => act(act(c, 'acknowledge', { actor: admin }), 'acknowledge', { actor: admin })), 'invalid_transition');
});

test('applyAction never mutates the stored record', () => {
  const c = named();
  const before = JSON.stringify(c);
  act(c, 'acknowledge', { actor: admin });
  assert.equal(JSON.stringify(c), before);
});

test('escalation is recorded once, dated at the deadline, and cleared by the next stage', () => {
  const c = named();
  const late = c.dueAt + 3 * HOUR;
  assert.equal(isOverdue(c, late), true);
  const escalated = escalate(c, late, org.caseRules);
  assert.equal(escalated.escalatedTo, 'project_director');
  const entry = escalated.history.at(-1);
  assert.deepEqual([entry.action, entry.at, entry.recordedAt, entry.stage], ['escalated', c.dueAt, late, 'ack']);
  assert.equal(escalate(escalated, late + HOUR, org.caseRules), null, 'not escalated twice');
  const acknowledged = applyAction(escalated, 'acknowledge', { actor: admin, now: late, caseRules: org.caseRules });
  assert.equal(acknowledged.escalatedAt, null);
});

test('anonymous cases store no reporter and round their times to the hour', async () => {
  const code = newAccessCode();
  const access = { salt: 'ab'.repeat(16), hash: await hashAccessCode(code, 'ab'.repeat(16)) };
  let c = newCase({ id: 'c2', ref: newCaseRef(), org, type: 'grievance', category: 'harassment', severity: 'high', description: 'x', lang: 'ta', inputMode: 'voice', access, now: T });
  assert.equal(c.reporterId, null);
  assert.equal(c.anonymous, true);
  assert.equal(c.createdAt % HOUR, 0);
  assert.deepEqual(c.history[0].actor, { type: 'reporter' });
  c = applyAction(c, 'message', { actor: { type: 'reporter' }, now: T + 17 * 60_000, caseRules: org.caseRules, text: 'More detail' });
  assert.equal(c.messages[0].at % HOUR, 0, 'reporter activity is rounded too');
  assert.ok(!JSON.stringify(c).includes(code.replace(/-/g, '')), 'the code itself is never stored');
  assert.throws(() => newCase({ id: 'c3', ref: 'FS-X', org, type: 'safety', category: 'fall', severity: 'high', description: 'x', access, reporterId: 'w1', now: T }));
});

test('access codes: 12 Crockford characters, hashed with scrypt, forgiving of how they are typed', async () => {
  const code = newAccessCode();
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const salt = 'cd'.repeat(16);
  const access = { salt, hash: await hashAccessCode(code, salt) };
  assert.equal(await verifyAccessCode(code, access), true);
  assert.equal(await verifyAccessCode(code.toLowerCase().replace(/-/g, ' '), access), true);
  assert.equal(await verifyAccessCode('0000-0000-0000', access), false);
  assert.equal(await verifyAccessCode('', access), false);
  assert.equal(normalizeAccessCode('ab cd-ef gh-jk mn'), 'ABCDEFGHJKMN');
  assert.equal(normalizeAccessCode('O1L1-0000-0000'), '0111' + '0'.repeat(8), 'O→0, L→1');
  assert.equal(normalizeRef('fs-7kq4-m2xd'), 'FS-7KQ4-M2XD');
  assert.equal(normalizeRef('7KQ4M2XD'), 'FS-7KQ4-M2XD');
  assert.equal(normalizeRef('FS-123'), null);
  assert.notEqual(newCaseRef(), newCaseRef());
});

test('views: admins never see the access secret; reporters never see internal ids', async () => {
  const salt = 'ef'.repeat(16);
  const access = { salt, hash: await hashAccessCode('AAAA-BBBB-CCCC', salt) };
  const anon = newCase({ id: 'c9', ref: 'FS-AAAA-CCCC', org, type: 'safety', category: 'fall', severity: 'high', description: 'x', lang: 'en', inputMode: 'text', access, now: T });
  const a = adminView(anon, people, T);
  assert.equal(a.reporter, null);
  assert.equal('access' in a, false);
  assert.ok(!JSON.stringify(a).includes(access.hash));

  const r = reporterView(act(named(), 'acknowledge', { actor: admin }), people, T);
  assert.equal(r.id, undefined);
  assert.equal(r.assignee.name, 'Vikram');
  assert.equal(r.history[0].actor.type, 'you');
  assert.equal('access' in r, false);
});
