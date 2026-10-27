import { h, mount, toast, storage } from './dom.js';
import { api } from './api.js';
import * as i18n from './i18n.js';
import {
  errorText,
  busy,
  showError,
  langSwitch,
  listenButton,
  pill,
  statusPill,
  statusSteps,
  personLabel,
  caseTitle,
  outcomeText,
  deadlineText,
  historyList,
  messageThread,
} from './ui.js';

const { t } = i18n;
const app = document.getElementById('app');
const SEVERITY_TONE = { critical: 'stop', high: 'stop', medium: 'warn', low: '' };
const FLAG_TONE = { critical: 'stop', warning: 'warn', info: 'quiet' };
const OUTCOMES = { pay: ['upheld', 'partly_upheld', 'not_upheld'], safety: ['fixed', 'action_taken', 'not_confirmed'], grievance: ['fixed', 'action_taken', 'not_confirmed'] };

const state = { me: null, overview: null, demoOrgs: null, filters: storage.get('fs.adminFilters', { type: '', status: 'active' }) };

/* ---------- shell ---------- */

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [name = '', arg = ''] = path.split('/');
  return { name, arg: decodeURIComponent(arg), params: new URLSearchParams(query) };
}

function industrySwitch() {
  const org = state.overview?.org;
  if (!state.overview?.demoMode || !state.demoOrgs || !org) return null;
  return h(
    'div',
    { class: 'segmented segmented-dark', role: 'group', 'aria-label': t('demo.industry') },
    state.demoOrgs.map((o) =>
      h(
        'button',
        {
          type: 'button',
          'aria-pressed': String(o.id === org.id),
          onclick: async (e) => {
            if (o.id === org.id) return;
            await busy(e.currentTarget, async () => {
              try {
                await api('/api/admin/demo/switch', { method: 'POST', body: { orgId: o.id } });
                state.overview = null;
                toast(t('demo.switched', { industry: t(`industry.${o.industry}`) }), 'ok');
                await loadOverview();
                route(true);
              } catch (err) {
                toast(errorText(err), 'error');
              }
            });
          },
        },
        t(`industry.${o.industry}`),
      ),
    ),
  );
}

function header() {
  const ov = state.overview;
  const tab = (name, href, label, count) =>
    h('a', { class: 'tab', href, 'aria-current': currentRoute().name === name || (name === 'cases' && currentRoute().name === 'case') ? 'page' : null }, label, count ? h('span', { class: 'tab-count' }, i18n.num(count, 0)) : null);
  const k = ov?.radar.kpis;
  return h(
    'header',
    { class: 'adminbar' },
    h(
      'div',
      { class: 'adminbar-top' },
      h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'FairShift'),
      ov ? h('p', { class: 'org-name' }, ov.org.name, ' ', pill(t(`industry.${ov.org.industry}`), 'hivis')) : null,
      h('div', { class: 'adminbar-tools' }, industrySwitch(), langSwitch(changeLang), state.me ? h('span', { class: 'me' }, personLabel(state.me)) : null, state.me ? h('button', { type: 'button', class: 'link link-light', onclick: signOut }, t('common.signOut')) : null),
    ),
    state.me
      ? h(
          'nav',
          { class: 'tabs', 'aria-label': t('admin.sections') },
          tab('', '#/', t('admin.radar')),
          tab('cases', '#/cases', t('admin.cases'), k ? k.openPayDisputes + k.openSafetyReports + k.openGrievances : 0),
          tab('settings', '#/settings', t('admin.settings')),
        )
      : null,
  );
}

function shell(focus, ...content) {
  const main = h('main', { id: 'main', class: 'admin-main', tabindex: '-1' }, ...content);
  const skip = h('a', { class: 'skip', href: '#main', onclick: (e) => { e.preventDefault(); main.focus(); } }, t('common.skip'));
  mount(app, skip, header(), main);
  if (focus) main.focus({ preventScroll: true });
  return main;
}

const loading = (focus) => shell(focus, h('p', { class: 'loading', role: 'status' }, t('common.loading')));

async function changeLang(code) {
  await i18n.loadLang(code);
  if (state.me) api('/api/auth/me', { method: 'PATCH', body: { lang: code } }).catch(() => {});
  route(false);
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.me = null;
  state.overview = null;
  renderLogin();
}

function failed(err, focus) {
  if (err.status === 401 || err.status === 403) {
    state.me = null;
    return renderLogin();
  }
  return shell(focus, h('p', { class: 'alert alert-stop', role: 'alert' }, errorText(err)), h('button', { class: 'btn', type: 'button', onclick: () => route(true) }, t('common.retry')));
}

async function loadOverview() {
  state.overview = await api('/api/admin/overview');
  state.me = { ...state.me, ...state.overview.me };
  return state.overview;
}

/* ---------- sign in ---------- */

