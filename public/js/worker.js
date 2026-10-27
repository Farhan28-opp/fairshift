import { h, mount, toast, storage } from './dom.js';
import { api } from './api.js';
import * as i18n from './i18n.js';
import { speak, stopSpeaking, canSpeak } from './voice.js';
import {
  errorText,
  busy,
  showError,
  langSwitch,
  listenButton,
  micButton,
  pill,
  statusPill,
  statusSteps,
  personLabel,
  caseTitle,
  outcomeText,
  deadlineText,
  historyList,
  messageThread,
  lineLabel,
} from './ui.js';

const { t } = i18n;
const app = document.getElementById('app');
const ANON_KEY = 'fs.anonCases';

const state = {
  user: storage.get('fs.user'),
  home: null,
  pendingCode: null,
  anon: null, // { ref, code } of the anonymous case being viewed; kept in memory only
  justReported: null,
  speech: null,
  cleanup: null,
  timer: null,
};

/* ---------- shell ---------- */

function setUser(user) {
  state.user = user;
  if (user) storage.set('fs.user', { id: user.id, name: user.name, lang: user.lang, role: user.role });
  else storage.remove('fs.user');
}

function header() {
  const pageListen = canSpeak()
    ? h(
        'button',
        { type: 'button', class: 'listen', id: 'listen', 'aria-pressed': 'false', onclick: toggleReading },
        h('span', { 'aria-hidden': 'true' }, '🔊'),
        h('span', { class: 'listen-label' }, t('common.listen')),
      )
    : null;
  return h(
    'header',
    { class: 'bar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }), 'FairShift'),
    langSwitch(changeLang),
    pageListen,
  );
}

/** Replaces the screen; `focus` moves keyboard and screen-reader focus to the new content. */
function shell(focus, ...content) {
  stopReading();
  state.cleanup?.();
  state.cleanup = null;
  clearInterval(state.timer);
  state.speech = null;
  const main = h('main', { id: 'main', class: 'view', tabindex: '-1' }, ...content);
  const skip = h(
    'a',
    {
      class: 'skip',
      href: '#main',
      onclick: (e) => {
        e.preventDefault();
        main.focus();
      },
    },
    t('common.skip'),
  );
  mount(app, skip, header(), main);
  if (focus) main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
  return main;
}

const back = (href = '#/', label = t('common.back')) =>
  h('a', { class: 'back', href }, h('span', { 'aria-hidden': 'true' }, '←'), label);
const title = (text) => h('h1', { class: 'view-title' }, text);
const loading = (focus) => shell(focus, h('p', { class: 'loading', role: 'status' }, t('common.loading')));

function toggleReading() {
  const btn = document.getElementById('listen');
  if (btn?.getAttribute('aria-pressed') === 'true') return stopReading();
  const text = state.speech ? state.speech() : document.getElementById('main')?.innerText || '';
  if (speak(text, i18n.lang(), stopReading)) btn?.setAttribute('aria-pressed', 'true');
  else toast(t('voice.noVoice'), 'error');
  return null;
}

function stopReading() {
  stopSpeaking();
  document.getElementById('listen')?.setAttribute('aria-pressed', 'false');
}

async function changeLang(code) {
  await i18n.loadLang(code);
  if (state.user) {
    setUser({ ...state.user, lang: code });
    api('/api/auth/me', { method: 'PATCH', body: { lang: code } }).catch(() => {});
  }
  route(false);
}

function failed(err) {
  if (err.status === 401) return signedOut();
  toast(errorText(err), 'error');
  return null;
}

function signedOut() {
  setUser(null);
  state.home = null;
  if (currentRoute().name === 'track') return route(false);
  return renderLogin();
}

function currentRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [name = '', arg = ''] = path.split('/');
  return { name, arg: decodeURIComponent(arg), params: new URLSearchParams(query) };
}

/* ---------- sign in ---------- */

