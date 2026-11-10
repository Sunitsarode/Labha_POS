// First-run wizard (like Frappe Books' setup): business + GST registration, admin account.
import { api } from '../api.js';
import { app, boot } from '../app.js';
import { stateLabel, validateGSTIN } from '../gst.js';
import { busy, formData, html, render, stateOptions, toast } from '../ui.js';

export function mount(el) {
  render(el, html`<div class="auth"><form class="card card-pad auth-card wide" novalidate>
    <div class="auth-head"><div class="brand-mark">₹</div><h1>Set up your store</h1>
      <p class="muted">GST-ready billing in a minute. You can change all of this later in Settings.</p></div>

    <div class="section-title">Business &amp; GST</div>
    <div class="form-grid">
      <label class="field span-2"><span>Business / shop name *</span><input class="input" name="company_name" required maxlength="120" autofocus></label>
      <label class="field"><span>GST registration</span>
        <select class="input" name="registration_type">
          <option value="Regular">Regular taxpayer (Tax Invoice)</option>
          <option value="Composition">Composition scheme (Bill of Supply)</option>
          <option value="Unregistered">Not registered under GST</option>
        </select></label>
      <label class="field" data-show="gstin"><span>GSTIN *</span><input class="input mono" name="gstin" maxlength="15" placeholder="29ABCDE1234F1Z5" autocomplete="off" style="text-transform:uppercase"><span class="hint" data-gstin-hint>15 characters. State is read from the first two digits.</span></label>
      <label class="field hidden" data-show="state"><span>State *</span><select class="input" name="state_code">${stateOptions('')}</select></label>
      <label class="field"><span>Legal name (as per GST)</span><input class="input" name="legal_name" maxlength="160"></label>
      <label class="field"><span>Phone</span><input class="input" name="phone" maxlength="20" inputmode="tel"></label>
      <label class="field span-2"><span>Address</span><textarea class="input" name="address" rows="2" maxlength="300"></textarea></label>
      <label class="field"><span>City</span><input class="input" name="city" maxlength="60"></label>
      <label class="field"><span>PIN code</span><input class="input" name="pincode" maxlength="6" inputmode="numeric"></label>
      <label class="check span-2"><input type="checkbox" name="prices_include_tax" checked>
        <span>Selling prices include GST (MRP-style retail pricing)</span></label>
    </div>

    <div class="section-title">Admin account</div>
    <div class="form-grid">
      <label class="field"><span>Your name</span><input class="input" name="full_name" maxlength="80"></label>
      <label class="field"><span>Username *</span><input class="input" name="username" required minlength="3" maxlength="32" autocomplete="username" value="admin"></label>
      <label class="field"><span>Password *</span><input class="input" type="password" name="password" required minlength="8" autocomplete="new-password"></label>
      <label class="field"><span>Repeat password *</span><input class="input" type="password" name="confirm" required minlength="8" autocomplete="new-password"></label>
      ${app.setupKeyRequired ? html`<label class="field span-2"><span>Setup key *</span><input class="input" name="setup_key" required autocomplete="off"><span class="hint">Set by the person who deployed this Worker (SETUP_KEY secret).</span></label>` : ''}
      <label class="check span-2"><input type="checkbox" name="sample_data" checked>
        <span>Load sample items and customers so I can try billing straight away</span></label>
    </div>
    <button class="btn btn-primary btn-lg btn-block mt-lg">Create store</button>
  </form></div>`);

  const form = el.querySelector('form');
  const reg = form.elements.registration_type;
  const gst = form.elements.gstin;
  const hint = form.querySelector('[data-gstin-hint]');
  const sync = () => {
    const unregistered = reg.value === 'Unregistered';
    form.querySelector('[data-show=gstin]').classList.toggle('hidden', unregistered);
    form.querySelector('[data-show=state]').classList.toggle('hidden', !unregistered);
  };
  reg.addEventListener('change', sync);
  gst.addEventListener('input', () => {
    const v = gst.value.trim();
    if (v.length < 15) { hint.className = 'hint'; hint.textContent = `${v.length}/15 characters`; gst.classList.remove('invalid'); return; }
    const r = validateGSTIN(v);
    hint.className = `hint ${r.ok ? 'ok' : 'err'}`;
    hint.textContent = r.ok ? `✓ Valid GSTIN. State: ${stateLabel(r.state)}, PAN ${r.pan}` : r.error;
    gst.classList.toggle('invalid', !r.ok);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formData(form);
    if (!v.company_name.trim()) return toast('Enter your business name', 'error');
    if (v.password !== v.confirm) return toast('Passwords do not match', 'error');
    if (v.password.length < 8) return toast('Use a password of at least 8 characters', 'error');
    busy(form.querySelector('.btn-primary'), async () => {
      await api.post('/api/setup', {
        company: {
          company_name: v.company_name, registration_type: v.registration_type, gstin: v.gstin, state_code: v.state_code,
          legal_name: v.legal_name, phone: v.phone, address: v.address, city: v.city, pincode: v.pincode,
          prices_include_tax: v.prices_include_tax,
        },
        admin: { username: v.username, full_name: v.full_name, password: v.password },
        sample_data: v.sample_data,
        setup_key: v.setup_key,
      });
      toast('Store created. Welcome!', 'success');
      location.hash = '#/pos';
      await boot();
    });
  });
}
