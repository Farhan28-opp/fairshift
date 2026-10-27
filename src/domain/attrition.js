'use strict';

const { DAY, dayKey } = require('./time');
const { worstSeverity } = require('./fatigue');

const WINDOW_DAYS = 14;
const NEW_JOINER_DAYS = 90;

/**
 * Explainable quit-risk score (0-100). Every point comes from a named factor
 * the manager can act on; there is no hidden model. Anonymous feedback is
 * never used here, so speaking up can never raise a worker's risk score.
 */
function attritionRisk({ shifts, now, tzOffsetMinutes, joinedAt, fatigueFlags = [], openPayQueries = 0, workDaysPerWeek = 6 }) {
  const expected = Math.round((WINDOW_DAYS / 7) * workDaysPerWeek);
  const daysIn = (from, to) =>
    new Set(shifts.filter((s) => s.checkIn >= from && s.checkIn < to).map((s) => dayKey(s.checkIn, tzOffsetMinutes)))
      .size;

  const recentRate = daysIn(now - WINDOW_DAYS * DAY, now) / expected;
  const priorRate = daysIn(now - 2 * WINDOW_DAYS * DAY, now - WINDOW_DAYS * DAY) / expected;
  const tenureDays = Math.floor((now - joinedAt) / DAY);
  const factors = [];

  // Only compare attendance once there is a full prior window to compare with.
  if (tenureDays >= 2 * WINDOW_DAYS && priorRate - recentRate >= 0.25) {
    factors.push({ code: 'ATTENDANCE_DROP', points: 30, from: pct(priorRate), to: pct(recentRate) });
  } else if (tenureDays >= WINDOW_DAYS && recentRate < 0.6) {
    factors.push({ code: 'LOW_ATTENDANCE', points: 15, rate: pct(recentRate) });
  }

  const fatigue = worstSeverity(fatigueFlags);
  if (fatigue === 'critical') factors.push({ code: 'OVERWORK', points: 20 });
  else if (fatigue === 'warning') factors.push({ code: 'OVERWORK', points: 10 });

  if (openPayQueries > 0) factors.push({ code: 'PAY_DISPUTE', points: 15, count: openPayQueries });
  if (tenureDays < NEW_JOINER_DAYS) factors.push({ code: 'NEW_JOINER', points: 10, days: tenureDays });

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const level = score >= 45 ? 'high' : score >= 25 ? 'medium' : 'low';
  return { score, level, factors };
}

const pct = (rate) => Math.round(Math.min(rate, 1) * 100);

module.exports = { attritionRisk };
