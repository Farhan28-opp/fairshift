'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePayslip, hourlyRate, paySnapshot } = require('../src/domain/payroll');
const { INDUSTRIES, RUPEE } = require('../src/config/industries');

const TZ = 330;
const rules = INDUSTRIES.construction.rules;
const HOUR = 3_600_000;
/** A shift on a local (IST) day: start hour and length in hours. */
const shift = (day, start, hours, extra = {}) => {
  const checkIn = Date.parse(`${day}T00:00:00Z`) - TZ * 60_000 + start * HOUR;
  return { id: `${day}-${start}`, checkIn, checkOut: hours == null ? null : checkIn + hours * HOUR, ...extra };
};
const dailyWorker = { wage: { type: 'daily', amount: 800 * RUPEE }, allowances: [], pfEnrolled: false, advances: {} };
const slip = (worker, shifts, extra = {}) =>
  computePayslip({ worker, shifts, rules, month: '2026-10', tzOffsetMinutes: TZ, minimumDailyWage: 700 * RUPEE, ...extra });
const line = (p, code) => p.lines.find((l) => l.code === code);

test('daily wage: 8 ordinary hours are paid at the daily rate, extra hours at 2x', () => {
  const p = slip(dailyWorker, [shift('2026-10-05', 8, 10)]);
  assert.equal(line(p, 'basic').amount, 800 * RUPEE);
  assert.equal(line(p, 'basic').hours, 8);
  assert.equal(line(p, 'overtime').hours, 2);
  // 800 / 8 = 100 an hour; 2 h at 2x = 400
  assert.equal(line(p, 'overtime').amount, 400 * RUPEE);
  assert.equal(line(p, 'overtime').rate, 200 * RUPEE);
  assert.equal(p.gross, 1200 * RUPEE);
  // ESI (0.75%) applies because gross is under the ₹21,000 ceiling: ₹9.
  assert.equal(line(p, 'esi').amount, 9 * RUPEE);
  assert.equal(p.net, 1191 * RUPEE);
});

test('weekly rule: ordinary hours beyond 48 in a Monday-start week become overtime', () => {
  // Mon 5 Oct to Sun 11 Oct: seven 8-hour days = 56 h, so the 7th day is overtime.
  const days = ['05', '06', '07', '08', '09', '10', '11'].map((d) => shift(`2026-10-${d}`, 8, 8));
  const p = slip(dailyWorker, days);
  assert.equal(line(p, 'basic').hours, 48);
  assert.equal(line(p, 'overtime').hours, 8);
  assert.equal(line(p, 'overtime').amount, 8 * 200 * RUPEE);
});

test('shifts without a check-out are never paid until corrected', () => {
  const p = slip(dailyWorker, [shift('2026-10-05', 8, 8), shift('2026-10-06', 8, null)]);
  assert.equal(p.daysPresent, 1);
  assert.equal(line(p, 'basic').hours, 8);
  const missing = p.records.find((r) => r.day === '2026-10-06');
  assert.equal(missing.checkOut, null);
  assert.equal(missing.hours, null);
});

test('monthly salary is pro-rated by hours and capped at the salary', () => {
  const monthly = { wage: { type: 'monthly', amount: 15600 * RUPEE }, allowances: [], pfEnrolled: false };
  assert.equal(hourlyRate(monthly.wage, rules), (15600 * RUPEE) / 26 / 8);
  const days = Array.from({ length: 31 }, (_, i) => shift(`2026-10-${String(i + 1).padStart(2, '0')}`, 8, 8));
  const p = slip(monthly, days);
  assert.equal(line(p, 'basic').amount, 15600 * RUPEE);
  assert.equal(line(p, 'basic').capped, true);
});

