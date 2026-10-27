'use strict';

const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');
const v = require('../validate');
const { HttpError } = require('../errors');
const { createRateLimiter } = require('../rateLimit');
const { presentOrgConfig } = require('../present');
const { RUPEE, SEVERITIES, ESCALATION_ROLES } = require('../../config/industries');
const { HOUR, dayKey, monthKey, addMonths } = require('../../domain/time');
const { siteCode, isStale } = require('../../domain/shifts');
const { computePayslip } = require('../../domain/payroll');
const { buildRadar } = require('../../domain/radar');
const { CASE_TYPES, STATUSES, OUTCOMES, ADMIN_ACTIONS, isActive, adminView } = require('../../domain/cases');
const { ensureDemoData } = require('../../data/seed');

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

/** Spreadsheet-safe CSV cell: quotes, and neutralises formula injection (=, +, -, @). */
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rupees = (paise) => (paise / 100).toFixed(2);

/** List rows: enough to triage, without the full history and evidence. */
function caseSummary(view) {
  return {
    id: view.id,
    ref: view.ref,
    type: view.type,
    category: view.category,
    severity: view.severity,
    status: view.status,
    anonymous: view.anonymous,
    reporter: view.reporter,
    assignee: view.assignee,
    description: view.description.length > 160 ? `${view.description.slice(0, 157)}…` : view.description,
    lang: view.lang,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    dueAt: view.dueAt,
    overdue: view.overdue,
    escalated: view.escalated,
    reopenCount: view.reopenCount,
    messageCount: view.messages.length,
  };
}

function caseOrder(a, b) {
  return (
    isActive(b) - isActive(a) ||
    b.overdue - a.overdue ||
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    b.createdAt - a.createdAt
  );
}

