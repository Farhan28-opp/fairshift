'use strict';

const RUPEE = 100; // all money is stored as integer paise

/**
 * Default labour rules. Values follow India's Code on Wages, 2019 and the
 * Occupational Safety, Health and Working Conditions Code, 2020 (in force
 * since 21 Nov 2025): 8 hours a day, 48 hours a week, overtime paid at
 * no less than twice the ordinary rate. Every value is overridable per
 * organisation; confirm state-notified rates before production use.
 */
const BASE_RULES = Object.freeze({
  dailyHours: 8,
  weeklyHours: 48,
  overtimeMultiplier: 2,
  maxShiftHours: 10,
  minRestHours: 10,
  maxConsecutiveDays: 6,
  workingDaysPerMonth: 26,
  pfRate: 0.12,
  pfWageCeiling: 15000 * RUPEE,
  esiRate: 0.0075,
  esiGrossCeiling: 21000 * RUPEE,
});

/** Hazard categories a worker can pick from. `severity` is the triage baseline. */
const HAZARDS = Object.freeze({
  fall: { icon: '🪜', severity: 'high' },
  structural: { icon: '🧱', severity: 'high' },
  electrical: { icon: '⚡', severity: 'high' },
  fire: { icon: '🔥', severity: 'high' },
  machinery: { icon: '⚙️', severity: 'medium' },
  ppe: { icon: '🦺', severity: 'medium' },
  heat: { icon: '🌡️', severity: 'medium' },
  water: { icon: '🚰', severity: 'medium' },
  chemical: { icon: '🧪', severity: 'medium' },
  biohazard: { icon: '☣️', severity: 'high' },
  violence: { icon: '🛑', severity: 'high' },
  wet_floor: { icon: '💧', severity: 'low' },
  sanitation: { icon: '🚻', severity: 'low' },
  abuse: { icon: '🗣️', severity: 'high' },
  other: { icon: '❓', severity: 'low' },
});

/** Sector presets: the same platform, tuned to how each industry works. */
const SECTORS = Object.freeze({
  construction: {
    rules: { ...BASE_RULES, maxShiftHours: 10 },
    hazards: ['fall', 'structural', 'electrical', 'ppe', 'machinery', 'heat', 'water', 'abuse', 'other'],
  },
  education: {
    rules: { ...BASE_RULES, maxShiftHours: 12, minRestHours: 10 },
    hazards: ['electrical', 'fire', 'wet_floor', 'chemical', 'sanitation', 'water', 'abuse', 'other'],
  },
  healthcare: {
    rules: { ...BASE_RULES, maxShiftHours: 12, minRestHours: 8 },
    hazards: ['biohazard', 'violence', 'chemical', 'wet_floor', 'ppe', 'electrical', 'fire', 'abuse', 'other'],
  },
  manufacturing: {
    rules: { ...BASE_RULES, maxShiftHours: 10 },
    hazards: ['machinery', 'chemical', 'fire', 'electrical', 'ppe', 'heat', 'abuse', 'other'],
  },
});

function sectorPreset(sector) {
  const preset = SECTORS[sector];
  if (!preset) throw new Error(`Unknown sector: ${sector}`);
  return preset;
}

function hazardsFor(sector) {
  return sectorPreset(sector).hazards.map((id) => ({ id, icon: HAZARDS[id].icon }));
}

module.exports = { RUPEE, BASE_RULES, HAZARDS, SECTORS, sectorPreset, hazardsFor };
