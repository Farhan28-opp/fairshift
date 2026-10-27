'use strict';

const { MemoryStore } = require('./memoryStore');
const { FirestoreStore } = require('./firestoreStore');

/** Picks the storage driver from config: memory (tests), file (local), firestore (Cloud Run). */
function createStore(config) {
  switch (config.storage) {
    case 'memory':
      return new MemoryStore();
    case 'file':
      return new MemoryStore({ file: config.dataFile });
    case 'firestore':
      return new FirestoreStore({ databaseId: config.firestoreDatabase });
    default:
      throw new Error(`Unknown storage driver: ${config.storage}`);
  }
}

module.exports = { createStore };
