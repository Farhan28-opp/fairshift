'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * JSON-lines logger. Cloud Logging reads the `severity` field directly.
 * Never pass request bodies, OTPs, report text or names into `fields`.
 */
function createLogger({ level = 'info', write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log = (severity) => (message, fields = {}) => {
    if (LEVELS[severity] < threshold) return;
    write(JSON.stringify({ severity: severity.toUpperCase(), message, time: new Date().toISOString(), ...fields }));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** Logs method, route and status only, never the user or the payload. */
function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms) });
    });
    next();
  };
}

module.exports = { createLogger, requestLogger };
