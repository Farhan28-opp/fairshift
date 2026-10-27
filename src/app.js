'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { createAuth } = require('./http/auth');
const { errorHandler, HttpError } = require('./http/errors');
const { requestLogger } = require('./logger');
const { authRouter } = require('./http/routes/auth');
const { workerRouter } = require('./http/routes/worker');
const { adminRouter } = require('./http/routes/admin');
const { publicRouter } = require('./http/routes/public');
const { createCaseService } = require('./services/cases');
const { ensureDemoData } = require('./data/seed');
const { MINUTE } = require('./domain/time');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Rejects cross-site writes: a foreign Origin, or a body that is not JSON
 * (plain HTML forms cannot send application/json). Backs up SameSite=Strict.
 */
function sameOriginWrites(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const { origin } = req.headers;
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host;
    } catch {
      /* malformed origin */
    }
    if (host !== req.headers.host) return next(new HttpError(403, 'bad_origin'));
  }
  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (hasBody && !req.is('application/json')) return next(new HttpError(415, 'unsupported_media_type'));
  return next();
}

/** In demo mode, refreshes the seeded data once it is older than DEMO_RESET_HOURS (checked every 5 minutes). */
function demoRefresher({ repo, config, clock, logger }) {
  let nextCheck = 0;
  let running = null;
  return async (req, res, next) => {
    const now = clock();
    if (now >= nextCheck) {
      nextCheck = now + 5 * MINUTE;
      running = ensureDemoData(repo, { now, resetHours: config.demoResetHours })
        .then((refreshed) => refreshed && logger.info('demo_data_refreshed'))
        .catch((err) => logger.error('demo_refresh_failed', { message: err?.message }))
        .finally(() => {
          running = null;
        });
    }
    if (running) await running;
    next();
  };
}

/**
 * Builds the Express app. Everything it depends on is injected, so tests run
 * it with an in-memory store and a controllable clock.
 */
function createApp({ config, repo, logger, clock = Date.now, sendOtp }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Cloud Run terminates TLS in front of us

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
    next();
  });
  app.use(compression());
  app.use(requestLogger(logger));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Static files: revalidate code on every load so a new deploy is picked up at once.
  const page = (file) => (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
  app.get('/', page('index.html'));
  app.get('/admin', page('admin.html'));
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        const longLived = /\.(woff2|svg|png)$/.test(filePath);
        res.setHeader('Cache-Control', longLived ? 'public, max-age=604800' : 'no-cache');
      },
    }),
  );

  const auth = createAuth({
    repo,
    clock,
    demoMode: config.demoMode,
    secureCookies: config.isProduction,
    sendOtp: sendOtp || (async (phone) => logger.info('otp_dispatched', { phoneSuffix: phone.slice(-2) })),
  });
  const cases = createCaseService({ repo });
  const ctx = { repo, clock, config, cases, auth, logger };

  const api = express.Router();
  api.use(express.json({ limit: '16kb' }));
  api.use(sameOriginWrites);
  if (config.demoMode && config.demoResetHours > 0) api.use(demoRefresher({ repo, config, clock, logger }));
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(auth.attachUser);
  api.use('/auth', authRouter({ auth, repo, clock }));
  api.use('/worker', auth.requireRole('worker'), workerRouter(ctx));
  api.use('/admin', auth.requireRole('admin'), adminRouter(ctx));
  api.use('/public', publicRouter(ctx));
  api.use((req, res, next) => next(new HttpError(404, 'not_found')));
  app.use('/api', api);

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
