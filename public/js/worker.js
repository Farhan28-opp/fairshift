import { h, mount, toast, storage } from './dom.js';
import { api } from './api.js';
import * as i18n from './i18n.js';
import { speak, stopSpeaking, canSpeak, canListen, listen } from './voice.js';
import * as offline from './offline.js';

const { t } = i18n;
const app = document.getElementById('app');
const REPORT_STEPS = ['open', 'acknowledged', 'in_progress', 'resolved'];
const FACES = ['😞', '🙁', '😐', '🙂', '😄'];
const ASPECTS = ['pay', 'safety', 'respect', 'workload'];

const state = {
  user: storage.get('fs.user'),
  home: null,
  pendingCode: null,
  speech: null,
  cleanup: null,
  timer: null,
};

const ROUTES = {
  '': renderHome,
  checkin: renderCheckin,
  pay: renderPay,
  report: renderReport,
  feedback: renderFeedback,
  skills: renderSkills,
};

/* ---------- shell ---------- */

function setUser(user) {
  state.user = user;
  if (user) storage.set('fs.user', user);
  else {
    storage.remove('fs.user');
    storage.remove('fs.home');
  }
}

function header() {
  const select = h(
    'select',
    { class: 'lang-select', 'aria-label': t('lang.choose'), onchange: (e) => changeLang(e.target.value) },
    i18n.LANGS.map((code) => h('option', { value: code, selected: code === i18n.lang() }, i18n.LANG_NAMES[code])),
  );
  const listenBtn = canSpeak()
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
    select,
    listenBtn,
  );
}

/** Replaces the screen. `focus` moves screen readers to the new content on navigation. */
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
    'Skip to content',
  );
  mount(app, skip, header(), main);
  if (focus) main.focus({ preventScroll: true });
  return main;
}

const back = () => h('a', { class: 'back', href: '#/' }, h('span', { 'aria-hidden': 'true' }, '←'), t('common.back'));
const title = (text) => h('h1', { class: 'view-title' }, text);
const loading = (focus) => shell(focus, h('p', { class: 'loading' }, t('common.loading')));

function toggleReading() {
  const btn = document.getElementById('listen');
  if (btn?.getAttribute('aria-pressed') === 'true') return stopReading();
  const main = document.getElementById('main');
  const text = state.speech ? state.speech() : main?.innerText || '';
  if (speak(text, i18n.lang(), stopReading)) btn?.setAttribute('aria-pressed', 'true');
}

function stopReading() {
  stopSpeaking();
  document.getElementById('listen')?.setAttribute('aria-pressed', 'false');
}

async function changeLang(code) {
  await i18n.loadLang(code);
  if (state.user) {
    state.user = { ...state.user, lang: code };
    storage.set('fs.user', state.user);
    api('/api/auth/me', { method: 'PATCH', body: { lang: code } }).catch(() => {});
  }
  route(false);
}

function failed(err) {
  if (err.status === 401) return signedOut();
  toast(err.status === 0 ? t('common.offline') : t('common.error'), 'error');
  return null;
}

function signedOut() {
  setUser(null);
  state.home = null;
  renderLogin();
}

/** Mic button that dictates into a text field in the worker's language. */
function micButton(target) {
  if (!canListen()) return null;
  let stop = null;
  const label = h('span', null, t('report.speak'));
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet mic',
      'aria-pressed': 'false',
      onclick: () => {
        if (stop) return stop();
        const prefix = target.value ? `${target.value} ` : '';
        btn.setAttribute('aria-pressed', 'true');
        label.textContent = t('report.listening');
        stop = listen(i18n.lang(), {
          onText: (text) => {
            target.value = prefix + text;
            target.dataset.voice = '1';
          },
          onEnd: () => {
            stop = null;
            btn.setAttribute('aria-pressed', 'false');
            label.textContent = t('report.speak');
          },
        });
        return null;
      },
    },
    h('span', { 'aria-hidden': 'true' }, '🎤'),
    label,
  );
  return btn;
}

/* ---------- offline-aware shift state ---------- */

function effectiveShift() {
  const last = offline.queued().at(-1);
  if (last?.path.endsWith('/checkin')) return { checkIn: last.clientTime, queued: true };
  if (last?.path.endsWith('/checkout')) return null;
  return state.home?.shift || null;
}