test('PF is 12% of basic up to the ceiling; ESI applies only up to the gross ceiling', () => {
  const worker = { ...dailyWorker, pfEnrolled: true };
  const p = slip(worker, [shift('2026-10-05', 8, 8)]);
  assert.equal(line(p, 'pf').amount, Math.round(800 * 0.12) * RUPEE);
  assert.equal(line(p, 'esi').amount, Math.round(800 * 0.0075) * RUPEE);

  const rich = { wage: { type: 'daily', amount: 2000 * RUPEE }, pfEnrolled: true, allowances: [] };
  const days = Array.from({ length: 12 }, (_, i) => shift(`2026-10-${String(i + 1).padStart(2, '0')}`, 8, 8));
  const big = slip(rich, days);
  assert.equal(line(big, 'pf').amount, 15000 * 0.12 * RUPEE, 'PF base is capped at ₹15,000');
  assert.equal(line(big, 'esi'), undefined, 'no ESI above ₹21,000 gross');
});

test('every line is in whole rupees and the payslip adds up exactly', () => {
  const worker = { wage: { type: 'daily', amount: 733 * RUPEE }, allowances: [{ code: 'travel', amount: 600 * RUPEE }], pfEnrolled: true, advances: { '2026-10': 500 * RUPEE } };
  const p = slip(worker, [shift('2026-10-05', 8, 9.37), shift('2026-10-06', 7.5, 8.11)]);
  for (const l of p.lines) assert.equal(l.amount % RUPEE, 0, `${l.code} is whole rupees`);
  const earned = p.lines.filter((l) => l.kind === 'earning').reduce((s, l) => s + l.amount, 0);
  const deducted = p.lines.filter((l) => l.kind === 'deduction').reduce((s, l) => s + l.amount, 0);
  assert.equal(p.gross, earned);
  assert.equal(p.net, earned - deducted);
  assert.equal(line(p, 'advance').amount, 500 * RUPEE);
});

test('agreed adjustments appear as their own lines, linked to the case', () => {
  const adjustments = [
    { id: 'a1', month: '2026-10', amount: 1000 * RUPEE, caseRef: 'FS-AAAA-BBBB', reason: 'refund' },
    { id: 'a2', month: '2026-10', amount: -200 * RUPEE, caseRef: 'FS-CCCC-DDDD', reason: 'overpaid' },
    { id: 'a3', month: '2026-09', amount: 999 * RUPEE, caseRef: 'FS-OLD0-0000', reason: 'other month' },
  ];
  const p = slip(dailyWorker, [shift('2026-10-05', 8, 8)], { adjustments });
  assert.deepEqual(
    p.lines.filter((l) => ['adjustment', 'recovery'].includes(l.code)).map((l) => [l.code, l.amount, l.caseRef]),
    [
      ['adjustment', 1000 * RUPEE, 'FS-AAAA-BBBB'],
      ['recovery', 200 * RUPEE, 'FS-CCCC-DDDD'],
    ],
  );
  // ESI is on wages only (₹800 → ₹6), not on the correction.
  assert.equal(line(p, 'esi').amount, 6 * RUPEE);
  assert.equal(p.net, (800 + 1000 - 200 - 6) * RUPEE);
});

test('minimum-wage check compares the effective daily rate with the configured minimum', () => {
  const low = { ...dailyWorker, wage: { type: 'daily', amount: 680 * RUPEE } };
  assert.equal(slip(low, []).compliance.minimumWage.ok, false);
  assert.equal(slip(dailyWorker, []).compliance.minimumWage.ok, true);
});

test('a dispute snapshot freezes the disputed line and the named days', () => {
  const p = slip(dailyWorker, [shift('2026-10-05', 8, 10), shift('2026-10-06', 8, 8)]);
  const snap = paySnapshot(p, 'overtime', ['2026-10-05'], 123);
  assert.equal(snap.takenAt, 123);
  assert.equal(snap.line.code, 'overtime');
  assert.deepEqual(snap.records.map((r) => r.day), ['2026-10-05']);
  assert.equal(snap.net, p.net);
});
