'use strict';

const crypto = require('node:crypto');
const { RUPEE, industryPreset } = require('../config/industries');
const { HOUR, MINUTE, dayKey, dayStart, addDays } = require('../domain/time');
const { triage } = require('../domain/triage');
const { computePayslip, paySnapshot } = require('../domain/payroll');
const { newCase, applyAction, newCaseRef, newAccessCode, hashAccessCode } = require('../domain/cases');

/** Bump when the seed changes, so deployed demos pick up the new data. */
const SEED_VERSION = 4;
const TZ = 330; // India Standard Time, UTC+5:30
const HISTORY_DAYS = 35;

/** Small deterministic PRNG (mulberry32) so the demo is the same on every seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bytesFrom = (r) => (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));

/**
 * Two fictional workplaces, one per industry mode. They share all code; what
 * differs is configuration (wage type, rules, categories, deadlines) and data.
 * [name, language, job role, wage in rupees (per day or per month), pattern]
 */
const ORGS = [
  {
    id: 'org_construction',
    name: 'Sunrise Towers Site',
    industry: 'construction',
    city: 'Chennai',
    siteId: 'site_sunrise_b',
    minimumDailyWage: 700 * RUPEE,
    allowances: [{ code: 'travel', amount: 600 * RUPEE }],
    admins: [
      ['Vikram Rao', 'site_manager', '9000000100'],
      ['Priya Natarajan', 'safety_officer', '9000000110'],
      ['Dinesh Kumar', 'payroll_accountant', '9000000111'],
    ],
    workers: [
      ['Murugan Selvam', 'ta', 'mason', 950, 'steady'],
      ['Lakshmi Perumal', 'ta', 'helper', 720, 'steady'],
      ['Ramesh Yadav', 'en', 'helper', 720, 'overworked'],
      ['Kannan Velu', 'ta', 'crane_operator', 1100, 'missedCheckout'],
      ['Arjun Das', 'en', 'electrician', 1000, 'steady'],
      ['Selvi Raman', 'ta', 'helper', 680, 'newJoiner'],
      ['Imran Shaikh', 'en', 'carpenter', 900, 'overtimeHeavy'],
      ['Sathish Kumar', 'ta', 'bar_bender', 850, 'steady'],
    ],
  },
  {
    id: 'org_college',
    name: 'Greenfield Arts & Science College',
    industry: 'education',
    city: 'Chennai',
    siteId: 'site_greenfield_main',
    minimumDailyWage: 560 * RUPEE,
    allowances: [{ code: 'hra', amount: 1500 * RUPEE }],
    admins: [
      ['Revathi Nair', 'admin_officer', '9000000200'],
      ['Mohan Raj', 'estate_manager', '9000000210'],
      ['Shanthi Ramesh', 'accounts_officer', '9000000211'],
    ],
    workers: [
      ['Meena Krishnan', 'ta', 'housekeeping', 15500, 'steady'],
      ['Raju Pandian', 'ta', 'security_guard', 16000, 'night'],
      ['Joseph DSouza', 'en', 'electrician', 21000, 'overtimeHeavy'],
      ['Fatima Begum', 'ta', 'housekeeping', 15500, 'steady'],
      ['Prakash Murthy', 'ta', 'plumber', 17000, 'steady'],
      ['Kavitha Mani', 'ta', 'housekeeping_supervisor', 18000, 'steady'],
      ['Suresh Babu', 'ta', 'security_guard', 16000, 'backToBack'],
      ['Anbu Selvan', 'ta', 'gardener', 14000, 'steady'],
    ],
  },
];

/** Planned start hour and length for a pattern on a day (offset 0 = today), or null for a day off. */
function plannedShift(pattern, offset, dow, r) {
  const sunday = dow === 0;
  switch (pattern) {
    case 'overworked':
      if (offset <= 12) return { start: 6.5, hours: 12 + r() }; // no weekly off lately
      return sunday || r() > 0.93 ? null : { start: 8, hours: 9 + r() * 0.5 };
    case 'overtimeHeavy':
      return sunday || r() > 0.93 ? null : { start: 8, hours: 8 + (r() < 0.6 ? 2 + r() : 0.3) };
    case 'night':
      return sunday || r() > 0.95 ? null : { start: 20, hours: 12 };
    case 'backToBack':
      if (sunday) return null;
      return offset % 2 === 0 ? { start: 7, hours: 8 } : { start: 22, hours: 8 };
    default:
      return sunday || r() > 0.93 ? null : { start: 8, hours: 7.5 + r() * 0.5 + (r() < 0.08 ? 1 + r() * 0.5 : 0) };
  }
}

