'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { createStore } = require('./data/store');
const { Repo } = require('./data/repo');
const { ensureDemoData } = require('./data/seed');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const repo = new Repo(createStore(config));

  if (config.demoMode) {
    const seeded = await ensureDemoData(repo, { resetHours: config.demoResetHours });
    logger.info('demo_data_ready', { storage: config.storage, seeded });
  } else {
    logger.warn('demo_mode_off', { note: 'No SMS gateway is configured; set DEMO_MODE=true to sign in with on-screen codes.' });
  }

  const app = createApp({ config, repo, logger });
  const server = app.listen(config.port, () => {
    logger.info('server_started', { port: config.port, storage: config.storage, demoMode: config.demoMode });
  });

  const shutdown = (signal) => {
    logger.info('shutting_down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  process.stderr.write(`${JSON.stringify({ severity: 'ERROR', message: 'startup_failed', error: err?.message })}\n`);
  process.exit(1);
});
