'use strict';

const crypto = require('node:crypto');
const { HOUR, dayKey, weekKey } = require('./time');

/**
 * Six-digit check-in code printed as a QR poster at the site. It rotates daily
 * (HMAC of the organisation's secret + site + date), so a photo of yesterday's
 * poster is useless. The secret is stored per organisation in the database.
 */
function siteCode(secret, siteId, day) {
  const digest = crypto.createHmac('sha256', secret).update(`${siteId}:${day}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

function shiftHours(shift, now = shift.checkOut) {
  const end = shift.checkOut ?? now;
  return Math.max(0, (end - shift.checkIn) / HOUR);
}

/** Hours of a shift that fall inside [from, to). Open shifts run until `to`. */
function hoursWithin(shift, from, to) {
  const start = Math.max(shift.checkIn, from);
  const end = Math.min(shift.checkOut ?? to, to);
  return Math.max(0, (end - start) / HOUR);
}

/** An open shift older than `staleShiftHours` was never checked out: a record to fix, not a shift in progress. */
function isStale(shift, rules, now) {
  return shift.checkOut == null && now - shift.checkIn > rules.staleShiftHours * HOUR;
}

/** The shift the worker is on right now, if any. */
function currentShift(shifts, rules, now) {
  return shifts.filter((s) => s.checkOut == null && !isStale(s, rules, now)).sort((a, b) => b.checkIn - a.checkIn)[0] || null;
}

function missingCheckouts(shifts, rules, now) {
  return shifts.filter((s) => isStale(s, rules, now));
}

/**
 * Splits completed shifts into ordinary and overtime hours.
 * Daily rule: hours beyond `dailyHours` in a day are overtime.
 * Weekly rule: ordinary hours beyond `weeklyHours` in a Monday-start week
 * are also overtime. A shift belongs to the day it started on.
 */
function splitHours(shifts, rules, tzOffsetMinutes) {
  const byDay = new Map();
  for (const shift of shifts) {
    if (shift.checkOut == null) continue;
    const key = dayKey(shift.checkIn, tzOffsetMinutes);
    byDay.set(key, (byDay.get(key) || 0) + shiftHours(shift));
  }

  const days = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, hours]) => {
      const ordinary = Math.min(hours, rules.dailyHours);
      return { day, hours, ordinary, overtime: hours - ordinary };
    });

  const ordinaryByWeek = new Map();
  for (const d of days) {
    const week = weekKey(d.day);
    const used = ordinaryByWeek.get(week) || 0;
    const allowed = Math.max(0, rules.weeklyHours - used);
    if (d.ordinary > allowed) {
      d.overtime += d.ordinary - allowed;
      d.ordinary = allowed;
    }
    ordinaryByWeek.set(week, used + d.ordinary);
  }

  const total = (field) => days.reduce((sum, d) => sum + d[field], 0);
  return { days, hours: total('hours'), ordinaryHours: total('ordinary'), overtimeHours: total('overtime') };
}

module.exports = { siteCode, shiftHours, hoursWithin, isStale, currentShift, missingCheckouts, splitHours };
