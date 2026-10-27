'use strict';

const { HttpError } = require('./errors');
const { MINUTE } = require('../domain/time');

/** Small input validators. Each returns the clean value or throws a 400 naming the field. */
const invalid = (field) => new HttpError(400, 'invalid_input', { field });

function text(value, field, { min = 0, max = 500, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw invalid(field);
  }
  if (typeof value !== 'string') throw invalid(field);
  // Strip control characters except tab and newlines.
  // eslint-disable-next-line no-control-regex
  const clean = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!clean && optional) return null;
  if (clean.length < min || clean.length > max) throw invalid(field);
  return clean;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw invalid(field);
  return value;
}

function integer(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if ((value == null || value === '') && optional) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw invalid(field);
  return value;
}

function pattern(value, field, regex) {
  if (typeof value !== 'string' || !regex.test(value)) throw invalid(field);
  return value;
}

/** Accepts "+91 90000 00101", "09000000101" etc. and returns the 10-digit Indian mobile number. */
function phone(value) {
  if (typeof value !== 'string') throw invalid('phone');
  const digits = value.replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(digits)) throw invalid('phone');
  return digits;
}

/** A list of distinct calendar days (YYYY-MM-DD) inside `month`. */
function days(value, field, month) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 31) throw invalid(field);
  const out = [...new Set(value)];
  for (const d of out) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !d.startsWith(`${month}-`) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
      throw invalid(field);
    }
  }
  return out.sort();
}

/** "YYYY-MM-DDTHH:MM" in the organisation's local time -> epoch milliseconds. */
function localDateTime(value, field, tzOffsetMinutes) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw invalid(field);
  const ts = Date.parse(`${value}:00Z`);
  if (Number.isNaN(ts)) throw invalid(field);
  return ts - tzOffsetMinutes * MINUTE;
}

module.exports = { text, oneOf, integer, bool, pattern, phone, days, localDateTime, invalid };
