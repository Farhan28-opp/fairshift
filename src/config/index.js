'use strict';

const path = require('node:path');

const STORAGE_DRIVERS = Object.freeze(['memory', 'file', 'firestore']);

/**
 * Runtime configuration, read once from the environment. No secrets live
 * here: Firestore uses the Cloud Run service account (Application Default
 * Credentials) and per-organisation secrets are generated into the database.
 */
function loadConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const storage = env.STORAGE || (isProduction ? 'firestore' : 'file');
  if (!STORAGE_DRIVERS.includes(storage)) {
    throw new Error(`STORAGE must be one of ${STORAGE_DRIVERS.join(', ')}`);
  }
  const resetHours = Number(env.DEMO_RESET_HOURS ?? 24);
  return Object.freeze({
    port: Number.parseInt(env.PORT, 10) || 8080,
    isProduction,
    demoMode: env.DEMO_MODE === 'true',
    storage,
    dataFile: env.DATA_FILE || path.join(process.cwd(), 'data', 'fairshift.json'),
    firestoreDatabase: env.FIRESTORE_DATABASE || undefined,
    // Demo data is re-seeded when it is older than this, so evaluators always see current activity. 0 disables it.
    demoResetHours: Number.isFinite(resetHours) && resetHours >= 0 ? resetHours : 24,
    logLevel: env.LOG_LEVEL || 'info',
  });
}

module.exports = { loadConfig, STORAGE_DRIVERS };
