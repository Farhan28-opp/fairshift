'use strict';

const crypto = require('node:crypto');
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { createRateLimiter } = require('../rateLimit');
const { LANGS } = require('./auth');
const { RUPEE, industryPreset } = require('../../config/industries');
const { HOUR, DAY, dayKey, monthKey, addDays, addMonths, round1, round2 } = require('../../domain/time');
const { siteCode, splitHours, shiftHours, isStale, currentShift, missingCheckouts } = require('../../domain/shifts');
const { evaluateFatigue } = require('../../domain/fatigue');
const { PAY_REASONS, isActive, normalizeRef, reporterView } = require('../../domain/cases');

const sameCode = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Payslips a worker can open and dispute: this month and the two before. */
const payMonths = (now, tz) => {
  const current = monthKey(now, tz);
  return [current, addMonths(current, -1), addMonths(current, -2)];
};

function workerRouter({ repo, clock, config, cases }) {
  const r = express.Router();
  const writeLimit = createRateLimiter({ windowMs: HOUR, max: 60, key: (req) => req.user.id, clock });
  const orgOf = (req) => repo.getOrg(req.user.orgId);

  async function myCase(req) {
    const ref = normalizeRef(req.params.ref);
    const record = ref ? await repo.findCaseByRef(ref) : null;
    // Only the named reporter can open an identified case here; anonymous ones go through the access code.
    if (!record || record.reporterId !== req.user.id) throw new HttpError(404, 'not_found');
    return record;
  }

  r.get('/home', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const [shifts, mine] = await Promise.all([repo.shiftsForUser(req.user.id), repo.casesForReporter(req.user.id)]);
    const today = dayKey(now, org.tz);
    const current = currentShift(shifts, org.rules, now);
    const recent = shifts.filter((s) => s.checkIn >= now - 14 * DAY && !isStale(s, org.rules, now));
    const byDay = new Map(splitHours(recent, org.rules, org.tz).days.map((d) => [d.day, d]));
    const week = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(today, i - 6);
      const d = byDay.get(day);
      return { day, hours: round1(d?.hours || 0), overtime: round1(d?.overtime || 0) };
    });

    res.json({
      shift: current ? { id: current.id, checkIn: current.checkIn, method: current.method } : null,
      week,
      weekHours: round1(week.reduce((s, d) => s + d.hours, 0)),
      weekOvertime: round1(week.reduce((s, d) => s + d.overtime, 0)),
      fatigue: evaluateFatigue(shifts, org.rules, now, org.tz),
      missingCheckouts: missingCheckouts(shifts, org.rules, now).map((s) => ({ id: s.id, day: dayKey(s.checkIn, org.tz), checkIn: s.checkIn })),
      cases: { active: mine.filter(isActive).length, awaitingConfirmation: mine.filter((c) => c.status === 'resolved').length },
      rules: { dailyHours: org.rules.dailyHours, overtimeMultiplier: org.rules.overtimeMultiplier, staleShiftHours: org.rules.staleShiftHours },
      // Demo only: today's site code, so evaluators can check in without the printed QR poster.
      demo: config.demoMode ? { siteCode: siteCode(org.checkinSecret, org.siteId, today) } : undefined,
      serverTime: now,
    });
  });

  r.post('/checkin', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const method = v.oneOf(req.body?.method, 'method', ['qr', 'code']);
    const code = v.pattern(req.body?.code, 'code', /^\d{6}$/);
    if (!sameCode(code, siteCode(org.checkinSecret, org.siteId, dayKey(now, org.tz)))) throw new HttpError(422, 'wrong_code');

    const shifts = await repo.shiftsForUser(req.user.id);
    if (currentShift(shifts, org.rules, now)) throw new HttpError(409, 'already_checked_in');
    if (shifts.some((s) => s.checkOut != null && s.checkOut > now)) throw new HttpError(409, 'overlaps_previous_shift');

    const shift = { id: `sh_${crypto.randomUUID()}`, orgId: org.id, userId: req.user.id, checkIn: now, checkOut: null, method, corrections: [] };
    await repo.putShift(shift);
    res.status(201).json({ shift: { id: shift.id, checkIn: shift.checkIn, method } });
  });

  r.post('/checkout', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const open = currentShift(await repo.shiftsForUser(req.user.id), org.rules, now);
    if (!open) throw new HttpError(409, 'not_checked_in');
    const shift = await repo.updateShift(open.id, (s) => {
      if (!s || s.checkOut != null) throw new HttpError(409, 'not_checked_in');
      return { ...s, checkOut: now };
    });
    const day = dayKey(shift.checkIn, org.tz);
    const all = await repo.shiftsForUser(req.user.id);
    const dayTotals = splitHours(all.filter((s) => dayKey(s.checkIn, org.tz) === day), { ...org.rules, weeklyHours: Infinity }, org.tz);
    res.json({
      shift: { id: shift.id, checkIn: shift.checkIn, checkOut: shift.checkOut, hours: round2(shiftHours(shift)) },
      today: { hours: round1(dayTotals.hours), overtime: round1(dayTotals.overtimeHours) },
      fatigue: evaluateFatigue(all, org.rules, now, org.tz),
    });
  });

  /** The worker's own attendance records for the last two weeks. */
  r.get('/shifts', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const shifts = await repo.shiftsForUser(req.user.id);
    const split = new Map(splitHours(shifts, org.rules, org.tz).days.map((d) => [d.day, d]));
    const list = shifts
      .filter((s) => s.checkIn >= now - 14 * DAY)
      .reverse()
      .map((s) => {
        const day = dayKey(s.checkIn, org.tz);
        let status = 'done';
        if (s.checkOut == null) status = isStale(s, org.rules, now) ? 'missing_checkout' : 'on_shift';
        return {
          id: s.id,
          day,
          checkIn: s.checkIn,
          checkOut: s.checkOut,
          hours: s.checkOut == null ? null : round2(shiftHours(s)),
          dayOvertime: round2(split.get(day)?.overtime || 0),
          status,
          method: s.method,
          corrected: Boolean(s.corrections?.length),
        };
      });
    res.json({ shifts: list, rules: { dailyHours: org.rules.dailyHours, weeklyHours: org.rules.weeklyHours } });
  });

  r.get('/payslip', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const months = payMonths(now, org.tz);
    const month = req.query.month == null ? months[0] : v.oneOf(String(req.query.month), 'month', months);
    const payslip = await cases.payslipFor(org, req.user, month);
    const people = await cases.people(org.id);
    const disputes = (await repo.casesForReporter(req.user.id))
      .filter((c) => c.type === 'pay' && c.pay?.month === month)
      .map((c) => reporterView(c, people, now));
    res.json({ payslip, months, inProgress: month === months[0], wage: req.user.wage, reasons: PAY_REASONS, disputes });
  });

  /** PayProof: dispute one line of a payslip, optionally pointing at specific days. */
  r.post('/disputes', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const body = req.body || {};
    const month = v.oneOf(body.month, 'month', payMonths(now, org.tz));
    const payslip = await cases.payslipFor(org, req.user, month);
    const lineCode = v.oneOf(body.lineCode, 'lineCode', payslip.lines.map((l) => l.code));
    const reason = v.oneOf(body.reason, 'reason', PAY_REASONS);
    const days = v.days(body.days, 'days', month);
    const expected = v.integer(body.expectedRupees, 'expectedRupees', { min: 0, max: 1_000_000, optional: true });
    const message = v.text(body.message, 'message', { min: 3, max: 1000 });
    const inputMode = v.oneOf(body.inputMode ?? 'text', 'inputMode', ['text', 'voice']);
    const lang = v.oneOf(body.lang ?? req.user.lang, 'lang', LANGS);

    const record = await cases.createPayDispute({
      org,
      worker: req.user,
      payslip,
      lineCode,
      reason,
      days,
      expectedAmount: expected == null ? null : expected * RUPEE,
      message,
      lang,
      inputMode,
      now,
    });
    res.status(201).json({ case: reporterView(record, await cases.people(org.id), now) });
  });

  /** SpeakSafe: report a hazard or grievance. Anonymous reports store no link to this account. */
  r.post('/reports', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const body = req.body || {};
    const category = v.oneOf(body.category, 'category', industryPreset(org.industry).categories);
    const description = v.text(body.description, 'description', { min: 5, max: 1000 });
    const anonymous = v.bool(body.anonymous, 'anonymous');
    const inputMode = v.oneOf(body.inputMode ?? 'text', 'inputMode', ['text', 'voice']);
    const lang = v.oneOf(body.lang ?? req.user.lang, 'lang', LANGS);

    const { record, accessCode } = await cases.createReport({
      org,
      reporter: anonymous ? null : req.user,
      category,
      description,
      lang,
      inputMode,
      now,
    });
    res.status(201).json({ case: reporterView(record, await cases.people(org.id), now), accessCode });
  });

  r.get('/cases', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const list = await cases.sweep(org, await repo.casesForReporter(req.user.id), now);
    const people = await cases.people(org.id);
    res.json({ cases: list.map((c) => reporterView(c, people, now)) });
  });

  r.get('/cases/:ref', async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const [record] = await cases.sweep(org, [await myCase(req)], now);
    res.json({ case: reporterView(record, await cases.people(org.id), now) });
  });

  r.post('/cases/:ref/messages', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const record = await myCase(req);
    const text = v.text(req.body?.text, 'text', { min: 1, max: 1000 });
    const updated = await cases.act(org, record.id, 'message', { actor: { type: 'worker', id: req.user.id }, now, text });
    res.status(201).json({ case: reporterView(updated, await cases.people(org.id), now) });
  });

  /** The Fairness Loop's last step: the worker confirms the fix, or reopens the case. */
  r.post('/cases/:ref/verify', writeLimit, async (req, res) => {
    const now = clock();
    const org = await orgOf(req);
    const record = await myCase(req);
    const accepted = v.bool(req.body?.accepted, 'accepted');
    const note = v.text(req.body?.note, 'note', { max: 1000, optional: accepted });
    const updated = await cases.act(org, record.id, accepted ? 'confirm' : 'reopen', { actor: { type: 'worker', id: req.user.id }, now, note });
    res.json({ case: reporterView(updated, await cases.people(org.id), now) });
  });

  return r;
}

module.exports = { workerRouter, payMonths };