async function renderLogin() {
  let phone = '';
  const status = h('p', { role: 'status', class: 'form-status' });
  const phoneInput = h('input', { class: 'input', id: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', maxlength: '16', required: true, 'aria-describedby': 'login-status' });
  const codeInput = h('input', { class: 'input code-input', id: 'otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true, 'aria-describedby': 'login-status' });
  status.id = 'login-status';
  const demoCode = h('p', { class: 'demo-hint', hidden: true });

  async function sendCode(e) {
    e?.preventDefault();
    await busy(sendBtn, async () => {
      try {
        const res = await api('/api/auth/request-otp', { method: 'POST', body: { phone: phoneInput.value } });
        phone = phoneInput.value;
        phoneStep.hidden = true;
        codeStep.hidden = false;
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

  async function verify(e) {
    e.preventDefault();
    await busy(verifyBtn, async () => {
      try {
        const { user } = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: codeInput.value } });
        if (user.role !== 'worker') {
          location.assign('/admin');
          return;
        }
        setUser(user);
        await i18n.loadLang(user.lang);
        if (location.hash.startsWith('#/track')) location.hash = '#/';
        route(true);
      } catch (err) {
        showError(status, err);
      }
    });
  }

  const sendBtn = h('button', { class: 'btn btn-block', type: 'submit' }, t('login.sendCode'));
  const verifyBtn = h('button', { class: 'btn btn-block', type: 'submit' }, t('login.verify'));
  const phoneStep = h(
    'form',
    { class: 'field', onsubmit: sendCode, novalidate: true },
    h('label', { class: 'field-label', for: 'phone' }, t('login.phone')),
    phoneInput,
    sendBtn,
  );
  const codeStep = h(
    'form',
    { class: 'field', hidden: true, onsubmit: verify, novalidate: true },
    h('label', { class: 'field-label', for: 'otp' }, t('login.code')),
    codeInput,
    demoCode,
    verifyBtn,
    h(
      'button',
      {
        type: 'button',
        class: 'link',
        onclick: () => {
          codeStep.hidden = true;
          phoneStep.hidden = false;
          phoneInput.focus();
        },
      },
      t('login.changeNumber'),
    ),
  );

  const demo = h('section', { class: 'demo card', 'aria-labelledby': 'demo-title' });
  shell(
    false,
    title(t('login.title')),
    h('p', { class: 'lede' }, t('login.intro')),
    phoneStep,
    codeStep,
    status,
    h(
      'a',
      { class: 'choice choice-quiet', href: '#/track' },
      h('span', { class: 'choice-icon', 'aria-hidden': 'true' }, '🔒'),
      h('span', null, h('strong', null, t('track.title')), h('span', { class: 'choice-sub' }, t('track.loginHint'))),
    ),
    demo,
    h('p', { class: 'footer-links' }, h('a', { href: '/admin' }, t('login.employer'))),
  );

  try {
    const { orgs } = await api('/api/public/demo');
    let active = storage.get('fs.demoOrg') || orgs[0]?.id;
    const people = h('div', { class: 'demo-people' });
    const tabs = h('div', { class: 'segmented', role: 'group', 'aria-label': t('demo.industry') });
    const draw = () => {
      const org = orgs.find((o) => o.id === active) || orgs[0];
      mount(
        tabs,
        orgs.map((o) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(o.id === org.id),
              onclick: () => {
                active = o.id;
                storage.set('fs.demoOrg', active);
                draw();
              },
            },
            t(`industry.${o.industry}`),
          ),
        ),
      );
      mount(
        people,
        h('p', { class: 'lede' }, org.name),
        org.workers.map((w) =>
          h(
            'button',
            {
              type: 'button',
              class: 'demo-person',
              onclick: () => {
                phoneInput.value = w.phone;
                sendCode();
              },
            },
            w.name,
            h('span', null, `${t(`job.${w.jobRole}`)} · ${i18n.LANG_NAMES[w.lang]}`),
          ),
        ),
      );
    };
    draw();
    mount(demo, h('h2', { class: 'card-title', id: 'demo-title' }, t('demo.title')), h('p', { class: 'lede' }, t('demo.workerHint')), tabs, people);
  } catch {
    demo.remove(); // not in demo mode
  }
}

/* ---------- home ---------- */

async function renderHome(focus) {
  if (!state.home) loading(focus);
  try {
    state.home = await api('/api/worker/home');
  } catch (err) {
    if (err.status === 401) return signedOut();
    if (!state.home) return shell(focus, h('p', { class: 'alert alert-stop', role: 'alert' }, errorText(err)), h('button', { class: 'btn', type: 'button', onclick: () => renderHome(true) }, t('common.retry')));
  }
  return drawHome(focus);
}

function elapsedText(since) {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60000));
  return t('home.elapsed', { h: Math.floor(mins / 60), m: mins % 60 });
}

function drawHome(focus) {
  const home = state.home;
  const { user } = state;
  const shift = home.shift;

  let punch;
  if (shift) {
    const elapsed = h('span', { class: 'punch-elapsed' }, elapsedText(shift.checkIn));
    const btn = h(
      'button',
      { type: 'button', class: 'punch-btn', onclick: () => busy(btn, checkOut) },
      h('span', { class: 'punch-meta' }, t('home.onShiftSince', { time: i18n.time(shift.checkIn) })),
      elapsed,
      h('span', { class: 'punch-action' }, t('home.checkOut')),
    );
    punch = h('div', { class: 'punch-ring is-on' }, btn);
    state.timer = setInterval(() => {
      elapsed.textContent = elapsedText(shift.checkIn);
    }, 30_000);
  } else {
    punch = h(
      'div',
      { class: 'punch-ring' },
      h('a', { class: 'punch-btn', href: '#/checkin' }, h('span', { class: 'punch-meta' }, t('home.notOnShift')), h('span', { class: 'punch-action' }, t('home.checkIn'))),
    );
  }

  const alerts = [];
  for (const m of home.missingCheckouts) {
    alerts.push(
      h(
        'section',
        { class: 'alert alert-stop' },
        h('h2', { class: 'alert-title' }, '⚠️ ', t('home.missingTitle', { day: i18n.day(m.day) })),
        h('p', null, t('home.missingText', { hours: home.rules.staleShiftHours })),
        h('a', { class: 'btn btn-small btn-danger', href: `#/dispute?line=basic&reason=hours_missing&month=${m.day.slice(0, 7)}&day=${m.day}` }, t('home.missingAction')),
      ),
    );
  }
  if (home.cases.awaitingConfirmation) {
    alerts.push(
      h(
        'a',
        { class: 'alert alert-go alert-link', href: '#/cases' },
        h('span', { class: 'alert-title' }, '✅ ', t('home.confirmTitle', { count: home.cases.awaitingConfirmation })),
        h('span', null, t('home.confirmText')),
      ),
    );
  }
  if (home.fatigue.length) {
    alerts.push(
      h(
        'section',
        { class: `alert ${home.fatigue.some((f) => f.severity === 'critical') ? 'alert-stop' : ''}` },
        h('h2', { class: 'alert-title' }, '⏱️ ', t('fatigue.title')),
        h('ul', null, home.fatigue.map((f) => h('li', null, t(`fatigue.${f.code}`, { value: i18n.num(f.value), limit: f.limit })))),
        h('p', null, t('fatigue.advice')),
      ),
    );
  }

  const max = Math.max(10, ...home.week.map((d) => d.hours));
  const week = h(
    'section',
    { class: 'week', 'aria-labelledby': 'week-title' },
    h(
      'div',
      { class: 'week-head' },
      h('h2', { class: 'week-title', id: 'week-title' }, t('home.week')),
      h('p', { class: 'week-total' }, t('home.weekTotal', { hours: i18n.num(home.weekHours), ot: i18n.num(home.weekOvertime) })),
    ),
    h(
      'ol',
      { class: 'week-bars' },
      home.week.map((d, i) =>
        h(
          'li',
          { class: `week-bar${i === 6 ? ' is-today' : ''}` },
          h(
            'div',
            { class: 'week-col', 'aria-hidden': 'true' },
            h('span', { class: 'week-ordinary', style: { height: `${((d.hours - d.overtime) / max) * 100}%` } }),
            d.overtime ? h('span', { class: 'week-ot', style: { height: `${(d.overtime / max) * 100}%` } }) : null,
          ),
          h('span', { 'aria-hidden': 'true' }, i18n.weekday(d.day)),
          h('span', { class: 'sr-only' }, t('home.dayHours', { day: i18n.weekday(d.day, 'long'), hours: i18n.num(d.hours), ot: i18n.num(d.overtime) })),
        ),
      ),
    ),
    h('a', { class: 'link', href: '#/shifts' }, t('home.allShifts')),
  );

  const tile = (cls, href, icon, label, badge) =>
    h(
      'a',
      { class: `tile tile-${cls}`, href },
      h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, icon),
      h('span', null, label),
      badge ? h('span', { class: 'pill pill-quiet tile-badge' }, badge) : null,
    );

  shell(
    focus,
    h(
      'div',
      null,
      h('h1', { class: 'view-title' }, t('home.greeting', { name: user.name.split(' ')[0] })),
      h('p', { class: 'lede' }, `${t(`job.${user.jobRole}`)} · ${user.org.name}`),
    ),
    alerts,
    h('div', { class: 'punch' }, punch),
    week,
    h(
      'nav',
      { class: 'tiles', 'aria-label': t('home.menu') },
      tile('pay', '#/pay', '₹', t('tile.pay')),
      tile('report', '#/speak', '🛡️', t('tile.speak')),
      tile('cases', '#/cases', '📋', t('tile.cases'), home.cases.active ? t('tile.activeCount', { count: home.cases.active }) : null),
      tile('track', '#/track', '🔒', t('tile.track')),
    ),
    h(
      'div',
      { class: 'footer-links' },
      h(
        'button',
        {
          type: 'button',
          class: 'link',
          onclick: async () => {
            await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
            signedOut();
          },
        },
        t('common.signOut'),
      ),
    ),
  );
  state.speech = () =>
    [
      t('home.greeting', { name: user.name.split(' ')[0] }),
      shift ? t('home.onShiftSince', { time: i18n.time(shift.checkIn) }) : t('home.notOnShift'),
      t('home.weekTotal', { hours: i18n.num(home.weekHours), ot: i18n.num(home.weekOvertime) }),
      ...home.missingCheckouts.map((m) => t('home.missingTitle', { day: i18n.day(m.day) })),
    ].join('. ');
}