/** Story days referenced by the seeded pay disputes. */
const STORY = {
  missedCheckout: { offset: 2, start: 8 + 5 / 60, hours: null },
  imranOvertime: { offset: 5, start: 8, hours: 10.5 },
};

function seedShifts({ org, worker, pattern, now, r }) {
  const today = dayKey(now, TZ);
  const joinedDaysAgo = Math.floor((now - worker.joinedAt) / (24 * HOUR));
  const shifts = [];
  for (let offset = Math.min(HISTORY_DAYS, joinedDaysAgo); offset >= 0; offset -= 1) {
    const day = addDays(today, -offset);
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    let plan = plannedShift(pattern, offset, dow, r);
    let jitter = Math.round((r() - 0.3) * 20) * MINUTE;
    if (pattern === 'missedCheckout' && offset === STORY.missedCheckout.offset) {
      plan = STORY.missedCheckout;
      jitter = 0;
    }
    if (worker.id === 'org_construction_w7' && offset === STORY.imranOvertime.offset) {
      plan = STORY.imranOvertime;
      jitter = 0;
    }
    if (!plan) continue;
    const checkIn = dayStart(day, TZ) + plan.start * HOUR + jitter;
    if (checkIn > now) continue;
    const end = plan.hours == null ? null : Math.round(checkIn + plan.hours * HOUR);
    shifts.push({
      id: `sh_${worker.id}_${day}`,
      orgId: org.id,
      userId: worker.id,
      checkIn: Math.round(checkIn),
      checkOut: end != null && end <= now ? end : null,
      method: r() < 0.75 ? 'qr' : 'code',
      corrections: [],
    });
    // A late-night concrete pour two days ago: the back-to-back shift the radar should flag.
    if (pattern === 'overworked' && offset === 2) {
      const pour = dayStart(day, TZ) + 22 * HOUR;
      if (pour + 4 * HOUR <= now) {
        shifts.push({ id: `sh_${worker.id}_${day}_pour`, orgId: org.id, userId: worker.id, checkIn: pour, checkOut: pour + 4 * HOUR, method: 'qr', corrections: [] });
      }
    }
  }
  return shifts;
}

