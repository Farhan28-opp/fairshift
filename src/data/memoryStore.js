'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Document store kept in memory, optionally written through to a JSON file
 * so local runs survive restarts. Production uses FirestoreStore, which has
 * the same async interface:
 *
 *   get(col, id)            -> doc | null
 *   put(col, doc)           upsert by doc.id
 *   putMany(col, docs)
 *   patch(col, id, fields)  replace the given top-level fields (doc must exist)
 *   find(col, where)        docs whose fields equal every value in `where`
 *   update(col, id, fn)     atomic read-modify-write; fn(current) returns the
 *                           next doc, or undefined to leave it unchanged
 *   remove(col, id), clear(col)
 *
 * Documents are copied on the way in and out, so callers can never mutate
 * stored state by accident (the same behaviour as a real database).
 */
class MemoryStore {
  constructor({ file = null } = {}) {
    this.file = file;
    this.cols = new Map();
    if (file) this.load();
  }

  col(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map());
    return this.cols.get(name);
  }

  async get(col, id) {
    const doc = this.col(col).get(id);
    return doc ? structuredClone(doc) : null;
  }

  async put(col, doc) {
    if (!doc?.id) throw new Error('Document needs an id');
    this.col(col).set(doc.id, structuredClone(doc));
    this.save();
  }

  async putMany(col, docs) {
    for (const doc of docs) {
      if (!doc?.id) throw new Error('Document needs an id');
      this.col(col).set(doc.id, structuredClone(doc));
    }
    this.save();
  }

  async patch(col, id, fields) {
    const doc = this.col(col).get(id);
    if (!doc) throw new Error(`Missing document ${col}/${id}`);
    Object.assign(doc, structuredClone(fields));
    this.save();
  }

  async find(col, where = {}) {
    const entries = Object.entries(where);
    const out = [];
    for (const doc of this.col(col).values()) {
      if (entries.every(([key, value]) => doc[key] === value)) out.push(structuredClone(doc));
    }
    return out;
  }

  async update(col, id, fn) {
    const current = this.col(col).get(id);
    const next = fn(current ? structuredClone(current) : null);
    if (next === undefined) return current ? structuredClone(current) : null;
    if (next.id !== id) throw new Error('update() must keep the document id');
    this.col(col).set(id, structuredClone(next));
    this.save();
    return structuredClone(next);
  }

  async remove(col, id) {
    this.col(col).delete(id);
    this.save();
  }

  async clear(col) {
    this.col(col).clear();
    this.save();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const [name, docs] of Object.entries(data)) {
      this.cols.set(name, new Map(docs.map((doc) => [doc.id, doc])));
    }
  }

  /** Atomic write: a crash mid-write leaves the previous file intact. */
  save() {
    if (!this.file) return;
    const data = {};
    for (const [name, docs] of this.cols) data[name] = [...docs.values()];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { MemoryStore };
