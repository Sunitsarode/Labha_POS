// Printable documents: 80 mm thermal receipt, A4 GST tax invoice / credit note, shift (X/Z) report.
// URL: /print#inv=<id>&f=thermal|a4[&auto=1]   or   /print#session=<id>[&auto=1]
import {
  amountInWords, docTitle, fmtAmount, fmtDate, fmtQty, fmtRate, hsnSummary, sgstLabel, stateLabel, taxBreakup, upiLink,
} from './gst.js';
import { qrSvg } from './qr.js';
import { html, raw, render } from './ui.js';

const params = new URLSearchParams(location.hash.slice(1));
const docEl = document.getElementById('doc');

async function get(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Error ${r.status}`);
  return d;
}

function setPage(format) {
  const style = document.createElement('style');
  style.textContent = format === 'a4' ? '@page { size: A4; margin: 10mm; }' : '@page { size: 80mm auto; margin: 2mm 3mm; }';
  document.head.append(style);
  document.body.classList.add(format === 'a4' ? 'is-a4' : 'is-thermal');
}

const addressLines = (S) => [S.address, [S.city, S.pincode].filter(Boolean).join(' - ')].filter(Boolean).join('\n');
const COMPOSITION_NOTE = 'Composition taxable person, not eligible to collect tax on supplies';

/** Credit notes are stored as negative amounts; print them as positive figures under a "Credit Note" title. */
function signed(d) {
  const sign = d.invoice.doc_type === 'Return' ? -1 : 1;
  const keys = ['qty', 'gross', 'discount_amount', 'taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'total'];
  return { sign, lines: d.lines.map((l) => ({ ...l, ...Object.fromEntries(keys.map((k) => [k, sign * l[k]])) })) };
}

function upiBlock(S, inv, size) {
  if (!S.upi_id || !(inv.outstanding > 0) || inv.status === 'Cancelled') return '';
  const link = upiLink({ vpa: S.upi_id, name: S.company_name, amount: inv.outstanding, note: inv.number });
  return html`<div class="upi">${raw(qrSvg(link, { size, label: 'UPI payment QR' }))}<div><b>Scan to pay ₹${fmtAmount(inv.outstanding)}</b><br>UPI: ${S.upi_id}</div></div>`;
}

/* ------------------------------------------------------- thermal receipt */
function renderThermal(S, d) {
  const inv = d.invoice;
  const { sign, lines } = signed(d);
  const f = (x) => fmtAmount(sign * x);
  const inter = inv.supply_type === 'INTER';
  const sl = sgstLabel(S.state_code);
  const title = docTitle(inv, d.lines);
  const rates = taxBreakup(lines).filter((r) => r.gst_rate > 0 || r.cess_rate > 0);
  const isRet = inv.doc_type === 'Return';
  render(docEl, html`<div class="receipt">
    <div class="c">
      <div class="shop">${S.company_name}</div>
      ${S.legal_name && S.legal_name !== S.company_name ? html`<div>${S.legal_name}</div>` : ''}
      <div class="pre">${addressLines(S)}</div>
      ${S.phone ? html`<div>Ph: ${S.phone}</div>` : ''}
      ${S.gstin ? html`<div>GSTIN: <b>${S.gstin}</b></div>` : ''}
    </div>
    <div class="doc-title">${title}</div>
    ${inv.tax_regime === 'Composition' ? html`<div class="c small">${COMPOSITION_NOTE}</div>` : ''}
    ${inv.status === 'Cancelled' ? html`<div class="stamp">CANCELLED</div>` : ''}
    <table class="kv">
      <tr><td>${isRet ? 'Note no.' : 'Bill no.'}</td><td>${inv.number}</td></tr>
      <tr><td>Date</td><td>${fmtDate(inv.date)} ${inv.time.slice(0, 5)}</td></tr>
      ${d.return_against ? html`<tr><td>Against</td><td>${d.return_against.number} dt. ${fmtDate(d.return_against.date)}</td></tr>` : ''}
      <tr><td>Customer</td><td>${inv.customer_name}</td></tr>
      ${inv.customer_gstin ? html`<tr><td>GSTIN</td><td>${inv.customer_gstin}</td></tr>` : ''}
      ${inv.customer_phone ? html`<tr><td>Phone</td><td>${inv.customer_phone}</td></tr>` : ''}
      <tr><td>Place of supply</td><td>${stateLabel(inv.place_of_supply)}</td></tr>
    </table>
    <table class="lines">
      <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>${lines.map((l) => html`
        <tr class="nm"><td colspan="4">${l.item_name}</td></tr>
        <tr class="dt"><td>${[l.hsn && `HSN ${l.hsn}`, l.gst_treatment === 'Taxable' ? `GST ${fmtRate(l.gst_rate)}%` : l.gst_treatment].filter(Boolean).join(' · ')}</td>
          <td class="r">${fmtQty(l.qty)}</td><td class="r">${fmtAmount(l.rate)}</td><td class="r">${fmtAmount(l.gross)}</td></tr>
        ${l.discount_amount ? html`<tr class="dt"><td colspan="3">Discount${l.discount_pct ? ` ${fmtRate(l.discount_pct)}%` : ''}</td><td class="r">-${fmtAmount(l.discount_amount)}</td></tr>` : ''}`)}
      </tbody>
    </table>
    <table class="tot">
      <tr><td>Lines / qty</td><td class="r">${lines.length} / ${fmtQty(sign * inv.total_qty)}</td></tr>
      ${inv.discount_total ? html`<tr><td>Total discount</td><td class="r">-${f(inv.discount_total)}</td></tr>` : ''}
      <tr><td>Taxable value</td><td class="r">${f(inv.taxable_total)}</td></tr>
      ${inter ? html`<tr><td>IGST</td><td class="r">${f(inv.igst_total)}</td></tr>`
        : html`<tr><td>CGST</td><td class="r">${f(inv.cgst_total)}</td></tr><tr><td>${sl}</td><td class="r">${f(inv.sgst_total)}</td></tr>`}
      ${inv.cess_total ? html`<tr><td>Cess</td><td class="r">${f(inv.cess_total)}</td></tr>` : ''}
      ${inv.round_off ? html`<tr><td>Round off</td><td class="r">${f(inv.round_off)}</td></tr>` : ''}
      <tr class="grand"><td>${isRet ? 'CREDIT TOTAL' : 'TOTAL'}</td><td class="r">₹${f(inv.grand_total)}</td></tr>
    </table>
    ${d.payments.length ? html`<table class="tot pay">${d.payments.map((p) => html`<tr><td>${isRet ? 'Refund' : 'Paid'} (${p.mode})</td><td class="r">${fmtAmount(sign * p.amount)}</td></tr>`)}
      ${inv.change_amount > 0 ? html`<tr><td>Tendered</td><td class="r">${fmtAmount(inv.tendered_total)}</td></tr><tr><td>Change returned</td><td class="r">${fmtAmount(inv.change_amount)}</td></tr>` : ''}</table>` : ''}
    ${inv.outstanding > 0 && inv.status !== 'Cancelled' ? html`<div class="due">Balance due: ₹${fmtAmount(inv.outstanding)}</div>` : ''}
    ${rates.length ? html`<table class="gst"><thead><tr><th>GST%</th><th class="r">Taxable</th>${inter ? html`<th class="r">IGST</th>` : html`<th class="r">CGST</th><th class="r">${sl}</th>`}</tr></thead>
      <tbody>${rates.map((r) => html`<tr><td>${fmtRate(r.gst_rate)}%</td><td class="r">${fmtAmount(r.taxable_value)}</td>${inter ? html`<td class="r">${fmtAmount(r.igst)}</td>` : html`<td class="r">${fmtAmount(r.cgst)}</td><td class="r">${fmtAmount(r.sgst)}</td>`}</tr>`)}</tbody></table>` : ''}
    <p class="words">${amountInWords(sign * inv.grand_total)}</p>
    ${inv.prices_include_tax && inv.tax_total ? html`<p class="c small">Prices are inclusive of GST</p>` : ''}
    ${upiBlock(S, inv, 120)}
    ${isRet && inv.notes ? html`<p class="small">Reason: ${inv.notes}</p>` : ''}
    ${S.receipt_footer ? html`<p class="c foot pre">${S.receipt_footer}</p>` : ''}
  </div>`);
}

/* ---------------------------------------------------- A4 tax invoice */
function renderA4(S, d) {
  const inv = d.invoice;
  const { sign, lines } = signed(d);
  const f = (x) => fmtAmount(sign * x);
  const inter = inv.supply_type === 'INTER';
  const sl = sgstLabel(S.state_code);
  const title = docTitle(inv, d.lines);
  const isRet = inv.doc_type === 'Return';
  const hasCess = lines.some((l) => l.cess);
  const hsn = hsnSummary(lines).filter((h) => h.taxable_value || h.cgst || h.igst);
  const half = (r) => fmtRate(r / 2);
  render(docEl, html`<div class="a4">
    <header class="a4-head">
      <div>
        <div class="shop">${S.company_name}</div>
        ${S.legal_name && S.legal_name !== S.company_name ? html`<div>${S.legal_name}</div>` : ''}
        <div class="pre">${addressLines(S)}</div>
        <div>${[S.phone && `Ph: ${S.phone}`, S.email].filter(Boolean).join(' · ')}</div>
        ${S.gstin ? html`<div>GSTIN: <b>${S.gstin}</b> · PAN: ${S.gstin.slice(2, 12)}</div>` : ''}
        <div>State: ${stateLabel(S.state_code)}</div>
      </div>
      <div class="r">
        <div class="doc-title">${title.toUpperCase()}</div>
        <div class="small">Original for recipient</div>
        ${inv.tax_regime === 'Composition' ? html`<div class="small">${COMPOSITION_NOTE}</div>` : ''}
        ${inv.status === 'Cancelled' ? html`<div class="stamp">CANCELLED</div>` : ''}
      </div>
    </header>
    <section class="meta">
      <div class="box">
        <div class="lbl">${isRet ? 'Credit note issued to' : 'Billed to'}</div>
        <b>${inv.customer_name}</b>
        ${inv.customer_address ? html`<div class="pre">${inv.customer_address}</div>` : ''}
        ${inv.customer_phone ? html`<div>Ph: ${inv.customer_phone}</div>` : ''}
        <div>${inv.customer_gstin ? html`GSTIN: <b>${inv.customer_gstin}</b>` : 'Unregistered'}</div>
        ${inv.customer_state ? html`<div>State: ${stateLabel(inv.customer_state)}</div>` : ''}
      </div>
      <div class="box"><table class="kv">
        <tr><td>${isRet ? 'Credit note no.' : 'Invoice no.'}</td><td><b>${inv.number}</b></td></tr>
        <tr><td>Date</td><td>${fmtDate(inv.date)}</td></tr>
        ${d.return_against ? html`<tr><td>Original invoice</td><td>${d.return_against.number} dt. ${fmtDate(d.return_against.date)}</td></tr>` : ''}
        <tr><td>Place of supply</td><td>${stateLabel(inv.place_of_supply)}</td></tr>
        <tr><td>Reverse charge</td><td>${inv.reverse_charge ? 'Yes' : 'No'}</td></tr>
        ${isRet && inv.notes ? html`<tr><td>Reason</td><td>${inv.notes}</td></tr>` : ''}
      </table></div>
    </section>
    <table class="items">
      <thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Discount</th><th class="r">Taxable value</th>
        ${inter ? html`<th class="r">IGST</th>` : html`<th class="r">CGST</th><th class="r">${sl}</th>`}${hasCess ? html`<th class="r">Cess</th>` : ''}<th class="r">Amount</th></tr></thead>
      <tbody>${lines.map((l) => {
        const taxed = l.gst_treatment === 'Taxable';
        return html`<tr><td>${l.idx}</td><td>${l.item_name}${taxed ? '' : html`<div class="small">${l.gst_treatment}</div>`}</td><td>${l.hsn}</td>
          <td class="r">${fmtQty(l.qty)} ${l.uom}</td><td class="r">${fmtAmount(l.rate)}</td><td class="r">${l.discount_amount ? fmtAmount(l.discount_amount) : ''}</td>
          <td class="r">${fmtAmount(l.taxable_value)}</td>
          ${inter ? html`<td class="r">${fmtAmount(l.igst)}<div class="small">@${fmtRate(l.gst_rate)}%</div></td>`
            : html`<td class="r">${fmtAmount(l.cgst)}<div class="small">@${half(l.gst_rate)}%</div></td><td class="r">${fmtAmount(l.sgst)}<div class="small">@${half(l.gst_rate)}%</div></td>`}
          ${hasCess ? html`<td class="r">${fmtAmount(l.cess)}</td>` : ''}<td class="r">${fmtAmount(l.total)}</td></tr>`;
      })}</tbody>
    </table>
    <section class="bottom">
      <div>
        <div class="lbl">Amount in words</div><div class="words">${amountInWords(sign * inv.grand_total)}</div>
        ${hsn.length ? html`<table class="hsn"><thead><tr><th>HSN/SAC</th><th class="r">Taxable</th>${inter ? html`<th class="r">IGST</th>` : html`<th class="r">CGST</th><th class="r">${sl}</th>`}<th class="r">Total tax</th></tr></thead>
          <tbody>${hsn.map((h) => html`<tr><td>${h.hsn || '—'} <span class="small">@${fmtRate(h.gst_rate)}%</span></td><td class="r">${fmtAmount(h.taxable_value)}</td>
            ${inter ? html`<td class="r">${fmtAmount(h.igst)}</td>` : html`<td class="r">${fmtAmount(h.cgst)}</td><td class="r">${fmtAmount(h.sgst)}</td>`}
            <td class="r">${fmtAmount(h.cgst + h.sgst + h.igst + h.cess)}</td></tr>`)}</tbody></table>` : ''}
        ${S.bank_details ? html`<div class="lbl">Bank details</div><div class="pre">${S.bank_details}</div>` : ''}
        ${upiBlock(S, inv, 110)}
        ${S.terms ? html`<div class="lbl">Terms &amp; conditions</div><div class="pre small">${S.terms}</div>` : ''}
      </div>
      <div>
        <table class="tot">
          <tr><td>Taxable value</td><td class="r">${f(inv.taxable_total)}</td></tr>
          ${inter ? html`<tr><td>IGST</td><td class="r">${f(inv.igst_total)}</td></tr>`
            : html`<tr><td>CGST</td><td class="r">${f(inv.cgst_total)}</td></tr><tr><td>${sl}</td><td class="r">${f(inv.sgst_total)}</td></tr>`}
          ${inv.cess_total ? html`<tr><td>Cess</td><td class="r">${f(inv.cess_total)}</td></tr>` : ''}
          ${inv.round_off ? html`<tr><td>Round off</td><td class="r">${f(inv.round_off)}</td></tr>` : ''}
          <tr class="grand"><td>${isRet ? 'Credit note total' : 'Invoice total'}</td><td class="r">₹${f(inv.grand_total)}</td></tr>
          ${!isRet ? html`<tr><td>Received</td><td class="r">${fmtAmount(inv.paid_total)}</td></tr>` : ''}
          ${inv.outstanding > 0 && inv.status !== 'Cancelled' ? html`<tr><td><b>Balance due</b></td><td class="r"><b>${fmtAmount(inv.outstanding)}</b></td></tr>` : ''}
        </table>
        <div class="sign">For ${S.company_name}<div class="space"></div>Authorised signatory</div>
      </div>
    </section>
    <footer class="c small">This is a computer-generated ${title.toLowerCase()}.</footer>
  </div>`);
}

/* ------------------------------------------------------ shift report */
function renderShift(S, d) {
  const s = d.session;
  const sum = d.summary;
  const c = s.closing;
  const modes = [...new Set([...Object.keys(sum.expected), ...Object.keys(c?.counted || {})])];
  render(docEl, html`<div class="receipt">
    <div class="c"><div class="shop">${S.company_name}</div>${S.gstin ? html`<div>GSTIN: ${S.gstin}</div>` : ''}</div>
    <div class="doc-title">${s.status === 'Closed' ? 'Shift closing (Z) report' : 'Shift (X) report'}</div>
    <table class="kv">
      <tr><td>Shift</td><td>#${s.id}</td></tr>
      <tr><td>Cashier</td><td>${s.full_name || s.username}</td></tr>
      <tr><td>Opened</td><td>${s.opened_at}</td></tr>
      ${s.closed_at ? html`<tr><td>Closed</td><td>${s.closed_at}</td></tr>` : ''}
    </table>
    <table class="tot">
      <tr><td>Sales (${sum.sales.count})</td><td class="r">${fmtAmount(sum.sales.total)}</td></tr>
      <tr><td>Returns (${sum.returns.count})</td><td class="r">${fmtAmount(sum.returns.total)}</td></tr>
      <tr class="grand"><td>Net sales</td><td class="r">₹${fmtAmount(sum.sales.total + sum.returns.total)}</td></tr>
      <tr><td>Taxable value</td><td class="r">${fmtAmount(sum.sales.taxable + sum.returns.taxable)}</td></tr>
      <tr><td>GST</td><td class="r">${fmtAmount(sum.sales.tax + sum.returns.tax)}</td></tr>
      <tr><td>Discounts given</td><td class="r">${fmtAmount(sum.sales.discount)}</td></tr>
      <tr><td>Credit sales (due)</td><td class="r">${fmtAmount(sum.sales.credit)}</td></tr>
      <tr><td>Cancelled (${sum.cancelled.count})</td><td class="r">${fmtAmount(sum.cancelled.total)}</td></tr>
      <tr><td>Opening cash</td><td class="r">${fmtAmount(s.opening_cash)}</td></tr>
    </table>
    <table class="gst"><thead><tr><th>Mode</th><th class="r">Expected</th>${c ? html`<th class="r">Counted</th><th class="r">Diff.</th>` : ''}</tr></thead>
      <tbody>${modes.map((m) => html`<tr><td>${m}</td><td class="r">${fmtAmount(c?.expected?.[m] ?? sum.expected[m] ?? 0)}</td>
        ${c ? html`<td class="r">${fmtAmount(c.counted[m] ?? 0)}</td><td class="r">${fmtAmount(c.difference[m] ?? 0)}</td>` : ''}</tr>`)}</tbody></table>
    <p class="c small">Printed ${new Date().toLocaleString('en-IN')}</p>
  </div>`);
}

async function main() {
  try {
    const boot = await get('/api/bootstrap');
    if (!boot.user) throw new Error('Please sign in to print documents.');
    const S = boot.settings;
    if (params.get('session')) {
      const d = await get(`/api/sessions/${Number(params.get('session'))}`);
      setPage('thermal');
      renderShift(S, d);
      document.title = `Shift ${d.session.id}`;
    } else {
      const d = await get(`/api/invoices/${Number(params.get('inv'))}`);
      const format = params.get('f') === 'a4' ? 'a4' : 'thermal';
      setPage(format);
      (format === 'a4' ? renderA4 : renderThermal)(S, d);
      document.title = d.invoice.number.replace(/\//g, '-');
    }
    document.getElementById('print-btn').addEventListener('click', () => window.print());
    document.getElementById('print-hint').textContent = 'Use your browser print dialog; choose the 80 mm printer for receipts.';
    if (params.get('auto') === '1') setTimeout(() => window.print(), 200);
  } catch (e) {
    render(docEl, html`<p class="error">${e.message}</p>`);
  }
}

main();
