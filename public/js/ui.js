// Components shared by the worker app and the admin dashboard.
import { h, toast } from './dom.js';
import * as i18n from './i18n.js';
import { speak, stopSpeaking, canSpeak, canListen, listen } from './voice.js';
import { icon } from './icons.js';

const { t } = i18n;

export const CASE_STEPS = ['open', 'in_review', 'resolved', 'closed'];

/** Turns an API error into a sentence in the current language. */
export function errorText(err) {
  if (!err || err.status === 0) return t('error.network');
  if (err.code === 'invalid_input' && err.details?.field) {
    const field = String(err.details.field).split('.')[0];
    return t('error.invalid_field', { field: t(`field.${field}`) });
  }
  return i18n.has(`error.${err.code}`) ? t(`error.${err.code}`) : t('error.generic');
}

/** Runs an async action with the button disabled, so a double tap cannot submit twice. */
export async function busy(button, fn) {
  if (button?.disabled) return undefined;
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
  }
  try {
    return await fn();
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

/** Shows an error next to a form and announces it. */
export function showError(statusEl, err) {
  // A bug in our own code (not an API answer) is logged so it can be found.
  if (err instanceof Error && err.status === undefined) console.error(err);
  const message = typeof err === 'string' ? err : errorText(err);
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.classList.add('is-error');
  }
  toast(message, 'error');
}

/** Two-language switch; each language is written in its own script. */
export function langSwitch(onChange) {
  return h(
    'div',
    { class: 'lang-switch', role: 'group', 'aria-label': t('lang.choose') },
    i18n.LANGS.map((code) =>
      h(
        'button',
        { type: 'button', lang: code, 'aria-pressed': String(code === i18n.lang()), onclick: () => code !== i18n.lang() && onChange(code) },
        i18n.LANG_NAMES[code],
      ),
    ),
  );
}

/** A "Listen" button that reads text aloud, or explains why it cannot. */
export function listenButton(getText, { lang = () => i18n.lang(), label = t('common.listen'), className = 'btn btn-quiet btn-small' } = {}) {
  if (!canSpeak()) return null;
  const btn = h(
    'button',
    {
      type: 'button',
      class: className,
      'aria-pressed': 'false',
      onclick: () => {
        if (btn.getAttribute('aria-pressed') === 'true') {
          stopSpeaking();
          btn.setAttribute('aria-pressed', 'false');
          return;
        }
        const ok = speak(getText(), lang(), () => btn.setAttribute('aria-pressed', 'false'));
        if (ok) btn.setAttribute('aria-pressed', 'true');
        else toast(t('voice.noVoice'), 'error');
      },
    },
    icon('volume', 18),
    h('span', null, label),
  );
  return btn;
}

/** Mic button that dictates into a text field; typing always works too. */
export function micButton(target) {
  if (!canListen()) return null;
  let stop = null;
  const label = h('span', null, t('voice.speak'));
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet btn-small mic',
      'aria-pressed': 'false',
      onclick: () => {
        if (stop) {
          stop();
          return;
        }
        const prefix = target.value ? `${target.value} ` : '';
        btn.setAttribute('aria-pressed', 'true');
        label.textContent = t('voice.listening');
        stop = listen(i18n.lang(), {
          onText: (text) => {
            target.value = prefix + text;
            target.dataset.voice = '1';
            target.dispatchEvent(new Event('input'));
          },
          onError: (code) => toast(code === 'not-allowed' ? t('voice.denied') : t('voice.failed'), 'error'),
          onEnd: () => {
            stop = null;
            btn.setAttribute('aria-pressed', 'false');
            label.textContent = t('voice.speak');
          },
        });
      },
    },
    icon('mic', 18),
    label,
  );
  return btn;
}

export const pill = (text, tone = '') => h('span', { class: `pill${tone ? ` pill-${tone}` : ''}` }, text);

const STATUS_TONE = { open: 'warn', in_review: 'quiet', resolved: 'go', closed: '' };

export function statusPill(c) {
  return pill(t(`status.${c.status}`), STATUS_TONE[c.status]);
}

/** Status shown as four labelled steps (text, not colour alone). */
export function statusSteps(status) {
  const reached = CASE_STEPS.indexOf(status);
  return h(
    'ol',
    { class: 'steps', 'aria-label': t('case.progress', { status: t(`status.${status}`) }) },
    CASE_STEPS.map((step, i) =>
      h('li', { class: i <= reached ? 'is-done' : '', 'aria-current': i === reached ? 'step' : null }, t(`step.${step}`)),
    ),
  );
}

