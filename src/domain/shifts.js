'use strict';

const crypto = require('node:crypto');
const { HOUR, dayKey, weekKey } = require('./time');

const EARTH_RADIUS_M = 6_371_000;
// GPS on budget phones is noisy; give up to 50 m of benefit of the doubt.
const MAX_ACCURACY_CREDIT_M = 50;

function distanceMeters(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function isWithinGeofence(point, site) {
  const credit = Math.min(Math.max(point.accuracy || 0, 0), MAX_ACCURACY_CREDIT_M);
  return distanceMeters(point, site) - credit <= site.radiusM;
}

/**
 * Six-digit check-in code printed as a QR poster at the site. It rotates daily
 * (HMAC of site + date), so a photo of yesterday's poster is useless.
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

module.exports = { distanceMeters, isWithinGeofence, siteCode, shiftHours, hoursWithin, splitHours };
