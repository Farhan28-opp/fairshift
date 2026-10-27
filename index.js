'use strict';

/**
 * Vercel entrypoint. `npm start`, the Dockerfile and Cloud Run keep using src/server.js.
 *
 * Vercel's Express preset loads the first of app, index, server, src/app, src/index and
 * src/server (.js) that imports express. Without this file that is src/app.js, which only
 * exports the createApp factory. This builds the same app as src/server.js and exports it,
 * so Vercel runs it as one function. In demo mode the demo data is seeded on the first API
 * request by the demo refresher in src/app.js, so keep DEMO_RESET_HOURS above 0 on Vercel.
 */
require('express'); // marks this file as the Express entrypoint for Vercel's detection

const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { createStore } = require('./src/data/store');
const { Repo } = require('./src/data/repo');
const { createApp } = require('./src/app');

const config = loadConfig();
const logger = createLogger({ level: config.logLevel });
const repo = new Repo(createStore(config));

module.exports = createApp({ config, repo, logger });