function adminRouter({ repo, clock, config, cases, auth }) {
  const r = express.Router();
  const writeLimit = createRateLimiter({ windowMs: HOUR, max: 300, key: (req) => req.user.id, clock });
  const orgOf = (req) => repo.getOrg(req.user.orgId);
  const actorOf = (req) => ({ type: 'admin', id: req.user.id });

  async function loadCase(req, org) {
    const record = await repo.getCase(String(req.params.id));
    if (!record || record.orgId !== org.id) throw new HttpError(404, 'not_found');
    return record;
  }

  function requireActivePayCase(record) {
    if (record.type !== 'pay') throw new HttpError(409, 'not_pay_case');
    if (!isActive(record)) throw new HttpError(409, 'case_not_active');
  }

  /** Full case for the investigator, plus live pay evidence for disputes. */
  async function caseDetail(org, record, now) {
    const people = await cases.people(org.id, { includeWorkers: true });
    const view = adminView(record, people, now);
    if (record.type !== 'pay') return { case: view, evidence: null };

    const worker = people.get(record.reporterId);
    const payslip = await cases.payslipFor(org, worker, record.pay.month);
    const adjustments = (await repo.adjustmentsForUser(worker.id)).filter((a) => a.caseId === record.id);
    return {
      case: view,
      evidence: {
        worker: { id: worker.id, name: worker.name, jobRole: worker.jobRole, wage: worker.wage, allowances: worker.allowances || [], advance: worker.advances?.[record.pay.month] || 0 },
        current: {
          line: payslip.lines.find((l) => l.code === record.pay.lineCode) || null,
          gross: payslip.gross,
          net: payslip.net,
          hourlyRate: payslip.hourlyRate,
          daysPresent: payslip.daysPresent,
          rules: payslip.rules,
          records: payslip.records.map((rec) => ({
            ...rec,
            missingCheckout: isStale(rec, org.rules, now),
            disputed: (record.pay.days || []).includes(rec.day),
          })),
        },
        snapshot: record.pay.snapshot,
        adjustments: adjustments.map((a) => ({ id: a.id, amount: a.amount, reason: a.reason, createdAt: a.createdAt, createdBy: people.get(a.createdBy)?.name || null })),
      },
    };
  }

  r.get('/overview', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const [workers, admins, shifts, records] = await Promise.all([
      repo.listUsers(org.id, 'worker'),
      repo.listUsers(org.id, 'admin'),
      repo.shiftsForOrg(org.id),
      repo.casesForOrg(org.id),
    ]);
    const all = await cases.sweep(org, records, now);
    res.set('Cache-Control', 'no-store').json({
      org: presentOrgConfig(org),
      me: { id: req.user.id, name: req.user.name, title: req.user.title, lang: req.user.lang },
      handlers: admins.sort((a, b) => a.id.localeCompare(b.id)).map((a) => ({ id: a.id, name: a.name, title: a.title })),
      radar: buildRadar({ org, workers, shifts, cases: all, now }),
      demoMode: config.demoMode,
    });
  });

  r.get('/cases', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const type = req.query.type == null || req.query.type === '' ? null : v.oneOf(String(req.query.type), 'type', CASE_TYPES);
    const status = req.query.status == null || req.query.status === '' ? null : v.oneOf(String(req.query.status), 'status', [...STATUSES, 'active']);
    const all = await cases.sweep(org, await repo.casesForOrg(org.id), now);
    const people = await cases.people(org.id, { includeWorkers: true });
    const list = all
      .filter((c) => !type || c.type === type)
      .filter((c) => !status || (status === 'active' ? isActive(c) : c.status === status))
      .map((c) => adminView(c, people, now))
      .sort(caseOrder)
      .map(caseSummary);
    res.set('Cache-Control', 'no-store').json({ cases: list });
  });

  r.get('/cases/:id', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const [record] = await cases.sweep(org, [await loadCase(req, org)], now);
    res.set('Cache-Control', 'no-store').json(await caseDetail(org, record, now));
  });

  r.post('/cases/:id/actions', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const record = await loadCase(req, org);
    const body = req.body || {};
    const action = v.oneOf(body.action, 'action', ADMIN_ACTIONS);
    const ctx = { actor: actorOf(req), now };
    if (action === 'assign' || (action === 'acknowledge' && body.assigneeId)) {
      const handlers = (await repo.listUsers(org.id, 'admin')).map((a) => a.id);
      ctx.assigneeId = v.oneOf(body.assigneeId, 'assigneeId', handlers);
    }
    if (action === 'message') ctx.text = v.text(body.text, 'text', { min: 1, max: 1000 });
    if (action === 'resolve') {
      ctx.outcome = v.oneOf(body.outcome, 'outcome', OUTCOMES[record.type]);
      ctx.note = v.text(body.note, 'note', { min: 3, max: 1000 });
    }
    const updated = await cases.act(org, record.id, action, ctx);
    res.json(await caseDetail(org, updated, now));
  });

  /** Correct a worker's attendance record (or add a missing one) while investigating a pay dispute. */
  r.post('/cases/:id/shifts', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const record = await loadCase(req, org);
    requireActivePayCase(record);
    const body = req.body || {};
    const checkIn = v.localDateTime(body.checkIn, 'checkIn', org.tz);
    const checkOut = v.localDateTime(body.checkOut, 'checkOut', org.tz);
    if (!dayKey(checkIn, org.tz).startsWith(record.pay.month)) throw v.invalid('checkIn');
    if (checkOut <= checkIn || checkOut - checkIn > 24 * HOUR || checkOut > now) throw v.invalid('checkOut');
    const reason = v.text(body.reason, 'reason', { min: 3, max: 300 });

    const workerShifts = await repo.shiftsForUser(record.reporterId);
    const shiftId = body.shiftId == null || body.shiftId === '' ? null : v.oneOf(body.shiftId, 'shiftId', workerShifts.map((s) => s.id));
    // A shift with a missing check-out has no known end, so it does not block a correction.
    const endOf = (s) => s.checkOut ?? (isStale(s, org.rules, now) ? s.checkIn : now);
    if (workerShifts.some((s) => s.id !== shiftId && s.checkIn < checkOut && endOf(s) > checkIn)) throw new HttpError(409, 'shift_overlap');

    const correction = { at: now, by: req.user.id, caseId: record.id, reason, before: null, after: { checkIn, checkOut } };
    if (shiftId) {
      await repo.updateShift(shiftId, (s) => {
        correction.before = { checkIn: s.checkIn, checkOut: s.checkOut };
        return { ...s, checkIn, checkOut, corrections: [...(s.corrections || []), { ...correction }] };
      });
    } else {
      await repo.putShift({ id: `sh_${crypto.randomUUID()}`, orgId: org.id, userId: record.reporterId, checkIn, checkOut, method: 'correction', corrections: [correction] });
    }
    const updated = await cases.log(record.id, {
      at: now,
      actor: actorOf(req),
      action: shiftId ? 'shift_corrected' : 'shift_added',
      note: reason,
      shift: { day: dayKey(checkIn, org.tz), before: correction.before, after: correction.after },
    });
    res.status(201).json(await caseDetail(org, updated, now));
  });

  /** Record an agreed pay correction; it appears as its own line on the worker's payslip. */
  r.post('/cases/:id/adjustments', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const record = await loadCase(req, org);
    requireActivePayCase(record);
    const amountRupees = v.integer(req.body?.rupees, 'rupees', { min: -100_000, max: 100_000 });
    if (amountRupees === 0) throw v.invalid('rupees');
    const reason = v.text(req.body?.reason, 'reason', { min: 3, max: 300 });
    const adjustment = {
      id: `adj_${crypto.randomUUID()}`,
      orgId: org.id,
      userId: record.reporterId,
      month: record.pay.month,
      amount: amountRupees * RUPEE,
      reason,
      caseId: record.id,
      caseRef: record.ref,
      createdBy: req.user.id,
      createdAt: now,
    };
    await repo.putAdjustment(adjustment);
    const updated = await cases.log(record.id, { at: now, actor: actorOf(req), action: 'adjustment', amount: adjustment.amount, month: adjustment.month, note: reason });
    res.status(201).json(await caseDetail(org, updated, now));
  });

  r.get('/settings', async (req, res) => {
    const org = await orgOf(req);
    const people = await cases.people(org.id);
    const audit = (await repo.auditForOrg(org.id)).slice(0, 20).map((a) => ({ ...a, actor: people.get(a.actorId)?.name || null }));
    res.set('Cache-Control', 'no-store').json({ org: presentOrgConfig(org), audit });
  });

  /** Deadlines apply from the next status change; cases keep the deadline they already have. */
  r.put('/settings/case-rules', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const body = req.body || {};
    const row = (value, field) => {
      const ack = v.integer(value?.ack, `${field}.ack`, { min: 1, max: 720 });
      const resolve = v.integer(value?.resolve, `${field}.resolve`, { min: 1, max: 2160 });
      if (resolve < ack) throw v.invalid(`${field}.resolve`);
      return { ack, resolve };
    };
    const next = {
      deadlines: Object.fromEntries(SEVERITIES.map((sev) => [sev, row(body.deadlines?.[sev], `deadlines.${sev}`)])),
      pay: row(body.pay, 'pay'),
      escalateTo: v.oneOf(body.escalateTo, 'escalateTo', ESCALATION_ROLES),
    };
    await repo.patchOrg(org.id, { caseRules: next });
    await repo.addAudit({ id: crypto.randomUUID(), orgId: org.id, at: now, actorId: req.user.id, action: 'case_rules_updated', before: org.caseRules, after: next });
    res.json({ org: presentOrgConfig({ ...org, caseRules: next }) });
  });

  r.get('/site-code', async (req, res) => {
    const org = await orgOf(req);
    const day = dayKey(clock(), org.tz);
    res.set('Cache-Control', 'no-store').json({ code: siteCode(org.checkinSecret, org.siteId, day), validOn: day });
  });

  /** Poster QR. Scanning it with any camera app opens FairShift with the code filled in. */
  r.get('/site-qr.svg', async (req, res) => {
    const org = await orgOf(req);
    const code = siteCode(org.checkinSecret, org.siteId, dayKey(clock(), org.tz));
    const svg = await QRCode.toString(`${req.protocol}://${req.get('host')}/?checkin=${code}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#14202B', light: '#FFFFFF' },
    });
    res.set('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  });

  /** Wage register for the month, ready for Excel. */
  r.get('/wage-register.csv', async (req, res) => {
    const org = await orgOf(req);
    const current = monthKey(clock(), org.tz);
    const allowed = [current, addMonths(current, -1), addMonths(current, -2)];
    const month = req.query.month == null ? current : v.oneOf(String(req.query.month), 'month', allowed);
    const header = ['Name', 'Job', 'Days present', 'Ordinary hours', 'Overtime hours', 'Basic', 'Overtime pay', 'Allowances and adjustments', 'Gross', 'PF', 'ESI', 'Advance and recoveries', 'Total deductions', 'Net pay', 'Daily rate', 'Minimum daily wage', 'Meets minimum wage'];
    const rows = [];
    for (const w of await repo.listUsers(org.id, 'worker')) {
      const [shifts, adjustments] = await Promise.all([repo.shiftsForUser(w.id), repo.adjustmentsForUser(w.id)]);
      const p = computePayslip({ worker: w, shifts, rules: org.rules, month, tzOffsetMinutes: org.tz, minimumDailyWage: org.minimumDailyWage, adjustments });
      const line = (code) => p.lines.find((l) => l.code === code);
      const sum = (pred) => p.lines.filter(pred).reduce((s, l) => s + l.amount, 0);
      rows.push([
        w.name, w.jobRole, p.daysPresent, line('basic').hours, line('overtime').hours,
        rupees(line('basic').amount), rupees(line('overtime').amount),
        rupees(sum((l) => l.kind === 'earning' && !['basic', 'overtime'].includes(l.code))), rupees(p.gross),
        rupees(line('pf')?.amount || 0), rupees(line('esi')?.amount || 0),
        rupees(sum((l) => ['advance', 'recovery'].includes(l.code))),
        rupees(p.totalDeductions), rupees(p.net), rupees(p.compliance.minimumWage.dailyRate),
        rupees(p.compliance.minimumWage.minimum), p.compliance.minimumWage.ok ? 'Yes' : 'No',
      ]);
    }
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    res.set('Cache-Control', 'no-store').type('text/csv').attachment(`wage-register-${org.id}-${month}.csv`).send(`\uFEFF${csv}`);
  });

  /** Demo only: switch industry by signing in as the other workplace's administrator. */
  r.post('/demo/switch', async (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'not_found');
    const orgs = await repo.listOrgs();
    const orgId = v.oneOf(req.body?.orgId, 'orgId', orgs.map((o) => o.id));
    const [target] = (await repo.listUsers(orgId, 'admin')).sort((a, b) => a.id.localeCompare(b.id));
    if (!target) throw new HttpError(404, 'not_found');
    await auth.clearSession(req, res);
    auth.setSessionCookie(res, await auth.createSession(target.id));
    res.json({ ok: true });
  });

  /** Demo only: restore the seeded records. */
  r.post('/demo/reset', async (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'not_found');
    await ensureDemoData(repo, { now: clock(), force: true });
    res.json({ ok: true });
  });

  return r;
}

module.exports = { adminRouter, csvCell };
