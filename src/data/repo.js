'use strict';

/** Every collection the app persists. Names are kept in one place. */
const COLLECTIONS = Object.freeze({
  orgs: 'orgs',
  users: 'users',
  shifts: 'shifts',
  cases: 'cases',
  adjustments: 'adjustments',
  audit: 'audit',
  sessions: 'sessions',
  otps: 'otps',
  meta: 'meta',
});

/** Records owned by the demo seed; sessions and one-time codes are left alone on reset. */
const SEEDED = Object.freeze(['orgs', 'users', 'shifts', 'cases', 'adjustments', 'audit']);

const byTime = (field) => (a, b) => a[field] - b[field];

/** Domain-level data access on top of a document store (memory, file or Firestore). */
class Repo {
  constructor(store) {
    this.store = store;
  }

  // Organisations
  getOrg(id) {
    return this.store.get(COLLECTIONS.orgs, id);
  }

  listOrgs() {
    return this.store.find(COLLECTIONS.orgs);
  }

  patchOrg(id, fields) {
    return this.store.patch(COLLECTIONS.orgs, id, fields);
  }

  // People (workers and admins)
  getUser(id) {
    return this.store.get(COLLECTIONS.users, id);
  }

  async getUserByPhone(phone) {
    const [user] = await this.store.find(COLLECTIONS.users, { phone });
    return user || null;
  }

  listUsers(orgId, role) {
    return this.store.find(COLLECTIONS.users, role ? { orgId, role } : { orgId });
  }

  patchUser(id, fields) {
    return this.store.patch(COLLECTIONS.users, id, fields);
  }

  // Shifts
  getShift(id) {
    return this.store.get(COLLECTIONS.shifts, id);
  }

  async shiftsForUser(userId) {
    return (await this.store.find(COLLECTIONS.shifts, { userId })).sort(byTime('checkIn'));
  }

  async shiftsForOrg(orgId) {
    return (await this.store.find(COLLECTIONS.shifts, { orgId })).sort(byTime('checkIn'));
  }

  putShift(shift) {
    return this.store.put(COLLECTIONS.shifts, shift);
  }

  updateShift(id, fn) {
    return this.store.update(COLLECTIONS.shifts, id, fn);
  }

  // Cases (pay disputes, safety reports, grievances)
  getCase(id) {
    return this.store.get(COLLECTIONS.cases, id);
  }

  async findCaseByRef(ref) {
    const [found] = await this.store.find(COLLECTIONS.cases, { ref });
    return found || null;
  }

  async casesForOrg(orgId) {
    return (await this.store.find(COLLECTIONS.cases, { orgId })).sort(byTime('createdAt')).reverse();
  }

  async casesForReporter(userId) {
    return (await this.store.find(COLLECTIONS.cases, { reporterId: userId })).sort(byTime('createdAt')).reverse();
  }

  putCase(record) {
    return this.store.put(COLLECTIONS.cases, record);
  }

  updateCase(id, fn) {
    return this.store.update(COLLECTIONS.cases, id, fn);
  }

  // Pay adjustments agreed when a dispute is upheld
  async adjustmentsForUser(userId) {
    return (await this.store.find(COLLECTIONS.adjustments, { userId })).sort(byTime('createdAt'));
  }

  putAdjustment(adjustment) {
    return this.store.put(COLLECTIONS.adjustments, adjustment);
  }

  // Audit trail for settings changes
  addAudit(entry) {
    return this.store.put(COLLECTIONS.audit, entry);
  }

  async auditForOrg(orgId) {
    return (await this.store.find(COLLECTIONS.audit, { orgId })).sort(byTime('at')).reverse();
  }

  // Sign-in
  getSession(id) {
    return this.store.get(COLLECTIONS.sessions, id);
  }

  putSession(session) {
    return this.store.put(COLLECTIONS.sessions, session);
  }

  removeSession(id) {
    return this.store.remove(COLLECTIONS.sessions, id);
  }

  getOtp(id) {
    return this.store.get(COLLECTIONS.otps, id);
  }

  putOtp(otp) {
    return this.store.put(COLLECTIONS.otps, otp);
  }

  updateOtp(id, fn) {
    return this.store.update(COLLECTIONS.otps, id, fn);
  }

  removeOtp(id) {
    return this.store.remove(COLLECTIONS.otps, id);
  }

  // Housekeeping
  getMeta(id) {
    return this.store.get(COLLECTIONS.meta, id);
  }

  updateMeta(id, fn) {
    return this.store.update(COLLECTIONS.meta, id, fn);
  }

  putMany(collection, docs) {
    return this.store.putMany(COLLECTIONS[collection], docs);
  }

  async clearSeeded() {
    for (const name of SEEDED) await this.store.clear(COLLECTIONS[name]);
  }
}

module.exports = { Repo, COLLECTIONS };
