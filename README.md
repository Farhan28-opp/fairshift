# FairShift

**Fairer, safer, more transparent work for shift workers (UN SDG 8).**
A worker records a shift, sees exactly how it becomes pay, can challenge any amount or report a danger (with or without their name), and confirms whether the fix really worked. Employers get a rule-based **Fairness Radar** and the evidence to act.

Built for Prompt Wars 2026 (ACM SRMIST). One app, two industry modes: **construction site** and **college campus**. Tamil and English throughout.

---

## The Fairness Loop

```
 record shift ─▶ explained payslip ─▶ dispute a line / report a problem
      ▲                                          │
      │                                          ▼
 worker verifies ◀── resolution ◀── investigate with evidence
 (confirm or reopen)   (audited)    (assign, message, correct records, adjust pay, deadlines)
```

Every stage is implemented end to end and covered by automated tests.

| Stage | What happens |
|---|---|
| **Record** | Check in with the site's daily-rotating QR poster or its 6-digit code; check out with one tap. Records are stored in the database. |
| **Explain** | The payslip is calculated on the server from those records: basic, daily/weekly overtime, allowances, PF, ESI, advances and corrections, each with the numbers used ("21 days, 163.8 h × ₹137.50 an hour"). Read-aloud available. |
| **Challenge** | *PayProof*: "Question this" on any payslip line or shift record. The dispute freezes a snapshot of the line and the named days. *SpeakSafe*: safety reports and grievances, named or anonymous, typed or spoken. |
| **Investigate** | Admins see the case queue (overdue first), the original report, and for pay disputes the live attendance records next to the snapshot. They acknowledge, assign a responsible person, message the worker, correct a shift record or add a pay adjustment — each with a reason. |
| **Account** | Every status change, assignment, message, correction and escalation is appended to the case's audit history. Deadlines come from per-workplace configuration; a missed deadline is escalated and recorded. |
| **Verify** | The worker (or anonymous reporter) confirms the fix, or reopens the case with a reason and a fresh deadline. Only they can close it. |

## Features

**Attendance and PayProof** — persistent check-in/out; server-side hours, overtime and pay components; plain-language payslip; disputes linked to the payslip line and records; admin queue to investigate, correct and resolve; corrections appear on the payslip with the case number.

**SpeakSafe** — identified and anonymous submissions; case number (`FS-XXXX-XXXX`) plus a 60-bit access code shown once; tracking from any device without signing in; status history, two-way messages, assignment, resolution; configurable acknowledge/resolve deadlines per severity with escalation. Reports mentioning injury or immediate danger (English, Tamil, Hindi) are marked critical.

**Fairness Radar** — computed from stored records only. Each flag states the measured value, the configured limit and the rule: excessive hours (long shift, weekly hours, short rest, no weekly off), missing check-outs, below-minimum-wage rates, open pay disputes, overdue/escalated cases, critical reports, reopened cases. No predictions or scores about people.

**Two industry modes** — the same code, different configuration and data:

| | Construction site | College campus |
|---|---|---|
| Wage | Daily wage | Monthly salary |
| Longest shift / stale check-out | 10 h / 16 h | 12 h / 18 h |
| Categories | Fall from height, scaffolding, electrical, safety gear, machines/crane, heat, water, harassment, late pay… | Electrical, fire safety, slippery floor, chemicals, lighting, toilets, water, harassment, workload… |
| Critical case deadline | Acknowledge 1 h, resolve 8 h | Acknowledge 2 h, resolve 24 h |
| Escalates to | Project director | Principal |
| Demo people | Masons, helpers, crane operator, carpenter… | Housekeeping, security guards, plumber, gardener… |

**Inclusivity** — complete Tamil/English switching in both interfaces (536 strings, including statuses, errors and field names; checked by tests). Large touch targets (≥ 44–52 px), visible focus, skip links, labelled controls, text on every status (never colour alone), contrast-checked palette with dark mode, Atkinson Hyperlegible font. Read-aloud and voice input use the phone's own speech engines when available; typing always works, and the app says so when a Tamil voice is missing instead of reading Tamil with an English voice. The worker app is plain JavaScript modules with no framework: about 43 KB compressed for the code, styles and both dictionaries (fonts excluded).

## Try the demo

The deployed demo runs with `DEMO_MODE=true`: the sign-in code is shown on screen (there is no SMS gateway), and the sample data refreshes every 24 hours.

| Who | Phone | Try |
|---|---|---|
| Vikram Rao, site manager (construction) | 9000000100 | Fairness Radar, pay dispute investigation |
| Revathi Nair, admin officer (college) | 9000000200 | College mode (or use the industry switch) |
| Kannan Velu, crane operator | 9000000104 | Missing check-out → "Ask to fix this day" |
| Lakshmi Perumal, helper | 9000000102 | A resolved report waiting for her to verify |
| Meena Krishnan, housekeeping (college) | 9000000201 | A refunded deduction waiting for her to verify |

