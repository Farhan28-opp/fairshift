'use strict';

const { HttpError } = require('./errors');

/** Tiny input validators. Each returns the clean value or throws a 400. */
const invalid = (field) => new HttpError(400, 'invalid_input', { field });

function text(value, field, { min = 0, max = 500, optional = false } = {}) {
  if (value == null || value === '') {
    if (optional) return null;
    throw invalid(field);
  }
  if (typeof value !== 'string') throw invalid(field);
  const clean = value.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (clean.length < min || clean.length > max) throw invalid(field);
  return clean;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw invalid(field);
  return value;
}

function number(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(field);
  return value;
}

function integer(value, field, opts) {
  const n = number(value, field, opts);
  if (n != null && !Number.isInteger(n)) throw invalid(field);
  return n;
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

module.exports = { text, oneOf, number, integer, bool, pattern, phone };
