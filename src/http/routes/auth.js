'use strict';

const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { createRateLimiter } = require('../rateLimit');
const { presentUser } = require('../present');
const { MINUTE } = require('../../domain/time');

const LANGS = Object.freeze(['en', 'ta']);

function authRouter({ auth, repo, clock }) {
  const r = express.Router();
  const perIp = createRateLimiter({ windowMs: 15 * MINUTE, max: 40, key: (req) => req.ip, clock });
  const perPhone = createRateLimiter({
    windowMs: 15 * MINUTE,
    max: 5,
    key: (req) => String(req.body?.phone ?? '').replace(/\D/g, '').slice(-10),
    clock,
  });

  // Same answer whether or not the number is registered, so numbers cannot be enumerated.
  r.post('/request-otp', perIp, perPhone, async (req, res) => {
    const phone = v.phone(req.body?.phone);
    const result = await auth.requestOtp(phone);
    res.json({ ok: true, ...(result.otp ? { demoOtp: result.otp } : {}) });
  });

  r.post('/verify-otp', perIp, async (req, res) => {
    const phone = v.phone(req.body?.phone);
    const otp = v.pattern(req.body?.otp, 'otp', /^\d{6}$/);
    const { sid, user } = await auth.verifyOtp(phone, otp);
    auth.setSessionCookie(res, sid);
    res.json({ user: presentUser(user, await repo.getOrg(user.orgId)) });
  });

  r.post('/logout', async (req, res) => {
    await auth.clearSession(req, res);
    res.json({ ok: true });
  });

  // Signed-out is a normal state here, not an error: answer 200 with no user.
  r.get('/me', async (req, res) => {
    res.json({ user: req.user ? presentUser(req.user, await repo.getOrg(req.user.orgId)) : null });
  });

  r.patch('/me', async (req, res) => {
    if (!req.user) throw new HttpError(401, 'not_signed_in');
    const lang = v.oneOf(req.body?.lang, 'lang', LANGS);
    await repo.patchUser(req.user.id, { lang });
    res.json({ user: presentUser({ ...req.user, lang }, await repo.getOrg(req.user.orgId)) });
  });

  return r;
}

module.exports = { authRouter, LANGS };