async function sync(silent = false) {
  if (!offline.queued().length || !navigator.onLine) return;
  const sent = await offline.flush(api);
  if (sent) {
    state.home = null;
    if (!silent) {
      toast(t('common.synced'), 'ok');
      route(false);
    }
  }
}

/* ---------- login ---------- */

async function renderLogin() {
  let phone = '';
  const status = h('p', { role: 'status', class: 'lede' });
  const phoneInput = h('input', {
    class: 'input',
    id: 'phone',
    type: 'tel',
    inputmode: 'numeric',
    autocomplete: 'tel',
    maxlength: '16',
    required: true,
  });
  const codeInput = h('input', {
    class: 'input code-input',
    id: 'otp',
    type: 'text',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    maxlength: '6',
    required: true,
  });
  const demoCode = h('p', { class: 'demo-hint', hidden: true });

  const loginError = (err) => {
    const map = {
      otp_incorrect: 'login.wrongCode',
      otp_expired: 'login.expired',
      too_many_attempts: 'login.tooMany',
      too_many_requests: 'login.tooMany',
      invalid_input: 'login.badPhone',
    };
    status.textContent = err.status === 0 ? t('common.offline') : t(map[err.code] || 'common.error');
  };

  async function sendCode(e) {
    e?.preventDefault();
    try {
      const res = await api('/api/auth/request-otp', { method: 'POST', body: { phone: phoneInput.value } });
      phone = phoneInput.value;
      phoneStep.hidden = true;
      codeStep.hidden = false;
      status.textContent = '';
      if (res.demoOtp) {
        codeInput.value = res.demoOtp;
        demoCode.textContent = t('login.demoCode', { code: res.demoOtp });
        demoCode.hidden = false;
        verifyBtn.focus();
      } else codeInput.focus();
    } catch (err) {
      loginError(err);
    }
  }

  async function verify(e) {
    e.preventDefault();
    try {
      const { user } = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, otp: codeInput.value } });
      if (user.role !== 'worker') {
        location.assign('/admin');
        return;
      }
      setUser(user);
      await i18n.loadLang(user.lang);
      route(true);
    } catch (err) {
      loginError(err);
    }
  }

  const verifyBtn = h('button', { class: 'btn btn-block', type: 'submit' }, t('login.verify'));
  const phoneStep = h(
    'form',
    { class: 'field', onsubmit: sendCode },
    h('label', { class: 'field-label', for: 'phone' }, t('login.phone')),
    phoneInput,
    h('button', { class: 'btn btn-block', type: 'submit' }, t('login.sendCode')),
  );
  const codeStep = h(
    'form',
    { class: 'field', hidden: true, onsubmit: verify },
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

  const langs = h(
    'div',
    { class: 'langs', role: 'group', 'aria-label': t('lang.choose') },
    i18n.LANGS.map((code) =>
      h(
        'button',
        {
          type: 'button',
          class: 'lang-btn',
          lang: code,
          'aria-pressed': String(code === i18n.lang()),
          onclick: async () => {
            await i18n.loadLang(code);
            renderLogin();
          },
        },
        i18n.LANG_NAMES[code],
      ),
    ),
  );

  const demo = h('section', { class: 'demo', 'aria-labelledby': 'demo-title' });
  shell(
    false,
    h('h1', { class: 'view-title' }, t('login.title')),
    langs,
    phoneStep,
    codeStep,
    status,
    demo,
    h('div', { class: 'footer-links' }, h('a', { href: '/admin' }, t('login.employer'))),
  );

  try {
    const { orgs } = await api('/api/public/demo-accounts');
    mount(
      demo,
      h('h2', { class: 'card-title', id: 'demo-title' }, t('login.demoTitle')),
      h('p', { class: 'lede' }, t('login.demoHint')),
      orgs.map((group) =>
        h(
          'div',
          { class: 'demo-org' },
          h('h3', null, `${group.org.name} (${t(`sector.${group.org.sector}`)})`),
          h(
            'div',
            { class: 'demo-people' },
            group.workers.map((w) =>
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
                h('span', null, `${w.jobRole}, ${i18n.LANG_NAMES[w.lang]}`),
              ),
            ),
          ),
        ),
      ),
    );
  } catch {
    demo.remove(); // not in demo mode
  }
}

/* ---------- home ---------- */

