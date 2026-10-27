'use strict';

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { MemoryStore } = require('./data/store');
const { seedDemoData } = require('./data/seed');
const { createAiService } = require('./services/ai');
const { createApp } = require('./app');

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const store = new MemoryStore();

if (config.demoMode) {
  seedDemoData(store);
  logger.info('demo_data_loaded', { users: store.listUsers().length });
} else {
  logger.warn('demo_mode_off', { note: 'No SMS gateway or database is configured; set DEMO_MODE=true for the prototype.' });
}

const ai = createAiService({ apiKey: config.geminiApiKey, model: config.geminiModel, logger });
const app = createApp({ config, store, ai, logger });

const server = app.listen(config.port, () => {
  logger.info('server_started', { port: config.port, demoMode: config.demoMode, ai: ai.enabled });
});

function shutdown(signal) {
  logger.info('shutting_down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
