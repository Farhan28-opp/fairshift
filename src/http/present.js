'use strict';

const { categoriesFor, ESCALATION_ROLES, SEVERITIES } = require('../config/industries');

/** Shapes records into API responses. Only whitelisted fields leave the server (never secrets). */

function presentOrg(org) {
  return {
    id: org.id,
    name: org.name,
    industry: org.industry,
    city: org.city,
    wageType: org.wageType,
    categories: categoriesFor(org.industry),
  };
}

/** The configuration an administrator can see (and partly edit). */
function presentOrgConfig(org) {
  return {
    ...presentOrg(org),
    minimumDailyWage: org.minimumDailyWage,
    rules: {
      dailyHours: org.rules.dailyHours,
      weeklyHours: org.rules.weeklyHours,
      overtimeMultiplier: org.rules.overtimeMultiplier,
      maxShiftHours: org.rules.maxShiftHours,
      minRestHours: org.rules.minRestHours,
      maxConsecutiveDays: org.rules.maxConsecutiveDays,
      staleShiftHours: org.rules.staleShiftHours,
      workingDaysPerMonth: org.rules.workingDaysPerMonth,
      pfRate: org.rules.pfRate,
      esiRate: org.rules.esiRate,
    },
    caseRules: org.caseRules,
    escalationRoles: ESCALATION_ROLES,
    severities: SEVERITIES,
  };
}

function presentUser(user, org) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    lang: user.lang,
    title: user.title || null,
    jobRole: user.jobRole || null,
    wage: user.wage || null,
    org: presentOrg(org),
  };
}

module.exports = { presentOrg, presentOrgConfig, presentUser };
