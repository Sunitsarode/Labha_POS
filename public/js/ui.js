// Small UI toolkit: auto-escaping templates, modals, toasts, CSV, icons.
import { fmtINR, fmtAmount, fmtQty, fmtDate, STATES } from './gst.js';

export { fmtINR as money, fmtAmount as amount, fmtQty as qty, fmtDate as date };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------ safe HTML templating */
class Html {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
/** Mark a trusted string (e.g. our own SVG) as HTML. Never pass user data to raw(). */
export const raw = (s) => new Html(String(s));
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function part(v) {
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false || v === true) return '';
  return esc(v);
}
/** Tagged template: every interpolated value is HTML-escaped unless wrapped in raw() / html``. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Html(out);
}
export function render(el, h) { el.innerHTML = String(h); }

/* --------------------------------------------------------------- icons */
const PATHS = {
  cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 4h2.3l2.4 11.2h11.3L21 8H6.1"/>',
  grid: '<rect x="3" y="3" width="7.5" height="9" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6"/><rect x="3" y="15" width="7.5" height="6" rx="1.6"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  box: '<path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5 12 12l9-4.5M12 12v9"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.6c2 .6 3.3 2.4 3.7 5.4"/>',
  chart: '<path d="M3.5 20.5h17"/><rect x="5" y="11" width="3.2" height="6.5" rx="1"/><rect x="10.4" y="5.5" width="3.2" height="12" rx="1"/><rect x="15.8" y="8.5" width="3.2" height="9" rx="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14.5 8.5l2 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  printer: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 10l5-5 5 5M5 20h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  rupee: '<path d="M7 4h10M7 9h10M7 4h3a5 5 0 0 1 0 10H7l8 6"/>',
};
export function icon(name) {
  return raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`);
}

/* --------------------------------------------------------------- toast */
export function toast(message, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast-error' : kind === 'success' ? ' toast-success' : ''}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  document.getElementById('toast-root').append(el);
  setTimeout(() => el.remove(), ms);
}

/* --------------------------------------------------------------- modal */
/**
 * Opens a modal. `content` is an html`` value. Returns { el, body, close }.
 * dismissable=false keeps it open on backdrop click (forms you don't want to lose).
 */
export function openModal({ title, content, wide = false, dismissable = true, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  render(wrap, html`<div class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-label="${title}">
    <div class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
    <div class="modal-body"></div></div>`);
  const body = wrap.querySelector('.modal-body');
  render(body, content ?? '');
  const prevFocus = document.activeElement;
  let closed = false;
  function close(value) {
    if (closed) return;
    closed = true;
    wrap.remove();
    document.removeEventListener('keydown', onKey, true);
    if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    onClose?.(value);
  }
  function onKey(e) {
    if (e.key === 'Escape' && root.lastElementChild === wrap) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }
  wrap.addEventListener('mousedown', (e) => { if (dismissable && e.target === wrap) close(); });
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey, true);
  root.append(wrap);
  requestAnimationFrame(() => {
    const f = wrap.querySelector('[autofocus]') || wrap.querySelector('.modal-body input:not([type=hidden]):not([disabled]), .modal-body select, .modal-body textarea');
    f?.focus();
    if (f?.select && f.type !== 'checkbox' && f.tagName === 'INPUT') f.select();
  });
  return { el: wrap, body, close };
}

export function confirmDialog(message, { title = 'Please confirm', ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      content: html`<p>${message}</p><div class="modal-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok autofocus>${ok}</button></div>`,
      onClose: (v) => resolve(v === true),
    });
    m.body.querySelector('[data-ok]').addEventListener('click', () => m.close(true));
  });
}

/* ------------------------------------------------------------- helpers */
/** Form → plain object. Checkboxes become booleans. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled && !el.dataset.keep) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

/** Disable a button while an async action runs; shows API errors as a toast. */
export async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), 'error', 6000);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function options(list, selected) {
  return list.map((o) => {
    const [value, label] = Array.isArray(o) ? o : [o, o];
    return html`<option value="${value}" ${String(value) === String(selected ?? '') ? raw('selected') : ''}>${label}</option>`;
  });
}
export function stateOptions(selected, placeholder = 'Select state') {
  return [html`<option value="">${placeholder}</option>`, options(STATES.map(([c, n]) => [c, `${c} – ${n}`]), selected)];
}

export function download(filename, content, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([mime.startsWith('text/csv') ? '﻿' + content : content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function toCSV(header, rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export const todayISO = () => {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.toISOString().slice(0, 10);
};
export const monthISO = () => todayISO().slice(0, 7);
export const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function statusBadge(inv) {
  if (inv.status === 'Cancelled') return html`<span class="badge badge-bad">Cancelled</span>`;
  const out = [];
  if (inv.doc_type === 'Return') out.push(html`<span class="badge badge-info">Credit note</span>`);
  else if (inv.status === 'Paid') out.push(html`<span class="badge badge-good">Paid</span>`);
  else out.push(html`<span class="badge badge-warn">${inv.status}</span>`);
  if (inv.return_status) out.push(html` <span class="badge">${inv.return_status}</span>`);
  return out;
}
