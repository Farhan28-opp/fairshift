'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { HOUR } = require('./time');

const scrypt = promisify(crypto.scrypt);

/**
 * One case engine for the whole Fairness Loop: pay disputes, safety reports
 * and grievances share the same lifecycle, deadlines, audit history,
 * messages and worker verification.
 *
 *   open ──acknowledge──▶ in_review ──resolve──▶ resolved ──confirm──▶ closed
 *     └────────────resolve─────────────▶ ▲          └──reopen──▶ in_review
 *
 * Admins acknowledge, assign, message and resolve. Only the person who raised
 * the case (signed-in worker, or anonymous reporter holding the access code)
 * can confirm the fix or reopen it. Every change appends to `history`.
 */

const CASE_TYPES = Object.freeze(['pay', 'safety', 'grievance']);
const STATUSES = Object.freeze(['open', 'in_review', 'resolved', 'closed']);
const ACTIVE = new Set(['open', 'in_review']);
const OUTCOMES = Object.freeze({
  pay: ['upheld', 'partly_upheld', 'not_upheld'],
  safety: ['fixed', 'action_taken', 'not_confirmed'],
  grievance: ['fixed', 'action_taken', 'not_confirmed'],
});
const PAY_REASONS = Object.freeze(['hours_missing', 'overtime_missing', 'wrong_rate', 'wrong_deduction', 'allowance_missing', 'other']);
const ADMIN_ACTIONS = Object.freeze(['acknowledge', 'assign', 'message', 'resolve']);
const REPORTER_ACTIONS = Object.freeze(['message', 'confirm', 'reopen']);

// Crockford base32: no I, L, O or U, so codes survive being read aloud or written by hand.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]+$/;
const SCRYPT_PARAMS = Object.freeze({ N: 2 ** 14, r: 8, p: 1 });