async function checkOut() {
  try {
    const res = await api('/api/worker/checkout', { method: 'POST', body: {} });
    toast(t('checkin.doneOut', { hours: i18n.num(res.today.hours), ot: i18n.num(res.today.overtime) }), 'ok');
    state.home = null;
    return renderHome(false);
  } catch (err) {
    return failed(err);
  }
}

/* ---------- check-in ---------- */

function codeFromQr(raw) {
  try {
    const code = new URL(raw).searchParams.get('checkin');
    if (/^\d{6}$/.test(code || '')) return code;
  } catch {
    /* not a URL */
  }
  return /^\d{6}$/.test(raw) ? raw : null;
}

async function renderCheckin(focus) {
  if (!state.home) {
    loading(focus);
    try {
      state.home = await api('/api/worker/home');
    } catch (err) {
      return failed(err);
    }
  }
  if (state.home?.shift) {
    toast(t('checkin.already'));
    location.hash = '#/';
    return null;
  }
  const status = h('p', { role: 'status', class: 'form-status', id: 'checkin-status' });
  const codeInput = h('input', { class: 'input code-input', id: 'site-code', type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', required: true, 'aria-describedby': 'checkin-status' });
  const submitBtn = h('button', { class: 'btn btn-block', type: 'submit' }, t('checkin.submit'));
  const codeForm = h(
    'form',
    {
      class: 'field',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(submitBtn, () => submit({ method: 'code', code: codeInput.value.trim() }));
      },
    },
    h('label', { for: 'site-code', class: 'field-label' }, t('checkin.codeLabel')),
    codeInput,
    submitBtn,
  );
  const scanner = h('div', { class: 'scanner', hidden: true });
  const canScan = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

  async function submit(body) {
    if (!/^\d{6}$/.test(body.code)) return showError(status, t('checkin.codeFormat'));
    try {
      const res = await api('/api/worker/checkin', { method: 'POST', body });
      toast(t('checkin.done', { time: i18n.time(res.shift.checkIn) }), 'ok');
      state.home = null;
      location.hash = '#/';
    } catch (err) {
      if (err.status === 401) return signedOut();
      showError(status, err);
    }
    return null;
  }

  async function startScan() {
    let stream;
    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      const stop = () => stream.getTracks().forEach((track) => track.stop());
      state.cleanup = stop;
      const video = h('video', { playsinline: true, muted: true, 'aria-label': t('checkin.pointCamera') });
      video.srcObject = stream;
      mount(scanner, h('p', { class: 'field-label' }, t('checkin.pointCamera')), video);
      scanner.hidden = false;
      await video.play();
      const tick = async () => {
        if (!video.isConnected) return stop();
        const found = await detector.detect(video).catch(() => []);
        const code = found.map((b) => codeFromQr(b.rawValue)).find(Boolean);
        if (code) {
          stop();
          scanner.hidden = true;
          return submit({ method: 'qr', code });
        }
        setTimeout(tick, 300);
        return null;
      };
      tick();
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      status.textContent = t('checkin.noCamera');
      codeInput.focus();
    }
  }

  shell(
    focus,
    back(),
    title(t('checkin.title')),
    h('p', { class: 'lede' }, t('checkin.intro')),
    state.home?.demo ? h('p', { class: 'demo-hint' }, t('checkin.demoCode', { code: state.home.demo.siteCode })) : null,
    canScan
      ? h('button', { type: 'button', class: 'choice', onclick: startScan }, h('span', { class: 'choice-icon', 'aria-hidden': 'true' }, '📷'), t('checkin.scan'))
      : null,
    scanner,
    codeForm,
    status,
  );

  if (state.pendingCode) {
    const code = state.pendingCode;
    state.pendingCode = null;
    submit({ method: 'qr', code });
  }
  return null;
}

/* ---------- shift records ---------- */

const SHIFT_TONE = { done: 'go', on_shift: 'quiet', missing_checkout: 'stop' };

