'use strict';

/**
 * Tamil and English must be complete across both interfaces: every key the
 * UI can ask for (including statuses, categories, errors and field names
 * that come from the server) exists in both dictionaries.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const en = require('../public/i18n/en.json');
const ta = require('../public/i18n/ta.json');
const { CATEGORIES, SEVERITIES, ESCALATION_ROLES, INDUSTRIES } = require('../src/config/industries');
const { STATUSES, CASE_TYPES, OUTCOMES, PAY_REASONS } = require('../src/domain/cases');
const { ORGS } = require('../src/data/seed');

const read = (dir) =>
  fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
const ui = read(path.join(__dirname, '..', 'public', 'js'));
const server = read(path.join(__dirname, '..', 'src'));
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('English and Tamil have exactly the same keys and placeholders', () => {
  assert.deepEqual(Object.keys(ta).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim() && ta[key].trim(), `${key} is not empty`);
    assert.deepEqual(placeholders(ta[key]), placeholders(en[key]), `${key} placeholders match`);
  }
});

test('the Tamil dictionary is actually Tamil', () => {
  const tamil = Object.values(ta).filter((s) => /[஀-௿]/.test(s)).length;
  assert.ok(tamil / Object.keys(ta).length > 0.97, `${tamil} of ${Object.keys(ta).length} strings contain Tamil script`);
});

test('every literal key used by the worker app and the dashboard exists', () => {
  const used = new Set();
  for (const m of ui.matchAll(/\bt\(\s*'([\w.]+)'/g)) used.add(m[1]);
  for (const m of ui.matchAll(/\bt\([^)]*?\?\s*'([\w.]+)'\s*:\s*'([\w.]+)'/g)) used.add(m[1]).add(m[2]);
  assert.ok(used.size > 250);
  const missing = [...used].filter((k) => !(k in en));
  assert.deepEqual(missing, []);
});

test('every value the server can send has a label in both languages', () => {
  const families = {
    cat: Object.keys(CATEGORIES),
    status: STATUSES,
    step: STATUSES,
    type: CASE_TYPES,
    typeRule: CASE_TYPES,
    severity: SEVERITIES,
    outcome: [...new Set(Object.values(OUTCOMES).flat())],
    reason: PAY_REASONS,
    esc: ESCALATION_ROLES,
    industry: Object.keys(INDUSTRIES),
    wage: ['daily', 'monthly'],
    per: ['daily', 'monthly'],
    job: [...new Set(ORGS.flatMap((o) => o.workers.map((w) => w[2])))],
    title: [...new Set(ORGS.flatMap((o) => o.admins.map((a) => a[1])))],
    line: ['basic', 'overtime', 'pf', 'esi', 'advance', 'adjustment', 'recovery', 'night', ...new Set(ORGS.flatMap((o) => o.allowances.map((a) => a.code)))],
    history: ['submitted', 'acknowledged', 'assigned', 'message', 'resolved', 'confirmed', 'reopened', 'escalated.ack', 'escalated.resolve', 'shift_corrected', 'shift_added', 'adjustment'],
    fatigue: ['LONG_SHIFT', 'WEEKLY_HOURS', 'SHORT_REST', 'NO_WEEKLY_OFF'],
    flag: ['LONG_SHIFT', 'WEEKLY_HOURS', 'SHORT_REST', 'NO_WEEKLY_OFF', 'MISSING_CHECKOUT', 'BELOW_MIN_WAGE', 'PAY_DISPUTE_OPEN', 'CASE_OVERDUE', 'CRITICAL_OPEN', 'CASE_REOPENED'],
    flagShort: ['LONG_SHIFT', 'WEEKLY_HOURS', 'SHORT_REST', 'NO_WEEKLY_OFF', 'MISSING_CHECKOUT', 'BELOW_MIN_WAGE'],
    rule: ['LONG_SHIFT', 'WEEKLY_HOURS', 'SHORT_REST', 'NO_WEEKLY_OFF', 'MISSING_CHECKOUT', 'BELOW_MIN_WAGE', 'PAY_DISPUTE_OPEN', 'CRITICAL_OPEN', 'CASE_REOPENED', 'CASE_OVERDUE.ack', 'CASE_OVERDUE.resolve', 'CASE_OVERDUE.ack.pay', 'CASE_OVERDUE.resolve.pay'],
    flagKind: ['hours', 'attendance', 'pay', 'case'],
    flagSeverity: ['critical', 'warning', 'info'],
    shift: ['done', 'on_shift', 'missing_checkout'],
    input: ['text', 'voice'],
    'speak.kind': ['safety', 'grievance'],
    audit: ['case_rules_updated'],
  };
  const missing = [];
  for (const [family, values] of Object.entries(families)) {
    for (const v of values) if (!(`${family}.${v}` in en)) missing.push(`${family}.${v}`);
  }
  // Seed data job roles and industries line up with the categories offered.
  for (const preset of Object.values(INDUSTRIES)) for (const c of preset.categories) if (!(`cat.${c}` in en)) missing.push(`cat.${c}`);
  assert.deepEqual(missing, []);
});

test('every error code and field name the server can return is translated', () => {
  const codes = new Set();
  for (const m of server.matchAll(/new (?:HttpError|CaseError)\(\s*(?:\d+,\s*)?'([a-z_]+)'/g)) codes.add(m[1]);
  for (const m of server.matchAll(/error: '([a-z_]+)'/g)) codes.add(m[1]);
  assert.ok(codes.size > 20);
  assert.deepEqual([...codes].filter((c) => !(`error.${c}` in en)), []);

  const fields = new Set();
  for (const m of server.matchAll(/v\.(?:text|oneOf|integer|bool|pattern|days|localDateTime)\([^,]+,\s*'([\w.]+)'/g)) fields.add(m[1].split('.')[0]);
  for (const m of server.matchAll(/invalid\('([\w.]+)'\)/g)) fields.add(m[1].split('.')[0]);
  for (const m of server.matchAll(/`(\w+)\.\$\{/g)) fields.add(m[1]);
  assert.ok(fields.size > 20);
  assert.deepEqual([...fields].filter((f) => !(`field.${f}` in en)), []);
});
