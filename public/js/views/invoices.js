// Invoices & credit notes: list, detail, returns, payments against credit, cancellation.
import { api, qs } from '../api.js';
import { app, go, isAdmin, printDoc } from '../app.js';
import { docTitle, fmtRate, r2, round, sgstLabel, stateLabel } from '../gst.js';
import {
  addDays, busy, date, debounce, html, icon, money, openModal, options, qty, render, statusBadge, todayISO, toast,
} from '../ui.js';

export const SECTION_LABEL = {
  B2B: 'B2B · Table 4A', B2CL: 'B2C Large · Table 5', B2CS: 'B2C Small · Table 7',
  CDNR: 'Credit note, registered · Table 9B', CDNUR: 'Credit note, unregistered · Table 9B', NONE: 'Not reported (not a regular taxpayer)',
};

export function mount(el, params) {
  return params.id ? detail(el, Number(params.id)) : list(el);
}

/* ------------------------------------------------------------------ list */
async function list(el) {
  let offset = 0;
  let rows = [];
  render(el, html`<div class="page">
    <div class="page-head"><h1>Invoices &amp; credit notes</h1><a class="btn btn-primary" href="#/pos">${icon('cart')} New sale</a></div>
    <form class="filters" autocomplete="off">
      <label class="field"><span>From</span><input class="input" type="date" name="from" value="${addDays(todayISO(), -30)}"></label>
      <label class="field"><span>To</span><input class="input" type="date" name="to" value="${todayISO()}"></label>
      <label class="field grow"><span>Search</span><input class="input" name="q" placeholder="Number, customer, phone or GSTIN"></label>
      <label class="field"><span>Type</span><select class="input" name="type"><option value="">All documents</option><option value="Invoice">Invoices</option><option value="Return">Credit notes</option></select></label>
      <label class="field"><span>Status</span><select class="input" name="status"><option value="">Any status</option><option value="due">Payment due</option><option value="cancelled">Cancelled</option></select></label>
    </form>
    <div class="card"><div class="table-wrap" id="tbl"><div class="loading">Loading…</div></div></div>
    <div class="row-between mt"><span class="muted" id="summary"></span><button type="button" class="btn hidden" id="more">Load more</button></div>
  </div>`);
  const form = el.querySelector('form');
  const more = el.querySelector('#more');

  function draw() {
    const box = el.querySelector('#tbl');
    if (!rows.length) { render(box, html`<div class="empty"><h3>No documents</h3><p>Nothing matches these filters.</p></div>`); return; }
    render(box, html`<table class="table"><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>GST</th>
      <th class="num">Taxable</th><th class="num">Tax</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr class="clickable ${r.status === 'Cancelled' ? 'cancelled' : ''}" data-id="${r.id}">
        <td class="nowrap"><b class="mono">${r.number}</b></td>
        <td class="nowrap">${date(r.date)} <span class="faint small">${r.time.slice(0, 5)}</span></td>
        <td>${r.customer_name}${r.customer_gstin ? html`<div class="faint small mono">${r.customer_gstin}</div>` : ''}</td>
        <td class="nowrap"><span class="badge">${r.gst_section}</span>${r.supply_type === 'INTER' ? html` <span class="badge badge-info">IGST</span>` : ''}</td>
        <td class="num">${money(r.taxable_total)}</td><td class="num">${money(r.tax_total)}</td><td class="num"><b>${money(r.grand_total)}</b></td>
        <td class="keep nowrap">${statusBadge(r)}${r.outstanding > 0 ? html` <span class="faint small">due ${money(r.outstanding)}</span>` : ''}</td></tr>`)}
      </tbody></table>`);
  }

  async function load(append = false) {
    if (!append) { offset = 0; rows = []; }
    const v = Object.fromEntries(new FormData(form));
    try {
      const r = await api.get(`/api/invoices${qs({ ...v, limit: 100, offset })}`);
      rows = rows.concat(r.invoices);
      offset += r.invoices.length;
      draw();
      el.querySelector('#summary').textContent = `${r.count} document${r.count === 1 ? '' : 's'} · net ${money(r.total)} (excluding cancelled)`;
      more.classList.toggle('hidden', rows.length >= r.count);
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  form.addEventListener('input', debounce(() => load(), 250));
  form.addEventListener('submit', (e) => e.preventDefault());
  more.addEventListener('click', () => busy(more, () => load(true)));
  el.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) go(`invoices/${tr.dataset.id}`);
  });
  await load();
}

/* ---------------------------------------------------------------- detail */
async function detail(el, id) {
  const S = app.settings;

  async function load() {
    try {
      draw(await api.get(`/api/invoices/${id}`));
    } catch (e) {
      render(el, html`<div class="page"><a href="#/invoices">← Invoices</a><div class="empty"><h3>Cannot open this document</h3><p>${e.message}</p></div></div>`);
    }
  }

  function draw(d) {
    const inv = d.invoice;
    const lines = d.lines;
    const isRet = inv.doc_type === 'Return';
    const inter = inv.supply_type === 'INTER';
    const sign = isRet ? -1 : 1; // credit notes are stored negative; show them as positive amounts
    const f = (x) => money(sign * x);
    const hasCess = lines.some((l) => l.cess);
    const anyReturned = !isRet && lines.some((l) => l.returned_qty > 0);
    const live = inv.status !== 'Cancelled';
    const canReturn = !isRet && live && inv.return_status !== 'Returned';
    const canPay = !isRet && live && inv.outstanding > 0;
    const canCancel = isAdmin() && !isRet && live && !d.returns.some((r) => r.status !== 'Cancelled');
    const sl = sgstLabel(S.state_code);

    render(el, html`<div class="page">
      <div class="page-head">
        <div><a href="#/invoices" class="small">← Invoices</a>
          <h1 class="mono mt">${inv.number}</h1>
          <div class="row mt"><span class="badge badge-info">${docTitle(inv, lines)}</span>${statusBadge(inv)}</div></div>
        <div class="row">
          <button type="button" class="btn" data-print="thermal">${icon('printer')} Receipt</button>
          <button type="button" class="btn" data-print="a4">${icon('printer')} A4 ${isRet ? 'credit note' : 'invoice'}</button>
          ${canPay ? html`<button type="button" class="btn" data-act="pay">${icon('rupee')} Receive payment</button>` : ''}
          ${canReturn ? html`<button type="button" class="btn" data-act="return">${icon('undo')} Return items</button>` : ''}
          ${canCancel ? html`<button type="button" class="btn btn-danger" data-act="cancel">Cancel invoice</button>` : ''}
        </div>
      </div>

      <div class="card card-pad"><div class="kv">
        <div><span>Date</span><b>${date(inv.date)} ${inv.time.slice(0, 5)}</b></div>
        <div><span>Customer</span><b>${inv.customer_name}</b>${inv.customer_phone ? html`<div class="faint small">${inv.customer_phone}</div>` : ''}</div>
        <div><span>Customer GSTIN</span><b class="mono">${inv.customer_gstin || 'Unregistered'}</b></div>
        <div><span>Place of supply</span><b>${stateLabel(inv.place_of_supply)}</b></div>
        <div><span>Tax type</span><b>${inter ? 'Inter-state · IGST' : `Intra-state · CGST + ${sl}`}</b></div>
        <div><span>GSTR-1</span><b>${SECTION_LABEL[inv.gst_section] || inv.gst_section}</b></div>
        <div><span>Cashier</span><b>${d.cashier ? d.cashier.full_name || d.cashier.username : '—'}</b></div>
        ${d.return_against ? html`<div><span>Against invoice</span><b><a href="#/invoices/${d.return_against.id}" class="mono">${d.return_against.number}</a></b></div>` : ''}
        ${inv.notes ? html`<div><span>Notes</span><b>${inv.notes}</b></div>` : ''}
      </div></div>

      <div class="card mt"><div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Item</th><th>HSN/SAC</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Discount</th>
          <th class="num">Taxable</th><th class="num">GST %</th>${inter ? html`<th class="num">IGST</th>` : html`<th class="num">CGST</th><th class="num">${sl}</th>`}
          ${hasCess ? html`<th class="num">Cess</th>` : ''}<th class="num">Total</th>${anyReturned ? html`<th class="num">Returned</th>` : ''}</tr></thead>
        <tbody>${lines.map((l) => html`<tr>
          <td>${l.idx}</td><td><b>${l.item_name}</b><div class="faint small">${l.item_code}</div></td><td class="mono">${l.hsn || '—'}</td>
          <td class="num">${qty(sign * l.qty)} ${l.uom}</td><td class="num">${money(l.rate)}</td>
          <td class="num">${l.discount_amount ? f(l.discount_amount) : '—'}</td><td class="num">${f(l.taxable_value)}</td>
          <td class="num">${l.gst_treatment === 'Taxable' ? `${fmtRate(l.gst_rate)}%` : l.gst_treatment}</td>
          ${inter ? html`<td class="num">${f(l.igst)}</td>` : html`<td class="num">${f(l.cgst)}</td><td class="num">${f(l.sgst)}</td>`}
          ${hasCess ? html`<td class="num">${f(l.cess)}</td>` : ''}<td class="num"><b>${f(l.total)}</b></td>
          ${anyReturned ? html`<td class="num">${l.returned_qty ? qty(l.returned_qty) : ''}</td>` : ''}</tr>`)}</tbody>
      </table></div></div>

      <div class="grid-2 mt">
        <div class="card card-pad stack">
          <h2>${isRet ? 'Refund' : 'Payments'}</h2>
          ${d.payments.length ? html`<table class="table"><thead><tr><th>Mode</th><th>Date</th><th>Reference</th><th class="num">Amount</th></tr></thead><tbody>
            ${d.payments.map((p) => html`<tr><td>${p.mode}</td><td class="nowrap">${date(p.date)}</td><td class="mono small">${p.reference || ''}</td><td class="num">${money(sign * p.amount)}</td></tr>`)}</tbody></table>`
            : html`<p class="muted">${isRet ? 'Adjusted against the amount due on the invoice (no cash refund).' : 'No payment received.'}</p>`}
          ${!isRet && inv.change_amount > 0 ? html`<p class="muted small">Tendered ${money(inv.tendered_total)} · change returned ${money(inv.change_amount)}</p>` : ''}
          ${inv.outstanding > 0 && live ? html`<div class="notice notice-warn">Balance due: <b>${money(inv.outstanding)}</b></div>` : ''}
          ${d.returns.length ? html`<h3 class="mt">Credit notes against this invoice</h3><ul>${d.returns.map((r) => html`<li><a class="mono" href="#/invoices/${r.id}">${r.number}</a> · ${date(r.date)} · ${money(-r.grand_total)}${r.status === 'Cancelled' ? ' (cancelled)' : ''}</li>`)}</ul>` : ''}
        </div>
        <div class="card card-pad"><div class="totals-box">
          <div class="tot-row"><span>Gross amount</span><span>${f(inv.gross_total)}</span></div>
          ${inv.discount_total ? html`<div class="tot-row"><span>Discount</span><span>−${f(inv.discount_total)}</span></div>` : ''}
          <div class="tot-row"><span>Taxable value</span><span>${f(inv.taxable_total)}</span></div>
          ${inter ? html`<div class="tot-row"><span>IGST</span><span>${f(inv.igst_total)}</span></div>`
            : html`<div class="tot-row"><span>CGST</span><span>${f(inv.cgst_total)}</span></div><div class="tot-row"><span>${sl}</span><span>${f(inv.sgst_total)}</span></div>`}
          ${inv.cess_total ? html`<div class="tot-row"><span>Cess</span><span>${f(inv.cess_total)}</span></div>` : ''}
          ${inv.round_off ? html`<div class="tot-row"><span>Round off</span><span>${f(inv.round_off)}</span></div>` : ''}
          <div class="tot-row grand"><span>${isRet ? 'Credit note value' : 'Invoice total'}</span><span>${f(inv.grand_total)}</span></div>
        </div></div>
      </div>
    </div>`);

    el.querySelectorAll('[data-print]').forEach((b) => b.addEventListener('click', () => printDoc(`inv=${inv.id}&f=${b.dataset.print}`)));
    el.querySelector('[data-act=pay]')?.addEventListener('click', () => payDialog(inv));
    el.querySelector('[data-act=return]')?.addEventListener('click', () => returnDialog(d));
    el.querySelector('[data-act=cancel]')?.addEventListener('click', () => cancelDialog(inv));
  }

  function payDialog(inv) {
    const m = openModal({
      title: `Receive payment · ${inv.number}`,
      content: html`<form class="stack">
        <div class="notice">Balance due: <b>${money(inv.outstanding)}</b> from ${inv.customer_name}</div>
        <div class="form-grid">
          <label class="field"><span>Mode</span><select class="input" name="mode">${options(S.payment_modes, 'Cash')}</select></label>
          <label class="field"><span>Amount (₹)</span><input class="input" type="number" name="amount" min="0.01" max="${inv.outstanding}" step="0.01" value="${inv.outstanding}" autofocus></label>
          <label class="field span-2"><span>Reference (optional)</span><input class="input" name="reference" maxlength="60"></label>
        </div>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Record payment</button></div></form>`,
    });
    const form = m.body.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('.btn-primary'), async () => {
        const res = await api.post(`/api/invoices/${inv.id}/payment`, Object.fromEntries(new FormData(form)));
        m.close();
        toast('Payment recorded', 'success');
        draw(res);
      });
    });
  }

  function returnDialog(d) {
    const inv = d.invoice;
    const lines = d.lines.map((l) => ({ ...l, remaining: round(l.qty - l.returned_qty, 3) })).filter((l) => l.remaining > 0);
    const m = openModal({
      title: `Return items · ${inv.number}`,
      wide: true,
      dismissable: false,
      content: html`<form class="stack" novalidate>
        <p class="muted small">Creates a GST credit note. Stock is added back and the refund is paid from your current shift.</p>
        <div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th class="num">Sold</th><th class="num">Already returned</th><th class="num">Line total</th><th class="num" style="width:130px">Return qty</th></tr></thead><tbody>
          ${lines.map((l) => html`<tr><td><b>${l.item_name}</b><div class="faint small">${money(l.rate)} · ${l.gst_treatment === 'Taxable' ? `GST ${fmtRate(l.gst_rate)}%` : l.gst_treatment}</div></td>
            <td class="num">${qty(l.qty)}</td><td class="num">${qty(l.returned_qty)}</td><td class="num">${money(l.total)}</td>
            <td class="num"><input class="input" type="number" min="0" max="${l.remaining}" step="any" value="0" data-line="${l.id}" aria-label="Return quantity for ${l.item_name}"></td></tr>`)}
        </tbody></table></div>
        <div class="row"><button type="button" class="btn btn-sm" data-all>Return everything remaining</button></div>
        <div class="form-grid">
          <label class="field"><span>Refund by</span><select class="input" name="refund_mode">${options(S.payment_modes, 'Cash')}</select></label>
          <label class="field"><span>Reason</span><input class="input" name="reason" maxlength="200" placeholder="e.g. damaged, wrong size"></label>
        </div>
        ${inv.outstanding > 0 ? html`<div class="notice notice-warn">${money(inv.outstanding)} is still due on this invoice. The return value is adjusted against it first; only the rest is refunded.</div>` : ''}
        <div class="pay-status" data-preview>Select the quantities to return</div>
        <div class="modal-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary" disabled>Create credit note</button></div>
      </form>`,
    });
    const form = m.body.querySelector('form');
    const submit = form.querySelector('.btn-primary');
    const preview = () => {
      let value = 0;
      let n = 0;
      for (const inp of form.querySelectorAll('[data-line]')) {
        const l = lines.find((x) => x.id === Number(inp.dataset.line));
        const q = Math.min(l.remaining, Math.max(0, Number(inp.value) || 0));
        if (q > 0) { n++; value += (l.total * q) / l.qty; }
      }
      value = S.round_off ? Math.round(r2(value)) : r2(value);
      const box = form.querySelector('[data-preview]');
      submit.disabled = !n;
      box.className = `pay-status ${n ? 'good' : ''}`;
      render(box, n ? html`<span>Credit note value (approx.)</span><span>${money(value)}</span>` : html`<span>Select the quantities to return</span>`);
    };
    form.addEventListener('input', preview);
    form.querySelector('[data-all]').addEventListener('click', () => {
      for (const inp of form.querySelectorAll('[data-line]')) inp.value = inp.max;
      preview();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const payload = {
        lines: [...form.querySelectorAll('[data-line]')].map((i) => ({ line_id: Number(i.dataset.line), qty: Number(i.value) || 0 })).filter((x) => x.qty > 0),
        refund_mode: form.elements.refund_mode.value,
        reason: form.elements.reason.value,
      };
      busy(submit, async () => {
        const res = await api.post(`/api/invoices/${inv.id}/return`, payload);
        m.close();
        toast(`Credit note ${res.invoice.number} created${res.refund ? ` · refund ${money(res.refund)} by ${payload.refund_mode}` : ''}`, 'success', 6000);
        go(`invoices/${res.invoice.id}`);
      });
    });
  }

  function cancelDialog(inv) {
    const m = openModal({
      title: `Cancel ${inv.number}?`,
      content: html`<form class="stack">
        <div class="notice notice-warn">Cancel only if this invoice has <b>not</b> been reported in a filed GSTR-1. After filing, create a return (credit note) instead. Stock will be added back and the invoice will show as cancelled in the documents-issued summary.</div>
        <label class="field"><span>Reason</span><input class="input" name="reason" maxlength="120" required autofocus></label>
        <div class="modal-actions"><button type="button" class="btn" data-close>Keep invoice</button><button class="btn btn-danger">Cancel invoice</button></div></form>`,
    });
    const form = m.body.querySelector('form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('.btn-danger'), async () => {
        const res = await api.post(`/api/invoices/${inv.id}/cancel`, { reason: form.elements.reason.value });
        m.close();
        toast('Invoice cancelled');
        draw(res);
      });
    });
  }

  await load();
}
