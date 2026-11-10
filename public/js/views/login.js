import { api } from '../api.js';
import { app, boot } from '../app.js';
import { formData, html, render } from '../ui.js';

export function mount(el) {
  render(el, html`<div class="auth"><form class="card card-pad auth-card">
    <div class="auth-head"><div class="brand-mark">₹</div><h1>${app.settings?.company_name || 'Niwas POS'}</h1><p class="muted">Sign in to start billing</p></div>
    <div class="stack">
      <label class="field"><span>Username</span><input class="input" name="username" required autocomplete="username" autofocus></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
      <p class="notice notice-bad hidden" data-err role="alert"></p>
      <button class="btn btn-primary btn-lg btn-block">Sign in</button>
    </div>
  </form></div>`);
  const form = el.querySelector('form');
  const err = form.querySelector('[data-err]');
  form.elements.username.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.btn-primary');
    btn.disabled = true;
    err.classList.add('hidden');
    try {
      await api.post('/api/auth/login', formData(form));
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      form.elements.password.select();
    } finally {
      btn.disabled = false;
    }
  });
}