async function renderLogin() {
  let phone = '';
  const status = h('p', { role: 'status', class: 'form-status', id: 'login-status' });
  const phoneInput = h('input', { class: 'input', id: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', maxlength: '16', 'aria-describedby': 'login-status' });
  const codeInput = h('input', { class: 'input code-input', id: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', 'aria-describedby': 'login-status' });
  const sendBtn = h('button', { class: 'btn', type: 'submit' }, t('login.sendCode'));
  const verifyBtn = h('button', { class: 'btn', type: 'submit' }, t('login.verify'));
  const demoCode = h('p', { class: 'demo-hint', hidden: true });

  async function sendCode(e) {
    e?.preventDefault();
    await busy(sendBtn, async () => {
      try {
        const res = await api('/api/auth/request-otp', { method: 'POST', body: { phone: phoneInput.value } });
        phone = phoneInput.value;
        phoneForm.hidden = true;
        codeForm.hidden = false;
        status.textContent = t('login.codeSent');
        status.classList.remove('is-error');
        if (res.demoOtp) {
          codeInput.value = res.demoOtp;
          demoCode.textContent = t('login.demoCode', { code: res.demoOtp });
          demoCode.hidden = false;
          verifyBtn.focus();
        } else codeInput.focus();
      } catch (err) {
        showError(status, err);
      }
    });
  }

  const phoneForm = h('form', { class: 'field', novalidate: true, onsubmit: sendCode }, h('label', { for: 'phone', class: 'field-label' }, t('login.phone')), phoneInput, sendBtn);
  const codeForm = h(
    'form',
    {
      class: 'field',
      hidden: true,
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(verifyBtn, async () => {
          try {
            const { user } = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: codeInput.value } });
            if (user.role !== 'admin') {
              location.assign('/');
              return;
            }
            state.me = user;
            await i18n.loadLang(user.lang);
            location.hash = '#/';
            await loadOverview();
            route(true);
          } catch (err) {
            showError(status, err);
          }
        });
      },
    },
    h('label', { for: 'otp', class: 'field-label' }, t('login.code')),
    codeInput,
    demoCode,
    verifyBtn,
  );
  const demo = h('section', { class: 'card' });
  shell(
    false,
    h(
      'div',
      { class: 'login-panel' },
      h('h1', { class: 'view-title' }, t('admin.loginTitle')),
      h('p', { class: 'lede' }, t('admin.loginIntro')),
      phoneForm,
      codeForm,
      status,
      demo,
      h('p', { class: 'footer-links' }, h('a', { href: '/' }, t('admin.workerApp'))),
    ),
  );
  try {
    const { orgs } = await api('/api/public/demo');
    mount(
      demo,
      h('h2', { class: 'card-title' }, t('demo.title')),
      h('p', { class: 'lede' }, t('demo.adminHint')),
      orgs.map((o) =>
        h(
          'div',
          { class: 'demo-org' },
          h('h3', null, `${t(`industry.${o.industry}`)} · ${o.name}`),
          h(
            'div',
            { class: 'demo-people' },
            o.admins.map((a) =>
              h('button', { type: 'button', class: 'demo-person', onclick: () => { phoneInput.value = a.phone; sendCode(); } }, a.name, h('span', null, t(`title.${a.title}`))),
            ),
          ),
        ),
      ),
    );
  } catch {
    demo.remove();
  }
}

/* ---------- Fairness Radar ---------- */

function flagParams(f) {
  return {
    name: f.workerName,
    value: f.code === 'BELOW_MIN_WAGE' ? i18n.money(f.value) : i18n.num(f.value ?? 0),
    limit: f.code === 'BELOW_MIN_WAGE' ? i18n.money(f.limit) : i18n.num(f.limit ?? 0),
    day: f.day ? i18n.day(f.day) : '',
    ref: f.caseRef,
    type: f.caseType ? t(`typeRule.${f.caseType}`) : '',
    title: f.caseType ? caseTitle({ type: f.caseType, category: f.category }) : '',
    severity: f.caseSeverity ? t(`severity.${f.caseSeverity}`) : '',
    to: f.escalatedTo ? t(`esc.${f.escalatedTo}`) : '',
  };
}

function flagItem(f) {
  const params = flagParams(f);
  const ruleKey = f.code === 'CASE_OVERDUE' ? `rule.CASE_OVERDUE.${f.stage}${f.caseType === 'pay' ? '.pay' : ''}` : `rule.${f.code}`;
  return h(
    'li',
    { class: `flag flag-${f.severity}` },
    h('div', { class: 'flag-head' }, pill(t(`flagSeverity.${f.severity}`), FLAG_TONE[f.severity]), pill(t(`flagKind.${f.kind}`))),
    h('p', { class: 'flag-text' }, t(`flag.${f.code}`, params)),
    h('p', { class: 'flag-rule' }, t(ruleKey, params)),
    f.caseId ? h('a', { class: 'link', href: `#/case/${f.caseId}` }, t('radar.openCase', { ref: f.caseRef })) : null,
  );
}

