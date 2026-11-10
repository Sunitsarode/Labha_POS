// Customer add / edit dialog, shared by the POS and the Customers page.
import { api } from './api.js';
import { app } from './app.js';
import { stateLabel, validateGSTIN } from './gst.js';
import { busy, formData, html, openModal, stateOptions } from './ui.js';

/** Resolves with the saved customer, or null when cancelled. */
export function openCustomerForm(existing = null, prefill = {}) {
  return new Promise((resolve) => {
    const v = { name: '', phone: '', email: '', gstin: '', state_code: app.settings.state_code, address: '', ...prefill, ...(existing || {}) };
    let saved = null;
    const m = openModal({
      title: existing ? 'Edit customer' : 'New customer',
      dismissable: false,
      onClose: () => resolve(saved),
      content: html`<form class="form-grid" novalidate>
        <label class="field span-2"><span>Name *</span><input class="input" name="name" value="${v.name}" required maxlength="120" autofocus></label>
        <label class="field"><span>Phone</span><input class="input" name="phone" value="${v.phone}" inputmode="tel" maxlength="20"></label>
        <label class="field"><span>Email</span><input class="input" type="email" name="email" value="${v.email}" maxlength="120"></label>
        <label class="field"><span>GSTIN (registered business)</span>
          <input class="input mono" name="gstin" value="${v.gstin}" maxlength="15" autocomplete="off" style="text-transform:uppercase">
          <span class="hint" data-hint>Leave empty for unregistered (B2C) customers.</span></label>
        <label class="field"><span>State</span><select class="input" name="state_code" data-keep="1">${stateOptions(v.state_code)}</select></label>
        <label class="field span-2"><span>Address</span><textarea class="input" name="address" rows="2" maxlength="300">${v.address}</textarea></label>
        <div class="modal-actions span-2"><button type="button" class="btn" data-close>Cancel</button>
          <button class="btn btn-primary">${existing ? 'Save changes' : 'Add customer'}</button></div>
      </form>`,
    });
    const form = m.body.querySelector('form');
    const gst = form.elements.gstin;
    const state = form.elements.state_code;
    const hint = form.querySelector('[data-hint]');
    const check = () => {
      const g = gst.value.trim();
      state.disabled = false;
      gst.classList.remove('invalid');
      if (!g) { hint.className = 'hint'; hint.textContent = 'Leave empty for unregistered (B2C) customers.'; return; }
      if (g.length < 15) { hint.className = 'hint'; hint.textContent = `${g.length}/15 characters`; return; }
      const r = validateGSTIN(g);
      hint.className = `hint ${r.ok ? 'ok' : 'err'}`;
      hint.textContent = r.ok ? `✓ Valid · ${stateLabel(r.state)} · PAN ${r.pan}` : r.error;
      gst.classList.toggle('invalid', !r.ok);
      if (r.ok) { state.value = r.state; state.disabled = true; }
    };
    gst.addEventListener('input', check);
    check();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = formData(form);
      busy(form.querySelector('.btn-primary'), async () => {
        const res = existing ? await api.put(`/api/customers/${existing.id}`, body) : await api.post('/api/customers', body);
        saved = res.customer;
        m.close();
      });
    });
  });
}
