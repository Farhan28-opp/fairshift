'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../http/errors');
const { triage } = require('../domain/triage');
const { computePayslip, paySnapshot } = require('../domain/payroll');
const {
  newCase,
  newCaseRef,
  newAccessCode,
  hashAccessCode,
  verifyAccessCode,
  normalizeRef,
  applyAction,
  escalate,
} = require('../domain/cases');
const { CATEGORIES } = require('../config/industries');

const DUMMY_ACCESS = Object.freeze({ salt: '0'.repeat(32), hash: '0'.repeat(64) });

/** Case workflows shared by the worker, anonymous-tracking and admin routes. */
function createCaseService({ repo }) {
  async function uniqueRef() {
    for (let i = 0; i < 5; i += 1) {
      const ref = newCaseRef();
      if (!(await repo.findCaseByRef(ref))) return ref;
    }
    throw new Error('Could not allocate a case reference');
  }

  /** People whose names may appear on a case: admins for reporters, everyone for admins. */
  async function people(orgId, { includeWorkers = false } = {}) {
    const users = await repo.listUsers(orgId, includeWorkers ? undefined : 'admin');
    return new Map(users.map((u) => [u.id, u]));
  }

  /** Records escalations for any case whose deadline has passed; returns the up-to-date list. */
  async function sweep(org, records, now) {
    const out = [];
    for (const record of records) {
      if (escalate(record, now, org.caseRules)) {
        out.push(await repo.updateCase(record.id, (current) => escalate(current, now, org.caseRules) ?? undefined));
      } else {
        out.push(record);
      }
    }
    return out;
  }

  async function payslipFor(org, worker, month) {
    const [shifts, adjustments] = await Promise.all([repo.shiftsForUser(worker.id), repo.adjustmentsForUser(worker.id)]);
    return computePayslip({
      worker,
      shifts,
      rules: org.rules,
      month,
      tzOffsetMinutes: org.tz,
      minimumDailyWage: org.minimumDailyWage,
      adjustments,
    });
  }

  /** SpeakSafe: a safety report or grievance, named or anonymous. */
  async function createReport({ org, reporter, category, description, lang, inputMode, now }) {
    const { severity, matchedKeywords } = triage({ category, description });
    let access = null;
    let accessCode = null;
    if (!reporter) {
      accessCode = newAccessCode();
      const salt = crypto.randomBytes(16).toString('hex');
      access = { salt, hash: await hashAccessCode(accessCode, salt) };
    }
    const record = newCase({
      id: crypto.randomUUID(),
      ref: await uniqueRef(),
      org,
      type: CATEGORIES[category].kind,
      category,
      severity,
      matchedKeywords,
      description,
      lang,
      inputMode,
      reporterId: reporter ? reporter.id : null,
      access,
      now,
    });
    await repo.putCase(record);
    return { record, accessCode };
  }

  /** PayProof: a dispute tied to one payslip line, with the evidence frozen at that moment. */
  async function createPayDispute({ org, worker, payslip, lineCode, reason, days, expectedAmount, message, lang, inputMode, now }) {
    const record = newCase({
      id: crypto.randomUUID(),
      ref: await uniqueRef(),
      org,
      type: 'pay',
      category: lineCode,
      severity: 'medium',
      description: message,
      lang,
      inputMode,
      reporterId: worker.id,
      pay: { month: payslip.month, lineCode, reason, days, expectedAmount, snapshot: paySnapshot(payslip, lineCode, days, now) },
      now,
    });
    await repo.putCase(record);
    return record;
  }

  /** Runs a lifecycle action atomically. Throws 404 if the case is gone. */
  function act(org, caseId, action, ctx) {
    return repo.updateCase(caseId, (current) => {
      if (!current || current.orgId !== org.id) throw new HttpError(404, 'not_found');
      return applyAction(current, action, { ...ctx, caseRules: org.caseRules });
    });
  }

  /** Appends an audit entry that is not a status change (shift fixed, pay adjusted). */
  function log(caseId, entry) {
    return repo.updateCase(caseId, (current) => {
      if (!current) throw new HttpError(404, 'not_found');
      return { ...current, updatedAt: entry.at, history: [...current.history, entry] };
    });
  }

  /**
   * Finds an anonymous case from its reference and access code. The same
   * error is returned for an unknown reference and a wrong code.
   */
  async function findAnonymous(refInput, code) {
    const ref = normalizeRef(refInput);
    const record = ref ? await repo.findCaseByRef(ref) : null;
    // Hash against a dummy when the case is unknown, so timing does not reveal which references exist.
    const ok = await verifyAccessCode(code, record?.anonymous ? record.access : DUMMY_ACCESS);
    if (!record || !ok) throw new HttpError(404, 'case_not_found');
    return record;
  }

  return { people, sweep, payslipFor, createReport, createPayDispute, act, log, findAnonymous };
}

module.exports = { createCaseService };
