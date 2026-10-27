'use strict';

const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { createRateLimiter } = require('../rateLimit');
const { MINUTE } = require('../../domain/time');
const { reporterView, normalizeRef } = require('../../domain/cases');

/**
 * Routes that need no sign-in. Anonymous reporters follow their case here
 * with the case reference and the access code they were given; nothing in
 * these requests identifies them, and nothing about them is stored.
 */
function publicRouter({ repo, clock, config, cases }) {
  const r = express.Router();
  const perIp = createRateLimiter({ windowMs: 15 * MINUTE, max: 60, key: (req) => req.ip, clock });
  // Slows guessing against one case even from many addresses (60-bit codes make it hopeless anyway).
  const perRef = createRateLimiter({ windowMs: 15 * MINUTE, max: 20, key: (req) => normalizeRef(req.body?.ref) || 'invalid', clock });

  async function anonymousCase(req) {
    const ref = v.text(req.body?.ref, 'ref', { max: 20 });
    const code = v.text(req.body?.code, 'code', { max: 20 });
    return cases.findAnonymous(ref, code);
  }

  async function respond(res, record, now, status = 200) {
    const org = await repo.getOrg(record.orgId);
    const [fresh] = await cases.sweep(org, [record], now);
    res.status(status).set('Cache-Control', 'no-store').json({
      case: reporterView(fresh, await cases.people(org.id), now),
      org: { name: org.name, industry: org.industry },
    });
  }

  r.get('/config', (req, res) => {
    res.json({ demoMode: config.demoMode, languages: ['en', 'ta'], demoResetHours: config.demoMode ? config.demoResetHours : null });
  });

  r.post('/cases/lookup', perIp, perRef, async (req, res) => {
    await respond(res, await anonymousCase(req), clock());
  });

  r.post('/cases/messages', perIp, perRef, async (req, res) => {
    const now = clock();
    const record = await anonymousCase(req);
    const org = await repo.getOrg(record.orgId);
    const text = v.text(req.body?.text, 'text', { min: 1, max: 1000 });
    await respond(res, await cases.act(org, record.id, 'message', { actor: { type: 'reporter' }, now, text }), now, 201);
  });

  r.post('/cases/verify', perIp, perRef, async (req, res) => {
    const now = clock();
    const record = await anonymousCase(req);
    const org = await repo.getOrg(record.orgId);
    const accepted = v.bool(req.body?.accepted, 'accepted');
    const note = v.text(req.body?.note, 'note', { max: 1000, optional: accepted });
    await respond(res, await cases.act(org, record.id, accepted ? 'confirm' : 'reopen', { actor: { type: 'reporter' }, now, note }), now);
  });

  /** Demo accounts and sample anonymous cases for evaluators. Absent unless DEMO_MODE=true. */
  r.get('/demo', async (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'not_found');
    const [orgs, meta] = await Promise.all([repo.listOrgs(), repo.getMeta('demo')]);
    const out = [];
    const order = ['construction', 'education'];
    for (const org of orgs.sort((a, b) => order.indexOf(a.industry) - order.indexOf(b.industry))) {
      const users = await repo.listUsers(org.id);
      out.push({
        id: org.id,
        name: org.name,
        industry: org.industry,
        admins: users.filter((u) => u.role === 'admin').sort((a, b) => a.id.localeCompare(b.id)).map((u) => ({ phone: u.phone, name: u.name, title: u.title })),
        workers: users
          .filter((u) => u.role === 'worker')
          .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
          .map((u) => ({ phone: u.phone, name: u.name, jobRole: u.jobRole, lang: u.lang })),
        anonymousCases: (meta?.anonymousCases || []).filter((c) => c.orgId === org.id).map(({ ref, code }) => ({ ref, code })),
      });
    }
    res.set('Cache-Control', 'no-store').json({ orgs: out });
  });

  return r;
}

module.exports = { publicRouter };