async function renderShifts(focus) {
  loading(focus);
  let data;
  try {
    data = await api('/api/worker/shifts');
  } catch (err) {
    return failed(err);
  }
  shell(
    false,
    back(),
    title(t('shifts.title')),
    h('p', { class: 'lede' }, t('shifts.intro', { daily: data.rules.dailyHours, weekly: data.rules.weeklyHours })),
    data.shifts.length
      ? h(
          'ul',
          { class: 'rows card' },
          data.shifts.map((s) =>
            h(
              'li',
              { class: 'track' },
              h('div', { class: 'track-head' }, i18n.day(s.day), pill(t(`shift.${s.status}`), SHIFT_TONE[s.status]), s.corrected ? pill(t('shift.corrected'), 'quiet') : null),
              h(
                'p',
                { class: 'row-detail' },
                t('shifts.inOut', { in: i18n.time(s.checkIn), out: s.checkOut ? i18n.time(s.checkOut) : '—' }),
                s.hours != null ? ` · ${t('shifts.hours', { hours: i18n.num(s.hours) })}` : '',
                s.dayOvertime ? ` · ${t('shifts.overtime', { hours: i18n.num(s.dayOvertime) })}` : '',
              ),
              s.status !== 'on_shift'
                ? h('a', { class: 'link', href: `#/dispute?line=basic&reason=hours_missing&month=${s.day.slice(0, 7)}&day=${s.day}` }, t('shifts.question'))
                : null,
            ),
          ),
        )
      : h('p', { class: 'lede' }, t('shifts.none')),
  );
  if (focus) document.getElementById('main')?.focus({ preventScroll: true });
  return null;
}

/* ---------- PayProof: payslip ---------- */

function lineDetail(l, p) {
  switch (l.code) {
    case 'basic':
      return l.wageType === 'monthly'
        ? t('pay.basicMonthly', { days: l.days, hours: i18n.num(l.hours), rate: i18n.money2(l.rate), salary: i18n.money(l.wageAmount), wd: p.rules.workingDaysPerMonth, dh: p.rules.dailyHours })
        : t('pay.basicDaily', { days: l.days, hours: i18n.num(l.hours), rate: i18n.money2(l.rate), wage: i18n.money(l.wageAmount), dh: p.rules.dailyHours });
    case 'overtime':
      return t('pay.overtimeDetail', { hours: i18n.num(l.hours), multiplier: l.multiplier, rate: i18n.money2(l.rate), dh: p.rules.dailyHours, wh: p.rules.weeklyHours });
    case 'pf':
      return t('pay.pfDetail', { pct: i18n.num(l.ratePct, 2), base: i18n.money(l.base) });
    case 'esi':
      return t('pay.esiDetail', { pct: i18n.num(l.ratePct, 2), base: i18n.money(l.base) });
    case 'advance':
      return t('pay.advanceDetail');
    case 'adjustment':
    case 'recovery':
      return l.reason;
    default:
      return t('pay.allowanceDetail');
  }
}

async function renderPay(focus) {
  const { params } = currentRoute();
  const month = params.get('month');
  loading(focus);
  let data;
  try {
    data = await api(`/api/worker/payslip${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  } catch (err) {
    return failed(err);
  }
  const p = data.payslip;
  const swatch = (l) => (l.kind === 'deduction' ? 'sw-deduction' : { basic: 'sw-basic', overtime: 'sw-overtime' }[l.code] || 'sw-allowance');
  const earnings = p.lines.filter((l) => l.kind === 'earning');
  const deductions = p.lines.filter((l) => l.kind === 'deduction');
  const ot = earnings.find((l) => l.code === 'overtime');
  const disputeHref = (l) => `#/dispute?line=${l.code}&month=${p.month}`;

  const row = (l) =>
    h(
      'li',
      { class: 'row' },
      h('span', { class: `swatch ${swatch(l)}`, 'aria-hidden': 'true' }),
      h('div', null, h('div', { class: 'row-label' }, lineLabel(l)), h('div', { class: 'row-detail' }, lineDetail(l, p))),
      h(
        'div',
        { class: 'row-amount' },
        `${l.kind === 'deduction' ? '− ' : ''}${i18n.money(l.amount)}`,
        h('div', null, h('a', { class: 'link', href: disputeHref(l), 'aria-label': t('pay.questionLine', { line: lineLabel(l) }) }, t('pay.question'))),
      ),
    );

  const pct = (amount) => `${p.gross ? (amount / p.gross) * 100 : 0}%`;
  const seg = (cls, amount) => (amount > 0 ? h('span', { class: cls, style: { width: pct(amount) } }) : null);
  const allowanceTotal = earnings.filter((l) => !['basic', 'overtime'].includes(l.code)).reduce((s, l) => s + l.amount, 0);
  const wage = p.compliance.minimumWage;
  state.speech = () =>
    t('pay.speech', {
      month: i18n.monthName(p.month),
      net: i18n.money(p.net),
      gross: i18n.money(p.gross),
      deductions: i18n.money(p.totalDeductions),
      ot: i18n.num(ot?.hours || 0),
      otPay: i18n.money(ot?.amount || 0),
    });

  shell(
    false,
    back(),
    title(t('pay.title')),
    h(
      'div',
      { class: 'months', role: 'group', 'aria-label': t('pay.month') },
      data.months.map((m) =>
        h('a', { class: 'month-chip', href: `#/pay?month=${m}`, 'aria-current': m === p.month ? 'page' : null }, i18n.monthName(m)),
      ),
    ),
    h(
      'section',
      { class: 'net', 'aria-labelledby': 'net-label' },
      h('p', { class: 'net-label', id: 'net-label' }, data.inProgress ? t('pay.inProgress') : i18n.monthName(p.month), ' · ', t('pay.net')),
      h('p', { class: 'net-amount' }, i18n.money(p.net)),
      h('p', { class: 'net-sub' }, t('pay.netSub', { gross: i18n.money(p.gross), deductions: i18n.money(p.totalDeductions), days: p.daysPresent })),
      listenButton(() => state.speech(), { className: 'btn btn-hivis btn-small' }),
    ),
    h(
      'div',
      { 'aria-hidden': 'true', class: 'field' },
      h('div', { class: 'paybar' }, seg('sw-basic', earnings[0].amount), seg('sw-overtime', ot?.amount || 0), seg('sw-allowance', allowanceTotal)),
      h('div', { class: 'paybar paybar-cut' }, seg('sw-deduction', p.totalDeductions)),
    ),
    h(
      'p',
      { class: `alert ${wage.ok ? 'alert-go' : 'alert-stop'}` },
      wage.ok ? '✅ ' : '⚠️ ',
      t(wage.ok ? 'pay.minWageOk' : 'pay.minWageLow', { rate: i18n.money(wage.dailyRate), min: i18n.money(wage.minimum) }),
    ),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('pay.earnings')), h('ul', { class: 'rows' }, earnings.map(row))),
    deductions.length ? h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('pay.deductions')), h('ul', { class: 'rows' }, deductions.map(row))) : null,
    h(
      'details',
      { class: 'card' },
      h('summary', { class: 'card-title' }, t('pay.records', { count: p.records.length })),
      h('p', { class: 'lede' }, t('pay.recordsIntro')),
      h(
        'table',
        { class: 'records' },
        h('thead', null, h('tr', null, [t('pay.col.day'), t('pay.col.in'), t('pay.col.out'), t('pay.col.hours')].map((c) => h('th', { scope: 'col' }, c)))),
        h(
          'tbody',
          null,
          p.records.map((r) =>
            h(
              'tr',
              { class: r.checkOut ? '' : 'is-missing' },
              h('td', null, i18n.day(r.day)),
              h('td', null, i18n.time(r.checkIn)),
              h('td', null, r.checkOut ? i18n.time(r.checkOut) : t('shift.noCheckout')),
              h('td', null, r.hours != null ? i18n.num(r.hours) : '—'),
            ),
          ),
        ),
      ),
    ),
    data.disputes.length
      ? h(
          'section',
          { class: 'card' },
          h('h2', { class: 'card-title' }, t('pay.myQuestions')),
          h('ul', { class: 'rows' }, data.disputes.map(caseRow)),
        )
      : null,
  );
  if (focus) document.getElementById('main')?.focus({ preventScroll: true });
  return null;
}

