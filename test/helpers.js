'use strict';

const { createApp } = require('../src/app');
const { MemoryStore } = require('../src/data/memoryStore');
const { Repo } = require('../src/data/repo');
const { ensureDemoData } = require('../src/data/seed');
const { createLogger } = require('../src/logger');

/** Wednesday 14 Oct 2026, 12:00 IST: a fixed "now" so every run sees the same data. */
const T0 = Date.parse('2026-10-14T06:30:00Z');
const HOUR = 3_600_000;

const PHONES = {
  vikram: '9000000100', // construction site manager
  priya: '9000000110', // construction safety officer
  revathi: '9000000200', // college admin officer
  murugan: '9000000101',
  lakshmi: '9000000102',
  kannan: '9000000104', // has a missing check-out and an open pay dispute
  meena: '9000000201', // college housekeeping
};

/**
 * Boots the real Express app on an ephemeral port with an in-memory store,
 * seeded demo data and a clock the test controls.
 */
async function startApp({ store = new MemoryStore(), now = T0, seed = true, demoMode = true } = {}) {
  const clock = { now };
  const repo = new Repo(store);
  if (seed) await ensureDemoData(repo, { now, resetHours: 0 });
  const config = Object.freeze({ port: 0, isProduction: false, demoMode, storage: 'memory', demoResetHours: 0, logLevel: 'silent' });
  const app = createApp({ config, repo, logger: createLogger({ level: 'silent' }), clock: () => clock.now });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  /** A tiny browser: keeps the session cookie between requests. */
  function client() {
    let cookie = '';
    async function request(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
      const text = await res.text();
      const parse = () => {
        try {
          return text ? JSON.parse(text) : null;
        } catch {
          return text;
        }
      };
      return { status: res.status, data: parse(), headers: res.headers };
    }
    const c = {
      get: (path, headers) => request('GET', path, undefined, headers),
      post: (path, body = {}, headers) => request('POST', path, body, headers),
      put: (path, body = {}, headers) => request('PUT', path, body, headers),
      patch: (path, body = {}, headers) => request('PATCH', path, body, headers),
      async login(phone) {
        const otp = await c.post('/api/auth/request-otp', { phone });
        const res = await c.post('/api/auth/verify-otp', { phone, otp: otp.data.demoOtp });
        if (res.status !== 200) throw new Error(`login failed for ${phone}: ${res.status}`);
        return res.data.user;
      },
      get cookie() {
        return cookie;
      },
    };
    return c;
  }

  async function as(name) {
    const c = client();
    await c.login(PHONES[name]);
    return c;
  }

  return {
    base,
    repo,
    store,
    clock,
    client,
    as,
    advance: (hours) => {
      clock.now += hours * HOUR;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startApp, T0, HOUR, PHONES };
