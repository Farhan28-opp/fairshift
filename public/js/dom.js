// Minimal DOM builder. Text always goes in through textContent/text nodes,
// never innerHTML, so user-supplied text cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyAttrs(el, attrs) {
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    // CSSOM writes are allowed by our strict CSP (style-src 'self'); style="" attributes are not.
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'value' && 'value' in el) el.value = value;
    else if (key === 'checked' && 'checked' in el) el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

export function mount(root, ...children) {
  root.replaceChildren();
  appendChildren(root, children);
}

/** Polite screen-reader + visual toast. */
export function toast(message, tone = 'info') {
  const live = document.getElementById('live');
  if (live) {
    live.textContent = '';
    setTimeout(() => {
      live.textContent = message;
    }, 50);
  }
  const visual = document.getElementById('toast');
  if (!visual) return;
  visual.className = `toast toast-${tone}`;
  visual.textContent = message;
  visual.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    visual.hidden = true;
  }, 6000);
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or storage full: the app still works online */
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
