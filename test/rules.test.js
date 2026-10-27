'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { INDUSTRIES } = require('../src/config/industries');
const { splitHours, siteCode, isStale, currentShift, missingCheckouts } = require('../src/domain/shifts');
const { evaluateFatigue } = require('../src/domain/fatigue');
const { triage, findDangerTerms } = require('../src/domain/triage');

const TZ = 330;
const HOUR = 3_600_000;
const rules = INDUSTRIES.construction.rules;
const at = (day, hour) => Date.parse(`${day}T00:00:00Z`) - TZ * 60_000 + hour * HOUR;
const shift = (day, start, hours) => ({ checkIn: at(day, start), checkOut: hours == null ? null : at(day, start) + hours * HOUR });

test('a shift belongs to the day it started, even when it ends after midnight', () => {
  const split = splitHours([shift('2026-10-05', 20, 12)], rules, TZ);
  assert.deepEqual(split.days.map((d) => [d.day, d.hours, d.overtime]), [['2026-10-05', 12, 4]]);
});

test('site check-in codes are six digits, stable for a day and different the next day', () => {
  const a = siteCode('secret', 'site-1', '2026-10-14');
  assert.match(a, /^\d{6}$/);
  assert.equal(siteCode('secret', 'site-1', '2026-10-14'), a);
  assert.notEqual(siteCode('secret', 'site-1', '2026-10-15'), a);
  assert.notEqual(siteCode('other-secret', 'site-1', '2026-10-14'), a);
});

test('an open shift older than the configured limit is a missing check-out, not a shift in progress', () => {
  const now = at('2026-10-14', 12);
  const stale = shift('2026-10-12', 8, null);
  const today = shift('2026-10-14', 8, null);
  assert.equal(isStale(stale, rules, now), true);
  assert.equal(isStale(today, rules, now), false);
  assert.equal(currentShift([stale, today], rules, now), today);
  assert.deepEqual(missingCheckouts([stale, today], rules, now), [stale]);
});

test('fatigue flags carry the measured value and the configured limit', () => {
  const now = at('2026-10-14', 23);
  const flags = evaluateFatigue([shift('2026-10-13', 6, 13), shift('2026-10-13', 21, 2)], rules, now, TZ);
  const byCode = Object.fromEntries(flags.map((f) => [f.code, f]));
  assert.deepEqual([byCode.LONG_SHIFT.value, byCode.LONG_SHIFT.limit], [13, rules.maxShiftHours]);
  assert.equal(byCode.SHORT_REST.value, 2);
  assert.equal(byCode.SHORT_REST.limit, rules.minRestHours);
  assert.equal(byCode.SHORT_REST.severity, 'critical');
});

test('fatigue ignores a shift with a missing check-out instead of counting days of hours', () => {
  const now = at('2026-10-14', 12);
  assert.deepEqual(evaluateFatigue([shift('2026-10-12', 8, null)], rules, now, TZ), []);
});

test('weekly-hours and no-day-off rules use the industry configuration', () => {
  const now = at('2026-10-14', 23);
  const days = Array.from({ length: 8 }, (_, i) => shift(`2026-10-${String(7 + i).padStart(2, '0')}`, 8, 9));
  const codes = evaluateFatigue(days, rules, now, TZ).map((f) => f.code);
  assert.ok(codes.includes('WEEKLY_HOURS'));
  assert.ok(codes.includes('NO_WEEKLY_OFF'));
  const relaxed = { ...rules, weeklyHours: 80, maxConsecutiveDays: 10 };
  assert.deepEqual(evaluateFatigue(days, relaxed, now, TZ), []);
});

test('triage: danger words in English, Tamil or Hindi make a report critical', () => {
  assert.equal(triage({ category: 'heat', description: 'A worker fainted near the mixer' }).severity, 'critical');
  assert.equal(triage({ category: 'other', description: 'ஒருவருக்கு காயம் ஏற்பட்டது' }).severity, 'critical');
  assert.equal(triage({ category: 'other', description: 'मजदूर घायल हो गया' }).severity, 'critical');
  assert.equal(triage({ category: 'water', description: 'Drinking water runs out by noon' }).severity, 'medium');
  assert.equal(triage({ category: 'wet_floor', description: 'Floor near the toilets is wet' }).severity, 'low');
});

test('triage does not fire on look-alike words', () => {
  assert.deepEqual(findDangerTerms('आगे जाओ, the shop is ahead'), []);
  assert.deepEqual(findDangerTerms('தீபாவளிக்கு விடுமுறை வேண்டும்'), [], 'தீ (fire) only matches as a whole word');
});

test('the two industry modes differ in configuration, not just labels', () => {
  const c = INDUSTRIES.construction;
  const e = INDUSTRIES.education;
  assert.equal(c.wageType, 'daily');
  assert.equal(e.wageType, 'monthly');
  assert.notEqual(c.rules.maxShiftHours, e.rules.maxShiftHours);
  assert.ok(c.categories.includes('fall') && !e.categories.includes('fall'));
  assert.ok(e.categories.includes('lighting') && !c.categories.includes('lighting'));
  assert.notDeepEqual(c.caseRules.deadlines, e.caseRules.deadlines);
  assert.notEqual(c.caseRules.escalateTo, e.caseRules.escalateTo);
});
