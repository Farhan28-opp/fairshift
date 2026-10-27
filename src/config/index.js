'use strict';

const crypto = require('node:crypto');

/**
 * Runtime configuration, read once from the environment.
 * Secrets are never hard-coded: on Cloud Run they come from Secret Manager
 * (see README). When APP_SECRET is absent a random one is generated per boot,
 * which is fine for the in-memory prototype store.
 */
function loadConfig(env = process.env) {
  return Object.freeze({
    port: Number.parseInt(env.PORT, 10) || 8080,
    isProduction: env.NODE_ENV === 'production',
    demoMode: env.DEMO_MODE === 'true',
    appSecret: env.APP_SECRET || crypto.randomBytes(32).toString('hex'),
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    logLevel: env.LOG_LEVEL || 'info',
  });
}

module.exports = { loadConfig };
