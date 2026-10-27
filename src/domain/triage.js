'use strict';

const { CATEGORIES, SEVERITIES } = require('../config/industries');

/**
 * Words that signal someone is hurt or in immediate danger, in the languages
 * workers report in (English, Tamil, and Hindi for migrant workers). Any match
 * makes the report critical. Matching is token-aware: `prefix` catches
 * inflections, `exact` avoids false hits on short words, `phrase` covers
 * multi-word terms. Triage can only raise severity, never lower it.
 */
const DANGER_TERMS = Object.freeze({
  prefix: [
    // English
    'injur', 'bleed', 'blood', 'unconscious', 'faint', 'collaps', 'electrocut', 'trapped', 'ambulanc', 'spark', 'crack',
    // Tamil
    'காயம', 'இரத்த', 'ரத்த', 'மயக்க', 'நெருப்ப', 'விழுந்த', 'சரிந்த', 'விரிசல', 'எரிவாயு', 'ஆம்புலன்ஸ', 'தீப்பிடி', 'ஷாக',
    // Hindi
    'घायल', 'खून', 'बेहोश', 'धुआ', 'गिर', 'करंट', 'फंस', 'दरार', 'एम्बुलेंस',
  ],
  exact: ['fell', 'fallen', 'shock', 'smoke', 'புகை', 'தீ', 'आग'],
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

/** Starting severity: the category's baseline, raised to critical when danger words appear. */
function triage({ category, description }) {
  const base = CATEGORIES[category]?.severity || 'low';
  const matched = findDangerTerms(description);
  return { severity: matched.length ? 'critical' : base, matchedKeywords: matched };
}

module.exports = { DANGER_TERMS, triage, findDangerTerms, maxSeverity };
