'use strict';

const RUPEE = 100; // all money is stored as integer paise

/**
 * Default labour rules. Values follow India's Code on Wages, 2019 and the
 * Occupational Safety, Health and Working Conditions Code, 2020: 8 hours a
 * day, 48 hours a week, overtime at no less than twice the ordinary rate.
 * Every value is stored per organisation; confirm state-notified rates
 * before production use.
 */
const BASE_RULES = Object.freeze({
  dailyHours: 8,
  weeklyHours: 48,
  overtimeMultiplier: 2,
  maxShiftHours: 10,
  minRestHours: 10,
  maxConsecutiveDays: 6,
  workingDaysPerMonth: 26,
  // An open shift older than this is treated as a missing check-out.
  staleShiftHours: 16,
  pfRate: 0.12,
  pfWageCeiling: 15000 * RUPEE,
  esiRate: 0.0075,
  esiGrossCeiling: 21000 * RUPEE,
});

/**
 * Everything a worker can raise through SpeakSafe. `kind` decides whether it
 * is a safety report or a grievance; `severity` is the starting triage level.
 */
const CATEGORIES = Object.freeze({
  fall: { kind: 'safety', severity: 'high', icon: '🪜' },
  structural: { kind: 'safety', severity: 'high', icon: '🧱' },
  electrical: { kind: 'safety', severity: 'high', icon: '⚡' },
  ppe: { kind: 'safety', severity: 'medium', icon: '🦺' },
  machinery: { kind: 'safety', severity: 'medium', icon: '🏗️' },
  heat: { kind: 'safety', severity: 'medium', icon: '🌡️' },
  water: { kind: 'safety', severity: 'medium', icon: '🚰' },
  fire: { kind: 'safety', severity: 'high', icon: '🔥' },
  wet_floor: { kind: 'safety', severity: 'low', icon: '💧' },
  chemical: { kind: 'safety', severity: 'medium', icon: '🧪' },
  lighting: { kind: 'safety', severity: 'medium', icon: '🔦' },
  sanitation: { kind: 'safety', severity: 'low', icon: '🚻' },
  harassment: { kind: 'grievance', severity: 'high', icon: '🛑' },
  unfair_treatment: { kind: 'grievance', severity: 'medium', icon: '⚖️' },
  wage_delay: { kind: 'grievance', severity: 'medium', icon: '⏳' },
  workload: { kind: 'grievance', severity: 'medium', icon: '🧺' },
  other: { kind: 'grievance', severity: 'low', icon: '💬' },
});

const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

/** Who an overdue case is escalated to. Labels are translated in the UI. */
const ESCALATION_ROLES = Object.freeze(['project_director', 'principal', 'hr_head', 'owner']);

/**
 * Industry presets: one platform, configured for how each workplace runs.
 * Deadlines are hours: `ack` to acknowledge a new case, `resolve` to resolve it.
 */
const INDUSTRIES = Object.freeze({
  construction: {
    wageType: 'daily',
    rules: { ...BASE_RULES, maxShiftHours: 10, staleShiftHours: 16 },
    categories: ['fall', 'structural', 'electrical', 'ppe', 'machinery', 'heat', 'water', 'harassment', 'wage_delay', 'unfair_treatment', 'other'],
    caseRules: {
      deadlines: {
        critical: { ack: 1, resolve: 8 },
        high: { ack: 4, resolve: 48 },
        medium: { ack: 24, resolve: 120 },
        low: { ack: 48, resolve: 240 },
      },
      pay: { ack: 24, resolve: 120 },
      escalateTo: 'project_director',
    },
  },
  education: {
    wageType: 'monthly',
    rules: { ...BASE_RULES, maxShiftHours: 12, staleShiftHours: 18 },
    categories: ['electrical', 'fire', 'wet_floor', 'chemical', 'lighting', 'sanitation', 'water', 'harassment', 'workload', 'unfair_treatment', 'other'],
    caseRules: {
      deadlines: {
        critical: { ack: 2, resolve: 24 },
        high: { ack: 8, resolve: 72 },
        medium: { ack: 24, resolve: 168 },
        low: { ack: 72, resolve: 336 },
      },
      pay: { ack: 48, resolve: 240 },
      escalateTo: 'principal',
    },
  },
});

function industryPreset(industry) {
  const preset = INDUSTRIES[industry];
  if (!preset) throw new Error(`Unknown industry: ${industry}`);
  return preset;
}

/** Categories offered to workers of an organisation, with their icon and kind. */
function categoriesFor(industry) {
  return industryPreset(industry).categories.map((id) => ({ id, ...CATEGORIES[id] }));
}

module.exports = { RUPEE, BASE_RULES, CATEGORIES, SEVERITIES, ESCALATION_ROLES, INDUSTRIES, industryPreset, categoriesFor };
