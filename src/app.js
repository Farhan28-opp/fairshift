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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Builds the Express app. Everything it depends on is injected, so tests can
 * run it with a fixed clock, a fresh store and a fake AI service.
 */
function createApp({ config, store, ai, logger, clock = Date.now, sendOtp }) {
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
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          workerSrc: ["'self'"],
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
    res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), microphone=(self), payment=()');
    next();
  });
  app.use(compression());
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '16kb' }));

  const auth = createAuth({
    store,
    clock,
    demoMode: config.demoMode,
    secureCookies: config.isProduction,
    sendOtp: sendOtp || ((phone) => logger.info('otp_dispatched', { phoneSuffix: phone.slice(-2) })),
  });
  app.use(auth.attachUser);

  const ctx = { store, clock, config, ai, logger };
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter({ auth, store, clock }));
  app.use('/api/worker', auth.requireRole('worker'), workerRouter(ctx));
  app.use('/api/admin', auth.requireRole('admin'), adminRouter(ctx));
  app.use('/api/public', publicRouter(ctx));
  app.use('/api', (req, res, next) => next(new HttpError(404, 'not_found')));

  const noCache = (res) => res.setHeader('Cache-Control', 'no-cache');
  const page = (file) => (req, res) => {
    noCache(res);
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
  app.get('/', page('index.html'));
  app.get('/admin', page('admin.html'));
  app.get('/p/:shareId', page('passport.html'));
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js') || filePath.endsWith('.html')) noCache(res);
      },
    }),
  );

  app.use(errorHandler(logger));
  return app;
}

module.exports = { createApp };
