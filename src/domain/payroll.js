'use strict';

const { splitHours } = require('./shifts');
const { addDays, round2 } = require('./time');

/** Ordinary hourly rate in paise. Monthly salaries assume `workingDaysPerMonth`. */
function hourlyRate(wage, rules) {
  const dailyRate = wage.type === 'daily' ? wage.amount : wage.amount / rules.workingDaysPerMonth;
  return dailyRate / rules.dailyHours;
}

/**
 * Builds a payslip that a worker can check line by line.
 * Pure function: no I/O, deterministic, integer paise throughout.
 *
 * @param {object} p
 * @param {object} p.worker  { wage: {type: 'daily'|'monthly', amount}, allowances, pfEnrolled, advances }
 * @param {Array}  p.shifts  all shifts for the worker (filtered here)
 * @param {object} p.rules   sector rules (see config/sectors.js)
 * @param {string} p.month   'YYYY-MM'
 * @param {number} p.tzOffsetMinutes
 * @param {number} p.minimumDailyWage  paise, state-notified minimum
 */
function computePayslip({ worker, shifts, rules, month, tzOffsetMinutes, minimumDailyWage }) {
  // Include the 6 days before the month so the weekly 48-hour rule sees the whole week.
  const from = addDays(`${month}-01`, -6);
  const split = splitHours(shifts, rules, tzOffsetMinutes);
  const days = split.days.filter((d) => d.day >= from && d.day.startsWith(month));

  const ordinaryHours = days.reduce((s, d) => s + d.ordinary, 0);
  const overtimeHours = days.reduce((s, d) => s + d.overtime, 0);
  const rate = hourlyRate(worker.wage, rules);

  let basic = Math.round(ordinaryHours * rate);
  if (worker.wage.type === 'monthly') basic = Math.min(basic, worker.wage.amount);
  const overtime = Math.round(overtimeHours * rate * rules.overtimeMultiplier);

  const earnings = [
    { code: 'basic', kind: 'earning', amount: basic, hours: round2(ordinaryHours), days: days.length },
    {
      code: 'overtime',
      kind: 'earning',
      amount: overtime,
      hours: round2(overtimeHours),
      multiplier: rules.overtimeMultiplier,
    },
    ...(worker.allowances || []).map((a) => ({ code: a.code, kind: 'earning', amount: a.amount })),
  ];
  const gross = earnings.reduce((s, l) => s + l.amount, 0);

  const deductions = [];
  if (worker.pfEnrolled) {
    deductions.push({
      code: 'pf',
      kind: 'deduction',
      amount: Math.round(Math.min(basic, rules.pfWageCeiling) * rules.pfRate),
      ratePct: round2(rules.pfRate * 100),
    });
  }
  if (gross > 0 && gross <= rules.esiGrossCeiling) {
    deductions.push({
      code: 'esi',
      kind: 'deduction',
      amount: Math.round(gross * rules.esiRate),
      ratePct: round2(rules.esiRate * 100),
    });
  }
  const advance = worker.advances?.[month] || 0;
  if (advance > 0) deductions.push({ code: 'advance', kind: 'deduction', amount: advance });

  const totalDeductions = deductions.reduce((s, l) => s + l.amount, 0);
  const effectiveDailyRate = Math.round(rate * rules.dailyHours);

  return {
    month,
    currency: 'INR',
    daysPresent: days.length,
    hourlyRate: Math.round(rate),
    lines: [...earnings, ...deductions],
    gross,
    totalDeductions,
    net: gross - totalDeductions,
    days: days.map((d) => ({ day: d.day, hours: round2(d.hours), overtime: round2(d.overtime) })),
    compliance: {
      minimumWage: {
        ok: effectiveDailyRate >= minimumDailyWage,
        dailyRate: effectiveDailyRate,
        minimum: minimumDailyWage,
      },
      overtimeRate: { ok: rules.overtimeMultiplier >= 2, multiplier: rules.overtimeMultiplier },
    },
  };
}

module.exports = { computePayslip, hourlyRate };