async function renderHome(focus) {
  if (!state.home) {
    state.home = storage.get('fs.home');
    if (!state.home) loading(focus);
  }
  try {
    state.home = await api('/api/worker/home');
    storage.set('fs.home', state.home);
  } catch (err) {
    if (err.status === 401) return signedOut();
    if (err.status !== 0) toast(t('common.error'), 'error');
  }
  drawHome(focus);
}

function elapsedText(since) {
  const mins = Math.max(0, Math.floor((Date.now() - since) / 60000));
  return t('home.elapsed', { h: Math.floor(mins / 60), m: mins % 60 });
}

function drawHome(focus) {
  const home = state.home || { week: [], fatigue: [] };
  const shift = effectiveShift();
  const user = state.user;

  let punch;
  if (shift) {
    const elapsed = h('span', { class: 'punch-elapsed' }, elapsedText(shift.checkIn));
    punch = h(
      'div',
      { class: 'punch-ring is-on' },
      h(
        'button',
        { type: 'button', class: 'punch-btn', onclick: checkOut },
        h('span', { class: 'punch-meta' }, t('home.onShiftSince', { time: i18n.time(shift.checkIn) })),
        elapsed,
        h('span', { class: 'punch-action' }, t('home.checkOut')),
      ),
    );
    state.timer = setInterval(() => {
      elapsed.textContent = elapsedText(shift.checkIn);
    }, 30_000);
  } else {
    punch = h(
      'div',
      { class: 'punch-ring' },
      h(
        'a',
        { class: 'punch-btn', href: '#/checkin' },
        h('span', { class: 'punch-meta' }, t('home.notOnShift')),
        h('span', { class: 'punch-action' }, t('home.checkIn')),
      ),
    );
  }

  const fatigue = home.fatigue?.length
    ? h(
        'section',
        { class: `alert ${home.fatigue.some((f) => f.severity === 'critical') ? 'alert-stop' : ''}` },
        h('h2', { class: 'alert-title' }, '⚠️ ', t('fatigue.title')),
        h('ul', null, home.fatigue.map((f) => h('li', null, t(`fatigue.${f.code}`, { value: i18n.num(f.value), limit: f.limit })))),
        h('p', null, t('fatigue.advice')),
      )
    : null;

  const max = Math.max(10, ...home.week.map((d) => d.hours));
  const week = home.week.length
    ? h(
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
              h('span', { class: 'sr-only' }, t('home.dayHours', { day: i18n.weekday(d.day, 'long'), hours: i18n.num(d.hours) })),
            ),
          ),
        ),
      )
    : null;

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
      h('p', { class: 'lede' }, `${user.jobRole}, ${user.org.name}`),
    ),
    fatigue,
    h('div', { class: 'punch' }, punch),
    offline.queued().length ? h('p', { class: 'queue-note' }, t('checkin.queued')) : null,
    week,
    h(
      'nav',
      { class: 'tiles', 'aria-label': 'FairShift' },
      tile('pay', '#/pay', '₹', t('tile.pay')),
      tile('report', '#/report', '⚠️', t('tile.report')),
      tile('feedback', '#/feedback', '💬', t('tile.feedback'), home.feedbackGiven === false ? t('tile.feedbackDue') : null),
      tile('skills', '#/skills', '🎓', t('tile.skills')),
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
}

