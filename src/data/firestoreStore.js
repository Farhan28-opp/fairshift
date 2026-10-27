'use strict';

const BATCH_LIMIT = 450; // Firestore allows 500 writes per batch

/**
 * Firestore implementation of the document-store interface described in
 * memoryStore.js. Only equality filters are used, so no composite indexes
 * are needed. Credentials come from the Cloud Run service account.
 *
 * `firestore` can be injected (tests use a fake); otherwise the official
 * client is loaded lazily so local runs do not need it.
 */
class FirestoreStore {
  constructor({ firestore, databaseId } = {}) {
    if (firestore) {
      this.db = firestore;
    } else {
      const { Firestore } = require('@google-cloud/firestore');
      this.db = new Firestore({ ignoreUndefinedProperties: true, ...(databaseId ? { databaseId } : {}) });
    }
  }

  ref(col, id) {
    return this.db.collection(col).doc(id);
  }

  async get(col, id) {
    const snap = await this.ref(col, id).get();
    return snap.exists ? snap.data() : null;
  }

  async put(col, doc) {
    if (!doc?.id) throw new Error('Document needs an id');
    await this.ref(col, doc.id).set(doc);
  }

  async putMany(col, docs) {
    for (let i = 0; i < docs.length; i += BATCH_LIMIT) {
      const batch = this.db.batch();
      for (const doc of docs.slice(i, i + BATCH_LIMIT)) {
        if (!doc?.id) throw new Error('Document needs an id');
        batch.set(this.ref(col, doc.id), doc);
      }
      await batch.commit();
    }
  }

  /** update() replaces each named top-level field and fails if the document is missing. */
  async patch(col, id, fields) {
    await this.ref(col, id).update(fields);
  }

  async find(col, where = {}) {
    let query = this.db.collection(col);
    for (const [key, value] of Object.entries(where)) query = query.where(key, '==', value);
    const snap = await query.get();
    return snap.docs.map((d) => d.data());
  }

  async update(col, id, fn) {
    const ref = this.ref(col, id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : null;
      const next = fn(current);
      if (next === undefined) return current;
      if (next.id !== id) throw new Error('update() must keep the document id');
      tx.set(ref, next);
      return next;
    });
  }

  async remove(col, id) {
    await this.ref(col, id).delete();
  }

  async clear(col) {
    const snap = await this.db.collection(col).get();
    for (let i = 0; i < snap.docs.length; i += BATCH_LIMIT) {
      const batch = this.db.batch();
      for (const d of snap.docs.slice(i, i + BATCH_LIMIT)) batch.delete(d.ref);
      await batch.commit();
    }
  }
}

module.exports = { FirestoreStore };
