'use strict';

const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { createRateLimiter } = require('../rateLimit');
const { presentUser } = require('../present');
const { MINUTE } = require('../../domain/time');

const LANGS = ['en', 'hi', 'ta'];

function authRouter({ auth, store, clock }) {
  const r = express.Router();
  const perIp = createRateLimiter({ windowMs: 15 * MINUTE, max: 30, key: (req) => req.ip, clock });
  const perPhone = createRateLimiter({
    windowMs: 15 * MINUTE,
    max: 5,
    key: (req) => String(req.body?.phone ?? '').replace(/\D/g, '').slice(-10),
    clock,
  });

  // Same answer whether or not the number is registered, so numbers cannot be enumerated.
  r.post('/request-otp', perIp, perPhone, (req, res) => {
    const phone = v.phone(req.body?.phone);
    const result = auth.requestOtp(phone);
    res.json({ ok: true, ...(result.otp ? { demoOtp: result.otp } : {}) });
  });

  r.post('/verify-otp', perIp, (req, res) => {
    const phone = v.phone(req.body?.phone);
    const otp = v.pattern(req.body?.otp, 'otp', /^\d{6}$/);
    const { sid, user } = auth.verifyOtp(phone, otp);
    auth.setSessionCookie(res, sid);
    res.json({ user: presentUser(user, store) });
  });

  r.post('/logout', (req, res) => {
    auth.clearSession(req, res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'not_signed_in');
    res.json({ user: presentUser(req.user, store) });
  });

  r.patch('/me', (req, res) => {
    if (!req.user) throw new HttpError(401, 'not_signed_in');
    const lang = v.oneOf(req.body?.lang, 'lang', LANGS);
    store.updateUser(req.user.id, { lang });
    res.json({ user: presentUser(req.user, store) });
  });

  return r;
}

module.exports = { authRouter, LANGS };
