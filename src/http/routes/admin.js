'use strict';

const express = require('express');
const QRCode = require('qrcode');
const v = require('../validate');
const { HttpError } = require('../errors');
const { presentReportForAdmin, presentPayQuery } = require('../present');
const { DAY, HOUR, dayKey, monthKey, addDays, addMonths, round1 } = require('../../domain/time');
const { siteCode, splitHours, hoursWithin } = require('../../domain/shifts');
const { computePayslip, hourlyRate } = require('../../domain/payroll');
const { evaluateFatigue, worstSeverity } = require('../../domain/fatigue');
const { attritionRisk } = require('../../domain/attrition');
const { SEVERITIES } = require('../../domain/triage');
const { aggregateFeedback } = require('../../domain/anonymity');

const REPORT_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved'];
const ATTENTION_LIMIT = 8;

/** Spreadsheet-safe CSV cell: quotes, and neutralises formula injection (=, +, -, @). */
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const rupees = (paise) => (paise / 100).toFixed(2);

function adminRouter({ store, clock, config }) {
  const r = express.Router();
  const orgOf = (req) => store.getOrg(req.user.orgId);

  function workerMetrics(worker, org, now) {
    const shifts = store.shiftsFor(worker.id);
    const fatigue = evaluateFatigue(shifts, org.rules, now, org.tz);
    const openPayQueries = store.payQueriesForUser(worker.id).filter((q) => q.status !== 'resolved').length;
    const risk = attritionRisk({
      shifts,
      now,
      tzOffsetMinutes: org.tz,
      joinedAt: worker.joinedAt,
      fatigueFlags: fatigue,
      openPayQueries,
      workDaysPerWeek: org.workDaysPerWeek,
    });
    const open = store.openShift(worker.id);
    const lastWeek = shifts.filter((s) => s.checkIn >= now - 7 * DAY);
    const dailyRate = Math.round(hourlyRate(worker.wage, org.rules) * org.rules.dailyHours);
    return {
      id: worker.id,
      name: worker.name,
      jobRole: worker.jobRole,
      lang: worker.lang,
      checkedInAt: open ? open.checkIn : null,
      weekHours: round1(lastWeek.reduce((s, sh) => s + hoursWithin(sh, now - 7 * DAY, now), 0)),
      weekOvertime: round1(splitHours(lastWeek, org.rules, org.tz).overtimeHours),
      fatigue,
      fatigueLevel: worstSeverity(fatigue),
      risk,
      dailyRate,
      belowMinimumWage: dailyRate < org.minimumDailyWage,
      skills: worker.skills,
      _days: new Set(shifts.map((s) => dayKey(s.checkIn, org.tz))),
    };
  }

  /** One ranked list of what a manager should act on first. */
  function attentionQueue({ workers, reports, payQueries, org, now }) {
    const items = [];
    for (const rep of reports) {
      if (rep.sla.escalated) {
        items.push({ kind: 'report', priority: rep.severity === 'critical' ? 100 : 60 + SEVERITIES.indexOf(rep.severity), id: rep.id, severity: rep.severity, category: rep.category, summary: rep.summaryEn || rep.description, overdueHours: round1(-rep.sla.hoursLeft) });
      }
    }
    for (const w of workers) {
      if (w.fatigueLevel === 'critical') items.push({ kind: 'fatigue', priority: 90, workerId: w.id, name: w.name, flags: w.fatigue });
      if (w.belowMinimumWage) items.push({ kind: 'min_wage', priority: 55, workerId: w.id, name: w.name, dailyRate: w.dailyRate, minimum: org.minimumDailyWage });
      if (w.risk.level === 'high') items.push({ kind: 'risk', priority: 40, workerId: w.id, name: w.name, score: w.risk.score, factors: w.risk.factors });
    }
    for (const q of payQueries) {
      if (q.status !== 'resolved') items.push({ kind: 'pay_query', priority: 50, id: q.id, name: q.workerName, lineCode: q.lineCode, ageHours: round1((now - q.createdAt) / HOUR) });
    }
    return items.sort((a, b) => b.priority - a.priority).slice(0, ATTENTION_LIMIT);
  }

  r.get('/overview', (req, res) => {
    const now = clock();
    const org = orgOf(req);
    const today = dayKey(now, org.tz);
    const workers = store.listWorkers(org.id).map((w) => workerMetrics(w, org, now));

    const trend = Array.from({ length: 14 }, (_, i) => {
      const day = addDays(today, i - 13);
      return { day, present: workers.filter((w) => w._days.has(day)).length };
    });

    const reports = store
      .reportsForOrg(org.id)
      .map((rep) => presentReportForAdmin(rep, now, store))
      .sort(
        (a, b) =>
          (a.status === 'resolved') - (b.status === 'resolved') ||
          b.sla.escalated - a.sla.escalated ||
          SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
          b.createdAt - a.createdAt,
      );
    const payQueries = store.payQueriesForOrg(org.id).map((q) => presentPayQuery(q, store));
    const feedback = aggregateFeedback(store.feedbackForOrg(org.id, addDays(today, -28)));
    const openReports = reports.filter((rep) => rep.status !== 'resolved');

    res.json({
      org: {
        id: org.id,
        name: org.name,
        sector: org.sector,
        city: org.city,
        minimumDailyWage: org.minimumDailyWage,
        rules: org.rules,
      },
      admin: { name: req.user.name, title: req.user.title },
      today,
      kpis: {
        headcount: workers.length,
        onShiftNow: workers.filter((w) => w.checkedInAt).length,
        presentToday: trend.at(-1).present,
        weekOvertimeHours: round1(workers.reduce((s, w) => s + w.weekOvertime, 0)),
        openReports: openReports.length,
        escalatedReports: openReports.filter((rep) => rep.sla.escalated).length,
        fatigueAlerts: workers.filter((w) => w.fatigue.length).length,
        highRisk: workers.filter((w) => w.risk.level === 'high').length,
        belowMinimumWage: workers.filter((w) => w.belowMinimumWage).length,
        openPayQueries: payQueries.filter((q) => q.status !== 'resolved').length,
      },
      attention: attentionQueue({ workers, reports, payQueries, org, now }),
      trend,
      workers: workers.map(({ _days, ...w }) => w),
      reports,
      payQueries,
      feedback,
    });
  });

  r.patch('/reports/:id', (req, res) => {
    const report = store.getReport(req.params.id);
    if (!report || report.orgId !== req.user.orgId) throw new HttpError(404, 'not_found');
    const status = v.oneOf(req.body?.status, 'status', REPORT_STATUSES);
    const response = v.text(req.body?.response, 'response', { max: 500, optional: true });
    store.updateReport(report.id, { status, response: response ?? report.response, updatedAt: clock() });
    res.json({ report: presentReportForAdmin(report, clock(), store) });
  });

  r.patch('/pay-queries/:id', (req, res) => {
    const query = store.getPayQuery(req.params.id);
    if (!query || query.orgId !== req.user.orgId) throw new HttpError(404, 'not_found');
    const status = v.oneOf(req.body?.status, 'status', ['open', 'resolved']);
    const response = v.text(req.body?.response, 'response', { max: 500, optional: true });
    store.updatePayQuery(query.id, { status, response: response ?? query.response });
    res.json({ query: presentPayQuery(query, store) });
  });

  /** Employer endorses a skill: it shows as verified on the worker's passport. */
  r.post('/workers/:id/skills', (req, res) => {
    const worker = store.getUser(req.params.id);
    if (!worker || worker.orgId !== req.user.orgId || worker.role !== 'worker') throw new HttpError(404, 'not_found');
    const org = orgOf(req);
    const name = v.text(req.body?.name, 'name', { min: 2, max: 80 });
    const skill = { name, issuer: org.name, date: dayKey(clock(), org.tz), verified: true };
    store.updateUser(worker.id, { skills: [...(worker.skills || []), skill] });
    res.status(201).json({ skill });
  });

  r.get('/site-code', (req, res) => {
    const org = orgOf(req);
    const day = dayKey(clock(), org.tz);
    res.set('Cache-Control', 'no-store').json({ code: siteCode(config.appSecret, org.site.id, day), validOn: day });
  });

  /** Poster QR. Scanning it with any camera app opens FairShift with the code filled in. */
  r.get('/site-qr.svg', async (req, res) => {
    const org = orgOf(req);
    const code = siteCode(config.appSecret, org.site.id, dayKey(clock(), org.tz));
    const svg = await QRCode.toString(`${req.protocol}://${req.get('host')}/?checkin=${code}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#18212B', light: '#FFFFFF' },
    });
    res.set('Cache-Control', 'no-store').type('image/svg+xml').send(svg);
  });

  /** Statutory-style wage register for the month, ready for Excel. */
  r.get('/wage-register.csv', (req, res) => {
    const org = orgOf(req);
    const current = monthKey(clock(), org.tz);
    const month = req.query.month == null ? current : v.oneOf(String(req.query.month), 'month', [current, addMonths(current, -1), addMonths(current, -2)]);
    const header = ['Name', 'Role', 'Days present', 'Ordinary hours', 'Overtime hours', 'Basic', 'Overtime pay', 'Allowances', 'Gross', 'PF', 'ESI', 'Advance', 'Total deductions', 'Net pay', 'Daily rate', 'Minimum daily wage', 'Meets minimum wage'];
    const rows = store.listWorkers(org.id).map((w) => {
      const p = computePayslip({ worker: w, shifts: store.shiftsFor(w.id), rules: org.rules, month, tzOffsetMinutes: org.tz, minimumDailyWage: org.minimumDailyWage });
      const line = (code) => p.lines.find((l) => l.code === code);
      const allowances = p.lines.filter((l) => l.kind === 'earning' && !['basic', 'overtime'].includes(l.code)).reduce((s, l) => s + l.amount, 0);
      return [
        w.name, w.jobRole, p.daysPresent, line('basic').hours, line('overtime').hours,
        rupees(line('basic').amount), rupees(line('overtime').amount), rupees(allowances), rupees(p.gross),
        rupees(line('pf')?.amount || 0), rupees(line('esi')?.amount || 0), rupees(line('advance')?.amount || 0),
        rupees(p.totalDeductions), rupees(p.net), rupees(p.compliance.minimumWage.dailyRate),
        rupees(p.compliance.minimumWage.minimum), p.compliance.minimumWage.ok ? 'Yes' : 'No',
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
    res.set('Cache-Control', 'no-store').type('text/csv').attachment(`wage-register-${org.id}-${month}.csv`).send(`﻿${csv}`);
  });

  return r;
}

module.exports = { adminRouter, csvCell };
