'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const { MINUTE, HOUR } = require('../domain/time');

const OTP_TTL = 5 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL = 12 * HOUR;
const COOKIE = 'fs_sid';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Passwordless login: phone number + one-time code. Workers never manage
 * passwords. OTPs and session ids are stored only as SHA-256 hashes.
 *
 * `sendOtp(phone, otp)` is the SMS gateway hook. In demo mode the code is
 * returned to the browser instead, because no SMS provider is configured.
 */
function createAuth({ store, clock = Date.now, demoMode = false, secureCookies = false, sendOtp }) {
  const otps = new Map();
  const sessions = new Map();

  function requestOtp(phone) {
    const user = store.getUserByPhone(phone);
    if (!user) return { sent: false };
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    otps.set(phone, { hash: sha256(otp), expiresAt: clock() + OTP_TTL, attempts: 0 });
    if (!demoMode) sendOtp(phone, otp);
    return { sent: true, otp: demoMode ? otp : undefined };
  }

  function verifyOtp(phone, otp) {
    const entry = otps.get(phone);
    if (!entry || entry.expiresAt < clock()) {
      otps.delete(phone);
      throw new HttpError(401, 'otp_expired');
    }
    entry.attempts += 1;
    if (entry.attempts > OTP_MAX_ATTEMPTS) {
      otps.delete(phone);
      throw new HttpError(429, 'too_many_attempts');
    }
    const supplied = sha256(String(otp));
    if (!crypto.timingSafeEqual(supplied, entry.hash)) throw new HttpError(401, 'otp_incorrect');
    otps.delete(phone);

    const user = store.getUserByPhone(phone);
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sha256(sid).toString('hex'), { userId: user.id, expiresAt: clock() + SESSION_TTL });
    return { sid, user };
  }

  function cookieHeader(value, maxAgeSeconds) {
    const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (secureCookies) parts.push('Secure');
    return parts.join('; ');
  }

  function setSessionCookie(res, sid) {
    res.setHeader('Set-Cookie', cookieHeader(sid, SESSION_TTL / 1000));
  }

  function clearSession(req, res) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) sessions.delete(sha256(sid).toString('hex'));
    res.setHeader('Set-Cookie', cookieHeader('', 0));
  }

  /** Middleware: resolves the session cookie to `req.user` (or leaves it null). */
  function attachUser(req, res, next) {
    req.user = null;
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid) {
      const key = sha256(sid).toString('hex');
      const session = sessions.get(key);
      if (session && session.expiresAt > clock()) req.user = store.getUser(session.userId);
      else if (session) sessions.delete(key);
    }
    next();
  }

  function requireRole(role) {
    return (req, res, next) => {
      if (!req.user) return next(new HttpError(401, 'not_signed_in'));
      if (req.user.role !== role) return next(new HttpError(403, 'forbidden'));
      return next();
    };
  }

  return { requestOtp, verifyOtp, setSessionCookie, clearSession, attachUser, requireRole };
}

module.exports = { createAuth, parseCookies };
