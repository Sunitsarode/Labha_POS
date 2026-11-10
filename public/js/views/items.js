// Item master: HSN/SAC, GST treatment & rate, UQC, barcode, stock, CSV import/export.
import { api, qs } from '../api.js';
import { app, isAdmin } from '../app.js';
import { fmtRate, GST_RATES, GST_TREATMENTS, UQC, validateHSN } from '../gst.js';
import {
  busy, confirmDialog, date, debounce, download, formData, html, icon, money, openModal, options, parseCSV, qty, render, toCSV, toast,
} from '../ui.js';

const CSV_HEADER = ['code', 'name', 'category', 'hsn', 'is_service', 'uom', 'rate', 'mrp', 'gst_treatment', 'gst_rate', 'cess_rate', 'barcode', 'track_stock', 'reorder_level', 'stock'];
const gstLabel = (it) => (it.gst_treatment === 'Taxable' ? `${fmtRate(it.gst_rate)}%${it.cess_rate ? ` + ${fmtRate(it.cess_rate)}% cess` : ''}` : it.gst_treatment);

export async function mount(el) {
  const admin = isAdmin();
  const S = app.settings;
  let items = [];
  let categories = [];

  render(el, html`<div class="page">
    <div class="page-head"><h1>Items</h1>${admin ? html`<div class="row">
      <button type="button" class="btn" data-act="template">${icon('download')} CSV template</button>
      <label class="btn">${icon('upload')} Import CSV<input type="file" accept=".csv,text/csv" hidden data-import></label>
      <button type="button" class="btn" data-act="export">${icon('download')} Export</button>
      <button type="button" class="btn btn-primary" data-act="new">${icon('plus')} New item</button></div>` : ''}</div>
    <form class="filters" autocomplete="off">
      <label class="field grow"><span>Search</span><input class="input" name="q" placeholder="Name, code, barcode or HSN"></label>
      <label class="field"><span>Category</span><select class="input" name="category"><option value="">All categories</option></select></label>
      <label class="field"><span>Status</span><select class="input" name="status"><option value="active">Active</option><option value="inactive">Disabled</option><option value="all">All</option></select></label>
      <label class="check" style="align-self:center"><input type="checkbox" name="low" value="1"> Low stock only</label>
    </form>
    <div class="card"><div class="table-wrap" id="tbl"><div class="loading">Loading…</div></div></div>
    <p class="faint small mt">Check the HSN code and GST rate of every product you sell. Rates for many goods changed on 22-Sep-2025 (GST 2.0).</p>
  </div>`);
  const form = el.querySelector('form');

  async function loadCategories() {
    categories = (await api.get('/api/items/categories')).categories;
    const sel = form.elements.category;
    const cur = sel.value;
    render(sel, html`<option value="">All categories</option>${options(categories, cur)}`);
  }

  async function load() {
    const v = formData(form);
    try {
      items = (await api.get(`/api/items${qs({ q: v.q, category: v.category, status: v.status, low: v.low ? '1' : '' , limit: 5000 })}`)).items;
      draw();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function draw() {
    const box = el.querySelector('#tbl');
    if (!items.length) { render(box, html`<div class="empty"><h3>No items</h3><p>${admin ? 'Add an item or import a CSV file.' : 'Nothing matches.'}</p></div>`); return; }
    render(box, html`<table class="table"><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>HSN/SAC</th><th>GST</th><th class="num">Price</th><th class="num">Stock</th>${admin ? html`<th></th>` : ''}</tr></thead><tbody>
      ${items.map((it) => {
        const low = it.track_stock && it.stock_qty <= it.reorder_level;
        return html`<tr>
          <td class="mono nowrap">${it.code}</td>
          <td><b>${it.name}</b> ${it.is_service ? html`<span class="badge">Service</span>` : ''} ${it.active ? '' : html`<span class="badge badge-bad">Disabled</span>`}
            ${it.barcode ? html`<div class="faint small mono">${it.barcode}</div>` : ''}</td>
          <td>${it.category}</td>
          <td class="mono">${it.hsn || html`<span class="badge badge-warn">Missing</span>`}</td>
          <td class="nowrap">${gstLabel(it)}</td>
          <td class="num">${money(it.rate)}${it.mrp ? html`<div class="faint small">MRP ${money(it.mrp)}</div>` : ''}</td>
          <td class="num">${it.track_stock ? html`${low ? html`<span class="badge badge-warn">Low</span> ` : ''}${qty(it.stock_qty)} ${it.uom}` : html`<span class="faint">—</span>`}</td>
          ${admin ? html`<td class="nowrap right"><button type="button" class="icon-btn" data-edit="${it.id}" title="Edit" aria-label="Edit ${it.name}">${icon('edit')}</button>${it.track_stock ? html`<button type="button" class="icon-btn" data-stock="${it.id}" title="Adjust stock" aria-label="Adjust stock of ${it.name}">${icon('box')}</button>` : ''}</td>` : ''}
        </tr>`;
      })}</tbody></table>`);
  }

  function itemForm(it = null) {
    const v = it || { code: '', name: '', category: '', hsn: '', is_service: 0, uom: 'NOS', rate: '', mrp: '', gst_treatment: 'Taxable', gst_rate: '', cess_rate: 0, barcode: '', track_stock: 1, reorder_level: 0, active: 1 };
    const m = openModal({
      title: it ? `Edit ${it.name}` : 'New item',
      wide: true,
      dismissable: false,
      content: html`<form class="form-grid" novalidate>
        <label class="field"><span>Item code / SKU *</span><input class="input" name="code" value="${v.code}" required maxlength="40" autofocus></label>
        <label class="field"><span>Barcode (EAN / UPC / own)</span><input class="input mono" name="barcode" value="${v.barcode}" maxlength="64"></label>
        <label class="field span-2"><span>Item name *</span><input class="input" name="name" value="${v.name}" required maxlength="140"></label>
        <label class="field"><span>Category</span><input class="input" name="category" value="${v.category}" list="catlist" maxlength="60"><datalist id="catlist">${categories.map((c) => html`<option value="${c}">`)}</datalist></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="is_service" ${v.is_service ? 'checked' : ''}><span>This is a <b>service</b> (SAC code, no stock)</span></label>
        <label class="field"><span data-hsnlabel>HSN code</span><input class="input mono" name="hsn" value="${v.hsn}" maxlength="8" inputmode="numeric"><span class="hint" data-hsnhint></span></label>
        <label class="field"><span>Unit (GST UQC)</span><select class="input" name="uom">${options(UQC.map(([c, n]) => [c, `${c} – ${n}`]), v.uom)}</select></label>
        <label class="field"><span>GST treatment</span><select class="input" name="gst_treatment">${options(GST_TREATMENTS, v.gst_treatment)}</select></label>
        <label class="field"><span>GST rate</span><select class="input" name="gst_rate"><option value="">Select GST rate</option>${options(GST_RATES.filter((r) => r > 0).map((r) => [r, `${fmtRate(r)}%`]), v.gst_rate)}</select></label>
        <label class="field"><span>Selling price (₹, ${S.prices_include_tax ? 'including' : 'excluding'} GST) *</span><input class="input" type="number" name="rate" min="0" step="0.01" value="${v.rate}"></label>
        <label class="field"><span>MRP (₹)</span><input class="input" type="number" name="mrp" min="0" step="0.01" value="${v.mrp || ''}"></label>
        <label class="field"><span>Compensation cess %</span><input class="input" type="number" name="cess_rate" min="0" step="0.01" value="${v.cess_rate || 0}"></label>
        <label class="field"><span>Re-order level</span><input class="input" type="number" name="reorder_level" min="0" step="any" value="${v.reorder_level || 0}"></label>
        ${it ? '' : html`<label class="field"><span>Opening stock</span><input class="input" type="number" name="opening_stock" step="any" value="0"></label>`}
        <label class="check" style="align-self:end"><input type="checkbox" name="track_stock" ${v.track_stock ? 'checked' : ''}><span>Track stock for this item</span></label>
        ${it ? html`<label class="check" style="align-self:end"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}><span>Active (shown in the POS)</span></label>` : ''}
        <div class="modal-actions span-2">${it ? html`<button type="button" class="btn btn-danger" data-delete>${icon('trash')} Delete</button><span class="grow"></span>` : ''}
          <button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">${it ? 'Save item' : 'Add item'}</button></div>
      </form>`,
    });
    const f = m.body.querySelector('form');
    const E = f.elements;
    const sync = () => {
      const service = E.is_service.checked;
      const taxable = E.gst_treatment.value === 'Taxable';
      E.gst_rate.disabled = !taxable;
      E.cess_rate.disabled = !taxable;
      if (!taxable) E.gst_rate.value = '';
      E.track_stock.disabled = service;
      if (service) E.track_stock.checked = false;
      if (E.opening_stock) E.opening_stock.disabled = service || !E.track_stock.checked;
      f.querySelector('[data-hsnlabel]').textContent = service ? 'SAC code' : 'HSN code';
      const err = validateHSN(E.hsn.value.trim(), service);
      const hint = f.querySelector('[data-hsnhint]');
      hint.className = `hint${err ? ' err' : ''}`;
      hint.textContent = err || (service ? '6-digit service code starting with 99' : '4 digits (turnover up to ₹5 crore) or 6 / 8 digits');
      E.hsn.classList.toggle('invalid', !!err);
    };
    f.addEventListener('input', sync);
    f.addEventListener('change', sync);
    sync();
    f.querySelector('[data-delete]')?.addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete ${it.name}? Items that were already billed are disabled instead, so old invoices stay intact.`, { ok: 'Delete', danger: true }))) return;
      busy(null, async () => {
        const r = await api.del(`/api/items/${it.id}`);
        toast(r.archived ? 'Item was used in invoices, so it has been disabled' : 'Item deleted', 'success');
        m.close();
        load();
      });
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = formData(f);
      busy(f.querySelector('.btn-primary'), async () => {
        if (it) await api.put(`/api/items/${it.id}`, body);
        else await api.post('/api/items', body);
        toast(it ? 'Item saved' : 'Item added', 'success');
        m.close();
        await loadCategories();
        load();
      });
    });
  }

  async function stockDialog(it) {
    let moves = [];
    try { moves = (await api.get(`/api/items/${it.id}/moves`)).moves; } catch (e) { toast(e.message, 'error'); }
    const m = openModal({
      title: `Stock · ${it.name}`,
      wide: true,
      content: html`<form class="stack" novalidate>
        <div class="notice">Current stock: <b>${qty(it.stock_qty)} ${it.uom}</b></div>
        <div class="row"><label class="check"><input type="radio" name="mode" value="set" checked> Set the counted quantity (stock take)</label>
          <label class="check"><input type="radio" name="mode" value="add"> Add / remove (use a minus sign to remove)</label></div>
        <div class="form-grid"><label class="field"><span>Quantity (${it.uom})</span><input class="input" type="number" name="qty" step="any" value="${it.stock_qty}" autofocus></label>
          <label class="field"><span>Reason</span><input class="input" name="reason" maxlength="80" placeholder="Stock count, purchase, damage…"></label></div>
        <div class="modal-actions"><button type="button" class="btn" data-close>Close</button><button class="btn btn-primary">Update stock</button></div>
        <h3>Recent stock movements</h3>
        ${moves.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Reason</th><th>Reference</th><th>By</th><th class="num">Qty</th></tr></thead><tbody>
          ${moves.map((mv) => html`<tr><td class="nowrap">${date(mv.created_at)}</td><td>${mv.reason}</td><td class="mono small">${mv.ref}</td><td>${mv.username || ''}</td><td class="num">${mv.qty > 0 ? '+' : ''}${qty(mv.qty)}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted">No movements yet.</p>`}
      </form>`,
    });
    const f = m.body.querySelector('form');
    f.addEventListener('change', (e) => { if (e.target.name === 'mode') f.elements.qty.value = e.target.value === 'set' ? it.stock_qty : 0; });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(f.querySelector('.btn-primary'), async () => {
        await api.post(`/api/items/${it.id}/stock`, formData(f));
        toast('Stock updated', 'success');
        m.close();
        load();
      });
    });
  }

  async function importCSV(file) {
    const rows = parseCSV(await file.text());
    if (rows.length < 2) return toast('The CSV file has no data rows', 'error');
    const header = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    if (!header.includes('code') || !header.includes('name')) return toast('The CSV needs at least "code" and "name" columns. Download the template.', 'error');
    const yesNo = (s) => (/^(1|y|yes|true)$/i.test(s) ? '1' : /^(0|n|no|false)$/i.test(s) ? '0' : undefined);
    const data = rows.slice(1).map((r) => {
      const o = Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]));
      for (const k of ['is_service', 'track_stock']) if (k in o) o[k] = yesNo(o[k]);
      if (o.gst_treatment === '') delete o.gst_treatment;
      return o;
    });
    if (!(await confirmDialog(`Import ${data.length} row(s)? Items with an existing code are updated; new codes are created.`, { ok: 'Import' }))) return;
    try {
      const r = await api.post('/api/items/import', { rows: data });
      toast(`Imported: ${r.created} new, ${r.updated} updated`, 'success', 6000);
      await loadCategories();
      load();
    } catch (e) {
      const errors = e.details?.errors;
      if (errors?.length) openModal({ title: 'Import failed', content: html`<p>${e.message}</p><ul class="small">${errors.map((x) => html`<li>${x}</li>`)}</ul>` });
      else toast(e.message, 'error', 6000);
    }
  }

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-edit],[data-stock]');
    if (!t) return;
    if (t.dataset.edit) return itemForm(items.find((i) => i.id === Number(t.dataset.edit)));
    if (t.dataset.stock) return stockDialog(items.find((i) => i.id === Number(t.dataset.stock)));
    if (t.dataset.act === 'new') return itemForm();
    if (t.dataset.act === 'template') {
      return download('items-template.csv', toCSV(CSV_HEADER, [
        ['BISC-200', 'Glucose Biscuits 200 g', 'Snacks', '1905', '0', 'NOS', '25', '25', 'Taxable', '5', '0', '8901234567890', '1', '10', '100'],
        ['SVC-ALTER', 'Alteration charges', 'Services', '998599', '1', 'NOS', '150', '', 'Taxable', '18', '0', '', '0', '0', ''],
        ['MILK-500', 'Fresh Milk 500 ml', 'Dairy', '0401', '0', 'NOS', '30', '30', 'Exempted', '0', '0', '', '1', '5', '40'],
      ]));
    }
    if (t.dataset.act === 'export') {
      return busy(t, async () => {
        const all = (await api.get('/api/items?status=all&limit=20000')).items;
        download(`items-${new Date().toISOString().slice(0, 10)}.csv`, toCSV(CSV_HEADER, all.map((i) => [
          i.code, i.name, i.category, i.hsn, i.is_service, i.uom, i.rate, i.mrp, i.gst_treatment, i.gst_rate, i.cess_rate, i.barcode, i.track_stock, i.reorder_level, i.stock_qty,
        ])));
      });
    }
    return undefined;
  });
  el.querySelector('[data-import]')?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) importCSV(file);
  });
  form.addEventListener('input', debounce(load, 250));
  form.addEventListener('submit', (e) => e.preventDefault());

  await loadCategories().catch(() => {});
  await load();
}