/** Builds the seeded cases by replaying real actions through the case engine. */
async function seedCases({ org, admins, workers, shifts, now, r }) {
  const bytes = bytesFrom(r);
  const at = (hoursAgo) => now - hoursAgo * HOUR;
  const today = dayKey(now, TZ);
  const month = today.slice(0, 7);
  const [a1, a2, a3] = admins.map((a) => ({ type: 'admin', id: a.id }));
  const w = (n) => workers[n - 1];
  const adjustments = [];
  const demoCodes = [];

  async function make({ key, type, category, description, lang, inputMode = 'text', reporter, hoursAgo, pay }) {
    const ref = newCaseRef(bytes);
    let access = null;
    if (!reporter) {
      const code = newAccessCode(bytes);
      const salt = bytes(16).toString('hex');
      access = { salt, hash: await hashAccessCode(code, salt) };
      demoCodes.push({ key, ref, code });
    }
    const { severity, matchedKeywords } = type === 'pay' ? { severity: 'medium', matchedKeywords: [] } : triage({ category, description });
    return newCase({
      id: `case_${org.id}_${key}`,
      ref,
      org,
      type,
      category,
      severity,
      matchedKeywords,
      description,
      lang,
      inputMode,
      reporterId: reporter ? reporter.id : null,
      access,
      pay,
      now: at(hoursAgo),
    });
  }
  const act = (record, action, hoursAgo, ctx) => applyAction(record, action, { now: at(hoursAgo), caseRules: org.caseRules, ...ctx });

  function dispute(worker, lineCode, reason, days, expectedAmount, hoursAgo, adjustmentList = []) {
    const disputeMonth = days[0] ? days[0].slice(0, 7) : month;
    const payslip = computePayslip({
      worker,
      shifts: shifts.filter((s) => s.userId === worker.id),
      rules: org.rules,
      month: disputeMonth,
      tzOffsetMinutes: TZ,
      minimumDailyWage: org.minimumDailyWage,
      adjustments: adjustmentList,
    });
    return { month: disputeMonth, lineCode, reason, days, expectedAmount, snapshot: paySnapshot(payslip, lineCode, days, at(hoursAgo)) };
  }

  const cases = [];
  if (org.industry === 'construction') {
    cases.push(
      await make({
        key: 'scaffold', type: 'safety', category: 'fall', lang: 'ta', inputMode: 'voice', hoursAgo: 30,
        description: 'நான்காவது மாடி சாரத்தில் கைப்பிடிக் கயிறு இல்லை. யாராவது கீழே விழும் அபாயம் உள்ளது.',
      }),
    );

    let c = await make({
      key: 'supervisor', type: 'grievance', category: 'harassment', lang: 'ta', inputMode: 'voice', hoursAgo: 30,
      description: 'சூப்பர்வைசர் எல்லோர் முன்னிலையிலும் திட்டுகிறார். 10 நிமிடம் தாமதமானால் அரை நாள் சம்பளம் பிடிக்கிறார்.',
    });
    c = act(c, 'acknowledge', 28, { actor: a1, assigneeId: a2.id });
    c = act(c, 'message', 27, { actor: a2, text: 'புகாருக்கு நன்றி. இது எந்த நாள் நடந்தது என்று சொல்ல முடியுமா? வருகைப் பதிவேட்டைச் சரிபார்க்கிறோம்.' });
    c = act(c, 'message', 20, { actor: { type: 'reporter' }, text: 'செவ்வாய்க்கிழமை காலை. எங்கள் குழுவில் மூன்று பேருக்கு இப்படி நடந்தது.' });
    cases.push(c);

    c = await make({
      key: 'water', type: 'safety', category: 'water', lang: 'ta', reporter: w(2), hoursAgo: 70,
      description: 'மதியத்திற்குள் குடிநீர் தீர்ந்துவிடுகிறது. வெயிலில் வேலை செய்ய முடியவில்லை.',
    });
    c = act(c, 'acknowledge', 66, { actor: a1 });
    c = act(c, 'message', 60, { actor: a1, text: 'A second water tanker is booked from Monday.' });
    c = act(c, 'resolve', 20, { actor: a1, outcome: 'fixed', note: 'A second water tanker now comes at 1 pm every day, and two extra drums are on level 3.' });
    cases.push(c);

    c = await make({
      key: 'shade', type: 'safety', category: 'heat', lang: 'ta', reporter: w(1), hoursAgo: 20,
      description: 'மதிய வெயிலில் ஓய்வு எடுக்க நிழல் இல்லை.',
    });
    c = act(c, 'acknowledge', 18, { actor: a1, assigneeId: a2.id });
    c = act(c, 'message', 17, { actor: a2, text: 'Shade net ordered. It goes up near the ground-floor rest area on Thursday.' });
    cases.push(c);

    c = await make({
      key: 'wire', type: 'safety', category: 'electrical', lang: 'en', reporter: w(5), hoursAgo: 216,
      description: 'Loose live wire hanging near the material lift on level 2.',
    });
    c = act(c, 'acknowledge', 214, { actor: a1, assigneeId: a2.id });
    c = act(c, 'resolve', 206, { actor: a2, outcome: 'fixed', note: 'Wire insulated and the junction box closed by the site electrician. Checked again the next morning.' });
    c = act(c, 'confirm', 200, { actor: { type: 'worker', id: w(5).id }, note: 'Checked it. It is safe now.' });
    cases.push(c);

    const missedDay = addDays(today, -STORY.missedCheckout.offset);
    cases.push(
      await make({
        key: 'missed-checkout', type: 'pay', category: 'basic', lang: 'ta', reporter: w(4), hoursAgo: 20,
        description: 'அன்று காலை 8 மணி முதல் மாலை 5 மணி வரை வேலை செய்தேன். வெளியேறும் பதிவு இல்லாததால் அந்த நாள் சம்பளத்தில் சேரவில்லை.',
        pay: dispute(w(4), 'basic', 'hours_missing', [missedDay], 1100 * RUPEE, 20),
      }),
    );

    const pourDay = addDays(today, -STORY.imranOvertime.offset);
    c = await make({
      key: 'overtime', type: 'pay', category: 'overtime', lang: 'en', reporter: w(7), hoursAgo: 50,
      description: 'I stayed till 9 pm for the slab pour that day, but overtime shows only 2.5 hours.',
      pay: dispute(w(7), 'overtime', 'overtime_missing', [pourDay], null, 50),
    });
    c = act(c, 'acknowledge', 45, { actor: a1, assigneeId: a3.id });
    c = act(c, 'message', 44, { actor: a3, text: 'Checking the gate register and the pour log for that evening.' });
    cases.push(c);
  } else {
    cases.push(
      await make({
        key: 'switchboard', type: 'safety', category: 'electrical', lang: 'en', reporter: w(3), hoursAgo: 9,
        description: 'Exposed wiring at the Block C corridor switchboard. Students touch it while passing.',
      }),
    );

    let c = await make({
      key: 'acid', type: 'safety', category: 'chemical', lang: 'ta', hoursAgo: 40,
      description: 'வேதியியல் ஆய்வக அறையில் அமிலப் பாட்டில்களுக்கு லேபிள் இல்லை. சுத்தம் செய்யும்போது பயமாக இருக்கிறது.',
    });
    c = act(c, 'acknowledge', 36, { actor: a1, assigneeId: a2.id });
    c = act(c, 'message', 35, { actor: a2, text: 'The lab in-charge will label and lock the store this week. Please do not clean that shelf until then.' });
    cases.push(c);

    cases.push(
      await make({
        key: 'night-duty', type: 'grievance', category: 'workload', lang: 'ta', inputMode: 'voice', hoursAgo: 80,
        description: 'இரவுப் பணி முடிந்த பிறகும் விடுதியில் கூடுதல் வேலை செய்யச் சொல்கிறார்கள். அதற்கு ஓவர்டைம் கிடைப்பதில்லை.',
      }),
    );

    c = await make({
      key: 'toilet-floor', type: 'safety', category: 'wet_floor', lang: 'ta', reporter: w(1), hoursAgo: 200,
      description: 'கழிப்பறை அருகே தரையில் தண்ணீர் தேங்கியுள்ளது. இருவர் வழுக்கும் நிலை ஏற்பட்டது.',
    });
    c = act(c, 'acknowledge', 196, { actor: a1, assigneeId: a2.id });
    c = act(c, 'resolve', 180, { actor: a2, outcome: 'fixed', note: 'Drain cleared and anti-slip mats placed outside both toilets.' });
    c = act(c, 'confirm', 170, { actor: { type: 'worker', id: w(1).id }, note: null });
    cases.push(c);

    c = await make({
      key: 'gate-lights', type: 'safety', category: 'lighting', lang: 'ta', reporter: w(2), hoursAgo: 30,
      description: 'விடுதி வாயில் அருகே பாதை விளக்குகள் எரியவில்லை. இரவில் ரோந்து செல்வது கடினம்.',
    });
    c = act(c, 'acknowledge', 26, { actor: a1, assigneeId: a2.id });
    cases.push(c);

    cases.push(
      await make({
        key: 'night-allowance', type: 'pay', category: 'night', lang: 'ta', reporter: w(2), hoursAgo: 26,
        description: 'இரவுப் பணிப் படி ₹1,500 என்று சொன்னார்கள். சம்பளச் சீட்டில் ₹1,200 மட்டுமே உள்ளது.',
        pay: dispute(w(2), 'night', 'allowance_missing', [], 1500 * RUPEE, 26),
      }),
    );

    c = await make({
      key: 'advance', type: 'pay', category: 'advance', lang: 'ta', reporter: w(1), hoursAgo: 144,
      description: 'இந்த மாதம் நான் எந்த முன்பணமும் வாங்கவில்லை. ஆனால் ₹1,000 பிடித்திருக்கிறார்கள்.',
      pay: dispute(w(1), 'advance', 'wrong_deduction', [], 0, 144),
    });
    c = act(c, 'acknowledge', 140, { actor: a1, assigneeId: a3.id });
    c = act(c, 'message', 120, { actor: a3, text: 'Checking the advance register.' });
    adjustments.push({
      id: `adj_${c.id}`,
      orgId: org.id,
      userId: w(1).id,
      month,
      amount: 1000 * RUPEE,
      reason: 'Advance entered against the wrong person; refunded.',
      caseId: c.id,
      caseRef: c.ref,
      createdBy: a3.id,
      createdAt: at(25),
    });
    c.history.push({ at: at(25), actor: a3, action: 'adjustment', amount: 1000 * RUPEE, month });
    c = act(c, 'resolve', 24, { actor: a3, outcome: 'upheld', note: "The ₹1,000 advance was entered against the wrong person. It is refunded as an adjustment on this month's payslip." });
    cases.push(c);
  }
  return { cases, adjustments, demoCodes };
}

