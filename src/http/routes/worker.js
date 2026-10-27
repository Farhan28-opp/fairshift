'use strict';

const crypto = require('node:crypto');
const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { createRateLimiter } = require('../rateLimit');
const { presentReportForWorker, presentPayQuery } = require('../present');
const { LANGS } = require('./auth');
const { sectorPreset } = require('../../config/sectors');
const { MINUTE, HOUR, DAY, dayKey, monthKey, addDays, addMonths, weekKey, round1 } = require('../../domain/time');
const { siteCode, isWithinGeofence, distanceMeters, splitHours, shiftHours } = require('../../domain/shifts');
const { computePayslip } = require('../../domain/payroll');
const { evaluateFatigue } = require('../../domain/fatigue');
const { triage, maxSeverity } = require('../../domain/triage');
const {
  FEEDBACK_ASPECTS,
  newTrackingToken,
  hashToken,
  coarsenTime,
  ballotKey,
} = require('../../domain/anonymity');
const { buildPassport } = require('../../domain/passport');

const MAX_OFFLINE_AGE = 72 * HOUR;
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

const sameCode = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Check-ins made offline are queued on the phone and sent later with the time
 * they happened. Accept that time if it is recent and not in the future.
 */
function eventTime(clientTime, now) {
  if (clientTime == null) return { ts: now, offline: false };
  const ts = v.integer(clientTime, 'clientTime', { min: now - MAX_OFFLINE_AGE, max: now + 2 * MINUTE });
  return { ts: Math.min(ts, now), offline: now - ts > MINUTE };
}