/* ---------- PayProof: raise a dispute ---------- */

async function renderDispute(focus) {
  const { params } = currentRoute();
  loading(focus);
  let data;
  try {
    const month = params.get('month');
    data = await api(`/api/worker/payslip${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  } catch (err) {
    return failed(err);
  }
  const p = data.payslip;
  const line = p.lines.find((l) => l.code === params.get('line')) || p.lines[0];
  const preDay = params.get('day');
  const status = h('p', { role: 'status', class: 'form-status', id: 'dispute-status' });
  const message = h('textarea', { class: 'input', id: 'dispute-msg', maxlength: '1000', required: true, 'aria-describedby': 'dispute-status' });
  const expected = h('input', { class: 'input', id: 'dispute-expected', type: 'number', inputmode: 'numeric', min: '0', step: '1' });
  const submitBtn = h('button', { class: 'btn btn-block', type: 'submit' }, t('dispute.send'));
  const days = p.records.map((r) => r.day).filter((d, i, all) => all.indexOf(d) === i);

  const form = h(
    'form',
    {
      class: 'view',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(submitBtn, async () => {
          const reason = form.querySelector('input[name=reason]:checked')?.value;
          if (!reason) return showError(status, t('dispute.pickReason'));
          if (message.value.trim().length < 3) {
            message.focus();
            return showError(status, t('dispute.describe'));
          }
          try {
            const res = await api('/api/worker/disputes', {
              method: 'POST',
              body: {
                month: p.month,
                lineCode: line.code,
                reason,
                days: [...form.querySelectorAll('input[name=day]:checked')].map((i) => i.value),
                expectedRupees: expected.value === '' ? null : Math.round(Number(expected.value)),
                message: message.value.trim(),
                inputMode: message.dataset.voice ? 'voice' : 'text',
                lang: i18n.lang(),
              },
            });
            toast(t('dispute.sent', { ref: res.case.ref }), 'ok');
            location.hash = `#/case/${res.case.ref}`;
          } catch (err) {
            if (err.status === 401) return signedOut();
            showError(status, err);
          }
          return null;
        });
      },
    },
    h(
      'fieldset',
      { class: 'question' },
      h('legend', null, t('dispute.reason')),
      h(
        'div',
        { class: 'options' },
        data.reasons.map((r) =>
          h(
            'div',
            { class: 'option' },
            h('input', { type: 'radio', name: 'reason', id: `reason-${r}`, value: r, checked: r === params.get('reason') }),
            h('label', { for: `reason-${r}` }, t(`reason.${r}`)),
          ),
        ),
      ),
    ),
    days.length
      ? h(
          'fieldset',
          { class: 'question' },
          h('legend', null, t('dispute.days')),
          h(
            'div',
            { class: 'day-picks' },
            days.map((d) =>
              h('div', { class: 'day-pick' }, h('input', { type: 'checkbox', name: 'day', id: `day-${d}`, value: d, checked: d === preDay }), h('label', { for: `day-${d}` }, i18n.day(d))),
            ),
          ),
        )
      : null,
    h('div', { class: 'field' }, h('label', { for: 'dispute-expected', class: 'field-label' }, t('dispute.expected')), expected),
    h('div', { class: 'field' }, h('label', { for: 'dispute-msg', class: 'field-label' }, t('dispute.message')), message, micButton(message)),
    status,
    submitBtn,
  );

  shell(
    false,
    back(`#/pay?month=${p.month}`),
    title(t('dispute.title')),
    h(
      'section',
      { class: 'card' },
      h('p', { class: 'row-label' }, `${lineLabel(line)} · ${i18n.monthName(p.month)}`),
      h('p', { class: 'net-amount small' }, `${line.kind === 'deduction' ? '− ' : ''}${i18n.money(line.amount)}`),
      h('p', { class: 'row-detail' }, lineDetail(line, p)),
      h('p', { class: 'lede' }, t('dispute.intro')),
    ),
    form,
  );
  if (focus) document.getElementById('main')?.focus({ preventScroll: true });
  return null;
}

