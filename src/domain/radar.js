'use strict';

const { DAY, HOUR, dayKey, addDays, round1 } = require('./time');
const { hoursWithin, splitHours, isStale, currentShift, missingCheckouts } = require('./shifts');
const { hourlyRate } = require('./payroll');
const { evaluateFatigue } = require('./fatigue');
const { isActive, isOverdue, stageHours } = require('./cases');

const SEVERITY_ORDER = Object.freeze({ critical: 0, warning: 1, info: 2 });
const KIND_ORDER = Object.freeze({ case: 0, pay: 1, attendance: 2, hours: 3 });
const TREND_DAYS = 14;

/**
 * Fairness Radar: rule-based flags computed from persisted records. Every
 * flag names the rule that fired, the measured value and the configured
 * limit. There are no predictions and no scores about people.
 *
 *   hours       LONG_SHIFT, WEEKLY_HOURS, SHORT_REST, NO_WEEKLY_OFF (fatigue.js)
 *   attendance  MISSING_CHECKOUT  open shift older than staleShiftHours
 *   pay         BELOW_MIN_WAGE    daily rate below the configured minimum
 *               PAY_DISPUTE_OPEN  a pay dispute waiting for a decision
 *   case        CASE_OVERDUE      acknowledge/resolve deadline passed (escalated)
 *               CRITICAL_OPEN     a critical safety report not yet resolved
 *               CASE_REOPENED     the worker said the fix did not work
 */
function buildRadar({ org, workers, shifts, cases, now }) {
  const { rules, tz } = org;
  const today = dayKey(now, tz);
  const byUser = new Map(workers.map((w) => [w.id, []]));
  for (const s of shifts) byUser.get(s.userId)?.push(s);

  const flags = [];
  const rows = workers.map((w) => {
    const list = byUser.get(w.id);
    const who = { workerId: w.id, workerName: w.name };

    for (const f of evaluateFatigue(list, rules, now, tz)) flags.push({ kind: 'hours', ...who, ...f });

    for (const s of missingCheckouts(list, rules, now)) {
      flags.push({
        kind: 'attendance',
        code: 'MISSING_CHECKOUT',
        severity: 'warning',
        ...who,
        shiftId: s.id,
        day: dayKey(s.checkIn, tz),
        value: round1((now - s.checkIn) / HOUR),
        limit: rules.staleShiftHours,
      });
    }

    const dailyRate = Math.round(hourlyRate(w.wage, rules) * rules.dailyHours);
    if (dailyRate < org.minimumDailyWage) {
      flags.push({ kind: 'pay', code: 'BELOW_MIN_WAGE', severity: 'critical', ...who, value: dailyRate, limit: org.minimumDailyWage });
    }

    const lastWeek = list.filter((s) => (s.checkOut ?? now) >= now - 7 * DAY && !isStale(s, rules, now));
    const current = currentShift(list, rules, now);
    return {
      id: w.id,
      name: w.name,
      jobRole: w.jobRole,
      wage: w.wage,
      dailyRate,
      onShiftSince: current ? current.checkIn : null,
      weekHours: round1(lastWeek.reduce((sum, s) => sum + hoursWithin(s, now - 7 * DAY, now), 0)),
      weekOvertime: round1(splitHours(lastWeek, rules, tz).overtimeHours),
      days: new Set(list.map((s) => dayKey(s.checkIn, tz))),
    };
  });

  for (const c of cases) {
    const ref = { caseId: c.id, caseRef: c.ref, caseType: c.type, category: c.category };
    if (isOverdue(c, now)) {
      const stage = c.status === 'open' ? 'ack' : 'resolve';
      flags.push({
        kind: 'case',
        code: 'CASE_OVERDUE',
        severity: c.severity === 'critical' || c.severity === 'high' ? 'critical' : 'warning',
        ...ref,
        stage,
        caseSeverity: c.severity,
        value: round1((now - c.dueAt) / HOUR),
        limit: stageHours(org.caseRules, c, stage),
        escalatedTo: c.escalatedTo || org.caseRules.escalateTo,
      });
    }
    if (!isActive(c)) continue;
    if (c.type !== 'pay' && c.severity === 'critical') flags.push({ kind: 'case', code: 'CRITICAL_OPEN', severity: 'critical', ...ref });
    if (c.type === 'pay' && !isOverdue(c, now)) {
      flags.push({ kind: 'pay', code: 'PAY_DISPUTE_OPEN', severity: 'info', ...ref, value: round1((now - c.createdAt) / HOUR) });
    }
    if (c.reopenCount > 0) flags.push({ kind: 'case', code: 'CASE_REOPENED', severity: 'warning', ...ref, value: c.reopenCount });
  }

  flags.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  const active = cases.filter(isActive);
  const trend = Array.from({ length: TREND_DAYS }, (_, i) => {
    const day = addDays(today, i - (TREND_DAYS - 1));
    return { day, present: rows.filter((r) => r.days.has(day)).length };
  });
  const flagged = (kind) => new Set(flags.filter((f) => f.kind === kind && f.workerId).map((f) => f.workerId)).size;

  return {
    today,
    kpis: {
      headcount: workers.length,
      onShiftNow: rows.filter((r) => r.onShiftSince).length,
      presentToday: trend.at(-1).present,
      openPayDisputes: active.filter((c) => c.type === 'pay').length,
      openSafetyReports: active.filter((c) => c.type === 'safety').length,
      openGrievances: active.filter((c) => c.type === 'grievance').length,
      overdueCases: cases.filter((c) => isOverdue(c, now)).length,
      awaitingConfirmation: cases.filter((c) => c.status === 'resolved').length,
      excessiveHours: flagged('hours'),
      attendanceIssues: flags.filter((f) => f.code === 'MISSING_CHECKOUT').length,
      belowMinimumWage: flags.filter((f) => f.code === 'BELOW_MIN_WAGE').length,
    },
    flags,
    trend,
    workers: rows.map(({ days, ...r }) => ({ ...r, flags: flags.filter((f) => f.workerId === r.id).map((f) => f.code) })),
  };
}

module.exports = { buildRadar };
