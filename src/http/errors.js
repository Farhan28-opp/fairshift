'use strict';

/** An error whose `code` is safe to show the client. Anything else becomes a 500. */
class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function errorHandler(logger) {
  // Express needs the 4-argument signature to treat this as an error handler.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.code, ...(err.details ? { details: err.details } : {}) });
    }
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    logger.error('unhandled_error', { path: req.path, message: err?.message });
    return res.status(500).json({ error: 'internal_error' });
  };
}

module.exports = { HttpError, errorHandler };