/* ---------- SpeakSafe ---------- */

function renderSpeak(focus) {
  const cats = state.user.org.categories;
  const status = h('p', { role: 'status', class: 'form-status', id: 'speak-status' });
  const text = h('textarea', { class: 'input', id: 'speak-text', placeholder: t('speak.placeholder'), maxlength: '1000', 'aria-describedby': 'speak-status' });
  const anon = h('input', { type: 'checkbox', id: 'anon', role: 'switch', checked: true, 'aria-describedby': 'anon-help' });
  const anonHelp = h('p', { id: 'anon-help', class: 'switch-help' }, t('speak.anonOn'));
  anon.addEventListener('change', () => {
    anonHelp.textContent = t(anon.checked ? 'speak.anonOn' : 'speak.anonOff');
  });
  const submitBtn = h('button', { class: 'btn btn-danger btn-block', type: 'submit' }, t('speak.send'));

  const group = (kind) =>
    h(
      'fieldset',
      { class: 'question' },
      h('legend', null, t(`speak.kind.${kind}`)),
      h(
        'div',
        { class: 'hazards' },
        cats
          .filter((c) => c.kind === kind)
          .map((c) =>
            h(
              'div',
              { class: 'hazard' },
              h('input', { type: 'radio', name: 'category', id: `cat-${c.id}`, value: c.id }),
              h('label', { for: `cat-${c.id}` }, h('span', { class: 'hazard-icon', 'aria-hidden': 'true' }, c.icon), t(`cat.${c.id}`)),
            ),
          ),
      ),
    );

  const form = h(
    'form',
    {
      class: 'view',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        busy(submitBtn, async () => {
          const category = form.querySelector('input[name=category]:checked')?.value;
          if (!category) return showError(status, t('speak.pickFirst'));
          if (text.value.trim().length < 5) {
            text.focus();
            return showError(status, t('speak.describeFirst'));
          }
          try {
            const res = await api('/api/worker/reports', {
              method: 'POST',
              body: { category, description: text.value.trim(), anonymous: anon.checked, inputMode: text.dataset.voice ? 'voice' : 'text', lang: i18n.lang() },
            });
            if (res.accessCode) {
              state.justReported = { ref: res.case.ref, code: res.accessCode, case: res.case };
              location.hash = '#/reported';
            } else {
              toast(t('speak.sentNamed', { ref: res.case.ref }), 'ok');
              location.hash = `#/case/${res.case.ref}`;
            }
          } catch (err) {
            if (err.status === 401) return signedOut();
            showError(status, err);
          }
          return null;
        });
      },
    },
    group('safety'),
    group('grievance'),
    h('div', { class: 'field' }, h('label', { for: 'speak-text', class: 'field-label' }, t('speak.describe')), text, micButton(text)),
    h('div', { class: 'switch' }, h('label', { for: 'anon', class: 'switch-label' }, '🔒 ', t('speak.anonymous')), anon, anonHelp),
    status,
    submitBtn,
  );

  shell(
    focus,
    back(),
    title(t('speak.title')),
    h('p', { class: 'lede' }, t('speak.intro')),
    h('p', { class: 'alert alert-stop' }, t('speak.emergency'), ' ', h('a', { href: 'tel:112' }, t('speak.call'))),
    form,
  );
}

/** Shown once after an anonymous report: the only time the access code is visible. */
function renderReported(focus) {
  const r = state.justReported;
  if (!r) {
    location.hash = '#/cases';
    return;
  }
  const save = h('input', { type: 'checkbox', id: 'save-code', checked: anonSaved().some((a) => a.ref === r.ref) });
  save.addEventListener('change', () => {
    if (save.checked) rememberAnon(r.ref, r.code);
    else forgetAnon(r.ref);
  });
  const spell = (s) => s.replace(/-/g, '').split('').join(', ');
  shell(
    focus,
    title(t('reported.title')),
    r.case.severity === 'critical' ? h('p', { class: 'alert alert-stop', role: 'alert' }, t('speak.urgent'), ' ', h('a', { class: 'btn btn-danger btn-small', href: 'tel:112' }, t('speak.call'))) : null,
    h('p', { class: 'lede' }, t('reported.intro')),
    h(
      'section',
      { class: 'code-card', 'aria-labelledby': 'code-title' },
      h('h2', { id: 'code-title', class: 'sr-only' }, t('reported.codes')),
      h('p', { class: 'code-label' }, t('track.ref')),
      h('p', { class: 'code-value' }, r.ref),
      h('p', { class: 'code-label' }, t('track.code')),
      h('p', { class: 'code-value code-secret' }, r.code),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-hivis btn-small',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(`${r.ref} ${r.code}`);
                toast(t('reported.copied'), 'ok');
              } catch {
                toast(t('reported.copyFailed'), 'error');
              }
            },
          },
          '📋 ',
          t('reported.copy'),
        ),
        listenButton(() => `${t('track.ref')}: ${spell(r.ref)}. ${t('track.code')}: ${spell(r.code)}`, { className: 'btn btn-hivis btn-small', label: t('reported.listen') }),
      ),
    ),
    h('p', { class: 'alert' }, '✍️ ', t('reported.writeDown')),
    h('div', { class: 'switch' }, h('label', { for: 'save-code', class: 'switch-label' }, t('reported.save')), save, h('p', { class: 'switch-help' }, t('reported.saveHelp'))),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-block',
        onclick: () => {
          state.anon = { ref: r.ref, code: r.code };
          location.hash = '#/track';
        },
      },
      t('reported.follow'),
    ),
    h('a', { class: 'link', href: '#/' }, t('common.home')),
  );
}

/* ---------- my cases ---------- */

const anonSaved = () => storage.get(ANON_KEY, []);
function rememberAnon(ref, code) {
  storage.set(ANON_KEY, [{ ref, code }, ...anonSaved().filter((a) => a.ref !== ref)].slice(0, 20));
}
function forgetAnon(ref) {
  storage.set(ANON_KEY, anonSaved().filter((a) => a.ref !== ref));
}