async function checkOut() {
  if (!navigator.onLine) {
    offline.enqueue('/api/worker/checkout');
    toast(t('checkin.queued'));
    return drawHome(false);
  }
  try {
    const res = await api('/api/worker/checkout', { method: 'POST', body: {} });
    toast(t('checkin.doneOut', { hours: i18n.num(res.today.hours), ot: i18n.num(res.today.overtime) }), 'ok');
    state.home = null;
    return renderHome(false);
  } catch (err) {
    if (err.status === 0) {
      offline.enqueue('/api/worker/checkout');
      toast(t('checkin.queued'));
      return drawHome(false);
    }
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

function renderCheckin(focus) {
  if (effectiveShift()) {
    toast(t('checkin.already'));
    location.hash = '#/';
    return;
  }
  const status = h('p', { role: 'status', class: 'lede' });
  const codeInput = h('input', {
    class: 'input code-input',
    id: 'site-code',
    type: 'text',
    inputmode: 'numeric',
    maxlength: '6',
    autocomplete: 'off',
    required: true,
  });
  const codeForm = h(
    'form',
    {
      class: 'field',
      hidden: true,
      onsubmit: (e) => {
        e.preventDefault();
        submit({ method: 'code', code: codeInput.value.trim() });
      },
    },
    h('label', { for: 'site-code', class: 'field-label' }, t('checkin.codeLabel')),
    codeInput,
    h('button', { class: 'btn btn-block', type: 'submit' }, t('checkin.submit')),
  );
  const scanner = h('div', { class: 'scanner', hidden: true });
  const canScan = 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);
  const choice = (icon, label, onclick) =>
    h('button', { type: 'button', class: 'choice', onclick }, h('span', { class: 'choice-icon', 'aria-hidden': 'true' }, icon), label);

  const showCode = () => {
    codeForm.hidden = false;
    codeInput.focus();
  };

  async function submit(body) {
    const queue = () => {
      offline.enqueue('/api/worker/checkin', body);
      toast(t('checkin.queued'));
      location.hash = '#/';
    };
    if (!navigator.onLine) return queue();
    try {
      const res = await api('/api/worker/checkin', { method: 'POST', body });
      toast(t('checkin.done', { time: i18n.time(res.shift.checkIn) }), 'ok');
      state.home = null;
      location.hash = '#/';
    } catch (err) {
      if (err.status === 0) return queue();
      if (err.status === 401) return signedOut();
      const messages = {
        outside_site: t('checkin.outside', { distance: i18n.num(err.details?.distanceM ?? 0, 0) }),
        wrong_code: t('checkin.wrongCode'),
        already_checked_in: t('checkin.already'),
      };
      status.textContent = messages[err.code] || t('common.error');
      toast(status.textContent, 'error');
      if (err.code === 'outside_site') showCode();
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
      showCode();
    }
  }

  function useLocation() {
    if (!navigator.geolocation) {
      status.textContent = t('checkin.noLocation');
      return showCode();
    }
    status.textContent = t('checkin.locating');
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        submit({
          method: 'gps',
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
        }),
      () => {
        status.textContent = t('checkin.noLocation');
        showCode();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
    return null;
  }

  shell(
    focus,
    back(),
    title(t('checkin.title')),
    state.home?.demo ? h('p', { class: 'demo-hint' }, t('checkin.demoCode', { code: state.home.demo.siteCode })) : null,
    h(
      'div',
      { class: 'choices' },
      canScan ? choice('📷', t('checkin.scan'), startScan) : null,
      choice('📍', t('checkin.location'), useLocation),
      choice('🔢', t('checkin.code'), showCode),
    ),
    scanner,
    codeForm,
    status,
  );

  if (state.pendingCode) {
    const code = state.pendingCode;
    state.pendingCode = null;
    submit({ method: 'qr', code });
  }
}

/* ---------- payslip ---------- */

async function renderPay(focus, month) {
  loading(focus);
  let data;
  try {
    data = await api(`/api/worker/payslip${month ? `?month=${encodeURIComponent(month)}` : ''}`);
  } catch (err) {
    return failed(err);
  }
  const p = data.payslip;
  const label = (code) => t(`pay.${code}`);
  const rupees = (paise) => i18n.num(paise / 100, 0);
  const swatch = (l) => {
    if (l.kind === 'deduction') return 'sw-deduction';
    return { basic: 'sw-basic', overtime: 'sw-overtime' }[l.code] || 'sw-allowance';
  };
  const detail = (l) =>
    ({
      basic: () => t('pay.basicDetail', { days: l.days, hours: i18n.num(l.hours), rate: i18n.num(p.hourlyRate / 100, 2) }),
      overtime: () => t('pay.overtimeDetail', { hours: i18n.num(l.hours), multiplier: l.multiplier }),
      pf: () => t('pay.pfDetail', { pct: i18n.num(l.ratePct, 2) }),
      esi: () => t('pay.esiDetail', { pct: i18n.num(l.ratePct, 2) }),
    })[l.code]?.() || null;

  const earnings = p.lines.filter((l) => l.kind === 'earning');
  const deductions = p.lines.filter((l) => l.kind === 'deduction');
  const ot = earnings.find((l) => l.code === 'overtime');

  function openAsk(li, line) {
    if (li.querySelector('.ask-form')) return;
    const text = h('textarea', { class: 'input', id: `ask-${line.code}`, placeholder: t('pay.askPlaceholder'), maxlength: '500' });
    const form = h(
      'form',
      {
        class: 'ask-form',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('/api/worker/pay-queries', {
              method: 'POST',
              body: { month: p.month, lineCode: line.code, message: text.value.trim() || null },
            });
            toast(t('pay.askSent'), 'ok');
            renderPay(false, p.month);
          } catch (err) {
            failed(err);
          }
        },
      },
      h('label', { for: text.id, class: 'field-label' }, t('pay.askTitle', { line: label(line.code) })),
      text,
      micButton(text),
      h('button', { class: 'btn', type: 'submit' }, t('pay.askSend')),
    );
    li.append(form);
    text.focus();
  }

  const row = (l) => {
    const li = h(
      'li',
      { class: 'row' },
      h('span', { class: `swatch ${swatch(l)}`, 'aria-hidden': 'true' }),
      h('div', null, h('div', { class: 'row-label' }, label(l.code)), detail(l) ? h('div', { class: 'row-detail' }, detail(l)) : null),
      h(
        'div',
        { class: 'row-amount' },
        `${l.kind === 'deduction' ? '− ' : ''}${i18n.money(l.amount)}`,
        h('div', null, h('button', { type: 'button', class: 'link', onclick: () => openAsk(li, l) }, t('pay.ask'))),
      ),
    );
    return li;
  };

  const pct = (amount) => `${p.gross ? (amount / p.gross) * 100 : 0}%`;
  const seg = (cls, amount) => (amount > 0 ? h('span', { class: cls, style: { width: pct(amount) } }) : null);
  const allowanceTotal = earnings.filter((l) => !['basic', 'overtime'].includes(l.code)).reduce((s, l) => s + l.amount, 0);
  const wage = p.compliance.minimumWage;

  state.speech = () =>
    t('pay.speech', {
      month: i18n.monthName(p.month),
      net: rupees(p.net),
      gross: rupees(p.gross),
      deductions: rupees(p.totalDeductions),
      ot: i18n.num(ot?.hours || 0),
      otPay: rupees(ot?.amount || 0),
    });

  shell(
    false,
    back(),
    title(t('pay.title')),
    h(
      'div',
      { class: 'months', role: 'group', 'aria-label': t('pay.title') },
      data.months.map((m) =>
        h(
          'button',
          { type: 'button', class: 'month-chip', 'aria-pressed': String(m === p.month), onclick: () => renderPay(false, m) },
          i18n.monthName(m),
        ),
      ),
    ),
    h(
      'section',
      { class: 'net', 'aria-labelledby': 'net-label' },
      h('p', { class: 'net-label', id: 'net-label' }, data.inProgress ? t('pay.inProgress') : i18n.monthName(p.month), ': ', t('pay.net')),
      h('p', { class: 'net-amount' }, i18n.money(p.net)),
      h('p', { class: 'net-sub' }, `${t('pay.gross')} ${i18n.money(p.gross)}, ${t('pay.deductions')} ${i18n.money(p.totalDeductions)}`),
      canSpeak()
        ? h(
            'button',
            { type: 'button', class: 'btn btn-hivis btn-small', onclick: () => speak(state.speech(), i18n.lang()) },
            h('span', { 'aria-hidden': 'true' }, '🔊'),
            t('common.listen'),
          )
        : null,
    ),
    h(
      'div',
      { 'aria-hidden': 'true', class: 'field' },
      h('div', { class: 'paybar' }, seg('sw-basic', earnings[0].amount), seg('sw-overtime', ot?.amount || 0), seg('sw-allowance', allowanceTotal)),
      h('div', { class: 'paybar paybar-cut' }, seg('sw-deduction', p.totalDeductions)),
    ),
    h(
      'section',
      { class: `alert ${wage.ok ? 'alert-go' : 'alert-stop'}` },
      h(
        'p',
        null,
        wage.ok ? '✅ ' : '⚠️ ',
        t(wage.ok ? 'pay.minWageOk' : 'pay.minWageLow', { rate: i18n.num(wage.dailyRate / 100, 0), min: i18n.num(wage.minimum / 100, 0) }),
      ),
    ),
    h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('pay.earnings')), h('ul', { class: 'rows' }, earnings.map(row))),
    deductions.length
      ? h('section', { class: 'card' }, h('h2', { class: 'card-title' }, t('pay.deductions')), h('ul', { class: 'rows' }, deductions.map(row)))
      : null,
    data.queries.length
      ? h(
          'section',
          { class: 'card' },
          h('h2', { class: 'card-title' }, t('pay.queries')),
          h(
            'ul',
            { class: 'rows' },
            data.queries.map((q) =>
              h(
                'li',
                { class: 'track' },
                h(
                  'div',
                  { class: 'track-head' },
                  label(q.lineCode),
                  h('span', { class: `pill ${q.status === 'resolved' ? 'pill-go' : 'pill-warn'}` }, t(`pay.status.${q.status}`)),
                ),
                q.message ? h('p', null, q.message) : null,
                q.response ? h('p', { class: 'reply' }, t('report.reply', { text: q.response })) : null,
              ),
            ),
          ),
        )
      : null,
  );
  if (focus) document.getElementById('main')?.focus({ preventScroll: true });
  return null;
}

