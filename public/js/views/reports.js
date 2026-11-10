// GST returns & sales reports. CSV exports follow the GST Offline Tool sheet layouts.
import { api, qs } from '../api.js';
import { app, go } from '../app.js';
import { fmtDate, fmtRate, sgstLabel, stateLabel, UQC } from '../gst.js';
import { amount, date, download, html, icon, money, monthISO, qty, render, toCSV } from '../ui.js';

const TABS = [['gstr1', 'GSTR-1'], ['gstr3b', 'GSTR-3B summary'], ['register', 'Sales register'], ['items', 'Item-wise sales']];
const UQC_NAME = new Map(UQC.map(([c, n]) => [c, n.toUpperCase()]));
const uqcLabel = (c) => (c === 'NA' ? 'NA' : `${c}-${UQC_NAME.get(c) || 'OTHERS'}`);

function monthRange(m) {
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { from: `${m}-01`, to: `${m}-${String(last).padStart(2, '0')}` };
}

export async function mount(el) {
  const S = app.settings;
  const sl = sgstLabel(S.state_code);
  let tab = 'gstr1';
  const init = monthRange(monthISO());

  render(el, html`<div class="page">
    <div class="page-head"><h1>GST &amp; reports</h1></div>
    <div class="tabs" role="tablist">${TABS.map(([k, l]) => html`<button type="button" class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${l}</button>`)}</div>
    <form class="filters mt" id="pf">
      <label class="field"><span>Return period (month)</span><input class="input" type="month" name="month" value="${monthISO()}"></label>
      <label class="field"><span>From</span><input class="input" type="date" name="from" value="${init.from}"></label>
      <label class="field"><span>To</span><input class="input" type="date" name="to" value="${init.to}"></label>
      <button class="btn btn-primary">Show</button>
    </form>
    <div id="out"><div class="loading">Loading…</div></div>
  </div>`);
  const pf = el.querySelector('#pf');
  const out = el.querySelector('#out');
  pf.elements.month.addEventListener('change', () => {
    if (!pf.elements.month.value) return;
    const r = monthRange(pf.elements.month.value);
    pf.elements.from.value = r.from;
    pf.elements.to.value = r.to;
    load();
  });
  pf.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  el.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    for (const t of el.querySelectorAll('[data-tab]')) t.classList.toggle('active', t === b);
    load();
  });

  const period = () => ({ from: pf.elements.from.value, to: pf.elements.to.value });
  const tag = () => `${period().from}_to_${period().to}`;
  let csvs = {};
  out.addEventListener('click', (e) => {
    const b = e.target.closest('[data-csv]');
    if (b && csvs[b.dataset.csv]) download(...csvs[b.dataset.csv]());
    const inv = e.target.closest('[data-inv]');
    if (inv) go(`invoices/${inv.dataset.inv}`);
  });

  async function load() {
    render(out, html`<div class="loading">Loading…</div>`);
    csvs = {};
    try {
      if (tab === 'gstr1') drawGstr1(await api.get(`/api/reports/gstr1${qs(period())}`));
      else if (tab === 'gstr3b') drawGstr3b(await api.get(`/api/reports/gstr3b${qs(period())}`));
      else if (tab === 'register') drawRegister(await api.get(`/api/reports/sales-register${qs(period())}`));
      else drawItems(await api.get(`/api/reports/item-sales${qs(period())}`));
    } catch (e) {
      render(out, html`<div class="empty"><h3>Could not load the report</h3><p>${e.message}</p></div>`);
    }
  }

  const csvBtn = (key) => html`<button type="button" class="btn btn-sm" data-csv="${key}">${icon('download')} CSV</button>`;
  const section = (title, key, count, table, note = '') => html`<div class="card mt">
    <div class="card-head"><div><h2>${title} <span class="faint small">· ${count}</span></h2>${note ? html`<div class="faint small">${note}</div>` : ''}</div>${count ? csvBtn(key) : ''}</div>
    ${count ? html`<div class="table-wrap">${table}</div>` : html`<div class="card-body faint">Nothing to report.</div>`}</div>`;

  /* ---------------------------------------------------------- GSTR-1 */
  function drawGstr1(g) {
    if (S.registration_type !== 'Regular') {
      render(out, html`<div class="notice notice-warn mt">GSTR-1 is filed by regular taxpayers only. Your business is set up as <b>${S.registration_type}</b>; see the GSTR-3B summary tab for the composition (CMP-08) figures.</div>`);
      return;
    }
    const rowsOf = (docs) => docs.flatMap((d) => d.rows.map((r) => ({ ...d, ...r })));
    const b2b = rowsOf(g.b2b);
    const b2cl = rowsOf(g.b2cl);
    const cdnr = rowsOf(g.cdnr);
    const cdnur = rowsOf(g.cdnur);
    const n = (x) => Number(x.toFixed(2));
    const dt = (d) => fmtDate(d);
    const sum = g.summary;
    const sumRow = (label, s) => html`<tr><td>${label}</td><td class="num">${s.count}</td><td class="num">${amount(s.txval)}</td><td class="num">${amount(s.iamt)}</td><td class="num">${amount(s.camt)}</td><td class="num">${amount(s.samt)}</td><td class="num">${amount(s.csamt)}</td></tr>`;
    const taxCells = (r) => html`<td class="num">${amount(r.txval)}</td><td class="num">${amount(r.iamt)}</td><td class="num">${amount(r.camt)}</td><td class="num">${amount(r.samt)}</td><td class="num">${amount(r.csamt)}</td>`;
    const taxHead = html`<th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">${sl}</th><th class="num">Cess</th>`;

    csvs = {
      b2b: () => [`b2b_${tag()}.csv`, toCSV(['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount'],
        b2b.map((r) => [r.ctin, r.name, r.number, dt(r.date), n(r.val), stateLabel(r.pos), r.rchrg, '', 'Regular B2B', '', r.rt, n(r.txval), n(r.csamt)]))],
      b2cl: () => [`b2cl_${tag()}.csv`, toCSV(['Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
        b2cl.map((r) => [r.number, dt(r.date), n(r.val), stateLabel(r.pos), '', r.rt, n(r.txval), n(r.csamt), '']))],
      b2cs: () => [`b2cs_${tag()}.csv`, toCSV(['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'],
        g.b2cs.map((r) => ['OE', stateLabel(r.pos), '', r.rt, n(r.txval), n(r.csamt), '']))],
      cdnr: () => [`cdnr_${tag()}.csv`, toCSV(['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
        cdnr.map((r) => [r.ctin, r.name, r.number, dt(r.date), 'C', stateLabel(r.pos), r.rchrg, 'Regular B2B', n(r.val), '', r.rt, n(r.txval), n(r.csamt)]))],
      cdnur: () => [`cdnur_${tag()}.csv`, toCSV(['UR Type', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'],
        cdnur.map((r) => ['B2CL', r.number, dt(r.date), 'C', stateLabel(r.pos), n(r.val), '', r.rt, n(r.txval), n(r.csamt)]))],
      exemp: () => [`exemp_${tag()}.csv`, toCSV(['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies'],
        g.nil.map((r) => [r.desc, n(r.nil_amt), n(r.expt_amt), n(r.ngsup_amt)]))],
      hsnb2b: () => [`hsn_b2b_${tag()}.csv`, toCSV(HSN_HEAD, g.hsn_b2b.map(hsnRow))],
      hsnb2c: () => [`hsn_b2c_${tag()}.csv`, toCSV(HSN_HEAD, g.hsn_b2c.map(hsnRow))],
      docs: () => [`docs_${tag()}.csv`, toCSV(['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
        g.docs.map((d) => [d.nature, d.from, d.to, d.total, d.cancelled]))],
    };
    const HSN_HEAD = ['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'];
    function hsnRow(h) { return [h.hsn, h.desc, uqcLabel(h.uqc), h.qty, n(h.val), h.rt, n(h.txval), n(h.iamt), n(h.camt), n(h.samt), n(h.csamt)]; }
    const hsnTable = (rows) => html`<table class="table"><thead><tr><th>HSN/SAC</th><th>Description</th><th>UQC</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Total value</th>${taxHead}</tr></thead><tbody>
      ${rows.map((h) => html`<tr><td class="mono">${h.hsn || html`<span class="badge badge-warn">Missing</span>`}</td><td>${h.desc}</td><td>${h.uqc}</td><td class="num">${qty(h.qty)}</td><td class="num">${fmtRate(h.rt)}%</td><td class="num">${amount(h.val)}</td>${taxCells(h)}</tr>`)}</tbody></table>`;
    const docTable = (rows, b2b) => html`<table class="table"><thead><tr>${b2b ? html`<th>GSTIN</th><th>Receiver</th>` : ''}<th>Number</th><th>Date</th><th>Place of supply</th><th class="num">Value</th><th class="num">Rate</th>${taxHead}</tr></thead><tbody>
      ${rows.map((r) => html`<tr class="clickable" data-inv="${r.id}">${b2b ? html`<td class="mono">${r.ctin}</td><td>${r.name}</td>` : ''}<td class="mono nowrap">${r.number}</td><td class="nowrap">${date(r.date)}</td><td>${stateLabel(r.pos)}</td><td class="num">${amount(r.val)}</td><td class="num">${fmtRate(r.rt)}%</td>${taxCells(r)}</tr>`)}</tbody></table>`;

    render(out, html`
      ${g.warnings.map((w) => html`<div class="notice notice-warn mt">${w}</div>`)}
      <div class="card mt"><div class="card-head"><div><h2>GSTR-1 summary</h2><div class="faint small">GSTIN ${g.gstin} · ${date(g.from)} to ${date(g.to)}</div></div>
        <a class="btn btn-sm" href="/api/reports/gstr1${qs({ ...period(), format: 'json' })}" download>${icon('download')} JSON (draft)</a></div>
        <div class="table-wrap"><table class="table"><thead><tr><th>Table</th><th class="num">Records</th>${taxHead}</tr></thead><tbody>
          ${sumRow('4A · B2B invoices', sum.b2b)}${sumRow('5 · B2C large invoices', sum.b2cl)}${sumRow('7 · B2C small (net of credit notes)', sum.b2cs)}
          ${sumRow('9B · Credit notes, registered (CDNR)', sum.cdnr)}${sumRow('9B · Credit notes, unregistered (CDNUR)', sum.cdnur)}
        </tbody></table></div>
        <div class="card-body faint small">Download the CSV of each table to fill the GST Offline Tool, or import the JSON draft into the Offline Tool to validate it before uploading. Always verify figures before filing.</div></div>
      ${section('4A · B2B invoices', 'b2b', g.b2b.length, docTable(b2b, true), 'Invoices to registered buyers (with GSTIN), one row per tax rate')}
      ${section('5 · B2C large', 'b2cl', g.b2cl.length, docTable(b2cl, false), `Inter-state sales to unregistered buyers above ₹${amount(g.b2cl_limit)}`)}
      ${section('7 · B2C small', 'b2cs', g.b2cs.length, html`<table class="table"><thead><tr><th>Supply</th><th>Place of supply</th><th class="num">Rate</th>${taxHead}</tr></thead><tbody>
        ${g.b2cs.map((r) => html`<tr><td>${r.sply_ty === 'INTER' ? 'Inter-state' : 'Intra-state'}</td><td>${stateLabel(r.pos)}</td><td class="num">${fmtRate(r.rt)}%</td>${taxCells(r)}</tr>`)}</tbody></table>`, 'Aggregated by place of supply and rate; credit notes against B2C small invoices are netted here')}
      ${section('9B · Credit notes (registered)', 'cdnr', g.cdnr.length, docTable(cdnr, true))}
      ${section('9B · Credit notes (unregistered, B2CL)', 'cdnur', g.cdnur.length, docTable(cdnur, false))}
      ${section('8 · Nil-rated, exempted and non-GST supplies', 'exemp', g.nil.some((r) => r.nil_amt || r.expt_amt || r.ngsup_amt) ? 4 : 0, html`<table class="table"><thead><tr><th>Description</th><th class="num">Nil-rated</th><th class="num">Exempted</th><th class="num">Non-GST</th></tr></thead><tbody>
        ${g.nil.map((r) => html`<tr><td>${r.desc}</td><td class="num">${amount(r.nil_amt)}</td><td class="num">${amount(r.expt_amt)}</td><td class="num">${amount(r.ngsup_amt)}</td></tr>`)}</tbody></table>`)}
      ${section('12 · HSN summary, B2B', 'hsnb2b', g.hsn_b2b.length, hsnTable(g.hsn_b2b))}
      ${section('12 · HSN summary, B2C', 'hsnb2c', g.hsn_b2c.length, hsnTable(g.hsn_b2c))}
      ${section('13 · Documents issued', 'docs', g.docs.length, html`<table class="table"><thead><tr><th>Nature of document</th><th>From</th><th>To</th><th class="num">Total</th><th class="num">Cancelled</th><th class="num">Net issued</th></tr></thead><tbody>
        ${g.docs.map((d) => html`<tr><td>${d.nature}</td><td class="mono">${d.from}</td><td class="mono">${d.to}</td><td class="num">${d.total}</td><td class="num">${d.cancelled}</td><td class="num">${d.total - d.cancelled}</td></tr>`)}</tbody></table>`)}
    `);
  }

  /* --------------------------------------------------------- GSTR-3B */
  function drawGstr3b(r) {
    if (r.regime !== 'Regular') {
      render(out, html`<div class="card card-pad mt stack"><h2>Composition summary (CMP-08)</h2>
        <div class="kv"><div><span>Turnover</span><b>${money(r.turnover)}</b></div><div><span>Composition rate</span><b>${fmtRate(r.composition_rate)}%</b></div>
          <div><span>CGST payable</span><b>${money(r.cgst)}</b></div><div><span>SGST / UTGST payable</span><b>${money(r.sgst)}</b></div></div>
        <p class="faint small">Turnover is the value of all bills of supply in the period (net of returns). Set the rate under Settings → Business &amp; GST.</p></div>`);
      return;
    }
    const a = r.outward_taxable;
    csvs.g3b = () => [`gstr3b_3.2_${tag()}.csv`, toCSV(['Place of Supply', 'Taxable Value', 'Integrated Tax'], r.inter_state_unregistered.map((x) => [x.pos_label, x.txval, x.iamt]))];
    render(out, html`<div class="card mt"><div class="card-head"><div><h2>3.1 · Outward supplies</h2><div class="faint small">${date(r.from)} to ${date(r.to)} · net of credit notes</div></div></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>Nature of supplies</th><th class="num">Taxable value</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">${sl}</th><th class="num">Cess</th></tr></thead><tbody>
        <tr><td>(a) Outward taxable supplies (other than zero-rated, nil-rated and exempted)</td><td class="num">${amount(a.txval)}</td><td class="num">${amount(a.iamt)}</td><td class="num">${amount(a.camt)}</td><td class="num">${amount(a.samt)}</td><td class="num">${amount(a.csamt)}</td></tr>
        <tr><td>(b) Outward taxable supplies (zero-rated)</td><td class="num">0.00</td><td class="num">0.00</td><td></td><td></td><td class="num">0.00</td></tr>
        <tr><td>(c) Other outward supplies (nil-rated, exempted)</td><td class="num">${amount(r.nil_exempt)}</td><td></td><td></td><td></td><td></td></tr>
        <tr><td>(e) Non-GST outward supplies</td><td class="num">${amount(r.non_gst)}</td><td></td><td></td><td></td><td></td></tr>
      </tbody></table></div></div>
      <div class="card mt"><div class="card-head"><div><h2>3.2 · Inter-state supplies to unregistered persons</h2><div class="faint small">Of the supplies in 3.1(a), by place of supply</div></div>${r.inter_state_unregistered.length ? csvBtn('g3b') : ''}</div>
        ${r.inter_state_unregistered.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Place of supply</th><th class="num">Taxable value</th><th class="num">IGST</th></tr></thead><tbody>
          ${r.inter_state_unregistered.map((x) => html`<tr><td>${x.pos_label}</td><td class="num">${amount(x.txval)}</td><td class="num">${amount(x.iamt)}</td></tr>`)}</tbody></table></div>` : html`<div class="card-body faint">None in this period.</div>`}</div>
      <div class="notice mt">Tax liability in GSTR-3B is auto-populated from your GSTR-1; use this page to cross-check it. Input tax credit (Table 4) comes from your purchases (GSTR-2B), which this POS does not record.</div>`);
  }

  /* -------------------------------------------------- sales register */
  function drawRegister(r) {
    const t = r.totals;
    csvs.reg = () => [`sales_register_${tag()}.csv`, toCSV(['Number', 'Type', 'Date', 'Customer', 'GSTIN', 'Place of supply', 'GSTR-1', 'Taxable', 'CGST', `${sl}`, 'IGST', 'Cess', 'Round off', 'Total', 'Outstanding', 'Status'],
      r.rows.map((x) => [x.number, x.doc_type === 'Return' ? 'Credit note' : 'Invoice', x.date, x.customer_name, x.customer_gstin, stateLabel(x.place_of_supply), x.gst_section, x.taxable_total, x.cgst_total, x.sgst_total, x.igst_total, x.cess_total, x.round_off, x.grand_total, x.outstanding, x.status]))];
    render(out, html`<div class="tiles mt">
        <div class="card tile"><div class="lbl">Net sales</div><div class="val">${money(t.grand_total)}</div><div class="sub">${r.rows.filter((x) => x.status !== 'Cancelled').length} documents</div></div>
        <div class="card tile"><div class="lbl">Taxable value</div><div class="val">${money(t.taxable_total)}</div></div>
        <div class="card tile"><div class="lbl">GST</div><div class="val">${money(t.cgst_total + t.sgst_total + t.igst_total + t.cess_total)}</div></div>
        <div class="card tile"><div class="lbl">Outstanding</div><div class="val">${money(t.outstanding)}</div></div>
      </div>
      ${r.payments.length ? html`<div class="card card-pad"><h3>Collections by payment mode</h3><div class="row mt">${r.payments.map((p) => html`<span class="badge">${p.mode}: ${money(p.amount)}</span>`)}</div></div>` : ''}
      <div class="card mt"><div class="card-head"><h2>Sales register <span class="faint small">· ${r.rows.length}</span></h2>${r.rows.length ? csvBtn('reg') : ''}</div>
      ${r.rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>GSTR-1</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">${sl}</th><th class="num">IGST</th><th class="num">Total</th></tr></thead><tbody>
        ${r.rows.map((x) => html`<tr class="clickable ${x.status === 'Cancelled' ? 'cancelled' : ''}" data-inv="${x.id}"><td class="mono nowrap">${x.number}</td><td class="nowrap">${date(x.date)}</td><td>${x.customer_name}</td><td><span class="badge">${x.gst_section}</span></td>
          <td class="num">${amount(x.taxable_total)}</td><td class="num">${amount(x.cgst_total)}</td><td class="num">${amount(x.sgst_total)}</td><td class="num">${amount(x.igst_total)}</td><td class="num"><b>${amount(x.grand_total)}</b></td></tr>`)}</tbody>
        <tfoot><tr><td colspan="4">Total (excluding cancelled)</td><td class="num">${amount(t.taxable_total)}</td><td class="num">${amount(t.cgst_total)}</td><td class="num">${amount(t.sgst_total)}</td><td class="num">${amount(t.igst_total)}</td><td class="num">${amount(t.grand_total)}</td></tr></tfoot></table></div>`
        : html`<div class="card-body faint">No documents in this period.</div>`}</div>`);
  }

  /* ------------------------------------------------- item-wise sales */
  function drawItems(r) {
    csvs.items = () => [`item_sales_${tag()}.csv`, toCSV(['Item code', 'Item', 'HSN/SAC', 'GST %', 'Sold qty', 'Returned qty', 'Net qty', 'Taxable', 'Tax', 'Total'],
      r.rows.map((x) => [x.item_code, x.item_name, x.hsn, x.gst_rate, x.sold_qty, x.returned_qty, x.net_qty, x.taxable, x.tax, x.total]))];
    render(out, html`<div class="card mt"><div class="card-head"><h2>Item-wise sales <span class="faint small">· ${r.rows.length}</span></h2>${r.rows.length ? csvBtn('items') : ''}</div>
      ${r.rows.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>HSN/SAC</th><th class="num">GST</th><th class="num">Sold</th><th class="num">Returned</th><th class="num">Net qty</th><th class="num">Taxable</th><th class="num">Tax</th><th class="num">Total</th></tr></thead><tbody>
        ${r.rows.map((x) => html`<tr><td><b>${x.item_name}</b><div class="faint small">${x.item_code}</div></td><td class="mono">${x.hsn}</td><td class="num">${fmtRate(x.gst_rate)}%</td><td class="num">${qty(x.sold_qty)}</td><td class="num">${x.returned_qty ? qty(x.returned_qty) : ''}</td><td class="num">${qty(x.net_qty)}</td><td class="num">${amount(x.taxable)}</td><td class="num">${amount(x.tax)}</td><td class="num"><b>${amount(x.total)}</b></td></tr>`)}</tbody></table></div>`
        : html`<div class="card-body faint">No sales in this period.</div>`}</div>`);
  }

  await load();
}