/** A rule violation the client may see (status + stable code). */
class CaseError extends Error {
  constructor(code, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

function randomCode(length, randomBytes = crypto.randomBytes) {
  // 256 is a multiple of 32, so masking keeps every character equally likely.
  return Array.from(randomBytes(length), (b) => ALPHABET[b & 31]).join('');
}

/** Public case number, e.g. FS-7KQ4-M2XD (40 random bits; not a secret). */
function newCaseRef(randomBytes) {
  const c = randomCode(8, randomBytes);
  return `FS-${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Secret shown once to an anonymous reporter, e.g. 4KD9-PX2M-QH7A (60 random bits). */
function newAccessCode(randomBytes) {
  const c = randomCode(12, randomBytes);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** Upper-cases, drops separators and maps look-alikes (O→0, I/L→1). */
function canonical(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function normalizeRef(input) {
  let c = canonical(input);
  if (c.length === 10 && c.startsWith('FS')) c = c.slice(2);
  if (c.length !== 8 || !CODE_RE.test(c)) return null;
  return `FS-${c.slice(0, 4)}-${c.slice(4)}`;
}

function normalizeAccessCode(input) {
  const c = canonical(input);
  return c.length === 12 && CODE_RE.test(c) ? c : null;
}

/** Access codes are stored only as a salted scrypt hash, so a database leak does not reveal them. */
async function hashAccessCode(code, salt) {
  const key = await scrypt(normalizeAccessCode(code) || '', salt, 32, SCRYPT_PARAMS);
  return key.toString('hex');
}

async function verifyAccessCode(code, access) {
  if (!access?.hash || !access?.salt || !normalizeAccessCode(code)) return false;
  const supplied = Buffer.from(await hashAccessCode(code, access.salt), 'hex');
  const stored = Buffer.from(access.hash, 'hex');
  return supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);
}

/** Rounds a timestamp down so an anonymous submission cannot be matched to who was on shift. */
function coarsenTime(ts, granularityMs = HOUR) {
  return Math.floor(ts / granularityMs) * granularityMs;
}

/** Configured deadline, in hours, for a case at a stage ('ack' or 'resolve'). */
function stageHours(caseRules, record, stage) {
  const row = record.type === 'pay' ? caseRules.pay : caseRules.deadlines[record.severity];
  return row[stage];
}

function isActive(record) {
  return ACTIVE.has(record.status);
}

function isOverdue(record, now) {
  return isActive(record) && record.dueAt != null && now > record.dueAt;
}

/**
 * Builds a new case. For anonymous cases there is no reporter id, no name
 * and the time is rounded to the hour; only a hash of the access code lets
 * the reporter come back to it.
 */
function newCase({ id, ref, org, type, category, severity, matchedKeywords = [], description, lang, inputMode, reporterId, access, pay, now }) {
  if (!CASE_TYPES.includes(type)) throw new Error(`Unknown case type ${type}`);
  const anonymous = Boolean(access);
  if (anonymous === Boolean(reporterId)) throw new Error('A case is either anonymous (access) or identified (reporterId)');
  const createdAt = anonymous ? coarsenTime(now) : now;
  const record = {
    id,
    ref,
    orgId: org.id,
    type,
    category,
    severity,
    matchedKeywords,
    description,
    lang,
    inputMode,
    anonymous,
    reporterId: anonymous ? null : reporterId,
    access: anonymous ? access : null,
    status: 'open',
    assigneeId: null,
    createdAt,
    updatedAt: createdAt,
    clockStart: createdAt,
    dueAt: null,
    escalatedAt: null,
    escalatedTo: null,
    reopenCount: 0,
    resolution: null,
    verification: null,
    pay: pay || null,
    history: [{ at: createdAt, actor: anonymous ? { type: 'reporter' } : { type: 'worker', id: reporterId }, action: 'submitted' }],
    messages: [],
  };
  record.dueAt = createdAt + stageHours(org.caseRules, record, 'ack') * HOUR;
  return record;
}

/**
 * Applies one action and returns the updated case (the input is not changed).
 * Throws CaseError for anything the rules do not allow.
 *
 * @param {object} record
 * @param {string} action   one of ADMIN_ACTIONS or REPORTER_ACTIONS
 * @param {object} ctx      { actor: {type: 'admin'|'worker'|'reporter', id?}, now, caseRules,
 *                            assigneeId?, text?, outcome?, note? }
 */
function applyAction(record, action, ctx) {
  const { actor, now, caseRules } = ctx;
  const allowed = actor.type === 'admin' ? ADMIN_ACTIONS : REPORTER_ACTIONS;
  if (!allowed.includes(action)) throw new CaseError('action_not_allowed', 403);
  if (record.status === 'closed') throw new CaseError('case_closed');

  // Anonymous reporters' activity times are rounded like their submission time.
  const at = actor.type === 'reporter' ? coarsenTime(now) : now;
  const next = structuredClone(record);
  const log = (entry) => next.history.push({ at, actor, ...entry });
  const requireActive = () => {
    if (!isActive(record)) throw new CaseError('invalid_transition');
  };

  switch (action) {
    case 'acknowledge': {
      if (record.status !== 'open') throw new CaseError('invalid_transition');
      next.status = 'in_review';
      next.dueAt = record.clockStart + stageHours(caseRules, record, 'resolve') * HOUR;
      next.escalatedAt = null;
      log({ action: 'acknowledged', from: 'open', to: 'in_review', dueAt: next.dueAt });
      // Someone is always responsible: default to the person acknowledging.
      const assignee = ctx.assigneeId || record.assigneeId || actor.id;
      if (assignee !== record.assigneeId) {
        next.assigneeId = assignee;
        log({ action: 'assigned', from: record.assigneeId, to: assignee });
      }
      break;
    }
    case 'assign':
      requireActive();
      if (!ctx.assigneeId) throw new CaseError('assignee_required', 400);
      if (ctx.assigneeId === record.assigneeId) throw new CaseError('no_change');
      next.assigneeId = ctx.assigneeId;
      log({ action: 'assigned', from: record.assigneeId, to: ctx.assigneeId });
      break;
    case 'message':
      if (!ctx.text) throw new CaseError('text_required', 400);
      next.messages.push({ at, actor, text: ctx.text });
      log({ action: 'message' });
      break;
    case 'resolve':
      requireActive();
      if (!OUTCOMES[record.type].includes(ctx.outcome)) throw new CaseError('invalid_outcome', 400);
      if (!ctx.note) throw new CaseError('note_required', 400);
      next.status = 'resolved';
      next.resolution = { at, by: actor.id, outcome: ctx.outcome, note: ctx.note };
      next.dueAt = null;
      next.escalatedAt = null;
      if (!next.assigneeId) next.assigneeId = actor.id;
      log({ action: 'resolved', from: record.status, to: 'resolved', outcome: ctx.outcome, note: ctx.note });
      break;
    case 'confirm':
      if (record.status !== 'resolved') throw new CaseError('invalid_transition');
      next.status = 'closed';
      next.verification = { at, accepted: true, note: ctx.note || null };
      log({ action: 'confirmed', from: 'resolved', to: 'closed', note: ctx.note || null });
      break;
    case 'reopen':
      if (record.status !== 'resolved') throw new CaseError('invalid_transition');
      if (!ctx.note) throw new CaseError('note_required', 400);
      next.status = 'in_review';
      next.reopenCount += 1;
      next.clockStart = at;
      next.dueAt = at + stageHours(caseRules, record, 'resolve') * HOUR;
      next.verification = { at, accepted: false, note: ctx.note };
      next.resolution = null;
      log({ action: 'reopened', from: 'resolved', to: 'in_review', note: ctx.note, dueAt: next.dueAt });
      break;
    default:
      throw new CaseError('action_not_allowed', 403);
  }

  next.updatedAt = at;
  return next;
}

/**
 * Records an escalation once a deadline has passed. Returns the updated case,
 * or null when nothing changes. The history entry is dated at the deadline and
 * notes when the system recorded it.
 */
function escalate(record, now, caseRules) {
  if (!isOverdue(record, now) || record.escalatedAt) return null;
  const next = structuredClone(record);
  next.escalatedAt = now;
  next.escalatedTo = caseRules.escalateTo;
  next.history.push({
    at: record.dueAt,
    recordedAt: now,
    actor: { type: 'system' },
    action: 'escalated',
    stage: record.status === 'open' ? 'ack' : 'resolve',
    to: caseRules.escalateTo,
    limitHours: stageHours(caseRules, record, record.status === 'open' ? 'ack' : 'resolve'),
  });
  return next;
}

/* ---------- views: only whitelisted fields leave the server ---------- */

function personView(people, id) {
  const p = id ? people.get(id) : null;
  return p ? { id: p.id, name: p.name, title: p.title || null, jobRole: p.jobRole || null } : null;
}

function actorView(actor, people, { forReporter }) {
  if (actor.type === 'admin') return { type: 'admin', ...personView(people, actor.id) };
  if (actor.type === 'system') return { type: 'system' };
  if (forReporter) return { type: 'you' };
  if (actor.type === 'reporter') return { type: 'reporter' };
  return { type: 'worker', ...personView(people, actor.id) };
}

function historyView(record, people, opts) {
  return record.history.map((h) => ({
    at: h.at,
    recordedAt: h.recordedAt,
    action: h.action,
    actor: actorView(h.actor, people, opts),
    from: h.action === 'assigned' ? personView(people, h.from) : h.from,
    to: h.action === 'assigned' ? personView(people, h.to) : h.to,
    outcome: h.outcome,
    note: h.note,
    dueAt: h.dueAt,
    stage: h.stage,
    limitHours: h.limitHours,
    amount: h.amount,
    month: h.month,
    shift: h.shift,
  }));
}

function common(record, people, now, opts) {
  return {
    id: record.id,
    ref: record.ref,
    type: record.type,
    category: record.category,
    severity: record.severity,
    status: record.status,
    anonymous: record.anonymous,
    description: record.description,
    lang: record.lang,
    inputMode: record.inputMode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    dueAt: record.dueAt,
    overdue: isOverdue(record, now),
    escalated: Boolean(record.escalatedAt),
    escalatedTo: record.escalatedTo,
    reopenCount: record.reopenCount,
    assignee: personView(people, record.assigneeId),
    resolution: record.resolution ? { ...record.resolution, by: personView(people, record.resolution.by) } : null,
    verification: record.verification,
    history: historyView(record, people, opts),
    messages: record.messages.map((m) => ({ at: m.at, text: m.text, actor: actorView(m.actor, people, opts), mine: opts.forReporter && m.actor.type !== 'admin' })),
  };
}

/** What the worker or anonymous reporter sees about their own case. */
function reporterView(record, people, now) {
  const pay = record.pay
    ? { month: record.pay.month, lineCode: record.pay.lineCode, reason: record.pay.reason, days: record.pay.days, expectedAmount: record.pay.expectedAmount }
    : null;
  return {
    ...common(record, people, now, { forReporter: true }),
    id: undefined,
    pay,
    canMessage: record.status !== 'closed',
    canVerify: record.status === 'resolved',
  };
}

/** What an administrator sees. Anonymous cases carry no reporter at all. */
function adminView(record, people, now) {
  return {
    ...common(record, people, now, { forReporter: false }),
    matchedKeywords: record.matchedKeywords,
    reporter: record.anonymous ? null : personView(people, record.reporterId),
    pay: record.pay,
    canAcknowledge: record.status === 'open',
    canResolve: isActive(record),
  };
}

module.exports = {
  CASE_TYPES,
  STATUSES,
  OUTCOMES,
  PAY_REASONS,
  ADMIN_ACTIONS,
  REPORTER_ACTIONS,
  CaseError,
  newCaseRef,
  newAccessCode,
  normalizeRef,
  normalizeAccessCode,
  hashAccessCode,
  verifyAccessCode,
  coarsenTime,
  stageHours,
  isActive,
  isOverdue,
  newCase,
  applyAction,
  escalate,
  reporterView,
  adminView,
};