function workerRouter({ store, clock, config, ai, logger }) {
  const r = express.Router();
  const writeLimit = createRateLimiter({ windowMs: HOUR, max: 60, key: (req) => req.user.id, clock });
  const orgOf = (req) => store.getOrg(req.user.orgId);

  r.get('/home', (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const shifts = store.shiftsFor(req.user.id);
    const open = store.openShift(req.user.id);
    const today = dayKey(now, org.tz);

    const split = splitHours(
      shifts.filter((s) => s.checkIn >= now - 14 * DAY),
      org.rules,
      org.tz,
    );
    const byDay = new Map(split.days.map((d) => [d.day, d]));
    const week = Array.from({ length: 7 }, (_, i) => {
      const day = addDays(today, i - 6);
      const d = byDay.get(day);
      return { day, hours: round1(d?.hours || 0), overtime: round1(d?.overtime || 0) };
    });

    res.json({
      shift: open ? { checkIn: open.checkIn, method: open.method } : null,
      week,
      weekHours: round1(week.reduce((s, d) => s + d.hours, 0)),
      weekOvertime: round1(week.reduce((s, d) => s + d.overtime, 0)),
      fatigue: evaluateFatigue(shifts, org.rules, now, org.tz),
      feedbackGiven: store.hasBallot(ballotKey(config.appSecret, req.user.id, weekKey(today))),
      rules: { dailyHours: org.rules.dailyHours, overtimeMultiplier: org.rules.overtimeMultiplier },
      // Demo only: shows today's site code so judges can check in without the printed QR poster.
      demo: config.demoMode ? { siteCode: siteCode(config.appSecret, org.site.id, today) } : undefined,
      serverTime: now,
    });
  });

  r.post('/checkin', writeLimit, (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const body = req.body || {};
    const method = v.oneOf(body.method, 'method', ['qr', 'code', 'gps']);
    const { ts, offline } = eventTime(body.clientTime, now);

    if (store.openShift(req.user.id)) throw new HttpError(409, 'already_checked_in');

    if (method === 'gps') {
      const point = {
        lat: v.number(body.lat, 'lat', { min: -90, max: 90 }),
        lng: v.number(body.lng, 'lng', { min: -180, max: 180 }),
        accuracy: v.number(body.accuracy, 'accuracy', { min: 0, max: 10_000, optional: true }),
      };
      if (!isWithinGeofence(point, org.site)) {
        throw new HttpError(422, 'outside_site', { distanceM: Math.round(distanceMeters(point, org.site)) });
      }
    } else {
      const code = v.pattern(body.code, 'code', /^\d{6}$/);
      if (!sameCode(code, siteCode(config.appSecret, org.site.id, dayKey(ts, org.tz)))) {
        throw new HttpError(422, 'wrong_code');
      }
    }

    const lastOut = Math.max(0, ...store.shiftsFor(req.user.id).map((s) => s.checkOut || 0));
    if (ts < lastOut) throw new HttpError(409, 'overlaps_previous_shift');

    const shift = store.addShift({ userId: req.user.id, orgId: org.id, checkIn: ts, method, offlineSync: offline });
    res.status(201).json({ shift: { checkIn: shift.checkIn, method: shift.method } });
  });

  r.post('/checkout', writeLimit, (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const open = store.openShift(req.user.id);
    if (!open) throw new HttpError(409, 'not_checked_in');
    const { ts, offline } = eventTime(req.body?.clientTime, now);
    if (ts <= open.checkIn) throw new HttpError(422, 'invalid_time');

    const shift = store.closeShift(open.id, req.user.id, { checkOut: ts, offlineSync: open.offlineSync || offline });
    const day = dayKey(shift.checkIn, org.tz);
    const dayTotals = splitHours(
      store.shiftsFor(req.user.id).filter((s) => dayKey(s.checkIn, org.tz) === day),
      { ...org.rules, weeklyHours: Infinity },
      org.tz,
    );
    res.json({
      shift: { checkIn: shift.checkIn, checkOut: shift.checkOut, hours: round1(shiftHours(shift)) },
      today: { hours: round1(dayTotals.hours), overtime: round1(dayTotals.overtimeHours) },
      fatigue: evaluateFatigue(store.shiftsFor(req.user.id), org.rules, now, org.tz),
    });
  });

  r.get('/payslip', (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const current = monthKey(now, org.tz);
    const months = [current, addMonths(current, -1), addMonths(current, -2)];
    const month = req.query.month == null ? current : v.oneOf(String(req.query.month), 'month', months);
    const payslip = computePayslip({
      worker: req.user,
      shifts: store.shiftsFor(req.user.id),
      rules: org.rules,
      month,
      tzOffsetMinutes: org.tz,
      minimumDailyWage: org.minimumDailyWage,
    });
    const queries = store
      .payQueriesForUser(req.user.id)
      .filter((q) => q.month === month)
      .map((q) => presentPayQuery(q));
    res.json({ payslip, months, inProgress: month === current, queries });
  });

  r.post('/pay-queries', writeLimit, (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const current = monthKey(now, org.tz);
    const month = v.oneOf(req.body?.month, 'month', [current, addMonths(current, -1), addMonths(current, -2)]);
    const lineCode = v.pattern(req.body?.lineCode, 'lineCode', /^[a-z_]{2,20}$/);
    const message = v.text(req.body?.message, 'message', { max: 500, optional: true });
    const query = store.addPayQuery({ orgId: org.id, userId: req.user.id, month, lineCode, message, createdAt: now });
    res.status(201).json({ query: presentPayQuery(query) });
  });

  r.post('/reports', writeLimit, (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const body = req.body || {};
    const category = v.oneOf(body.category, 'category', sectorPreset(org.sector).hazards);
    const description = v.text(body.description, 'description', { min: 3, max: 1000 });
    const anonymous = v.bool(body.anonymous, 'anonymous');
    const inputMode = v.oneOf(body.inputMode ?? 'text', 'inputMode', ['text', 'voice']);
    const lang = v.oneOf(body.lang ?? req.user.lang, 'lang', LANGS);

    const { severity, matchedKeywords } = triage({ category, description });
    const token = anonymous ? newTrackingToken() : null;
    // Anonymous: no reporter id, only a hash of the phone's secret token, time rounded to the hour.
    const createdAt = anonymous ? coarsenTime(now, HOUR) : now;
    const report = store.addReport({
      orgId: org.id,
      category,
      description,
      lang,
      inputMode,
      anonymous,
      reporterId: anonymous ? null : req.user.id,
      tokenHash: token ? hashToken(token) : null,
      severity,
      matchedKeywords,
      summaryEn: null,
      createdAt,
      updatedAt: createdAt,
    });

    if (ai.enabled) {
      ai.analyzeReport({ description, category, sector: org.sector })
        .then((result) => {
          if (!result) return;
          store.updateReport(report.id, {
            summaryEn: result.summaryEn,
            severity: maxSeverity(report.severity, result.severity),
            aiAssisted: true,
          });
        })
        .catch((err) => logger.warn('ai_enrichment_failed', { reason: err?.name }));
    }

    res.status(201).json({ report: presentReportForWorker(report), trackingToken: token });
  });

  r.get('/reports', (req, res) => {
    res.json({ reports: store.reportsByReporter(req.user.id).map(presentReportForWorker) });
  });

  /** Anonymous reports are followed with the secret tokens kept on the phone. */
  r.post('/reports/track', (req, res) => {
    const tokens = req.body?.tokens;
    if (!Array.isArray(tokens) || tokens.length > 50) throw new HttpError(400, 'invalid_input', { field: 'tokens' });
    const hashes = tokens.map((t) => hashToken(v.pattern(t, 'tokens', TOKEN_RE)));
    const found = new Map(store.reportsByTokenHashes(req.user.orgId, hashes).map((rep) => [rep.tokenHash, rep]));
    res.json({ reports: hashes.map((h) => (found.has(h) ? presentReportForWorker(found.get(h)) : null)) });
  });

  r.post('/feedback', writeLimit, (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const today = dayKey(now, org.tz);
    const week = weekKey(today);
    const ballot = ballotKey(config.appSecret, req.user.id, week);
    if (store.hasBallot(ballot)) throw new HttpError(409, 'already_submitted');

    const scores = {};
    for (const aspect of FEEDBACK_ASPECTS) {
      scores[aspect] = v.integer(req.body?.scores?.[aspect], `scores.${aspect}`, { min: 1, max: 5 });
    }
    const comment = v.text(req.body?.comment, 'comment', { max: 500, optional: true });
    store.addFeedback({ orgId: org.id, week, submittedOn: today, scores, comment }, ballot);
    res.status(201).json({ ok: true });
  });

  r.get('/passport', (req, res) => {
    const org = orgOf(req);
    const passport = buildPassport({ worker: req.user, org, shifts: store.shiftsFor(req.user.id), tzOffsetMinutes: org.tz });
    res.json({ passport, shareId: req.user.passportShared ? req.user.passportShareId : null });
  });

  r.post('/passport/share', writeLimit, (req, res) => {
    const enabled = v.bool(req.body?.enabled, 'enabled');
    store.updateUser(req.user.id, { passportShared: enabled });
    res.json({ shareId: enabled ? req.user.passportShareId : null });
  });

  return r;
}

module.exports = { workerRouter, eventTime };