async function renderRadar(focus) {
  if (!state.overview) loading(focus);
  try {
    await loadOverview();
  } catch (err) {
    return failed(err, focus);
  }
  const { org, radar } = state.overview;
  const k = radar.kpis;
  const kpi = (label, value, { tone = '', href = null, note = null } = {}) =>
    h(
      href ? 'a' : 'div',
      { class: `kpi${tone ? ` kpi-${tone}` : ''}`, href },
      h('span', { class: 'kpi-value' }, i18n.num(value, 0)),
      h('span', { class: 'kpi-label' }, label),
      note ? h('span', { class: 'kpi-note' }, note) : null,
    );
  const maxPresent = Math.max(1, k.headcount);

  shell(
    focus,
    h('div', { class: 'page-head' }, h('h1', { class: 'view-title' }, t('admin.radar')), h('p', { class: 'lede' }, t('radar.intro'))),
    h(
      'section',
      { class: 'kpis', 'aria-label': t('radar.summary') },
      kpi(t('kpi.onShift'), k.onShiftNow, { note: t('kpi.ofHeadcount', { present: i18n.num(k.presentToday, 0), total: i18n.num(k.headcount, 0) }) }),
      kpi(t('kpi.payDisputes'), k.openPayDisputes, { href: '#/cases?type=pay&status=active', tone: k.openPayDisputes ? 'warn' : '' }),
      kpi(t('kpi.safety'), k.openSafetyReports, { href: '#/cases?type=safety&status=active', tone: k.openSafetyReports ? 'warn' : '' }),
      kpi(t('kpi.grievances'), k.openGrievances, { href: '#/cases?type=grievance&status=active', tone: k.openGrievances ? 'warn' : '' }),
      kpi(t('kpi.overdue'), k.overdueCases, { href: '#/cases?status=active', tone: k.overdueCases ? 'stop' : 'go' }),
      kpi(t('kpi.awaiting'), k.awaitingConfirmation, { href: '#/cases?status=resolved' }),
      kpi(t('kpi.hours'), k.excessiveHours, { tone: k.excessiveHours ? 'warn' : 'go' }),
      kpi(t('kpi.missing'), k.attendanceIssues, { tone: k.attendanceIssues ? 'warn' : 'go' }),
      kpi(t('kpi.minWage'), k.belowMinimumWage, { tone: k.belowMinimumWage ? 'stop' : 'go' }),
    ),
    h(
      'div',
      { class: 'admin-grid' },
      h(
        'section',
        { class: 'card', 'aria-labelledby': 'flags-title' },
        h('h2', { class: 'card-title', id: 'flags-title' }, t('radar.flags', { count: radar.flags.length })),
        h('p', { class: 'lede' }, t('radar.flagsIntro')),
        radar.flags.length ? h('ol', { class: 'flags' }, radar.flags.map(flagItem)) : h('p', { class: 'alert alert-go' }, t('radar.noFlags')),
      ),
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'card', 'aria-labelledby': 'trend-title' },
          h('h2', { class: 'card-title', id: 'trend-title' }, t('radar.trend')),
          h(
            'ol',
            { class: 'trend', 'aria-hidden': 'true' },
            radar.trend.map((d) =>
              h('li', null, h('span', { class: 'trend-bar', style: { height: `${(d.present / maxPresent) * 100}%` } }), h('span', { class: 'trend-label' }, i18n.weekday(d.day))),
            ),
          ),
          h(
            'table',
            { class: 'sr-only' },
            h('caption', null, t('radar.trend')),
            h('tbody', null, radar.trend.map((d) => h('tr', null, h('th', { scope: 'row' }, i18n.day(d.day)), h('td', null, t('radar.present', { count: d.present }))))),
          ),
        ),
        configCard(org),
      ),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'workers-title' },
      h('h2', { class: 'card-title', id: 'workers-title' }, t('radar.workers')),
      h(
        'div',
        { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-labelledby': 'workers-title' },
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, [t('col.name'), t('col.job'), t('col.wage'), t('col.onShift'), t('col.hours7'), t('col.ot7'), t('col.flags')].map((c) => h('th', { scope: 'col' }, c)))),
          h(
            'tbody',
            null,
            radar.workers.map((w) =>
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, w.name),
                h('td', null, t(`job.${w.jobRole}`)),
                h('td', null, `${i18n.money(w.wage.amount)} ${t(`per.${w.wage.type}`)}`),
                h('td', null, w.onShiftSince ? t('col.since', { time: i18n.time(w.onShiftSince) }) : '—'),
                h('td', { class: 'num' }, i18n.num(w.weekHours)),
                h('td', { class: 'num' }, i18n.num(w.weekOvertime)),
                h('td', null, w.flags.length ? h('div', { class: 'pills' }, [...new Set(w.flags)].map((c) => pill(t(`flagShort.${c}`), 'warn'))) : '—'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  return null;
}

function configCard(org) {
  const r = org.rules;
  const row = (label, value) => h('div', null, h('dt', null, label), h('dd', null, value));
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'config-title' },
    h('h2', { class: 'card-title', id: 'config-title' }, t('config.title', { industry: t(`industry.${org.industry}`) })),
    h(
      'dl',
      { class: 'facts' },
      row(t('config.wageType'), t(`wage.${org.wageType}`)),
      row(t('config.dailyHours'), t('unit.hours', { n: r.dailyHours })),
      row(t('config.weeklyHours'), t('unit.hours', { n: r.weeklyHours })),
      row(t('config.overtime'), `${r.overtimeMultiplier}×`),
      row(t('config.maxShift'), t('unit.hours', { n: r.maxShiftHours })),
      row(t('config.minRest'), t('unit.hours', { n: r.minRestHours })),
      row(t('config.stale'), t('unit.hours', { n: r.staleShiftHours })),
      row(t('config.minWage'), i18n.money(org.minimumDailyWage)),
      row(t('config.escalateTo'), t(`esc.${org.caseRules.escalateTo}`)),
    ),
    h('p', { class: 'lede' }, t('config.categories'), ' ', org.categories.map((c) => t(`cat.${c.id}`)).join(', ')),
    h('a', { class: 'link', href: '#/settings' }, t('config.edit')),
  );
}

