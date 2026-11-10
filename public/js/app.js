// App shell: bootstrap, hash router, sidebar navigation, auth state.
import { api } from './api.js';
import { busy, formData, html, icon, openModal, render, toast } from './ui.js';

export const app = { user: null, settings: null, setupDone: false, setupKeyRequired: false };

const NAV = [
  { path: 'pos', label: 'POS', icon: 'cart', roles: ['admin', 'cashier'], load: () => import('./views/pos.js') },
  { path: 'dashboard', label: 'Dashboard', icon: 'grid', roles: ['admin'], load: () => import('./views/dashboard.js') },
  { path: 'invoices', label: 'Invoices', icon: 'receipt', roles: ['admin', 'cashier'], load: () => import('./views/invoices.js') },
  { path: 'items', label: 'Items', icon: 'box', roles: ['admin', 'cashier'], load: () => import('./views/items.js') },
  { path: 'customers', label: 'Customers', icon: 'users', roles: ['admin', 'cashier'], load: () => import('./views/customers.js') },
  { path: 'reports', label: 'GST & reports', icon: 'chart', roles: ['admin'], load: () => import('./views/reports.js') },
  { path: 'shifts', label: 'Shifts', icon: 'clock', roles: ['admin', 'cashier'], load: () => import('./views/shifts.js') },
  { path: 'settings', label: 'Settings', icon: 'sliders', roles: ['admin'], load: () => import('./views/settings.js') },
];

export const isAdmin = () => app.user?.role === 'admin';
export const go = (path) => { location.hash = `#/${path}`; };

/** Print a document (receipt / A4 / Z-report) through a hidden iframe: no pop-up blockers. */
export function printDoc(query) {
  const f = document.createElement('iframe');
  f.className = 'print-frame';
  f.title = 'Print preview';
  f.src = `/print#${query}&auto=1`;
  document.body.append(f);
  setTimeout(() => f.remove(), 120_000);
}
export const openDoc = (query) => window.open(`/print#${query}`, '_blank', 'noopener');

export async function boot() {
  try {
    const b = await api.get('/api/bootstrap');
    app.setupDone = b.setup_done;
    app.setupKeyRequired = !!b.setup_key_required;
    app.user = b.user;
    app.settings = b.settings;
  } catch (e) {
    const root = document.getElementById('app');
    render(root, html`<div class="auth"><div class="card card-pad auth-card">
      <h2>Cannot start Niwas POS</h2><p class="muted mt">${e.message}</p>
      <button type="button" class="btn btn-primary mt" data-retry>Try again</button></div></div>`);
    root.querySelector('[data-retry]').addEventListener('click', () => location.reload());
    return;
  }
  shellMounted = false;
  route();
}

let shellMounted = false;
let navToken = 0;
let cleanup = null;

const defaultPath = () => (isAdmin() ? 'dashboard' : 'pos');

async function route() {
  const token = ++navToken;
  if (cleanup) {
    try { cleanup(); } catch (e) { console.error(e); }
    cleanup = null;
  }
  const root = document.getElementById('app');
  if (!app.setupDone || !app.user) {
    shellMounted = false;
    return mount(root, () => import(app.setupDone ? './views/login.js' : './views/setup.js'), {}, token);
  }
  const [seg, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const entry = NAV.find((n) => n.path === seg && n.roles.includes(app.user.role));
  if (!entry) {
    location.replace(`#/${defaultPath()}`);
    return;
  }
  if (!shellMounted) renderShell(root);
  for (const a of root.querySelectorAll('.nav a')) a.classList.toggle('active', a.dataset.path === entry.path);
  document.title = `${entry.label} · ${app.settings?.company_name || 'Niwas POS'}`;
  const view = document.getElementById('view');
  view.className = `view${entry.path === 'pos' ? ' view-pos' : ''}`;
  await mount(view, entry.load, { id: rest[0] ? decodeURIComponent(rest[0]) : null }, token);
}

async function mount(container, load, params, token) {
  // A fresh host per navigation: a slow, superseded view can only ever write into its own detached node.
  const host = document.createElement('div');
  host.style.height = '100%';
  render(host, html`<div class="loading">Loading…</div>`);
  container.replaceChildren(host);
  try {
    const mod = await load();
    if (token !== navToken) return;
    const c = await mod.mount(host, params);
    if (token !== navToken) { if (typeof c === 'function') c(); return; }
    cleanup = typeof c === 'function' ? c : null;
  } catch (e) {
    console.error(e);
    if (token === navToken) {
      render(host, html`<div class="page"><div class="empty"><h3>Could not load this page</h3><p>${e.message}</p></div></div>`);
    }
  }
}

function renderShell(root) {
  const u = app.user;
  render(root, html`<div class="shell">
    <aside class="sidebar">
      <div class="brand" title="${app.settings.company_name}"><span class="brand-mark">₹</span><span class="brand-name">${app.settings.company_name}</span></div>
      <nav class="nav" aria-label="Main">
        ${NAV.filter((n) => n.roles.includes(u.role)).map((n) => html`<a href="#/${n.path}" data-path="${n.path}" title="${n.label}">${icon(n.icon)}<span>${n.label}</span></a>`)}
      </nav>
      <div class="sidebar-foot">
        <div class="who"><b>${u.full_name || u.username}</b><small>${u.role}</small></div>
        <button class="btn btn-ghost btn-sm" data-act="password" title="Change password">${icon('key')}<span class="label">Password</span></button>
        <button class="btn btn-ghost btn-sm" data-act="logout" title="Sign out">${icon('logout')}<span class="label">Sign out</span></button>
      </div>
    </aside>
    <main class="main"><div id="view" class="view"></div></main>
  </div>`);
  shellMounted = true;
  root.querySelector('[data-act=logout]').addEventListener('click', async () => {
    await api.post('/api/auth/logout').catch(() => {});
    app.user = null;
    location.hash = '';
    boot();
  });
  root.querySelector('[data-act=password]').addEventListener('click', changePassword);
}

function changePassword() {
  const m = openModal({
    title: 'Change password',
    dismissable: false,
    content: html`<form class="stack">
      <label class="field"><span>Current password</span><input class="input" type="password" name="current_password" required autocomplete="current-password"></label>
      <label class="field"><span>New password</span><input class="input" type="password" name="new_password" minlength="8" required autocomplete="new-password"></label>
      <label class="field"><span>Repeat new password</span><input class="input" type="password" name="confirm" minlength="8" required autocomplete="new-password"></label>
      <p class="faint small">Other devices signed in with your account will be signed out.</p>
      <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Change password</button></div>
    </form>`,
  });
  const form = m.body.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formData(form);
    if (v.new_password !== v.confirm) return toast('The new passwords do not match', 'error');
    busy(form.querySelector('.btn-primary'), async () => {
      await api.post('/api/auth/password', v);
      m.close();
      toast('Password changed', 'success');
    });
  });
}

window.addEventListener('hashchange', route);
window.addEventListener('auth:required', () => {
  if (!app.user) return;
  app.user = null;
  toast('Your session has ended. Please sign in again.', 'error');
  route();
});

boot();
