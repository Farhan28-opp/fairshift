import { storage } from './dom.js';

export const LANGS = ['en', 'hi', 'ta'];
const LOCALES = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
const TZ = 'Asia/Kolkata';
const cache = new Map();

let current = 'en';
let dict = {};
let fallback = {};

async function fetchDict(lang) {
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

/** Each language is shown in its own script, so a worker can find theirs without reading English. */
export const LANG_NAMES = { en: 'English', hi: 'हिन्दी', ta: 'தமிழ்' };

export const money = (paise) =>
  new Intl.NumberFormat(locale(), { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);

export const num = (n, digits = 1) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n);

export const time = (ts) => new Date(ts).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit', timeZone: TZ });

export const date = (ts) => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', timeZone: TZ });

export function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const weekday = (day, style = 'narrow') =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(locale(), { weekday: style, timeZone: 'UTC' });