/* ---------- cases ---------- */

async function renderCases(focus) {
  const { params } = currentRoute();
  if (params.has('type') || params.has('status')) {
    state.filters = { type: params.get('type') || '', status: params.get('status') || '' };
    storage.set('fs.adminFilters', state.filters);
  }
  if (!state.overview) {
    loading(focus);
    try {
      await loadOverview();
    } catch (err) {
      return failed(err, focus);
    }
  }
  const list = h('div', { class: 'case-list', 'aria-live': 'polite' }, h('p', { class: 'loading' }, t('common.loading')));
  const select = (id, label, value, options) =>
    h(
      'div',
      { class: 'field field-inline' },
      h('label', { for: id, class: 'field-label' }, label),
      h(
        'select',
        {
          id,
          class: 'input',
          onchange: (e) => {
            state.filters = { ...state.filters, [id === 'f-type' ? 'type' : 'status']: e.target.value };
            storage.set('fs.adminFilters', state.filters);
            load();
          },
        },
        options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)),
      ),
    );

  async function load() {
    try {
      const qs = new URLSearchParams(Object.entries(state.filters).filter(([, v]) => v)).toString();
      const { cases } = await api(`/api/admin/cases${qs ? `?${qs}` : ''}`);
      mount(
        list,
        cases.length
          ? h(
              'ul',
              { class: 'cases' },
              cases.map((c) =>
                h(
                  'li',
                  null,
                  h(
                    'a',
                    { class: `case-row${c.overdue ? ' is-overdue' : ''}`, href: `#/case/${c.id}` },
                    h('span', { class: 'case-row-title' }, caseTitle(c), h('span', { class: 'mono' }, c.ref)),
                    h(
                      'span',
                      { class: 'pills' },
                      pill(t(`type.${c.type}`)),
                      statusPill(c),
                      c.type !== 'pay' ? pill(t(`severity.${c.severity}`), SEVERITY_TONE[c.severity]) : null,
                      c.overdue ? pill(c.escalated ? t('case.escalatedShort') : t('case.overdue'), 'stop') : null,
                      c.reopenCount ? pill(t('case.reopened'), 'warn') : null,
                    ),
                    h('span', { class: 'case-row-text', lang: c.lang }, c.description),
                    h(
                      'span',
                      { class: 'case-row-meta' },
                      c.anonymous ? `🔒 ${t('actor.reporter')}` : c.reporter?.name,
                      ' · ',
                      c.assignee ? t('case.handledBy', { person: personLabel(c.assignee) }) : t('case.notAssigned'),
                      ' · ',
                      i18n.dateTime(c.createdAt),
                      c.dueAt ? ` · ${t('case.due', { when: i18n.dateTime(c.dueAt) })}` : '',
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'lede' }, t('cases.noneMatch')),
      );
    } catch (err) {
      failed(err, false);
    }
  }

  shell(
    focus,
    h('div', { class: 'page-head' }, h('h1', { class: 'view-title' }, t('admin.cases')), h('p', { class: 'lede' }, t('cases.adminIntro'))),
    h(
      'div',
      { class: 'filters' },
      select('f-type', t('filter.type'), state.filters.type, [['', t('filter.all')], ['pay', t('type.pay')], ['safety', t('type.safety')], ['grievance', t('type.grievance')]]),
      select('f-status', t('filter.status'), state.filters.status, [
        ['active', t('filter.active')],
        ['open', t('status.open')],
        ['in_review', t('status.in_review')],
        ['resolved', t('status.resolved')],
        ['closed', t('status.closed')],
        ['', t('filter.all')],
      ]),
    ),
    list,
  );
  await load();
  return null;
}

/* ---------- case investigation ---------- */

async function renderCase(focus, id) {
  loading(focus);
  try {
    if (!state.overview) await loadOverview();
    drawCase(await api(`/api/admin/cases/${encodeURIComponent(id)}`), focus);
  } catch (err) {
    if (err.status === 404) return shell(focus, h('a', { class: 'back', href: '#/cases' }, '← ', t('common.back')), h('p', { class: 'alert alert-stop' }, errorText(err)));
    return failed(err, focus);
  }
  return null;
}

/** Posts to a case endpoint and redraws the case with the result. */
function caseAction(c, path, body, okMessage, statusEl) {
  return api(`/api/admin/cases/${encodeURIComponent(c.id)}/${path}`, { method: 'POST', body })
    .then((detail) => {
      toast(okMessage, 'ok');
      state.overview = null; // counts changed
      drawCase(detail, false);
    })
    .catch((err) => showError(statusEl, err));
}

function handlerSelect(id, selected) {
  return h(
    'select',
    { id, class: 'input' },
    state.overview.handlers.map((p) => h('option', { value: p.id, selected: p.id === selected }, personLabel(p))),
  );
}

function drawCase(detail, focus) {
  const c = detail.case;
  const ev = detail.evidence;
  const status = h('p', { role: 'status', class: 'form-status', id: 'admin-case-status' });
  const active = c.status === 'open' || c.status === 'in_review';
  const actions = [];

  if (c.canAcknowledge) {
    const who = handlerSelect('ack-assignee', state.me.id);
    const btn = h('button', { type: 'submit', class: 'btn' }, t('act.acknowledge'));
    actions.push(
      h(
        'form',
        {
          class: 'action',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            busy(btn, () => caseAction(c, 'actions', { action: 'acknowledge', assigneeId: who.value }, t('act.acknowledged'), status));
          },
        },
        h('h3', null, t('act.acknowledgeTitle')),
        h('label', { for: 'ack-assignee', class: 'field-label' }, t('act.assignTo')),
        who,
        btn,
      ),
    );
  } else if (active) {
    const who = handlerSelect('assignee', c.assignee?.id);
    const btn = h('button', { type: 'submit', class: 'btn btn-quiet' }, t('act.assign'));
    actions.push(
      h(
        'form',
        {
          class: 'action',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            busy(btn, () => caseAction(c, 'actions', { action: 'assign', assigneeId: who.value }, t('act.assigned'), status));
          },
        },
        h('h3', null, t('act.assignTitle')),
        h('label', { for: 'assignee', class: 'field-label' }, t('act.assignTo')),
        who,
        btn,
      ),
    );
  }

  if (c.canResolve) {
    const note = h('textarea', { class: 'input', id: 'resolve-note', maxlength: '1000' });
    const btn = h('button', { type: 'submit', class: 'btn' }, t('act.resolve'));
    const form = h(
      'form',
      {
        class: 'action',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          busy(btn, async () => {
            const outcome = form.querySelector('input[name=outcome]:checked')?.value;
            if (!outcome) return showError(status, t('act.pickOutcome'));
            if (note.value.trim().length < 3) {
              note.focus();
              return showError(status, t('act.noteRequired'));
            }
            return caseAction(c, 'actions', { action: 'resolve', outcome, note: note.value.trim() }, t('act.resolved'), status);
          });
        },
      },
      h('h3', null, t('act.resolveTitle')),
      h(
        'fieldset',
        { class: 'question' },
        h('legend', null, t('act.outcome')),
        h(
          'div',
          { class: 'options' },
          OUTCOMES[c.type].map((o) => h('div', { class: 'option' }, h('input', { type: 'radio', name: 'outcome', id: `o-${o}`, value: o }), h('label', { for: `o-${o}` }, outcomeText(c, o)))),
        ),
      ),
      h('label', { for: 'resolve-note', class: 'field-label' }, t('act.note')),
      note,
      h('p', { class: 'lede' }, t('act.resolveHelp')),
      btn,
    );
    actions.push(form);
  }

  const msg = h('textarea', { class: 'input', id: 'admin-msg', maxlength: '1000' });
  const msgBtn = h('button', { type: 'submit', class: 'btn btn-quiet' }, t('case.send'));
  const messageForm =
    c.status !== 'closed'
      ? h(
          'form',
          {
            class: 'field',
            novalidate: true,
            onsubmit: (e) => {
              e.preventDefault();
              busy(msgBtn, async () => {
                if (!msg.value.trim()) return showError(status, t('case.writeFirst'));
                return caseAction(c, 'actions', { action: 'message', text: msg.value.trim() }, t('case.messageSent'), status);
              });
            },
          },
          h('label', { for: 'admin-msg', class: 'field-label' }, c.anonymous ? t('act.messageAnon') : t('act.message', { name: c.reporter?.name || '' })),
          msg,
          msgBtn,
        )
      : null;

  shell(
    focus,
    h('a', { class: 'back', href: '#/cases' }, h('span', { 'aria-hidden': 'true' }, '←'), t('admin.cases')),
    h(
      'div',
      { class: 'case-head' },
      h('h1', { class: 'view-title' }, caseTitle(c)),
      h('p', { class: 'case-meta' }, h('span', { class: 'mono' }, c.ref), ' · ', t(`type.${c.type}`), ' · ', i18n.dateTime(c.createdAt), ' · ', t(`input.${c.inputMode}`)),
      h(
        'div',
        { class: 'pills' },
        statusPill(c),
        c.type !== 'pay' ? pill(t(`severity.${c.severity}`), SEVERITY_TONE[c.severity]) : null,
        c.overdue ? pill(c.escalated ? t('case.escalatedTo', { to: t(`esc.${c.escalatedTo}`) }) : t('case.overdue'), 'stop') : null,
        c.reopenCount ? pill(t('case.reopenedCount', { count: c.reopenCount }), 'warn') : null,
      ),
    ),
    statusSteps(c.status),
    active ? h('p', { class: `alert ${c.overdue ? 'alert-stop' : ''}` }, h('strong', null, deadlineText(c)), h('br'), c.assignee ? t('case.handledBy', { person: personLabel(c.assignee) }) : t('case.notAssigned')) : null,
    c.resolution
      ? h(
          'section',
          { class: 'alert alert-go' },
          h('h2', { class: 'alert-title' }, outcomeText(c, c.resolution.outcome)),
          h('p', null, c.resolution.note),
          h('p', { class: 'row-detail' }, t('case.resolvedBy', { person: personLabel(c.resolution.by), when: i18n.dateTime(c.resolution.at) })),
          c.status === 'resolved' ? h('p', null, t('case.awaitingWorker')) : null,
        )
      : null,
    c.status === 'closed' ? h('p', { class: 'alert alert-go' }, '✅ ', t('case.closedAdmin', { when: i18n.dateTime(c.verification?.at || c.updatedAt) })) : null,
    h(
      'div',
      { class: 'admin-grid' },
      h(
        'div',
        { class: 'stack' },
        h(
          'section',
          { class: 'card' },
          h('h2', { class: 'card-title' }, t('case.report')),
          c.anonymous
            ? h('p', { class: 'alert' }, '🔒 ', t('case.anonNotice'))
            : h('p', { class: 'row-detail' }, t('case.reportedBy', { name: c.reporter?.name || '', job: c.reporter?.jobRole ? t(`job.${c.reporter.jobRole}`) : '' })),
          h('p', { class: 'quote', lang: c.lang }, c.description),
          listenButton(() => c.description, { lang: () => c.lang }),
          c.matchedKeywords?.length ? h('p', { class: 'alert alert-stop' }, t('case.dangerWords', { words: c.matchedKeywords.join(', ') })) : null,
        ),
        ev ? evidenceSection(c, ev, status) : null,
        h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('case.messages')), messageThread(c, { viewer: 'admin' }), messageForm),
      ),
      h(
        'div',
        { class: 'stack' },
        actions.length ? h('section', { class: 'card actions-card', 'aria-labelledby': 'actions-title' }, h('h2', { class: 'card-title', id: 'actions-title' }, t('act.title')), status, actions) : status,
        h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('case.audit')), historyList(c, { includeMessages: true })),
      ),
    ),
  );
}

