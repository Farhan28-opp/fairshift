'use strict';

const { dayKey } = require('./time');

/** "Murugan Selvam" -> "Murugan S." so a shared passport does not expose a full name. */
function publicName(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1).charAt(0)}.`;
}

/**
 * Portable work history. Days worked here are verified from check-ins;
 * earlier jobs and training are shown as self-declared unless an employer endorsed them.
 */
function buildPassport({ worker, org, shifts, tzOffsetMinutes }) {
  const days = [...new Set(shifts.filter((s) => s.checkOut != null).map((s) => dayKey(s.checkIn, tzOffsetMinutes)))].sort();
  const current = {
    org: org.name,
    sector: org.sector,
    role: worker.jobRole,
    from: days[0] || null,
    to: days.at(-1) || null,
    daysWorked: days.length,
    verified: true,
  };
  return {
    name: publicName(worker.name),
    role: worker.jobRole,
    experience: [current, ...(worker.pastExperience || []).map((e) => ({ ...e, verified: false }))],
    skills: (worker.skills || []).map(({ name, issuer, date, verified }) => ({ name, issuer, date, verified })),
  };
}

module.exports = { buildPassport, publicName };
