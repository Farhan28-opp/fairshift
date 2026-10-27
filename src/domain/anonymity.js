'use strict';

const crypto = require('node:crypto');

/** Minimum group size before any feedback result is shown (k-anonymity). */
const K_ANONYMITY = 5;
const FEEDBACK_ASPECTS = Object.freeze(['pay', 'safety', 'respect', 'workload']);

/** Secret the worker's phone keeps to follow an anonymous report. Never stored in clear. */
function newTrackingToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Rounds a timestamp down so submission time cannot be matched to who was on shift. */
function coarsenTime(ts, granularityMs) {
  return Math.floor(ts / granularityMs) * granularityMs;
}

/**
 * One-feedback-per-week receipt. It proves "this worker already answered"
 * without linking the worker to the answer: receipts and answers live in
 * separate collections and share no key.
 */
function ballotKey(secret, workerId, week) {
  return crypto.createHmac('sha256', secret).update(`${workerId}:${week}`).digest('hex');
}

/** Inserts at a random position so storage order does not reveal submission order. */
function insertAtRandom(list, item) {
  list.splice(crypto.randomInt(list.length + 1), 0, item);
  return list;
}

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Aggregates anonymous feedback. Below k responses nothing is revealed,
 * not even averages, because a small team makes answers guessable.
 */
function aggregateFeedback(entries, k = K_ANONYMITY) {
  if (entries.length < k) {
    return { count: entries.length, threshold: k, suppressed: true, averages: null, comments: [] };
  }
  const averages = {};
  for (const aspect of FEEDBACK_ASPECTS) {
    const sum = entries.reduce((s, e) => s + e.scores[aspect], 0);
    averages[aspect] = Math.round((sum / entries.length) * 10) / 10;
  }
  const comments = shuffled(entries.filter((e) => e.comment).map((e) => e.comment));
  return { count: entries.length, threshold: k, suppressed: false, averages, comments };
}

module.exports = {
  K_ANONYMITY,
  FEEDBACK_ASPECTS,
  newTrackingToken,
  hashToken,
  coarsenTime,
  ballotKey,
  insertAtRandom,
  shuffled,
  aggregateFeedback,
};