/** PayProof evidence: what the worker disputed, what the records say now, and the tools to correct them. */
function evidenceSection(c, ev, status) {
  const snap = ev.snapshot;
  const line = ev.current.line;
  const active = c.status === 'open' || c.status === 'in_review';
  const localInput = (ts) => {
    if (!ts) return '';
    const d = new Date(ts + 330 * 60_000);
    return d.toISOString().slice(0, 16);
  };

  function shiftForm(rec) {
    const id = rec ? rec.id : 'new';
    const cin = h('input', { type: 'datetime-local', class: 'input', id: `in-${id}`, value: rec ? localInput(rec.checkIn) : `${c.pay.month}-01T08:00` });
    const cout = h('input', { type: 'datetime-local', class: 'input', id: `out-${id}`, value: rec?.checkOut ? localInput(rec.checkOut) : rec ? localInput(rec.checkIn + 9 * 3_600_000) : `${c.pay.month}-01T17:00` });
    const reason = h('input', { class: 'input', id: `why-${id}`, maxlength: '300' });
    const btn = h('button', { type: 'submit', class: 'btn btn-small' }, rec ? t('ev.saveCorrection') : t('ev.addShift'));
    return h(
      'form',
      {
        class: 'inline-form',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          busy(btn, async () => {
            if (reason.value.trim().length < 3) {
              reason.focus();
              return showError(status, t('ev.reasonRequired'));
            }
            return caseAction(c, 'shifts', { shiftId: rec?.id ?? null, checkIn: cin.value, checkOut: cout.value, reason: reason.value.trim() }, t('ev.shiftSaved'), status);
          });
        },
      },
      h('div', { class: 'field' }, h('label', { for: `in-${id}`, class: 'field-label' }, t('ev.checkIn')), cin),
      h('div', { class: 'field' }, h('label', { for: `out-${id}`, class: 'field-label' }, t('ev.checkOut')), cout),
      h('div', { class: 'field field-wide' }, h('label', { for: `why-${id}`, class: 'field-label' }, t('ev.reason')), reason),
      btn,
    );
  }

  const recordRow = (rec) => {
    const flags = [rec.missingCheckout ? pill(t('shift.missing_checkout'), 'stop') : null, rec.disputed ? pill(t('ev.disputed'), 'warn') : null, rec.corrected ? pill(t('shift.corrected'), 'quiet') : null];
    const cell = h('td', null);
    if (active) {
      const details = h('details', null, h('summary', { class: 'link' }, t('ev.correct')), shiftForm(rec));
      cell.append(details);
    }
    return h(
      'tr',
      { class: rec.disputed ? 'is-disputed' : '' },
      h('th', { scope: 'row' }, i18n.day(rec.day)),
      h('td', null, i18n.time(rec.checkIn)),
      h('td', null, rec.checkOut ? i18n.time(rec.checkOut) : '—'),
      h('td', { class: 'num' }, rec.hours != null ? i18n.num(rec.hours) : '—'),
      h('td', null, h('div', { class: 'pills' }, flags)),
      cell,
    );
  };

  const adjAmount = h('input', { type: 'number', class: 'input', id: 'adj-amount', step: '1' });
  const adjReason = h('input', { class: 'input', id: 'adj-reason', maxlength: '300' });
  const adjBtn = h('button', { type: 'submit', class: 'btn btn-small' }, t('ev.addAdjustment'));

  return h(
    'section',
    { class: 'card evidence', 'aria-labelledby': 'ev-title' },
    h('h2', { class: 'card-title', id: 'ev-title' }, t('ev.title')),
    h(
      'dl',
      { class: 'facts' },
      h('div', null, h('dt', null, t('ev.worker')), h('dd', null, `${ev.worker.name} · ${t(`job.${ev.worker.jobRole}`)} · ${i18n.money(ev.worker.wage.amount)} ${t(`per.${ev.worker.wage.type}`)}`)),
      h('div', null, h('dt', null, t('ev.line')), h('dd', null, `${t(`line.${c.pay.lineCode}`)} · ${i18n.monthName(c.pay.month)}`)),
      h('div', null, h('dt', null, t('ev.reasonGiven')), h('dd', null, t(`reason.${c.pay.reason}`))),
      h('div', null, h('dt', null, t('ev.atDispute')), h('dd', null, snap.line ? i18n.money(snap.line.amount) : '—')),
      h('div', null, h('dt', null, t('ev.now')), h('dd', null, line ? i18n.money(line.amount) : '—')),
      c.pay.expectedAmount ? h('div', null, h('dt', null, t('ev.expected')), h('dd', null, i18n.money(c.pay.expectedAmount))) : null,
      c.pay.days?.length ? h('div', null, h('dt', null, t('ev.days')), h('dd', null, c.pay.days.map((d) => i18n.day(d)).join(', '))) : null,
      h('div', null, h('dt', null, t('ev.rate')), h('dd', null, t('ev.rateValue', { rate: i18n.money2(ev.current.hourlyRate), dh: ev.current.rules.dailyHours, ot: ev.current.rules.overtimeMultiplier }))),
    ),
    h('h3', null, t('ev.records', { month: i18n.monthName(c.pay.month) })),
    h(
      'div',
      { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': t('ev.records', { month: i18n.monthName(c.pay.month) }) },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, [t('pay.col.day'), t('pay.col.in'), t('pay.col.out'), t('pay.col.hours'), t('col.flags'), ''].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, ev.current.records.map(recordRow)),
      ),
    ),
    active ? h('details', { class: 'add-shift' }, h('summary', { class: 'btn btn-quiet btn-small' }, t('ev.addMissing')), shiftForm(null)) : null,
    h('h3', null, t('ev.adjustments')),
    ev.adjustments.length
      ? h('ul', { class: 'rows' }, ev.adjustments.map((a) => h('li', { class: 'track' }, h('span', { class: 'row-label' }, `${a.amount > 0 ? '+' : '−'}${i18n.money(Math.abs(a.amount))}`), h('span', { class: 'row-detail' }, `${a.reason} · ${a.createdBy || ''} · ${i18n.dateTime(a.createdAt)}`))))
      : h('p', { class: 'lede' }, t('ev.noAdjustments')),
    active
      ? h(
          'form',
          {
            class: 'inline-form',
            novalidate: true,
            onsubmit: (e) => {
              e.preventDefault();
              busy(adjBtn, async () => {
                const rupees = Math.round(Number(adjAmount.value));
                if (!rupees) {
                  adjAmount.focus();
                  return showError(status, t('ev.amountRequired'));
                }
                if (adjReason.value.trim().length < 3) {
                  adjReason.focus();
                  return showError(status, t('ev.reasonRequired'));
                }
                return caseAction(c, 'adjustments', { rupees, reason: adjReason.value.trim() }, t('ev.adjustmentSaved'), status);
              });
            },
          },
          h('div', { class: 'field' }, h('label', { for: 'adj-amount', class: 'field-label' }, t('ev.amount')), adjAmount),
          h('div', { class: 'field field-wide' }, h('label', { for: 'adj-reason', class: 'field-label' }, t('ev.reason')), adjReason),
          adjBtn,
        )
      : null,
    h('p', { class: 'lede' }, t('ev.payslipNote')),
  );
}