Worker app: `/` · Employer dashboard: `/admin` · Anonymous tracking: `/#/track` (sample case numbers and codes are listed on the demo login card via `/api/public/demo`).

## Architecture

```
public/             Worker app (index.html) and dashboard (admin.html): ES modules, no build step
  js/ui.js          Shared components: status steps, audit timeline, messages, voice, errors
  i18n/en.json      English and Tamil dictionaries (same keys, checked by tests)
  i18n/ta.json
src/
  server.js         Boot: config → store → seed (demo) → HTTP
  app.js            Express 5, Helmet CSP, same-origin write guard, routers
  config/           Environment config; industry presets (rules, categories, deadlines)
  domain/           Pure logic, no I/O: payroll, shifts, fatigue, triage, cases, radar
  services/cases.js Case workflows shared by worker, anonymous and admin routes
  data/             Document store (Firestore | JSON file | memory), repository, demo seed
  http/             Auth (phone + one-time code), validation, rate limits, routes
test/               node:test unit, API acceptance, security, persistence, i18n tests
```

**Storage.** One small document-store interface with three drivers: **Firestore** on Cloud Run (only equality queries, so no composite indexes; transactions for every case update), a **JSON file** for local runs, and **memory** for tests. Collections: `orgs`, `users`, `shifts`, `cases` (with history and messages), `adjustments`, `audit`, `sessions`, `otps`, `meta`.

**Money** is integer paise; payslip lines are whole rupees so they add up exactly. Rules follow the Code on Wages, 2019 and the OSH Code, 2020 defaults (8 h/day, 48 h/week, overtime at 2×) and are stored per workplace — confirm state-notified rates before real use.

## Security and privacy

- **Anonymous means no link.** An anonymous case stores no user id, name, phone or session; its times are rounded to the hour; the access code is stored only as a salted scrypt hash. Unknown case numbers and wrong codes get the same answer (with the same hashing cost). Admin views never include the access hash.
- **Sign-in:** phone + 6-digit one-time code (5-minute expiry, 5 attempts), codes and session ids stored only as SHA-256 hashes; `HttpOnly`, `SameSite=Strict`, `Secure` cookies; rate limits on sign-in, writes and anonymous lookups.
- **Authorisation on the server:** role checks on every route; admins only reach their own workplace; workers only their own cases; only admins in the same workplace can be made responsible.
- **Writes:** cross-origin requests and non-JSON bodies are refused; every input is validated and the error names the field. Strict Content-Security-Policy (`'self'` only), HSTS, `nosniff`, `frame-ancestors 'none'`; CSV export neutralises spreadsheet formulas.
- **No secrets in the repository.** Cloud Run reaches Firestore through its service account; per-workplace check-in secrets are generated into the database. Logs record method, path, status and timing only.

## Run locally

Requires Node.js 22.

```bash
npm install
npm run dev            # DEMO_MODE=true, data in ./data/fairshift.json
# open http://localhost:8080 (worker) and http://localhost:8080/admin
npm test               # 54 tests
npm run lint
```

Environment variables: `PORT` (8080), `NODE_ENV`, `DEMO_MODE` (`true` shows sign-in codes on screen and loads sample data), `STORAGE` (`firestore` in production, `file` locally, `memory`), `DATA_FILE`, `FIRESTORE_DATABASE`, `DEMO_RESET_HOURS` (24; `0` keeps data), `LOG_LEVEL`.

## Deploy to Google Cloud Run

```bash
gcloud auth login
./scripts/deploy.sh <your-gcp-project-id> asia-south1
```

The script enables the APIs, creates the Firestore (Native) database once, creates a service account that only has `roles/datastore.user`, and runs `gcloud run deploy --source .` with the Dockerfile (Node 22, non-root user). It prints the service URL and checks `/healthz`.

## Cross-industry adoption

Everything that differs between workplaces is data: wage type, hour limits, overtime multiplier, minimum wage, report categories, response deadlines and the escalation contact. A hospital or factory is a new preset in `src/config/industries.js` plus its categories — no new screens. The worker experience (check in, see pay, question it, report safely, verify the fix) is the same everywhere, which is what makes it learnable for workers who move between sites.

## What is deliberately not here

GPS tracking, SMS/IVR, offline sync, a skill marketplace and attrition prediction were left out to keep the Fairness Loop complete and trustworthy. Known limits of this prototype: no SMS provider is wired in (demo mode shows the code); rate limits are per instance; demo data is shared by everyone using the public demo.
