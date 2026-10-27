'use strict';

const { hazardsFor } = require('../config/sectors');
const { slaStatus } = require('../domain/triage');

/** Shapes domain records into API responses. Only whitelisted fields leave the server. */

function presentUser(user, store) {
  const org = store.getOrg(user.orgId);
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    lang: user.lang,
    title: user.title || null,
    jobRole: user.jobRole || null,
    org: { id: org.id, name: org.name, sector: org.sector, city: org.city, hazards: hazardsFor(org.sector) },
  };
}

function presentReportForWorker(report) {
  return {
    id: report.id,
    category: report.category,
    status: report.status,
    anonymous: report.anonymous,
    urgent: report.severity === 'critical',
    response: report.response,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };
}

function presentReportForAdmin(report, now, store) {
  return {
    id: report.id,
    category: report.category,
    description: report.description,
    summaryEn: report.summaryEn,
    lang: report.lang,
    inputMode: report.inputMode,
    anonymous: report.anonymous,
    // Anonymous reports have no reporter stored at all, so there is nothing to reveal.
    reporterName: report.anonymous ? null : store.getUser(report.reporterId)?.name || null,
    severity: report.severity,
    matchedKeywords: report.matchedKeywords,
    aiAssisted: Boolean(report.aiAssisted),
    status: report.status,
    response: report.response,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
    sla: slaStatus(report, now),
  };
}

function presentPayQuery(query, store) {
  const worker = store?.getUser(query.userId);
  return {
    id: query.id,
    month: query.month,
    lineCode: query.lineCode,
    message: query.message,
    status: query.status,
    response: query.response,
    createdAt: query.createdAt,
    ...(store ? { workerId: query.userId, workerName: worker?.name || null } : {}),
  };
}

module.exports = { presentUser, presentReportForWorker, presentReportForAdmin, presentPayQuery };