/* ---------- settings ---------- */

async function renderSettings(focus) {
  loading(focus);
  let data;
  try {
    if (!state.overview) await loadOverview();
    data = await api('/api/admin/settings');
  } catch (err) {
    return failed(err, focus);
  }
  const { org, audit } = data;
  const status = h('p', { role: 'status', class: 'form-status', id: 'settings-status' });
  const hoursInput = (id, value) => h('input', { type: 'number', class: 'input input-num', id, min: '1', max: '2160', step: '1', value: String(value) });
  const rows = [...org.severities].reverse().map((sev) => ({ key: sev, label: t(`severity.${sev}`), ack: hoursInput(`ack-${sev}`, org.caseRules.deadlines[sev].ack), resolve: hoursInput(`res-${sev}`, org.caseRules.deadlines[sev].resolve) }));
  rows.push({ key: 'pay', label: t('type.pay'), ack: hoursInput('ack-pay', org.caseRules.pay.ack), resolve: hoursInput('res-pay', org.caseRules.pay.resolve) });
  const esc = h('select', { id: 'escalate', class: 'input' }, org.escalationRoles.map((r) => h('option', { value: r, selected: r === org.caseRules.escalateTo }, t(`esc.${r}`))));
  const saveBtn = h('button', { type: 'submit', class: 'btn' }, t('settings.save'));
  const months = (() => {
    const now = new Date(Date.now() + 330 * 60_000);
    return [0, 1, 2].map((i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  })();

  shell(
    focus,
    h('div', { class: 'page-head' }, h('h1', { class: 'view-title' }, t('admin.settings')), h('p', { class: 'lede' }, t('settings.intro'))),
    h(
      'div',
      { class: 'admin-grid' },
      h(
        'form',
        {
          class: 'card',
          novalidate: true,
          'aria-labelledby': 'deadline-title',
          onsubmit: (e) => {
            e.preventDefault();
            busy(saveBtn, async () => {
              const num = (el) => Number.parseInt(el.value, 10);
              const body = { deadlines: {}, pay: null, escalateTo: esc.value };
              for (const r of rows) {
                const row = { ack: num(r.ack), resolve: num(r.resolve) };
                if (r.key === 'pay') body.pay = row;
                else body.deadlines[r.key] = row;
              }
              try {
                await api('/api/admin/settings/case-rules', { method: 'PUT', body });
                toast(t('settings.saved'), 'ok');
                state.overview = null;
                renderSettings(false);
              } catch (err) {
                showError(status, err);
              }
            });
          },
        },
        h('h2', { class: 'card-title', id: 'deadline-title' }, t('settings.deadlines')),
        h('p', { class: 'lede' }, t('settings.deadlinesIntro')),
        h(
          'table',
          { class: 'data' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('settings.caseKind')), h('th', { scope: 'col' }, t('settings.ack')), h('th', { scope: 'col' }, t('settings.resolve')))),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                null,
                h('th', { scope: 'row' }, r.label),
                h('td', null, h('label', { class: 'sr-only', for: r.ack.id }, `${r.label}: ${t('settings.ack')}`), r.ack),
                h('td', null, h('label', { class: 'sr-only', for: r.resolve.id }, `${r.label}: ${t('settings.resolve')}`), r.resolve),
              ),
            ),
          ),
        ),
        h('div', { class: 'field' }, h('label', { for: 'escalate', class: 'field-label' }, t('settings.escalateTo')), esc),
        status,
        saveBtn,
      ),
      h(
        'div',
        { class: 'stack' },
        configCard(org),
        h(
          'section',
          { class: 'card', 'aria-labelledby': 'qr-title' },
          h('h2', { class: 'card-title', id: 'qr-title' }, t('settings.qr')),
          h('p', { class: 'lede' }, t('settings.qrIntro')),
          h('img', { class: 'qr', src: `/api/admin/site-qr.svg?d=${Date.now()}`, alt: t('settings.qrAlt'), width: '200', height: '200' }),
          h('p', { class: 'site-code', id: 'site-code' }, '…'),
          h('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => window.print() }, t('settings.print')),
        ),
        h(
          'section',
          { class: 'card' },
          h('h2', { class: 'card-title' }, t('settings.register')),
          h('ul', { class: 'link-list' }, months.map((m) => h('li', null, h('a', { href: `/api/admin/wage-register.csv?month=${m}`, download: true }, t('settings.download', { month: i18n.monthName(m) }))))),
        ),
        state.overview?.demoMode
          ? h(
              'section',
              { class: 'card' },
              h('h2', { class: 'card-title' }, t('demo.resetTitle')),
              h('p', { class: 'lede' }, t('demo.resetIntro')),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-danger btn-small',
                  onclick: (e) =>
                    busy(e.currentTarget, async () => {
                      try {
                        await api('/api/admin/demo/reset', { method: 'POST', body: {} });
                        state.overview = null;
                        toast(t('demo.resetDone'), 'ok');
                        location.hash = '#/';
                      } catch (err) {
                        toast(errorText(err), 'error');
                      }
                    }),
                },
                t('demo.reset'),
              ),
            )
          : null,
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('settings.audit')),
      audit.length
        ? h('ol', { class: 'timeline' }, audit.map((a) => h('li', { class: 'timeline-item' }, h('time', null, i18n.dateTime(a.at)), h('p', null, t(`audit.${a.action}`, { actor: a.actor || '' })))))
        : h('p', { class: 'lede' }, t('settings.noAudit')),
    ),
  );
  api('/api/admin/site-code')
    .then(({ code }) => {
      const el = document.getElementById('site-code');
      if (el) el.textContent = t('settings.todayCode', { code });
    })
    .catch(() => {});
  return null;
}

/* ---------- router ---------- */

const ROUTES = { '': renderRadar, cases: renderCases, case: renderCase, settings: renderSettings };

function route(focus = true) {
  if (!state.me) return renderLogin();
  const { name, arg } = currentRoute();
  return (ROUTES[name] || renderRadar)(focus, arg);
}

async function boot() {
  await i18n.loadLang(i18n.savedLang() || 'en').catch(() => i18n.loadLang('en'));
  window.addEventListener('hashchange', () => route(true));
  try {
    const { user } = await api('/api/auth/me');
    if (!user) throw new Error('signed out');
    if (user.role !== 'admin') {
      location.replace('/');
      return;
    }
    state.me = user;
    if (user.lang !== i18n.lang()) await i18n.loadLang(user.lang);
  } catch {
    state.me = null;
  }
  try {
    state.demoOrgs = (await api('/api/public/demo')).orgs;
  } catch {
    state.demoOrgs = null;
  }
  route(false);
}

boot();