/* ---------- report danger ---------- */

async function renderReport(focus, justSent = null) {
  const hazards = state.user.org.hazards;
  const status = h('p', { role: 'status', class: 'lede' });
  const text = h('textarea', { class: 'input', id: 'report-text', placeholder: t('report.placeholder'), maxlength: '1000' });
  const anon = h('input', { type: 'checkbox', id: 'anon', role: 'switch', checked: true, 'aria-describedby': 'anon-help' });
  const mine = h('section', { class: 'card', 'aria-labelledby': 'mine-title' }, h('h2', { class: 'card-title', id: 'mine-title' }, t('report.mine')));

  async function send(e) {
    e.preventDefault();
    const category = form.querySelector('input[name=hazard]:checked')?.value;
    if (!category) {
      status.textContent = t('report.pickFirst');
      return;
    }
    if (text.value.trim().length < 3) {
      status.textContent = t('report.describeFirst');
      text.focus();
      return;
    }
    try {
      const res = await api('/api/worker/reports', {
        method: 'POST',
        body: {
          category,
          description: text.value.trim(),
          anonymous: anon.checked,
          inputMode: text.dataset.voice ? 'voice' : 'text',
          lang: i18n.lang(),
        },
      });
      if (res.trackingToken) storage.set('fs.tokens', [res.trackingToken, ...storage.get('fs.tokens', [])].slice(0, 50));
      toast(t('report.sent'), 'ok');
      renderReport(true, res.report);
    } catch (err) {
      failed(err);
    }
  }

  const form = h(
    'form',
    { class: 'view', onsubmit: send },
    h(
      'fieldset',
      { class: 'question' },
      h('legend', null, t('report.pick')),
      h(
        'div',
        { class: 'hazards' },
        hazards.map((hz) =>
          h(
            'div',
            { class: 'hazard' },
            h('input', { type: 'radio', name: 'hazard', id: `hz-${hz.id}`, value: hz.id }),
            h('label', { for: `hz-${hz.id}` }, h('span', { class: 'hazard-icon', 'aria-hidden': 'true' }, hz.icon), t(`hazard.${hz.id}`)),
          ),
        ),
      ),
    ),
    h('div', { class: 'field' }, h('label', { for: 'report-text', class: 'field-label' }, t('report.describe')), text, micButton(text)),
    h(
      'div',
      { class: 'switch' },
      h('label', { for: 'anon', class: 'switch-label' }, '🔒 ', t('report.anonymous')),
      anon,
      h('p', { id: 'anon-help', class: 'switch-help' }, t('report.anonymousHelp')),
    ),
    status,
    h('button', { class: 'btn btn-danger btn-block', type: 'submit' }, t('report.send')),
  );

  const sentPanel = justSent
    ? h(
        'section',
        { class: `alert ${justSent.urgent ? 'alert-stop' : 'alert-go'}` },
        h('p', { class: 'alert-title' }, t('report.sent')),
        justSent.urgent ? h('p', null, t('report.urgent')) : null,
        justSent.urgent ? h('a', { class: 'btn btn-danger', href: 'tel:112' }, '📞 ', t('report.call')) : null,
      )
    : null;

  shell(focus, back(), title(t('report.title')), sentPanel, form, mine);

  try {
    const tokens = storage.get('fs.tokens', []);
    const [named, tracked] = await Promise.all([
      api('/api/worker/reports'),
      tokens.length ? api('/api/worker/reports/track', { method: 'POST', body: { tokens } }) : { reports: [] },
    ]);
    const all = [...named.reports, ...tracked.reports.filter(Boolean)].sort((a, b) => b.createdAt - a.createdAt);
    const icon = Object.fromEntries(hazards.map((hz) => [hz.id, hz.icon]));
    mine.append(
      all.length
        ? h(
            'ul',
            { class: 'rows' },
            all.map((r) => {
              const reached = REPORT_STEPS.indexOf(r.status);
              return h(
                'li',
                { class: 'track' },
                h(
                  'div',
                  { class: 'track-head' },
                  h('span', { 'aria-hidden': 'true' }, icon[r.category] || '❓'),
                  t(`hazard.${r.category}`),
                  r.anonymous ? h('span', { class: 'pill pill-quiet' }, '🔒 ', t('report.hidden')) : null,
                  h('span', { class: 'lede' }, i18n.date(r.createdAt)),
                ),
                h(
                  'ol',
                  { class: 'steps', 'aria-label': t(`report.status.${r.status}`) },
                  REPORT_STEPS.map((step, i) => h('li', { class: i <= reached ? 'is-done' : '' }, t(`report.status.${step}`))),
                ),
                r.response ? h('p', { class: 'reply' }, t('report.reply', { text: r.response })) : null,
              );
            }),
          )
        : h('p', { class: 'lede' }, t('report.none')),
    );
  } catch (err) {
    failed(err);
  }
}

