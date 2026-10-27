'use strict';

const { HAZARDS } = require('../config/sectors');
const { HOUR } = require('./time');

const SEVERITIES = Object.freeze(['low', 'medium', 'high', 'critical']);

/** How long a report may stay open before it is escalated on the dashboard. */
const SLA_HOURS = Object.freeze({ critical: 2, high: 24, medium: 72, low: 168 });

/**
 * Signals that someone is hurt or in immediate danger, in the languages
 * workers report in. Any match makes the report critical.
 * Matching is token-aware: `prefix` catches inflections (गिरा, गिरने), `exact`
 * avoids false hits on short words (आग "fire" vs आगे "ahead"), `phrase`
 * covers multi-word terms.
 */
const DANGER_TERMS = Object.freeze({
  prefix: [
    // English
    'injur', 'bleed', 'blood', 'unconscious', 'faint', 'collaps', 'electrocut', 'trapped', 'ambulanc', 'spark', 'crack',
    // Hindi
    'घायल', 'खून', 'बेहोश', 'धुआ', 'गिर', 'करंट', 'गैस', 'फंस', 'दरार', 'एम्बुलेंस',
    // Tamil
    'காயம', 'இரத்த', 'ரத்த', 'மயக்க', 'நெருப்ப', 'விழுந்த', 'சரிந்த', 'விரிசல', 'எரிவாயு', 'ஆம்புலன்ஸ', 'தீப்பிடி', 'ஷாக',
  ],
  exact: ['fell', 'fallen', 'shock', 'smoke', 'आग', 'புகை', 'தீ'],
  phrase: ['gas leak', 'மின் அதிர்ச்சி'],
});

const TOKEN_SPLIT = /[\s.,;:!?।|()[\]{}"'“”‘’/\\-]+/u;

const rank = (severity) => SEVERITIES.indexOf(severity);

function maxSeverity(a, b) {
  return rank(b) > rank(a) ? b : a;
}

function findDangerTerms(description) {
  const text = String(description || '').toLowerCase().normalize('NFC');
  const tokens = text.split(TOKEN_SPLIT).filter(Boolean);
  const hits = new Set();
  for (const token of tokens) {
    for (const p of DANGER_TERMS.prefix) if (token.startsWith(p)) hits.add(p);
    if (DANGER_TERMS.exact.includes(token)) hits.add(token);
  }
  for (const phrase of DANGER_TERMS.phrase) if (text.includes(phrase)) hits.add(phrase);
  return [...hits];
}

function triage({ category, description }) {
  const base = HAZARDS[category]?.severity || 'low';
  const matched = findDangerTerms(description);
  return { severity: matched.length ? 'critical' : base, matchedKeywords: matched };
}

/** Escalation state for open reports: hours left before (or since) the SLA deadline. */
function slaStatus(report, now) {
  const deadline = report.createdAt + SLA_HOURS[report.severity] * HOUR;
  const open = report.status !== 'resolved';
  return {
    deadline,
    escalated: open && now > deadline,
    hoursLeft: Math.round(((deadline - now) / HOUR) * 10) / 10,
  };
}

module.exports = { SEVERITIES, SLA_HOURS, DANGER_TERMS, triage, findDangerTerms, maxSeverity, slaStatus };
