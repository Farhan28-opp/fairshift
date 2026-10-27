'use strict';

const { DAY, HOUR, dayKey, addDays, round1 } = require('./time');
const { shiftHours, hoursWithin } = require('./shifts');

const SEVERITY_RANK = Object.freeze({ warning: 1, critical: 2 });

/**
 * Flags overwork patterns in the last 7 days. Each flag carries the measured
 * value and the limit, so the UI can say exactly why it fired.
 *
 *   LONG_SHIFT     one shift (or the one running now) longer than maxShiftHours
 *   WEEKLY_HOURS   more than weeklyHours in a rolling 7 days
 *   SHORT_REST     less than minRestHours between two shifts (back-to-back)
 *   NO_WEEKLY_OFF  more than maxConsecutiveDays worked in a row
 */
function evaluateFatigue(shifts, rules, now, tzOffsetMinutes) {
  const windowStart = now - 7 * DAY;
  const recent = shifts
    .filter((s) => (s.checkOut ?? now) >= windowStart && s.checkIn <= now)
    .sort((a, b) => a.checkIn - b.checkIn);
  const flags = [];

  const longest = recent.reduce((max, s) => Math.max(max, shiftHours(s, now)), 0);
  if (longest > rules.maxShiftHours) {
    flags.push({
      code: 'LONG_SHIFT',
      severity: longest > rules.maxShiftHours + 2 ? 'critical' : 'warning',
      value: round1(longest),
      limit: rules.maxShiftHours,
    });
  }

  const weekHours = recent.reduce((sum, s) => sum + hoursWithin(s, windowStart, now), 0);
  if (weekHours > rules.weeklyHours) {
    flags.push({
      code: 'WEEKLY_HOURS',
      severity: weekHours > rules.weeklyHours * 1.25 ? 'critical' : 'warning',
      value: round1(weekHours),
      limit: rules.weeklyHours,
    });
  }

  let shortestRest = Infinity;
  for (let i = 1; i < recent.length; i += 1) {
    const prev = recent[i - 1];
    if (prev.checkOut == null) continue;
    shortestRest = Math.min(shortestRest, (recent[i].checkIn - prev.checkOut) / HOUR);
  }
  if (shortestRest < rules.minRestHours) {
    flags.push({
      code: 'SHORT_REST',
      severity: shortestRest < rules.minRestHours / 2 ? 'critical' : 'warning',
      value: round1(Math.max(0, shortestRest)),
      limit: rules.minRestHours,
    });
  }

  const worked = new Set(shifts.map((s) => dayKey(s.checkIn, tzOffsetMinutes)));
  let day = dayKey(now, tzOffsetMinutes);
  if (!worked.has(day)) day = addDays(day, -1);
  let streak = 0;
  while (worked.has(day)) {
    streak += 1;
    day = addDays(day, -1);
  }
  if (streak > rules.maxConsecutiveDays) {
    flags.push({
      code: 'NO_WEEKLY_OFF',
      severity: streak >= rules.maxConsecutiveDays + 4 ? 'critical' : 'warning',
      value: streak,
      limit: rules.maxConsecutiveDays,
    });
  }

  return flags;
}

function worstSeverity(flags) {
  return flags.reduce((worst, f) => (SEVERITY_RANK[f.severity] > (SEVERITY_RANK[worst] || 0) ? f.severity : worst), null);
}

module.exports = { evaluateFatigue, worstSeverity };