/* ---------- anonymous feedback ---------- */

function renderFeedback(focus) {
  const intro = h('p', { class: 'alert' }, '🔒 ', t('feedback.intro'));
  if (state.home?.feedbackGiven) {
    shell(focus, back(), title(t('feedback.title')), h('p', { class: 'alert alert-go' }, t('feedback.done')));
    return;
  }
  const status = h('p', { role: 'status', class: 'lede' });
  const comment = h('textarea', { class: 'input', id: 'fb-comment', maxlength: '500' });
  const form = h(
    'form',
    {
      class: 'view',
      onsubmit: async (e) => {
        e.preventDefault();
        const scores = {};
        for (const aspect of ASPECTS) {
          const picked = form.querySelector(`input[name=${aspect}]:checked`);
          if (!picked) {
            status.textContent = t('feedback.answerAll');
            return;
          }
          scores[aspect] = Number(picked.value);
        }
        try {
          await api('/api/worker/feedback', { method: 'POST', body: { scores, comment: comment.value.trim() || null } });
          if (state.home) state.home.feedbackGiven = true;
          toast(t('feedback.sent'), 'ok');
          shell(true, back(), title(t('feedback.title')), h('p', { class: 'alert alert-go' }, t('feedback.sent')));
        } catch (err) {
          if (err.code === 'already_submitted') {
            if (state.home) state.home.feedbackGiven = true;
            status.textContent = t('feedback.done');
          } else failed(err);
        }
      },
    },
    ASPECTS.map((aspect) =>
      h(
        'fieldset',
        { class: 'question card' },
        h('legend', null, t(`feedback.${aspect}`)),
        h(
          'div',
          { class: 'faces' },
          FACES.map((face, i) => {
            const id = `fb-${aspect}-${i + 1}`;
            return h(
              'div',
              { class: 'face' },
              h('input', { type: 'radio', name: aspect, id, value: String(i + 1) }),
              h('label', { for: id }, h('span', { class: 'face-emoji', 'aria-hidden': 'true' }, face), t(`feedback.scale.${i + 1}`)),
            );
          }),
        ),
      ),
    ),
    h('div', { class: 'field' }, h('label', { for: 'fb-comment', class: 'field-label' }, t('feedback.comment')), comment, micButton(comment)),
    status,
    h('button', { class: 'btn btn-block', type: 'submit' }, '🔒 ', t('feedback.send')),
  );
  shell(focus, back(), title(t('feedback.title')), intro, form);
}

