'use strict';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Calendar day (YYYY-MM-DD) of a timestamp in a fixed UTC offset (India: +330). */
function dayKey(ts, tzOffsetMinutes) {
  return new Date(ts + tzOffsetMinutes * MINUTE).toISOString().slice(0, 10);
}

function monthKey(ts, tzOffsetMinutes) {
  return dayKey(ts, tzOffsetMinutes).slice(0, 7);
}

/** Timestamp of local midnight for a day key. */
function dayStart(key, tzOffsetMinutes) {
  return Date.parse(`${key}T00:00:00Z`) - tzOffsetMinutes * MINUTE;
}

function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday that starts the week containing `key`. */
function weekKey(key) {
  const dow = (new Date(`${key}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(key, -dow);
}

function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

module.exports = { MINUTE, HOUR, DAY, dayKey, monthKey, dayStart, addDays, weekKey, addMonths, round1, round2 };
