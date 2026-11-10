// Customers: B2B (with GSTIN) and B2C buyers, outstanding balances, recent invoices.
import { api, qs } from '../api.js';
import { go } from '../app.js';
import { openCustomerForm } from '../customer-form.js';
import { stateLabel } from '../gst.js';
import { date, debounce, html, icon, money, openModal, render, statusBadge, toast } from '../ui.js';

export async function mount(el) {
  let rows = [];
  render(el, html`<div class="page">
    <div class="page-head"><h1>Customers</h1><button type="button" class="btn btn-primary" data-act="new">${icon('plus')} New customer</button></div>
    <div class="filters"><label class="field grow"><span>Search</span><input class="input" id="cq" placeholder="Name, phone or GSTIN" autocomplete="off"></label></div>
    <div class="card"><div class="table-wrap" id="tbl"><div class="loading">Loading…</div></div></div>
  </div>`);

  async function load() {
    try {
      rows = (await api.get(`/api/customers${qs({ q: el.querySelector('#cq').value.trim(), limit: 500 })}`)).customers;
      draw();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function draw() {
    const box = el.querySelector('#tbl');
    if (!rows.length) { render(box, html`<div class="empty"><h3>No customers</h3><p>Walk-in sales need no customer. Add customers for B2B invoices, credit sales or loyalty.</p></div>`); return; }
    render(box, html`<table class="table"><thead><tr><th>Name</th><th>Phone</th><th>GSTIN</th><th>State</th><th class="num">Outstanding</th></tr></thead><tbody>
      ${rows.map((c) => html`<tr class="clickable" data-id="${c.id}"><td><b>${c.name}</b></td><td>${c.phone}</td>
        <td>${c.gstin ? html`<span class="mono">${c.gstin}</span> <span class="badge badge-info">B2B</span>` : html`<span class="faint">Unregistered</span>`}</td>
        <td>${c.state_code ? stateLabel(c.state_code) : ''}</td>
        <td class="num">${c.outstanding > 0 ? html`<b>${money(c.outstanding)}</b>` : html`<span class="faint">—</span>`}</td></tr>`)}
    </tbody></table>`);
  }

  async function showCustomer(id) {
    let d;
    try { d = await api.get(`/api/customers/${id}`); } catch (e) { toast(e.message, 'error'); return; }
    const c = d.customer;
    const m = openModal({
      title: c.name,
      wide: true,
      content: html`<div class="stack">
        <div class="kv">
          <div><span>Phone</span><b>${c.phone || '—'}</b></div><div><span>Email</span><b>${c.email || '—'}</b></div>
          <div><span>GSTIN</span><b class="mono">${c.gstin || 'Unregistered'}</b></div><div><span>State</span><b>${c.state_code ? stateLabel(c.state_code) : '—'}</b></div>
          <div><span>Outstanding</span><b>${money(c.outstanding)}</b></div>${c.address ? html`<div><span>Address</span><b>${c.address}</b></div>` : ''}
        </div>
        <h3>Recent documents</h3>
        ${d.invoices.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Number</th><th>Date</th><th class="num">Total</th><th class="num">Due</th><th>Status</th></tr></thead><tbody>
          ${d.invoices.map((i) => html`<tr class="clickable" data-inv="${i.id}"><td class="mono">${i.number}</td><td>${date(i.date)}</td><td class="num">${money(i.grand_total)}</td><td class="num">${i.outstanding > 0 ? money(i.outstanding) : ''}</td><td>${statusBadge(i)}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No invoices yet.</p>`}
        <div class="modal-actions"><button type="button" class="btn" data-close>Close</button><button type="button" class="btn btn-primary" data-edit>${icon('edit')} Edit customer</button></div>
      </div>`,
    });
    m.body.addEventListener('click', async (e) => {
      const inv = e.target.closest('[data-inv]');
      if (inv) { m.close(); go(`invoices/${inv.dataset.inv}`); return; }
      if (e.target.closest('[data-edit]')) {
        m.close();
        const saved = await openCustomerForm(c);
        if (saved) { toast('Customer saved', 'success'); load(); }
      }
    });
  }

  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-act=new]')) {
      const saved = await openCustomerForm();
      if (saved) { toast(`${saved.name} added`, 'success'); load(); }
      return;
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) showCustomer(Number(tr.dataset.id));
  });
  el.querySelector('#cq').addEventListener('input', debounce(load, 250));
  await load();
}
