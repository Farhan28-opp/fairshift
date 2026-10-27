import { storage } from './dom.js';

// Tamil and English across both interfaces. Every visible string, status and
// error goes through t(); numbers and dates use the language's own locale.

export const LANGS = ['en', 'ta'];
/** Each language is named in its own script, so a worker can find theirs without reading English. */
export const LANG_NAMES = { en: 'English', ta: 'தமிழ்' };
const LOCALES = { en: 'en-IN', ta: 'ta-IN' };
const TZ = 'Asia/Kolkata';
const cache = new Map();

let current = 'en';
let dict = {};
let fallback = {};

function fetchDict(lang) {
  if (!cache.has(lang)) {
    cache.set(
      lang,
      fetch(`/i18n/${lang}.json`).then((r) => {
        if (!r.ok) throw new Error('dictionary unavailable');
        return r.json();
      }),
    );
  }
  return cache.get(lang);
}

export async function loadLang(lang) {
  const next = LANGS.includes(lang) ? lang : 'en';
  const [d, en] = await Promise.all([fetchDict(next), fetchDict('en')]);
  dict = d;
  fallback = en;
  current = next;
  document.documentElement.lang = next;
  storage.set('fs.lang', next);
  return next;
}

export const savedLang = () => storage.get('fs.lang');
export const lang = () => current;
export const locale = () => LOCALES[current];

/** Translate with {placeholders}. Falls back to English, then to the key. */
export function t(key, params = {}) {
  const template = dict[key] ?? fallback[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => (params[name] ?? '').toString());
}

/** True when the key exists (used for optional per-code texts). */
export const has = (key) => key in dict || key in fallback;

/** Whole rupees from paise, in the current language's digits and grouping. */
export const money = (paise) =>
  new Intl.NumberFormat(locale(), { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Math.round(paise / 100));

/** Rupees with paise, for hourly rates. */
export const money2 = (paise) =>
  new Intl.NumberFormat(locale(), { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(paise / 100);

export const num = (n, digits = 1) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n);

export const time = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', timeZone: TZ });

export const date = (ts) => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', timeZone: TZ });

export const dateTime = (ts) =>
  new Date(ts).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ });

/** A calendar day key (YYYY-MM-DD) as a short date. */
export const day = (key, style = 'short') =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(locale(), { day: 'numeric', month: style, weekday: 'short', timeZone: 'UTC' });

export function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const weekday = (key, style = 'narrow') =>
  new Date(`${key}T00:00:00Z`).toLocaleDateString(locale(), { weekday: style, timeZone: 'UTC' });

/** "in 5 h" / "3 h ago", for deadlines. */
export function relativeHours(ts, now = Date.now()) {
  const hours = (ts - now) / 3_600_000;
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  if (Math.abs(hours) >= 48) return rtf.format(Math.round(hours / 24), 'day');
  if (Math.abs(hours) >= 1) return rtf.format(Math.round(hours), 'hour');
  return rtf.format(Math.round(hours * 60), 'minute');
}
