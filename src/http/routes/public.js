'use strict';

const express = require('express');
const v = require('../validate');
const { HttpError } = require('../errors');
const { buildPassport } = require('../../domain/passport');

function publicRouter({ store, clock, config }) {
  const r = express.Router();

  /** A worker's shared skill passport, viewable by any future employer. */
  r.get('/passport/:shareId', (req, res) => {
    const shareId = v.pattern(req.params.shareId, 'shareId', /^[A-Za-z0-9_-]{12}$/);
    const worker = store.findByShareId(shareId);
    if (!worker || !worker.passportShared) throw new HttpError(404, 'not_found');
    const org = store.getOrg(worker.orgId);
    res.set('Cache-Control', 'no-store').json({
      passport: buildPassport({ worker, org, shifts: store.shiftsFor(worker.id), tzOffsetMinutes: org.tz }),
      checkedAt: clock(),
    });
  });

  /** Demo accounts for judges. Absent unless DEMO_MODE=true. */
  r.get('/demo-accounts', (req, res) => {
    if (!config.demoMode) throw new HttpError(404, 'not_found');
    const users = store.listUsers();
    const orgs = [...new Set(users.map((u) => u.orgId))].map((orgId) => {
      const org = store.getOrg(orgId);
      const members = users.filter((u) => u.orgId === orgId);
      const admin = members.find((u) => u.role === 'admin');
      return {
        org: { name: org.name, sector: org.sector },
        admin: admin ? { phone: admin.phone, name: admin.name, title: admin.title } : null,
        workers: members
          .filter((u) => u.role === 'worker')
          .map((u) => ({ phone: u.phone, name: u.name, jobRole: u.jobRole, lang: u.lang })),
      };
    });
    res.json({ orgs });
  });

  return r;
}

module.exports = { publicRouter };