/**
 * Writes the full demo dataset relative to `now`, so the dashboard always
 * shows current activity. Deterministic apart from the per-organisation
 * check-in secret, which is always random.
 */
async function seedDemoData(repo, { now = Date.now() } = {}) {
  const thisMonth = dayKey(now, TZ).slice(0, 7);
  const anonymousCases = [];

  for (const [orgIndex, spec] of ORGS.entries()) {
    const preset = industryPreset(spec.industry);
    const org = {
      id: spec.id,
      name: spec.name,
      industry: spec.industry,
      city: spec.city,
      tz: TZ,
      siteId: spec.siteId,
      checkinSecret: crypto.randomBytes(32).toString('hex'),
      rules: structuredClone(preset.rules),
      caseRules: structuredClone(preset.caseRules),
      minimumDailyWage: spec.minimumDailyWage,
      wageType: preset.wageType,
      workDaysPerWeek: 6,
    };

    const admins = spec.admins.map(([name, title, phone], j) => ({
      id: `${spec.id}_a${j + 1}`,
      orgId: spec.id,
      role: 'admin',
      phone,
      name,
      title,
      lang: 'en',
    }));

    const workers = spec.workers.map(([name, lang, jobRole, wage, pattern], i) => {
      const r = rng(orgIndex * 100 + i + 1);
      const joinedDaysAgo = pattern === 'newJoiner' ? 25 : 120 + Math.floor(r() * 900);
      const advances = {};
      if (spec.industry === 'construction' && pattern === 'overtimeHeavy') advances[thisMonth] = 2000 * RUPEE;
      if (spec.industry === 'education' && i === 0) advances[thisMonth] = 1000 * RUPEE;
      return {
        id: `${spec.id}_w${i + 1}`,
        orgId: spec.id,
        role: 'worker',
        phone: `9000000${orgIndex + 1}${String(i + 1).padStart(2, '0')}`,
        name,
        lang,
        jobRole,
        wage: { type: preset.wageType, amount: wage * RUPEE },
        allowances: pattern === 'night' || pattern === 'backToBack' ? [{ code: 'night', amount: 1200 * RUPEE }] : spec.allowances,
        pfEnrolled: pattern !== 'newJoiner',
        advances,
        joinedAt: now - joinedDaysAgo * 24 * HOUR,
        pattern,
        rngSeed: orgIndex * 100 + i + 1,
      };
    });

    const shifts = workers.flatMap((worker) =>
      seedShifts({ org, worker, pattern: worker.pattern, now, r: rng(worker.rngSeed * 7919) }),
    );
    const { cases, adjustments, demoCodes } = await seedCases({ org, admins, workers, shifts, now, r: rng(orgIndex + 4242) });

    await repo.putMany('orgs', [org]);
    await repo.putMany('users', [...admins, ...workers.map(({ pattern, rngSeed, ...w }) => w)]);
    await repo.putMany('shifts', shifts);
    await repo.putMany('cases', cases);
    await repo.putMany('adjustments', adjustments);
    for (const d of demoCodes) anonymousCases.push({ orgId: org.id, ...d });
  }
  return { anonymousCases };
}

