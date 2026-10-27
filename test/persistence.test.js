'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp, T0 } = require('./helpers');
const { MemoryStore } = require('../src/data/memoryStore');
const { FirestoreStore } = require('../src/data/firestoreStore');
const { Repo } = require('../src/data/repo');
const { ensureDemoData, SEED_VERSION } = require('../src/data/seed');
const { buildRadar } = require('../src/domain/radar');

test('records, cases and sessions survive a server restart (file store)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairshift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');

  const first = await startApp({ store: new MemoryStore({ file }) });
  const murugan = await first.as('murugan');
  const sent = (await murugan.post('/api/worker/reports', { category: 'water', description: 'Tank empty again on level 2', anonymous: true })).data;
  await first.close();

  // A brand-new process reading the same file.
  const second = await startApp({ store: new MemoryStore({ file }), seed: false });
  t.after(second.close);
  const stranger = second.client();
  const view = await stranger.post('/api/public/cases/lookup', { ref: sent.case.ref, code: sent.accessCode });
  assert.equal(view.status, 200);
  assert.equal(view.data.case.description, 'Tank empty again on level 2');

  // The old session cookie still works, because sessions are stored too.
  const res = await fetch(`${second.base}/api/worker/home`, { headers: { cookie: murugan.cookie } });
  assert.equal(res.status, 200);
});

test('the memory store hands out copies, so callers cannot change stored data by accident', async () => {
  const store = new MemoryStore();
  await store.put('things', { id: 'a', list: [1] });
  const copy = await store.get('things', 'a');
  copy.list.push(2);
  assert.deepEqual((await store.get('things', 'a')).list, [1]);
  assert.equal(await store.update('things', 'a', () => undefined).then((d) => d.list.length), 1);
  await assert.rejects(store.update('things', 'a', (d) => ({ ...d, id: 'b' })));
});

test('demo data is seeded once, deterministically, and refreshed when stale', async () => {
  const repo = new Repo(new MemoryStore());
  assert.equal(await ensureDemoData(repo, { now: T0, resetHours: 24 }), true);
  assert.equal(await ensureDemoData(repo, { now: T0 + 3_600_000, resetHours: 24 }), false, 'fresh data is left alone');
  const refs = (await repo.casesForOrg('org_construction')).map((c) => c.ref).sort();

  const other = new Repo(new MemoryStore());
  await ensureDemoData(other, { now: T0, resetHours: 24 });
  assert.deepEqual((await other.casesForOrg('org_construction')).map((c) => c.ref).sort(), refs, 'same seed, same records');

  await repo.putCase({ ...(await repo.casesForOrg('org_construction'))[0], id: 'extra', ref: 'FS-EXTR-A000' });
  assert.equal(await ensureDemoData(repo, { now: T0 + 25 * 3_600_000, resetHours: 24 }), true, 'stale data is refreshed');
  assert.equal(await repo.getCase('extra'), null);
  assert.equal((await repo.getMeta('seed')).version, SEED_VERSION);
});

/**
 * A minimal in-process stand-in for the Firestore client, implementing only
 * the calls FirestoreStore makes. It checks the adapter's use of the API;
 * production runs against real Firestore.
 */
function fakeFirestore() {
  const data = new Map();
  const col = (name) => {
    if (!data.has(name)) data.set(name, new Map());
    return data.get(name);
  };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const snap = (name, id) => ({ exists: col(name).has(id), id, data: () => clone(col(name).get(id)), ref: docRef(name, id) });
  function docRef(name, id) {
    return {
      get: async () => snap(name, id),
      set: async (doc) => col(name).set(id, clone(doc)),
      update: async (fields) => {
        if (!col(name).has(id)) throw new Error('NOT_FOUND');
        col(name).set(id, { ...col(name).get(id), ...clone(fields) });
      },
      delete: async () => col(name).delete(id),
      _name: name,
      _id: id,
    };
  }
  function query(name, filters = []) {
    return {
      where: (field, op, value) => {
        assert.equal(op, '==', 'only equality filters are used (no composite indexes needed)');
        return query(name, [...filters, [field, value]]);
      },
      doc: (id) => docRef(name, id),
      get: async () => ({
        docs: [...col(name).keys()].filter((id) => filters.every(([f, v]) => col(name).get(id)[f] === v)).map((id) => snap(name, id)),
      }),
    };
  }
  return {
    collection: (name) => query(name),
    batch: () => {
      const ops = [];
      return {
        set: (ref, doc) => ops.push(() => ref.set(doc)),
        delete: (ref) => ops.push(() => ref.delete()),
        commit: async () => {
          assert.ok(ops.length <= 500, 'batches stay within the Firestore limit');
          for (const op of ops) await op();
        },
      };
    },
    runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({ get: (ref) => ref.get(), set: (ref, doc) => writes.push(() => ref.set(doc)) });
      for (const w of writes) await w();
      return result;
    },
  };
}

test('the Firestore adapter supports everything the app does (seed, queries, transactions, reset)', async () => {
  const repo = new Repo(new FirestoreStore({ firestore: fakeFirestore() }));
  await ensureDemoData(repo, { now: T0, resetHours: 0 });
  const org = await repo.getOrg('org_construction');
  const workers = await repo.listUsers(org.id, 'worker');
  const radar = buildRadar({ org, workers, shifts: await repo.shiftsForOrg(org.id), cases: await repo.casesForOrg(org.id), now: T0 });
  assert.equal(radar.kpis.headcount, 8);
  assert.ok(radar.flags.length > 0);

  const [c] = await repo.casesForOrg(org.id);
  const updated = await repo.updateCase(c.id, (cur) => ({ ...cur, status: 'closed' }));
  assert.equal(updated.status, 'closed');
  assert.equal((await repo.findCaseByRef(c.ref)).status, 'closed');
  await repo.patchOrg(org.id, { caseRules: { ...org.caseRules, escalateTo: 'owner' } });
  assert.equal((await repo.getOrg(org.id)).caseRules.escalateTo, 'owner');
  assert.ok((await repo.getUserByPhone('9000000101')).name);

  assert.equal(await ensureDemoData(repo, { now: T0, resetHours: 0, force: true }), true);
  assert.equal((await repo.getOrg(org.id)).caseRules.escalateTo, 'project_director', 'reset restores the seed');
});
