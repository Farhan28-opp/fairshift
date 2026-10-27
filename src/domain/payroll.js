'use strict';

const { splitHours, shiftHours } = require('./shifts');
const { dayKey, round2 } = require('./time');

/** Payslip amounts are rounded to whole rupees (100 paise), so every line adds up exactly. */
const toRupee = (paise) => Math.round(paise / 100) * 100;

/** Ordinary hourly rate in paise. Monthly salaries assume `workingDaysPerMonth`. */
function hourlyRate(wage, rules) {
  const dailyRate = wage.type === 'daily' ? wage.amount : wage.amount / rules.workingDaysPerMonth;
  return dailyRate / rules.dailyHours;
}

/**
 * Builds a payslip a worker can check line by line. Pure and deterministic:
 * integer paise throughout, and every line carries the numbers used to
 * calculate it so the UI can explain it in plain words.
 *
 * @param {object} p
 * @param {object} p.worker       { wage: {type, amount}, allowances, pfEnrolled, advances }
 * @param {Array}  p.shifts       the worker's shifts (all of them; the weekly rule needs the prior week)
 * @param {object} p.rules        organisation rules (config/industries.js)
 * @param {string} p.month        'YYYY-MM'
 * @param {number} p.tzOffsetMinutes
 * @param {number} p.minimumDailyWage  paise, state-notified minimum
 * @param {Array}  [p.adjustments]     agreed corrections from resolved pay disputes
 */
function computePayslip({ worker, shifts, rules, month, tzOffsetMinutes, minimumDailyWage, adjustments = [] }) {
  const split = splitHours(shifts, rules, tzOffsetMinutes);
  const days = split.days.filter((d) => d.day.startsWith(month));

  const ordinaryHours = days.reduce((s, d) => s + d.ordinary, 0);
  const overtimeHours = days.reduce((s, d) => s + d.overtime, 0);
  const rate = hourlyRate(worker.wage, rules);

  const uncappedBasic = toRupee(ordinaryHours * rate);
  const capped = worker.wage.type === 'monthly' && uncappedBasic > worker.wage.amount;
  const basic = capped ? worker.wage.amount : uncappedBasic;
  const overtime = toRupee(overtimeHours * rate * rules.overtimeMultiplier);

  const monthAdjustments = adjustments.filter((a) => a.month === month);
  const earnings = [
    {
      code: 'basic',
      kind: 'earning',
      amount: basic,
      hours: round2(ordinaryHours),
      days: days.length,
      rate: Math.round(rate),
      wageType: worker.wage.type,
      wageAmount: worker.wage.amount,
      capped,
    },
    {
      code: 'overtime',
      kind: 'earning',
      amount: overtime,
      hours: round2(overtimeHours),
      rate: Math.round(rate * rules.overtimeMultiplier),
      multiplier: rules.overtimeMultiplier,
    },
    ...(worker.allowances || []).map((a) => ({ code: a.code, kind: 'earning', amount: a.amount })),
  ];
  const wageGross = earnings.reduce((s, l) => s + l.amount, 0);

  const deductions = [];
  if (worker.pfEnrolled) {
    const base = Math.min(basic, rules.pfWageCeiling);
    deductions.push({ code: 'pf', kind: 'deduction', amount: toRupee(base * rules.pfRate), ratePct: round2(rules.pfRate * 100), base });
  }
  if (wageGross > 0 && wageGross <= rules.esiGrossCeiling) {
    deductions.push({ code: 'esi', kind: 'deduction', amount: toRupee(wageGross * rules.esiRate), ratePct: round2(rules.esiRate * 100), base: wageGross });
  }
  const advance = worker.advances?.[month] || 0;
  if (advance > 0) deductions.push({ code: 'advance', kind: 'deduction', amount: advance });

  // Agreed corrections are listed separately, with the case they came from.
  for (const a of monthAdjustments) {
    const line = { amount: Math.abs(a.amount), caseRef: a.caseRef, reason: a.reason, adjustmentId: a.id };
    if (a.amount >= 0) earnings.push({ code: 'adjustment', kind: 'earning', ...line });
    else deductions.push({ code: 'recovery', kind: 'deduction', ...line });
  }

  const gross = earnings.reduce((s, l) => s + l.amount, 0);
  const totalDeductions = deductions.reduce((s, l) => s + l.amount, 0);
  const effectiveDailyRate = Math.round(rate * rules.dailyHours);

  // The underlying attendance records, including any that are missing a check-out.
  const records = shifts
    .filter((s) => dayKey(s.checkIn, tzOffsetMinutes).startsWith(month))
    .sort((a, b) => a.checkIn - b.checkIn)
    .map((s) => ({
      id: s.id,
      day: dayKey(s.checkIn, tzOffsetMinutes),
      checkIn: s.checkIn,
      checkOut: s.checkOut ?? null,
      hours: s.checkOut == null ? null : round2(shiftHours(s)),
      corrected: Boolean(s.corrections?.length),
    }));

  return {
    month,
    currency: 'INR',
    daysPresent: days.length,
    hourlyRate: Math.round(rate),
    lines: [...earnings, ...deductions],
    gross,
    totalDeductions,
    net: gross - totalDeductions,
    days: days.map((d) => ({ day: d.day, hours: round2(d.hours), ordinary: round2(d.ordinary), overtime: round2(d.overtime) })),
    records,
    rules: {
      dailyHours: rules.dailyHours,
      weeklyHours: rules.weeklyHours,
      overtimeMultiplier: rules.overtimeMultiplier,
      workingDaysPerMonth: rules.workingDaysPerMonth,
    },
    compliance: {
      minimumWage: { ok: effectiveDailyRate >= minimumDailyWage, dailyRate: effectiveDailyRate, minimum: minimumDailyWage },
      overtimeRate: { ok: rules.overtimeMultiplier >= 2, multiplier: rules.overtimeMultiplier },
    },
  };
}

/**
 * Evidence frozen into a pay dispute when it is raised: the disputed line,
 * the totals and the attendance records the worker pointed at (or the whole
 * month). The investigator compares it with the live payslip later.
 */
function paySnapshot(payslip, lineCode, days = [], takenAt = null) {
  const records = days.length ? payslip.records.filter((r) => days.includes(r.day)) : payslip.records;
  return {
    takenAt,
    line: payslip.lines.find((l) => l.code === lineCode) || null,
    gross: payslip.gross,
    net: payslip.net,
    hourlyRate: payslip.hourlyRate,
    daysPresent: payslip.daysPresent,
    records,
  };
}

module.exports = { computePayslip, hourlyRate, paySnapshot };
