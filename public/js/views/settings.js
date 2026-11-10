// Store settings (company, GST, numbering, POS rules, payments, printing) and user management.
import { api } from '../api.js';
import { app } from '../app.js';
import { docNumber, docSeries, fyFor, stateLabel, validateGSTIN } from '../gst.js';
import { busy, date, formData, html, icon, openModal, options, render, stateOptions, todayISO, toast } from '../ui.js';

const TABS = [['business', 'Business & GST'], ['billing', 'Billing & POS'], ['payments', 'Payments & printing'], ['users', 'Users']];

export async function mount(el) {
  let tab = 'business';
  const S = { ...app.settings };

  render(el, html`<div class="page">
    <div class="page-head"><h1>Settings</h1></div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button type="button" class="tab ${k === tab ? 'active' : ''}" data-tab="${k}" role="tab">${l}</button>`)}</div>
    <form class="card card-pad mt" id="sf" novalidate>
      <section data-panel="business" class="form-grid">
        <label class="field span-2"><span>Business / shop name *</span><input class="input" name="company_name" value="${S.company_name}" maxlength="120"></label>
        <label class="field"><span>Legal name (as per GST)</span><input class="input" name="legal_name" value="${S.legal_name}" maxlength="160"></label>
        <label class="field"><span>GST registration</span><select class="input" name="registration_type">${options([['Regular', 'Regular taxpayer (Tax Invoice)'], ['Composition', 'Composition scheme (Bill of Supply)'], ['Unregistered', 'Not registered']], S.registration_type)}</select></label>
        <label class="field" data-show="gstin"><span>GSTIN</span><input class="input mono" name="gstin" value="${S.gstin}" maxlength="15" style="text-transform:uppercase" autocomplete="off"><span class="hint" data-gstin-hint></span></label>
        <label class="field" data-show="state"><span>State</span><select class="input" name="state_code">${stateOptions(S.state_code)}</select></label>
        <label class="field" data-show="comp"><span>Composition tax rate % (for the CMP-08 summary)</span><input class="input" type="number" name="composition_rate" min="0" max="10" step="0.5" value="${S.composition_rate}"></label>
        <label class="field span-2"><span>Address</span><textarea class="input" name="address" rows="2" maxlength="300">${S.address}</textarea></label>
        <label class="field"><span>City</span><input class="input" name="city" value="${S.city}" maxlength="60"></label>
        <label class="field"><span>PIN code</span><input class="input" name="pincode" value="${S.pincode}" maxlength="6" inputmode="numeric"></label>
        <label class="field"><span>Phone</span><input class="input" name="phone" value="${S.phone}" maxlength="20"></label>
        <label class="field"><span>Email</span><input class="input" type="email" name="email" value="${S.email}" maxlength="120"></label>
      </section>

      <section data-panel="billing" class="form-grid hidden">
        <label class="field"><span>Invoice prefix (1–4 letters/digits)</span><input class="input mono" name="invoice_prefix" value="${S.invoice_prefix}" maxlength="4" style="text-transform:uppercase"><span class="hint" data-prev="invoice_prefix"></span></label>
        <label class="field"><span>Credit note prefix</span><input class="input mono" name="return_prefix" value="${S.return_prefix}" maxlength="4" style="text-transform:uppercase"><span class="hint" data-prev="return_prefix"></span></label>
        <p class="span-2 faint small">GST invoice numbers must be consecutive, unique within the financial year and at most 16 characters. Numbering restarts automatically on 1 April.</p>
        <label class="check span-2"><input type="checkbox" name="prices_include_tax" ${S.prices_include_tax ? 'checked' : ''}><span>Selling prices include GST (tax is worked out backwards from the price)</span></label>
        <label class="check span-2"><input type="checkbox" name="round_off" ${S.round_off ? 'checked' : ''}><span>Round bill totals to the nearest rupee</span></label>
        <label class="check span-2"><input type="checkbox" name="allow_negative_stock" ${S.allow_negative_stock ? 'checked' : ''}><span>Allow billing when stock is zero (negative stock)</span></label>
        <label class="check span-2"><input type="checkbox" name="cashier_can_edit_price" ${S.cashier_can_edit_price ? 'checked' : ''}><span>Cashiers may change item prices at the POS</span></label>
        <label class="field"><span>Maximum discount a cashier may give (%)</span><input class="input" type="number" name="cashier_max_discount" min="0" max="100" step="0.5" value="${S.cashier_max_discount}"></label>
        <label class="field"><span>B2C Large limit (₹, GSTR-1 Table 5)</span><input class="input" type="number" name="b2cl_limit" min="1" step="1" value="${S.b2cl_limit}"><span class="hint">Inter-state B2C invoices above this are reported invoice-wise. ₹1,00,000 since Aug 2024.</span></label>
      </section>

      <section data-panel="payments" class="form-grid hidden">
        <label class="field span-2"><span>Payment modes (comma separated; Cash is always included)</span><input class="input" name="payment_modes" value="${S.payment_modes.join(', ')}"></label>
        <label class="field"><span>UPI ID for QR payments</span><input class="input mono" name="upi_id" value="${S.upi_id}" placeholder="yourshop@okaxis" maxlength="100"><span class="hint">Shows a scan-to-pay QR with the exact amount at checkout and on bills with a balance due.</span></label>
        <label class="field"><span>Default print format</span><select class="input" name="print_format">${options([['thermal', 'Thermal receipt (80 mm)'], ['a4', 'A4 tax invoice']], S.print_format)}</select></label>
        <label class="check span-2"><input type="checkbox" name="auto_print" ${S.auto_print ? 'checked' : ''}><span>Print automatically after every sale</span></label>
        <label class="field span-2"><span>Receipt footer</span><textarea class="input" name="receipt_footer" rows="2" maxlength="300">${S.receipt_footer}</textarea></label>
        <label class="field"><span>Bank details (A4 invoice)</span><textarea class="input" name="bank_details" rows="3" maxlength="300">${S.bank_details}</textarea></label>
        <label class="field"><span>Terms &amp; conditions (A4 invoice)</span><textarea class="input" name="terms" rows="3" maxlength="1000">${S.terms}</textarea></label>
      </section>

      <div class="modal-actions" data-save><button class="btn btn-primary">${icon('check')} Save settings</button></div>
    </form>
    <div class="card mt hidden" data-panel="users"></div>
  </div>`);

  const form = el.querySelector('#sf');
  const E = form.elements;

  function syncBusiness() {
    const reg = E.registration_type.value;
    form.querySelector('[data-show=gstin]').classList.toggle('hidden', reg === 'Unregistered');
    form.querySelector('[data-show=state]').classList.toggle('hidden', reg !== 'Unregistered');
    form.querySelector('[data-show=comp]').classList.toggle('hidden', reg !== 'Composition');
    const hint = form.querySelector('[data-gstin-hint]');
    const r = validateGSTIN(E.gstin.value);
    hint.className = `hint ${r.ok ? 'ok' : E.gstin.value ? 'err' : ''}`;
    hint.textContent = r.ok ? `✓ ${stateLabel(r.state)} · PAN ${r.pan}` : E.gstin.value ? r.error : '';
    const fy = fyFor(todayISO());
    for (const k of ['invoice_prefix', 'return_prefix']) {
      const p = E[k].value.trim().toUpperCase() || '?';
      form.querySelector(`[data-prev=${k}]`).textContent = `Next: ${docNumber(docSeries(p, fy), 1)} (FY ${fy})`;
    }
  }
  form.addEventListener('input', syncBusiness);
  syncBusiness();

  function showTab(k) {
    tab = k;
    for (const b of el.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === k);
    for (const p of el.querySelectorAll('[data-panel]')) p.classList.toggle('hidden', p.dataset.panel !== k);
    form.classList.toggle('hidden', k === 'users');
    if (k === 'users') loadUsers();
  }
  el.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formData(form);
    v.payment_modes = v.payment_modes.split(',').map((x) => x.trim()).filter(Boolean);
    busy(form.querySelector('[data-save] .btn-primary'), async () => {
      const r = await api.put('/api/settings', v);
      app.settings = r.settings;
      const brand = document.querySelector('.brand-name');
      if (brand) brand.textContent = r.settings.company_name;
      toast('Settings saved', 'success');
    });
  });

  /* ------------------------------------------------------------ users */
  async function loadUsers() {
    const box = el.querySelector('[data-panel=users]');
    let users;
    try { users = (await api.get('/api/users')).users; } catch (e) { toast(e.message, 'error'); return; }
    render(box, html`<div class="card-head"><h2>Users</h2><button type="button" class="btn btn-primary btn-sm" data-user-new>${icon('plus')} Add user</button></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>
      ${users.map((u) => html`<tr><td class="mono">${u.username}${u.id === app.user.id ? html` <span class="badge">you</span>` : ''}</td><td>${u.full_name}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-info' : ''}">${u.role}</span></td>
        <td>${u.active ? html`<span class="badge badge-good">Active</span>` : html`<span class="badge badge-bad">Disabled</span>`}</td>
        <td>${date(u.created_at)}</td><td class="right"><button type="button" class="icon-btn" data-user="${u.id}" aria-label="Edit ${u.username}">${icon('edit')}</button></td></tr>`)}
      </tbody></table></div>
      <div class="card-body faint small">Cashiers can bill, take returns and manage customers. Admins also manage items, reports, settings and users.</div>`);
    box.onclick = (e) => {
      if (e.target.closest('[data-user-new]')) return userForm(null);
      const b = e.target.closest('[data-user]');
      if (b) userForm(users.find((u) => u.id === Number(b.dataset.user)));
      return undefined;
    };
  }

  function userForm(u) {
    const m = openModal({
      title: u ? `Edit ${u.username}` : 'Add user',
      content: html`<form class="form-grid" novalidate>
        <label class="field"><span>Username</span><input class="input" name="username" value="${u?.username || ''}" ${u ? 'disabled' : ''} maxlength="32" autocomplete="off"></label>
        <label class="field"><span>Full name</span><input class="input" name="full_name" value="${u?.full_name || ''}" maxlength="80"></label>
        <label class="field"><span>Role</span><select class="input" name="role">${options([['cashier', 'Cashier'], ['admin', 'Admin']], u?.role || 'cashier')}</select></label>
        <label class="field"><span>${u ? 'New password (leave empty to keep)' : 'Password'}</span><input class="input" type="password" name="password" minlength="8" autocomplete="new-password"></label>
        ${u ? html`<label class="check span-2"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}><span>Active (can sign in)</span></label>` : ''}
        <div class="modal-actions span-2"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">${u ? 'Save' : 'Add user'}</button></div></form>`,
    });
    const f = m.body.querySelector('form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = formData(f);
      if (!v.password) delete v.password;
      busy(f.querySelector('.btn-primary'), async () => {
        if (u) await api.put(`/api/users/${u.id}`, v);
        else await api.post('/api/users', v);
        m.close();
        toast(u ? 'User updated' : 'User added', 'success');
        loadUsers();
      });
    });
  }
}