const seedIsFresh = (meta, now, resetHours) =>
  Boolean(meta && meta.version === SEED_VERSION && meta.seededAt && (!resetHours || now - meta.seededAt < resetHours * HOUR));

/**
 * Seeds demo data when there is none, when the seed version changed, or when
 * it is older than `resetHours` (0 = never refresh). Safe with several Cloud
 * Run instances: one instance claims the job through a transaction.
 */
async function ensureDemoData(repo, { now = Date.now(), resetHours = 24, force = false } = {}) {
  if (!force && seedIsFresh(await repo.getMeta('seed'), now, resetHours)) return false;
  const claimed = await repo.updateMeta('seed', (current) => {
    if (!force && seedIsFresh(current, now, resetHours)) return undefined;
    if (current?.seedingAt && now - current.seedingAt < 2 * 60 * 1000) return undefined;
    return { ...(current || {}), id: 'seed', seedingAt: now };
  });
  if (claimed?.seedingAt !== now) return false;

  await repo.clearSeeded();
  const { anonymousCases } = await seedDemoData(repo, { now });
  await repo.updateMeta('demo', () => ({ id: 'demo', anonymousCases }));
  await repo.updateMeta('seed', () => ({ id: 'seed', version: SEED_VERSION, seededAt: now, seedingAt: null }));
  return true;
}

module.exports = { seedDemoData, ensureDemoData, SEED_VERSION, ORGS, TZ };