export function personLabel(p) {
  if (!p) return '';
  return p.title ? `${p.name} (${t(`title.${p.title}`)})` : p.name;
}

export function actorLabel(actor) {
  switch (actor?.type) {
    case 'admin':
      return personLabel(actor);
    case 'you':
      return t('actor.you');
    case 'reporter':
      return t('actor.reporter');
    case 'system':
      return t('actor.system');
    default:
      return actor?.name || t('actor.worker');
  }
}

/** Plain-language title for a case: the category, or the disputed pay line. */
export function caseTitle(c) {
  if (c.type === 'pay') return t('case.payTitle', { line: t(`line.${c.category}`) });
  return t(`cat.${c.category}`);
}

export function outcomeText(c, outcome) {
  return t(`outcome.${outcome}`, { type: t(`type.${c.type}`) });
}

/** Deadline sentence: when the next response is due, or that it is overdue and escalated. */
export function deadlineText(c, now = Date.now()) {
  if (!c.dueAt) return null;
  const stage = c.status === 'open' ? 'ack' : 'resolve';
  if (c.overdue) {
    return c.escalated
      ? t('deadline.escalated', { when: i18n.relativeHours(c.dueAt, now), to: t(`esc.${c.escalatedTo}`) })
      : t('deadline.overdue', { when: i18n.relativeHours(c.dueAt, now) });
  }
  return t(`deadline.${stage}`, { when: i18n.dateTime(c.dueAt), rel: i18n.relativeHours(c.dueAt, now) });
}

/** One audit-trail entry as a sentence. */
export function historyText(entry, c) {
  const actor = actorLabel(entry.actor);
  switch (entry.action) {
    case 'assigned':
      return t('history.assigned', { actor, to: personLabel(entry.to) });
    case 'resolved':
      return t('history.resolved', { actor, outcome: outcomeText(c, entry.outcome) });
    case 'escalated':
      return t(`history.escalated.${entry.stage}`, { to: t(`esc.${entry.to}`), limit: entry.limitHours });
    case 'shift_corrected':
    case 'shift_added':
      return t(`history.${entry.action}`, { actor, day: entry.shift?.day ? i18n.day(entry.shift.day) : '' });
    case 'adjustment':
      return t('history.adjustment', { actor, amount: i18n.money(entry.amount), month: entry.month ? i18n.monthName(entry.month) : '' });
    default:
      if (entry.actor?.type === 'you' && i18n.has(`history.${entry.action}.you`)) return t(`history.${entry.action}.you`);
      return t(`history.${entry.action}`, { actor });
  }
}

/** Audit trail, oldest first. Messages appear in the conversation instead, unless asked for. */
export function historyList(c, { includeMessages = false } = {}) {
  const entries = c.history.filter((e) => includeMessages || e.action !== 'message');
  return h(
    'ol',
    { class: 'timeline' },
    entries.map((e) =>
      h(
        'li',
        { class: `timeline-item is-${e.action}` },
        h('time', { datetime: new Date(e.at).toISOString() }, i18n.dateTime(e.at)),
        h('p', null, historyText(e, c)),
        e.note && e.action !== 'resolved' ? h('p', { class: 'timeline-note' }, e.note) : null,
      ),
    ),
  );
}

/** The two-way conversation between the reporter and the people handling the case. */
export function messageThread(c, { viewer }) {
  if (!c.messages.length) return h('p', { class: 'lede' }, t('case.noMessages'));
  return h(
    'ol',
    { class: 'thread' },
    c.messages.map((m) => {
      const fromStaff = m.actor.type === 'admin';
      const mine = viewer === 'admin' ? fromStaff : !fromStaff;
      return h(
        'li',
        { class: `bubble ${mine ? 'is-mine' : 'is-theirs'}` },
        h('p', { class: 'bubble-meta' }, `${actorLabel(m.actor)} · ${i18n.dateTime(m.at)}`),
        h('p', { class: 'bubble-text' }, m.text),
      );
    }),
  );
}

/** Label for a payslip line, including adjustments that name their case. */
export function lineLabel(line) {
  if (line.code === 'adjustment' || line.code === 'recovery') return t(`line.${line.code}`, { ref: line.caseRef });
  return t(`line.${line.code}`);
}