/* ---------- skill passport ---------- */

async function renderSkills(focus) {
  loading(focus);
  let data;
  try {
    data = await api('/api/worker/passport');
  } catch (err) {
    return failed(err);
  }
  const p = data.passport;
  const here = p.experience[0];
  const badge = (verified) =>
    h('span', { class: `pill ${verified ? 'pill-go' : ''}` }, verified ? `✔ ${t('skills.verified')}` : t('skills.self'));

  const shareBox = h('section', { class: 'card', 'aria-labelledby': 'share-title' });
  function drawShare(shareId) {
    const url = shareId ? `${location.origin}/p/${shareId}` : null;
    const toggle = async (enabled) => {
      try {
        const res = await api('/api/worker/passport/share', { method: 'POST', body: { enabled } });
        drawShare(res.shareId);
      } catch (err) {
        failed(err);
      }
    };
    const shareOut = async () => {
      if (navigator.share) {
        await navigator.share({ title: 'FairShift', url }).catch(() => {});
        return;
      }
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast(t('skills.copied'), 'ok');
    };
    mount(
      shareBox,
      h('h2', { class: 'card-title', id: 'share-title' }, t('skills.share')),
      h('p', { class: 'lede' }, t('skills.sharing')),
      url
        ? [
            h('p', { class: 'share-link' }, url),
            h('button', { type: 'button', class: 'btn', onclick: shareOut }, '🔗 ', navigator.share ? t('skills.share') : t('skills.copy')),
            h('button', { type: 'button', class: 'link', onclick: () => toggle(false) }, t('skills.stopShare')),
          ]
        : h('button', { type: 'button', class: 'btn', onclick: () => toggle(true) }, '🔗 ', t('skills.share')),
    );
  }
  drawShare(data.shareId);

  // Verified entries carry exact days (YYYY-MM-DD); self-declared ones carry years.
  const fmt = (v) => (v && v.length === 10 ? i18n.date(Date.parse(`${v}T12:00:00+05:30`)) : v || '');
  const range = (e) => `${fmt(e.from)} – ${e.verified ? t('skills.toNow') : fmt(e.to)}`;

  shell(
    false,
    back(),
    title(t('skills.title')),
    h('p', { class: 'lede' }, t('skills.intro')),
    h(
      'div',
      { class: 'passport-days' },
      h('strong', { 'aria-hidden': 'true' }, i18n.num(here.daysWorked, 0)),
      h('span', null, t('skills.verifiedDays', { days: here.daysWorked })),
      h('span', null, `${here.role}, ${here.org}`),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('skills.experience')),
      h(
        'ul',
        { class: 'rows' },
        p.experience.map((e) =>
          h(
            'li',
            { class: 'track' },
            h('div', { class: 'track-head' }, e.role, badge(e.verified)),
            h('p', { class: 'row-detail' }, `${e.org}, ${t(`sector.${e.sector}`)}`),
            h('p', { class: 'row-detail' }, range(e)),
          ),
        ),
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', { class: 'card-title' }, t('skills.training')),
      h(
        'ul',
        { class: 'rows' },
        p.skills.map((sk) => h('li', { class: 'track' }, h('div', { class: 'track-head' }, sk.name, badge(sk.verified)), h('p', { class: 'row-detail' }, sk.issuer))),
      ),
    ),
    shareBox,
  );
  if (focus) document.getElementById('main')?.focus({ preventScroll: true });
  return null;
}

/* ---------- boot ---------- */

function route(focus = true) {
  if (!state.user) return renderLogin();
  const name = location.hash.replace(/^#\/?/, '');
  return (ROUTES[name] || renderHome)(focus);
}

async function boot() {
  const code = new URLSearchParams(location.search).get('checkin');
  if (/^\d{6}$/.test(code || '')) {
    state.pendingCode = code;
    history.replaceState(null, '', '/#/checkin');
  }
  await i18n.loadLang(state.user?.lang || i18n.savedLang() || 'en').catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('hashchange', () => route(true));
  window.addEventListener('online', () => sync(false));
  window.addEventListener('offline', () => toast(t('common.offline')));

  try {
    const { user } = await api('/api/auth/me');
    if (user.role !== 'worker') {
      location.replace('/admin');
      return;
    }
    setUser(user);
    if (user.lang !== i18n.lang()) await i18n.loadLang(user.lang);
    await sync(true);
  } catch (err) {
    if (err.status !== 0) setUser(null); // offline: keep the cached user so check-ins still work
  }
  route(false);
}

boot();