function caseRow(c) {
  return h(
    'li',
    { class: 'track' },
    h(
      'a',
      { class: 'case-link', href: `#/case/${c.ref}` },
      h('span', { class: 'track-head' }, caseTitle(c), statusPill(c), c.overdue ? pill(t('case.overdue'), 'stop') : null),
      h('span', { class: 'row-detail' }, `${c.ref} · ${t(`type.${c.type}`)} · ${i18n.date(c.createdAt)}`),
      c.status === 'resolved' ? h('span', { class: 'pill pill-go' }, t('case.checkNow')) : null,
    ),
  );
}

async function renderCases(focus) {
  loading(focus);
  let data;
  try {
    data = await api('/api/worker/cases');
  } catch (err) {
    return failed(err);
  }
  const saved = anonSaved();
  shell(
    false,
    back(),
    title(t('cases.title')),
    h('p', { class: 'lede' }, t('cases.intro')),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('cases.named')),
      data.cases.length ? h('ul', { class: 'rows' }, data.cases.map(caseRow)) : h('p', { class: 'lede' }, t('cases.none')),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title' }, '🔒 ', t('cases.anonymous')),
      h('p', { class: 'lede' }, t('cases.anonIntro')),
      saved.length
        ? h(
            'ul',
            { class: 'rows' },
            saved.map((a) =>
              h(
                'li',
                { class: 'track' },
                h('span', { class: 'track-head' }, a.ref),
                h(
                  'div',
                  { class: 'actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn-small',
                      onclick: () => {
                        state.anon = { ...a };
                        location.hash = '#/track';
                      },
                    },
                    t('cases.open'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn-quiet btn-small',
                      onclick: () => {
                        forgetAnon(a.ref);
                        renderCases(false);
                      },
                    },
                    t('cases.forget'),
                  ),
                ),
              ),
            ),
          )
        : null,
      h('a', { class: 'btn btn-quiet', href: '#/track' }, t('track.title')),
    ),
  );
  if (focus) document.getElementById('main')?.focus({ preventScroll: true });
  return null;
}

/* ---------- case detail (named or anonymous) ---------- */

/**
 * The worker's view of one case: status, deadline, who is responsible, the
 * conversation, the audit trail, and (once resolved) the verify step.
 * `send` performs the message and verify calls for either kind of case.
 */
function drawCase(c, { focus, backHref, send, banner = null }) {
  const status = h('p', { role: 'status', class: 'form-status', id: 'case-status' });
  const reply = h('textarea', { class: 'input', id: 'reply', maxlength: '1000', 'aria-describedby': 'case-status' });
  const replyBtn = h('button', { class: 'btn', type: 'submit' }, t('case.send'));

  const replyForm = c.canMessage
    ? h(
        'form',
        {
          class: 'field',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            busy(replyBtn, async () => {
              if (!reply.value.trim()) return showError(status, t('case.writeFirst'));
              try {
                const updated = await send('message', { text: reply.value.trim() });
                toast(t('case.messageSent'), 'ok');
                drawCase(updated, { focus: false, backHref, send, banner });
              } catch (err) {
                showError(status, err);
              }
              return null;
            });
          },
        },
        h('label', { for: 'reply', class: 'field-label' }, t('case.reply')),
        reply,
        micButton(reply),
        replyBtn,
      )
    : null;

  let verify = null;
  if (c.canVerify) {
    const note = h('textarea', { class: 'input', id: 'verify-note', maxlength: '1000' });
    const noForm = h(
      'form',
      {
        class: 'field',
        hidden: true,
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          busy(noSubmit, async () => {
            if (!note.value.trim()) {
              note.focus();
              return showError(status, t('verify.whyRequired'));
            }
            try {
              const updated = await send('verify', { accepted: false, note: note.value.trim() });
              toast(t('verify.reopened'), 'ok');
              drawCase(updated, { focus: true, backHref, send, banner });
            } catch (err) {
              showError(status, err);
            }
            return null;
          });
        },
      },
      h('label', { for: 'verify-note', class: 'field-label' }, t('verify.why')),
      note,
      micButton(note),
    );
    const noSubmit = h('button', { class: 'btn btn-danger', type: 'submit' }, t('verify.sendNo'));
    noForm.append(noSubmit);
    const yesBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn',
        onclick: () =>
          busy(yesBtn, async () => {
            try {
              const updated = await send('verify', { accepted: true });
              toast(t('verify.thanks'), 'ok');
              drawCase(updated, { focus: true, backHref, send, banner });
            } catch (err) {
              showError(status, err);
            }
          }),
      },
      '👍 ',
      t('verify.yes'),
    );
    verify = h(
      'section',
      { class: 'card verify', 'aria-labelledby': 'verify-title' },
      h('h2', { class: 'card-title', id: 'verify-title' }, t(c.type === 'pay' ? 'verify.questionPay' : 'verify.question')),
      h('p', { class: 'lede' }, t('verify.intro')),
      h(
        'div',
        { class: 'actions' },
        yesBtn,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-quiet',
            onclick: () => {
              noForm.hidden = false;
              note.focus();
            },
          },
          '👎 ',
          t('verify.no'),
        ),
      ),
      noForm,
    );
  }

  const assignee = c.assignee ? t('case.handledBy', { person: personLabel(c.assignee) }) : t('case.notAssigned');
  const deadline = deadlineText(c);
  shell(
    focus,
    back(backHref),
    banner ? h('p', { class: 'demo-hint' }, '🔒 ', banner) : null,
    h(
      'div',
      { class: 'case-head' },
      title(caseTitle(c)),
      h('p', { class: 'case-meta' }, h('span', { class: 'mono' }, c.ref), ' · ', t(`type.${c.type}`), ' · ', i18n.dateTime(c.createdAt)),
      h('div', { class: 'pills' }, statusPill(c), c.anonymous ? pill(`🔒 ${t('case.nameHidden')}`, 'quiet') : null, c.severity === 'critical' ? pill(t('severity.critical'), 'stop') : null),
    ),
    statusSteps(c.status),
    c.status === 'open' || c.status === 'in_review'
      ? h('p', { class: `alert ${c.overdue ? 'alert-stop' : ''}` }, h('strong', null, deadline), h('br'), assignee)
      : null,
    c.resolution
      ? h(
          'section',
          { class: 'alert alert-go' },
          h('h2', { class: 'alert-title' }, outcomeText(c, c.resolution.outcome)),
          h('p', null, c.resolution.note),
          h('p', { class: 'row-detail' }, t('case.resolvedBy', { person: personLabel(c.resolution.by), when: i18n.dateTime(c.resolution.at) })),
        )
      : null,
    c.status === 'closed' ? h('p', { class: 'alert alert-go' }, '✅ ', t('case.closedText', { when: i18n.dateTime(c.verification?.at || c.updatedAt) })) : null,
    verify,
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('case.yourReport')),
      c.pay
        ? h(
            'p',
            { class: 'row-detail' },
            `${t(`line.${c.pay.lineCode}`)} · ${i18n.monthName(c.pay.month)} · ${t(`reason.${c.pay.reason}`)}`,
            c.pay.days?.length ? ` · ${c.pay.days.map((d) => i18n.day(d)).join(', ')}` : '',
            c.pay.expectedAmount ? ` · ${t('case.expected', { amount: i18n.money(c.pay.expectedAmount) })}` : '',
          )
        : null,
      h('p', { class: 'quote', lang: c.lang }, c.description),
      listenButton(() => c.description, { lang: () => c.lang }),
    ),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('case.messages')), messageThread(c, { viewer: 'reporter' }), replyForm, status),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('case.history')), historyList(c)),
  );
  state.speech = () => [caseTitle(c), t(`status.${c.status}`), deadline, c.resolution ? `${outcomeText(c, c.resolution.outcome)}. ${c.resolution.note}` : ''].filter(Boolean).join('. ');
}

