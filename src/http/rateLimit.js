'use strict';

const { HttpError } = require('./errors');

/**
 * Fixed-window, in-memory rate limiter. Enough for one Cloud Run instance;
 * move the counters to Redis/Memorystore when scaling out.
 */
function createRateLimiter({ windowMs, max, key, clock = Date.now }) {
  const hits = new Map();

  function prune(now) {
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }

  return function rateLimit(req, res, next) {
    const now = clock();
    if (hits.size > 10_000) prune(now);
    const k = key(req);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return next(new HttpError(429, 'too_many_requests'));
    }
    return next();
  };
}

module.exports = { createRateLimiter };