async function renderCase(focus, ref) {
  loading(focus);
  try {
    const { case: c } = await api(`/api/worker/cases/${encodeURIComponent(ref)}`);
    const send = async (kind, body) => {
      const path = kind === 'message' ? 'messages' : 'verify';
      return (await api(`/api/worker/cases/${encodeURIComponent(ref)}/${path}`, { method: 'POST', body })).case;
    };
    drawCase(c, { focus, backHref: '#/cases', send });
  } catch (err) {
    if (err.status === 401) return signedOut();
    shell(focus, back('#/cases'), h('p', { class: 'alert alert-stop', role: 'alert' }, errorText(err)));
  }
  return null;
}

/* ---------- anonymous tracking (no sign-in needed) ---------- */

function renderTrack(focus) {
  if (state.anon) {
    openAnon(focus, state.anon).catch((err) => {
      toast(errorText(err), 'error');
      renderTrack(focus);
    });
    return null;
  }
  const status = h('p', { role: 'status', class: 'form-status', id: 'track-status' });
  const ref = h('input', { class: 'input mono', id: 'track-ref', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'FS-XXXX-XXXX', 'aria-describedby': 'track-status' });
  const code = h('input', { class: 'input mono', id: 'track-code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX', 'aria-describedby': 'track-status' });
  const btn = h('button', { class: 'btn btn-block', type: 'submit' }, t('track.open'));
  shell(
    focus,
    back(state.user ? '#/' : '#/login'),
    title(t('track.title')),
    h('p', { class: 'lede' }, t('track.intro')),
    h(
      'form',
      {
        class: 'view',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          busy(btn, async () => {
            if (!ref.value.trim() || !code.value.trim()) return showError(status, t('track.both'));
            try {
              await openAnon(true, { ref: ref.value.trim(), code: code.value.trim() });
            } catch (err) {
              showError(status, err);
            }
            return null;
          });
        },
      },
      h('div', { class: 'field' }, h('label', { for: 'track-ref', class: 'field-label' }, t('track.ref')), ref),
      h('div', { class: 'field' }, h('label', { for: 'track-code', class: 'field-label' }, t('track.code')), code),
      status,
      btn,
    ),
    h('p', { class: 'alert' }, '🔒 ', t('track.privacy')),
  );
  return null;
}

async function openAnon(focus, creds) {
  const lookup = await api('/api/public/cases/lookup', { method: 'POST', body: creds }).catch((err) => {
    state.anon = null;
    throw err;
  });
  state.anon = { ref: lookup.case.ref, code: creds.code };
  const send = async (kind, body) => {
    const path = kind === 'message' ? 'messages' : 'verify';
    return (await api(`/api/public/cases/${path}`, { method: 'POST', body: { ...state.anon, ...body } })).case;
  };
  drawCase(lookup.case, { focus, backHref: state.user ? '#/cases' : '#/login', send, banner: t('track.viewing', { org: lookup.org.name }) });
}

/* ---------- router ---------- */

const ROUTES = {
  '': renderHome,
  checkin: renderCheckin,
  shifts: renderShifts,
  pay: renderPay,
  dispute: renderDispute,
  speak: renderSpeak,
  reported: renderReported,
  cases: renderCases,
  case: (focus, arg) => renderCase(focus, arg),
  track: renderTrack,
};

function route(focus = true) {
  const { name, arg } = currentRoute();
  // The access code is held in memory only while the tracking screen is open.
  if (name !== 'track') state.anon = null;
  if (name === 'track') return renderTrack(focus);
  if (state.user && name === 'login') {
    location.hash = '#/';
    return null;
  }
  if (!state.user) return renderLogin();
  return (ROUTES[name] || renderHome)(focus, arg);
}

async function boot() {
  const code = new URLSearchParams(location.search).get('checkin');
  if (/^\d{6}$/.test(code || '')) {
    state.pendingCode = code;
    history.replaceState(null, '', '/#/checkin');
  }
  await i18n.loadLang(state.user?.lang || i18n.savedLang() || 'ta').catch(() => i18n.loadLang('en'));
  window.addEventListener('hashchange', () => route(true));

  try {
    const { user } = await api('/api/auth/me');
    if (!user) throw new Error('signed out');
    if (user.role !== 'worker') {
      location.replace('/admin');
      return;
    }
    setUser(user);
    state.user = user;
    if (user.lang !== i18n.lang()) await i18n.loadLang(user.lang);
  } catch {
    setUser(null);
  }
  route(false);
}

boot();
