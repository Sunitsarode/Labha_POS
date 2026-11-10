// Point of Sale (ERPNext-POS style): item catalogue on the left, bill + payment on the right.
import { api, qs } from '../api.js';
import { app, isAdmin, printDoc } from '../app.js';
import { openCustomerForm } from '../customer-form.js';
import { computeInvoice, fmtRate, isValidState, r2, round, sgstLabel, stateName, upiLink } from '../gst.js';
import { qrSvg } from '../qr.js';
import { $, busy, confirmDialog, debounce, html, icon, money, openModal, qty as fmtQty, raw, render, stateOptions, toast } from '../ui.js';

const MAX_RESULTS = 150;

export async function mount(el) {
  const S = app.settings;
  const admin = isAdmin();
  const canEditPrice = admin || S.cashier_can_edit_price;
  const maxDisc = admin ? 100 : S.cashier_max_discount;
  const noTax = S.registration_type !== 'Regular';
  const draftKey = `niwas-pos-cart-${app.user.id}`;

  let items = [];
  let byId = new Map();
  let cat = '';
  let session = null;
  let cart = emptyCart();
  let heldCount = 0;
  let custResults = [];
  let lastCustQuery = '';
  const disposers = [];

  function emptyCart() {
    return { lines: [], customer: null, pos: S.state_code, discount_pct: 0, discount_amount: 0, notes: '' };
  }

  /* ------------------------------------------------------------- data */
  async function loadItems() {
    const res = await api.get('/api/items?status=active&limit=20000');
    items = res.items;
    for (const it of items) it._hay = `${it.name} ${it.code} ${it.barcode} ${it.hsn} ${it.category}`.toLowerCase();
    byId = new Map(items.map((i) => [i.id, i]));
    // Lines whose item disappeared are dropped; prices follow the master unless price edits are allowed.
    const before = cart.lines.length;
    cart.lines = cart.lines.filter((l) => byId.has(l.item_id));
    if (!canEditPrice) for (const l of cart.lines) l.rate = byId.get(l.item_id).rate;
    if (cart.lines.length !== before) toast('Some items in the bill are no longer available and were removed', 'error');
  }

  function sanitize(d) {
    const c = emptyCart();
    if (!d || typeof d !== 'object') return c;
    c.lines = (Array.isArray(d.lines) ? d.lines : [])
      .filter((l) => byId.has(Number(l.item_id)) && Number(l.qty) > 0)
      .map((l) => ({ item_id: Number(l.item_id), qty: round(l.qty, 3), rate: canEditPrice ? r2(l.rate) : byId.get(Number(l.item_id)).rate, discount_pct: Math.min(maxDisc, Math.max(0, Number(l.discount_pct) || 0)) }));
    c.customer = d.customer && d.customer.id ? d.customer : null;
    c.pos = isValidState(d.pos) ? d.pos : S.state_code;
    c.discount_pct = Number(d.discount_pct) || 0;
    c.discount_amount = Number(d.discount_amount) || 0;
    c.notes = typeof d.notes === 'string' ? d.notes : '';
    return c;
  }

  const saveDraft = () => { try { localStorage.setItem(draftKey, JSON.stringify(cart)); } catch { /* storage unavailable */ } };
  const restoreDraft = () => { try { cart = sanitize(JSON.parse(localStorage.getItem(draftKey) || 'null')); } catch { cart = emptyCart(); } };

  function calc() {
    return computeInvoice({
      lines: cart.lines.map((l) => {
        const it = byId.get(l.item_id);
        return { ...l, gst_rate: it.gst_rate, cess_rate: it.cess_rate, gst_treatment: it.gst_treatment };
      }),
      inclusive: S.prices_include_tax,
      interState: cart.pos !== S.state_code,
      noTax,
      discountPct: cart.discount_pct,
      discountAmount: cart.discount_amount,
      roundOff: S.round_off,
    });
  }

  /* ------------------------------------------------------------ shift */
  async function start() {
    const cur = await api.get('/api/sessions/current');
    session = cur.session;
    if (!session) return showOpenShift();
    await loadItems();
    restoreDraft();
    layout();
    api.get('/api/held').then((r) => { heldCount = r.held.length; renderCart(); }).catch(() => {});
  }

  function showOpenShift() {
    render(el, html`<div class="auth"><form class="card card-pad auth-card">
      <div class="auth-head"><div class="brand-mark">${icon('clock')}</div><h1>Start your shift</h1>
        <p class="muted">Count the cash in the drawer. It is used to reconcile the drawer when you close the shift.</p></div>
      <label class="field"><span>Opening cash in drawer (₹)</span><input class="input" type="number" name="opening_cash" min="0" step="0.01" value="0" autofocus></label>
      <button class="btn btn-primary btn-lg btn-block mt">Open shift and start billing</button></form></div>`);
    const form = el.querySelector('form');
    form.elements.opening_cash.select();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(form.querySelector('button'), async () => {
        await api.post('/api/sessions/open', { opening_cash: form.elements.opening_cash.value });
        toast('Shift opened', 'success');
        await start();
      });
    });
  }

  /* ----------------------------------------------------------- render */
  function layout() {
    render(el, html`<div class="pos">
      <section class="pos-catalog">
        <div class="pos-top">
          <div class="search-box">${icon('search')}<input class="input" id="q" placeholder="Search item, code, HSN or scan a barcode  (F2)" autocomplete="off" spellcheck="false" aria-label="Search items"></div>
          <a class="shift-pill" href="#/shifts" title="Shift details"><span class="dot"></span>Shift #${session.id}</a>
          <button type="button" class="icon-btn" data-act="reload" title="Reload items and prices" aria-label="Reload items">${icon('refresh')}</button>
        </div>
        <div class="chips" id="cats"></div>
        <div class="item-grid" id="grid"></div>
      </section>
      <aside class="pos-cart" id="cart" aria-label="Current bill"></aside>
    </div>
    <div class="mobile-cartbar" id="mbar"></div>`);
    renderCats();
    renderGrid();
    renderCart();
    $('#q', el).focus();
  }

  function renderCats() {
    const cats = [...new Set(items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const box = $('#cats', el);
    box.classList.toggle('hidden', !cats.length);
    render(box, html`<button type="button" class="chip ${cat === '' ? 'active' : ''}" data-cat="">All</button>${cats.map((c) => html`<button type="button" class="chip ${cat === c ? 'active' : ''}" data-cat="${c}">${c}</button>`)}`);
  }

  function filtered() {
    const terms = ($('#q', el)?.value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => (!cat || it.category === cat) && terms.every((t) => it._hay.includes(t)));
  }

  const gstTag = (it) => (it.gst_treatment === 'Taxable' ? `GST ${fmtRate(it.gst_rate)}%`
    : it.gst_treatment === 'Nil-Rated' ? 'Nil-rated' : it.gst_treatment === 'Exempted' ? 'Exempt' : 'Non-GST');

  function stockTag(it) {
    if (!it.track_stock) return '';
    if (it.stock_qty <= 0) return html`<span class="stk out">Out of stock</span>`;
    if (it.stock_qty <= it.reorder_level) return html`<span class="stk low">Low stock: ${fmtQty(it.stock_qty)}</span>`;
    return html`<span class="stk">${fmtQty(it.stock_qty)} ${it.uom} in stock</span>`;
  }

  function renderGrid() {
    const grid = $('#grid', el);
    if (!items.length) {
      render(grid, html`<div class="empty" style="grid-column:1/-1"><h3>No items yet</h3><p>${admin ? html`Add products under <a href="#/items">Items</a> to start billing.` : 'Ask an admin to add items.'}</p></div>`);
      return;
    }
    const list = filtered();
    if (!list.length) { render(grid, html`<div class="empty" style="grid-column:1/-1">No items match your search.</div>`); return; }
    render(grid, html`${list.slice(0, MAX_RESULTS).map((it) => html`<button type="button" class="item-card" data-add="${it.id}">
        <span class="nm">${it.name}</span><span class="cd">${it.code}${it.hsn ? ` · HSN ${it.hsn}` : ''}</span>
        <span class="ft"><span class="pr">${money(it.rate)}</span><span class="badge">${gstTag(it)}</span></span>${stockTag(it)}</button>`)}
      ${list.length > MAX_RESULTS ? html`<div class="faint small" style="grid-column:1/-1">Showing ${MAX_RESULTS} of ${list.length}. Refine your search.</div>` : ''}`);
  }

  function lineRow(l, cl, i) {
    const it = byId.get(l.item_id);
    const sub = [`${money(l.rate)} × ${fmtQty(l.qty)} ${it.uom}`, gstTag(it)];
    if (l.discount_pct) sub.push(`−${fmtRate(l.discount_pct)}%`);
    return html`<div class="cart-line">
      <div class="info" data-act="edit" data-i="${i}" title="Edit quantity, price or discount"><div class="nm">${it.name}</div><div class="sub">${sub.join(' · ')}</div></div>
      <div class="stepper"><button type="button" data-act="dec" data-i="${i}" aria-label="Decrease">−</button><input data-qty="${i}" value="${fmtQty(l.qty)}" inputmode="decimal" aria-label="Quantity of ${it.name}"><button type="button" data-act="inc" data-i="${i}" aria-label="Increase">+</button></div>
      <div class="amt">${money(cl.total)}</div>
      <button type="button" class="icon-btn" data-act="remove" data-i="${i}" aria-label="Remove ${it.name}">${icon('x')}</button>
    </div>`;
  }

  function renderCart() {
    const box = $('#cart', el);
    if (!box) return;
    const c = calc();
    const inter = cart.pos !== S.state_code;
    const cu = cart.customer;
    const hints = [];
    if (cu?.state_code && cu.state_code !== S.state_code && !inter) {
      hints.push(`${cu.name} is registered in ${stateName(cu.state_code)}. Counter sales are taxed in your state; change the place of supply only if the goods are delivered to that state.`);
    }
    if (!cu && c.grand_total >= 50000) hints.push('Bills of ₹50,000 or more to unregistered buyers must carry the buyer’s name and address (CGST Rule 46). Add the customer.');
    const has = cart.lines.length > 0;
    render(box, html`
      <div class="cart-head">
        <div class="cust-box">${cu ? html`<div class="cust-chip">${icon('user')}<div class="grow"><div class="who-name">${cu.name}</div>
              <small>${[cu.gstin ? `GSTIN ${cu.gstin}` : 'Unregistered (B2C)', cu.phone].filter(Boolean).join(' · ')}</small></div>
              <button type="button" class="icon-btn" data-act="cust-clear" aria-label="Remove customer">${icon('x')}</button></div>`
            : html`<div class="cust-row"><input class="input" id="custq" placeholder="Walk-in · search customer by name, phone or GSTIN" autocomplete="off" aria-label="Customer"><button type="button" class="btn" data-act="cust-new" title="New customer" aria-label="New customer">${icon('plus')}</button></div>
              <div class="dropdown hidden" id="custdd"></div>`}</div>
        <label class="pos-line-row">Place of supply <select class="input" id="posstate">${stateOptions(cart.pos, 'Select state')}</select>${inter ? html`<span class="badge badge-info">IGST</span>` : ''}</label>
        ${hints.map((h) => html`<div class="cart-hint">${h}</div>`)}
      </div>
      <div class="cart-lines">${has ? cart.lines.map((l, i) => lineRow(l, c.lines[i], i))
        : html`<div class="cart-empty"><div><p>Scan a barcode or tap an item to start the bill.</p><p class="small">F2 search · F4 pay · Esc clear search</p></div></div>`}</div>
      <div class="cart-totals">
        <div class="tot-row"><span>Subtotal · ${c.lines.length} line${c.lines.length === 1 ? '' : 's'}, qty ${fmtQty(c.total_qty)}</span><span>${money(c.gross_total)}</span></div>
        <div class="tot-row"><span><button type="button" class="link-btn" data-act="discount" ${has ? '' : 'disabled'}>${c.discount_total ? 'Discount' : '+ Add discount'}</button></span><span>${c.discount_total ? `−${money(c.discount_total)}` : ''}</span></div>
        <div class="tot-row"><span>Taxable value</span><span>${money(c.taxable_total)}</span></div>
        ${noTax ? html`<div class="tot-row"><span>GST</span><span>Not charged (${S.registration_type})</span></div>`
          : inter ? html`<div class="tot-row"><span>IGST</span><span>${money(c.igst_total)}</span></div>`
          : html`<div class="tot-row"><span>CGST</span><span>${money(c.cgst_total)}</span></div><div class="tot-row"><span>${sgstLabel(S.state_code)}</span><span>${money(c.sgst_total)}</span></div>`}
        ${c.cess_total ? html`<div class="tot-row"><span>Cess</span><span>${money(c.cess_total)}</span></div>` : ''}
        ${c.round_off ? html`<div class="tot-row"><span>Round off</span><span>${money(c.round_off)}</span></div>` : ''}
        <div class="tot-row grand"><span>Total</span><span>${money(c.grand_total)}</span></div>
      </div>
      <div class="cart-actions">
        <button type="button" class="btn" data-act="hold" ${has ? '' : 'disabled'}>${icon('pause')} Hold</button>
        <button type="button" class="btn" data-act="held">Held${heldCount ? ` (${heldCount})` : ''}</button>
        <button type="button" class="btn" data-act="clear" ${has ? '' : 'disabled'}>${icon('trash')} Clear</button>
        <button type="button" class="btn btn-primary btn-lg pay" data-act="pay" ${has ? '' : 'disabled'}>Pay ${money(c.grand_total)} <small>(F4)</small></button>
      </div>`);
    const bar = $('#mbar', el);
    if (bar) render(bar, html`<span>${c.lines.length} line${c.lines.length === 1 ? '' : 's'} · <b>${money(c.grand_total)}</b></span><button type="button" class="btn btn-sm" data-act="mcart">View bill</button>`);
  }

  function changed() { renderCart(); saveDraft(); }

  /* ---------------------------------------------------------- actions */
  function addItem(id, q = 1) {
    const it = byId.get(Number(id));
    if (!it) return;
    if (!S.allow_negative_stock && it.track_stock) {
      const inCart = cart.lines.filter((l) => l.item_id === it.id).reduce((a, l) => a + l.qty, 0);
      if (inCart + q > it.stock_qty) { toast(`Only ${fmtQty(it.stock_qty)} ${it.uom} of ${it.name} in stock`, 'error'); return; }
    }
    const line = cart.lines.find((l) => l.item_id === it.id && !l.discount_pct && l.rate === it.rate);
    if (line) line.qty = round(line.qty + q, 3);
    else cart.lines.push({ item_id: it.id, qty: q, rate: it.rate, discount_pct: 0 });
    changed();
    const card = el.querySelector(`[data-add="${it.id}"]`);
    if (card) { card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
  }

  function onSearchEnter() {
    const input = $('#q', el);
    const v = input.value.trim();
    if (!v) return;
    const lc = v.toLowerCase();
    let it = items.find((x) => x.barcode && x.barcode.toLowerCase() === lc) || items.find((x) => x.code.toLowerCase() === lc);
    const list = it ? [] : filtered();
    if (!it && list.length === 1) it = list[0];
    if (!it) {
      toast(list.length ? 'Several items match. Tap the one you want.' : `No item found for “${v}”`, list.length ? 'info' : 'error');
      return;
    }
    addItem(it.id);
    input.value = '';
    renderGrid();
  }

  const searchCustomers = debounce(async (q) => {
    const dd = $('#custdd', el);
    if (!dd) return;
    lastCustQuery = q.trim();
    if (!lastCustQuery) { dd.classList.add('hidden'); return; }
    try {
      const r = await api.get(`/api/customers${qs({ q: lastCustQuery, limit: 8 })}`);
      custResults = r.customers;
      render(dd, custResults.length
        ? custResults.map((cu, i) => html`<button type="button" data-pick="${i}"><b>${cu.name}</b><small>${[cu.phone, cu.gstin, cu.state_code && stateName(cu.state_code)].filter(Boolean).join(' · ')}${cu.outstanding > 0 ? ` · Due ${money(cu.outstanding)}` : ''}</small></button>`)
        : html`<button type="button" data-act="cust-new"><b>+ Add “${lastCustQuery}” as a new customer</b></button>`);
      dd.classList.remove('hidden');
    } catch (e) {
      toast(e.message, 'error');
    }
  }, 200);

  function selectCustomer(cu) {
    cart.customer = { id: cu.id, name: cu.name, phone: cu.phone, gstin: cu.gstin, state_code: cu.state_code, address: cu.address };
    changed();
  }

  async function newCustomer() {
    const prefill = /^[0-9+\s-]{6,}$/.test(lastCustQuery) ? { phone: lastCustQuery } : { name: lastCustQuery };
    const cu = await openCustomerForm(null, prefill);
    if (cu) { selectCustomer(cu); toast(`Customer ${cu.name} added`, 'success'); }
  }

  function editLine(i) {
    const l = cart.lines[i];
    const it = byId.get(l.item_id);
    const m = openModal({
      title: it.name,
      content: html`<form class="stack" novalidate>
        <div class="notice">${it.code} · HSN/SAC ${it.hsn || '—'} · ${gstTag(it)}${it.mrp ? ` · MRP ${money(it.mrp)}` : ''}${it.track_stock ? ` · Stock ${fmtQty(it.stock_qty)} ${it.uom}` : ''}</div>
        <div class="form-grid-3">
          <label class="field"><span>Quantity (${it.uom})</span><input class="input" type="number" name="qty" step="any" min="0" value="${l.qty}" autofocus></label>
          <label class="field"><span>Price ${S.prices_include_tax ? 'incl.' : 'excl.'} GST</span><input class="input" type="number" name="rate" step="0.01" min="0" value="${l.rate}" ${canEditPrice ? '' : raw('readonly title="Price changes need an admin"')}></label>
          <label class="field"><span>Discount %${maxDisc < 100 ? ` (max ${maxDisc})` : ''}</span><input class="input" type="number" name="discount_pct" step="0.01" min="0" max="${maxDisc}" value="${l.discount_pct || 0}"></label>
        </div>
        <div class="modal-actions"><button type="button" class="btn btn-danger" data-remove>${icon('trash')} Remove</button><span class="grow"></span>
          <button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Update</button></div>
      </form>`,
    });
    const form = m.body.querySelector('form');
    m.body.querySelector('[data-remove]').addEventListener('click', () => { cart.lines.splice(i, 1); changed(); m.close(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = round(form.elements.qty.value, 3);
      const rate = r2(form.elements.rate.value);
      const d = Number(form.elements.discount_pct.value) || 0;
      if (!(q > 0)) return toast('Quantity must be more than zero', 'error');
      if (rate < 0) return toast('Price cannot be negative', 'error');
      if (d < 0 || d > maxDisc) return toast(`Discount must be between 0 and ${maxDisc}%`, 'error');
      Object.assign(l, { qty: q, rate: canEditPrice ? rate : l.rate, discount_pct: d });
      changed();
      m.close();
    });
  }

  function editDiscount() {
    const c = calc();
    const isAmt = cart.discount_amount > 0;
    const m = openModal({
      title: 'Bill discount',
      content: html`<form class="stack" novalidate>
        <p class="muted small">Applied before GST and shared across all lines in proportion to their value, so every line's taxable value stays correct.</p>
        <div class="row"><label class="check"><input type="radio" name="kind" value="pct" ${isAmt ? '' : 'checked'}> Percent</label>
          <label class="check"><input type="radio" name="kind" value="amt" ${isAmt ? 'checked' : ''}> Amount (₹)</label></div>
        <label class="field"><span>Discount</span><input class="input" type="number" name="value" min="0" step="0.01" value="${isAmt ? cart.discount_amount : cart.discount_pct || ''}" autofocus></label>
        ${maxDisc < 100 ? html`<p class="faint small">Your limit: ${maxDisc}% of the bill.</p>` : ''}
        <div class="modal-actions"><button type="button" class="btn" data-clear>Remove discount</button><span class="grow"></span>
          <button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Apply</button></div></form>`,
    });
    const form = m.body.querySelector('form');
    m.body.querySelector('[data-clear]').addEventListener('click', () => { cart.discount_pct = 0; cart.discount_amount = 0; changed(); m.close(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = form.querySelector('[name=kind]:checked').value;
      const v = Number(form.elements.value.value) || 0;
      const base = c.gross_total - c.lines.reduce((a, l) => a + (l.discount_amount || 0), 0) + c.invoice_discount;
      const pct = kind === 'pct' ? v : base > 0 ? (v / base) * 100 : 0;
      if (v < 0 || (kind === 'pct' && v > 100)) return toast('Enter a valid discount', 'error');
      if (pct > maxDisc + 0.001) return toast(`Discount above ${maxDisc}% needs an admin`, 'error');
      cart.discount_pct = kind === 'pct' ? v : 0;
      cart.discount_amount = kind === 'amt' ? r2(v) : 0;
      changed();
      m.close();
    });
  }

  async function hold() {
    if (!cart.lines.length) return;
    const label = cart.customer?.name || `Bill ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
    await busy(null, async () => {
      await api.post('/api/held', { label, total: calc().grand_total, data: cart });
      cart = emptyCart();
      heldCount++;
      changed();
      toast(`Held as “${label}”`, 'success');
      $('#q', el)?.focus();
    });
  }

  async function showHeld() {
    let held;
    try { held = (await api.get('/api/held')).held; } catch (e) { toast(e.message, 'error'); return; }
    heldCount = held.length;
    renderCart();
    const when = (ts) => new Date(`${ts.replace(' ', 'T')}Z`).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const m = openModal({
      title: 'Held bills',
      content: held.length ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Bill</th><th>Held at</th><th class="num">Lines</th><th class="num">Total</th><th></th></tr></thead><tbody>
          ${held.map((h, i) => html`<tr><td><b>${h.label}</b></td><td class="nowrap">${when(h.created_at)}</td><td class="num">${h.data?.lines?.length ?? 0}</td><td class="num">${money(h.total)}</td>
            <td class="nowrap right"><button type="button" class="btn btn-sm btn-primary" data-resume="${i}">Resume</button> <button type="button" class="icon-btn" data-del="${i}" aria-label="Delete held bill">${icon('trash')}</button></td></tr>`)}
        </tbody></table></div>` : html`<div class="empty">No held bills. Use <b>Hold</b> to park a bill and serve the next customer.</div>`,
    });
    m.body.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-resume]');
      const d = e.target.closest('[data-del]');
      if (r) {
        const h = held[Number(r.dataset.resume)];
        if (cart.lines.length && !(await confirmDialog('Replace the current bill with the held one? The current bill will be lost unless you hold it first.', { ok: 'Replace' }))) return;
        await busy(r, async () => {
          await api.del(`/api/held/${h.id}`);
          cart = sanitize(h.data);
          heldCount = Math.max(0, heldCount - 1);
          changed();
          m.close();
        });
      } else if (d) {
        const h = held[Number(d.dataset.del)];
        await busy(d, async () => {
          await api.del(`/api/held/${h.id}`);
          heldCount = Math.max(0, heldCount - 1);
          renderCart();
          d.closest('tr').remove();
        });
      }
    });
  }

  function quickAmounts(total) {
    const set = new Set([total]);
    for (const step of [10, 50, 100, 500, 2000]) {
      const v = Math.ceil(total / step) * step;
      if (v > total) set.add(v);
    }
    return [...set].sort((a, b) => a - b).slice(0, 5);
  }

  function checkout() {
    if (!cart.lines.length) return;
    const c = calc();
    const total = c.grand_total;
    const modes = S.payment_modes;
    const m = openModal({
      title: 'Payment',
      dismissable: false,
      content: html`<div class="pay-total"><span class="lbl">Amount payable${cart.customer ? ` · ${cart.customer.name}` : ''}</span>
          <span class="amt">${money(total)}</span>${c.tax_total ? html`<span class="faint small">includes GST ${money(c.tax_total)}</span>` : ''}</div>
        <div class="pay-grid">${modes.map((mode) => html`<div class="pay-row">
          <button type="button" class="btn mode" data-fill="${mode}" title="Pay the balance by ${mode}">${mode}</button>
          <input class="input" type="number" min="0" step="0.01" data-mode="${mode}" placeholder="0.00" inputmode="decimal" aria-label="${mode} amount">
          ${mode === 'Cash' ? html`<span></span>` : html`<input class="input ref" data-ref="${mode}" placeholder="Reference / UTR (optional)" maxlength="60" aria-label="${mode} reference">`}</div>`)}</div>
        <div class="quick" aria-label="Quick cash amounts">${quickAmounts(total).map((v) => html`<button type="button" class="btn btn-sm" data-cash="${v}">${money(v)}</button>`)}</div>
        <div class="pay-status" id="paystatus" aria-live="polite"></div>
        <div id="upibox"></div>
        <label class="field mt"><span>Note on the bill (optional)</span><input class="input" id="paynote" maxlength="300" value="${cart.notes}"></label>
        <div class="modal-actions"><button type="button" class="btn" data-close>Back to bill</button><button type="button" class="btn btn-primary btn-lg" id="paydone">Complete sale</button></div>`,
    });
    const body = m.body;
    const input = (mode) => body.querySelector(`[data-mode="${CSS.escape(mode)}"]`);
    const values = () => Object.fromEntries(modes.map((mo) => [mo, r2(Number(input(mo).value) || 0)]));
    const done = body.querySelector('#paydone');
    const cashInput = input('Cash');
    cashInput.value = total.toFixed(2);
    cashInput.focus();
    cashInput.select();

    let lastUpi = -1;
    function update() {
      const v = values();
      const tendered = r2(Object.values(v).reduce((a, x) => a + x, 0));
      const nonCash = r2(tendered - (v.Cash || 0));
      const st = body.querySelector('#paystatus');
      let ok = true;
      if (nonCash > total) { st.className = 'pay-status bad'; st.textContent = 'Card / UPI cannot be more than the bill amount'; ok = false; }
      else if (tendered >= total) {
        const change = r2(tendered - total);
        st.className = 'pay-status good';
        render(st, change > 0 ? html`<span>Change to return</span><span>${money(change)}</span>` : html`<span>Fully paid</span><span>${money(tendered)}</span>`);
      } else {
        const due = r2(total - tendered);
        if (cart.customer) { st.className = 'pay-status warn'; render(st, html`<span>Credit to ${cart.customer.name}</span><span>${money(due)}</span>`); }
        else { st.className = 'pay-status bad'; render(st, html`<span>Collect ${money(due)} more, or select a customer to sell on credit</span>`); ok = false; }
      }
      done.disabled = !ok;
      const upi = v.UPI || 0;
      if (S.upi_id && upi !== lastUpi) {
        lastUpi = upi;
        const box = body.querySelector('#upibox');
        if (upi > 0 && input('UPI')) {
          const link = upiLink({ vpa: S.upi_id, name: S.company_name, amount: upi, note: `Bill at ${S.company_name}`.slice(0, 50) });
          render(box, html`<div class="upi">${raw(qrSvg(link, { size: 132, label: `UPI QR for ${money(upi)}` }))}<div><b>Scan &amp; pay ${money(upi)}</b><div class="muted small">Any UPI app · ${S.upi_id}</div><div class="faint small mt">Check the payment on your UPI app before completing the sale.</div></div></div>`);
        } else render(box, '');
      }
    }
    body.addEventListener('input', update);
    body.addEventListener('click', (e) => {
      const fill = e.target.closest('[data-fill]');
      const cash = e.target.closest('[data-cash]');
      if (fill) {
        const v = values();
        const others = Object.entries(v).filter(([k]) => k !== fill.dataset.fill).reduce((a, [, x]) => a + x, 0);
        const inp = input(fill.dataset.fill);
        inp.value = Math.max(0, r2(total - others)).toFixed(2);
        inp.focus();
        update();
      } else if (cash) {
        cashInput.value = Number(cash.dataset.cash).toFixed(2);
        update();
      }
    });
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !done.disabled) { e.preventDefault(); done.click(); }
    });
    done.addEventListener('click', () => busy(done, async () => {
      const v = values();
      const payments = modes.filter((mo) => v[mo] > 0).map((mo) => ({ mode: mo, amount: v[mo], reference: body.querySelector(`[data-ref="${CSS.escape(mo)}"]`)?.value || '' }));
      const res = await api.post('/api/invoices', {
        customer_id: cart.customer?.id ?? null,
        place_of_supply: cart.pos,
        lines: cart.lines.map((l) => ({ item_id: l.item_id, qty: l.qty, rate: l.rate, discount_pct: l.discount_pct })),
        discount_pct: cart.discount_pct,
        discount_amount: cart.discount_amount,
        payments,
        notes: body.querySelector('#paynote').value,
        expected_total: total,
      });
      m.close();
      cart = emptyCart();
      changed();
      saleDone(res.invoice);
      loadItems().then(() => { renderCats(); renderGrid(); }).catch(() => {});
    }));
    update();
  }

  function saleDone(inv) {
    const fmt = S.print_format;
    if (S.auto_print) printDoc(`inv=${inv.id}&f=${fmt}`);
    const m = openModal({
      title: 'Sale complete',
      onClose: () => $('#q', el)?.focus(),
      content: html`<div class="done">
        <div class="tick">${icon('check')}</div>
        <h2>${inv.number}</h2><div class="muted">${money(inv.grand_total)} · ${inv.customer_name}</div>
        ${inv.change_amount > 0 ? html`<div class="change">Return change: ${money(inv.change_amount)}</div>` : ''}
        ${inv.outstanding > 0 ? html`<div class="notice notice-warn">On credit: ${money(inv.outstanding)} due</div>` : ''}
        <div class="modal-actions" style="justify-content:center">
          <button type="button" class="btn" data-print="thermal">${icon('printer')} Receipt</button>
          <button type="button" class="btn" data-print="a4">${icon('printer')} A4 invoice</button>
          <button type="button" class="btn btn-primary" data-close autofocus>New sale</button></div></div>`,
    });
    m.body.addEventListener('click', (e) => {
      const p = e.target.closest('[data-print]');
      if (p) printDoc(`inv=${inv.id}&f=${p.dataset.print}`);
    });
  }

  /* ----------------------------------------------------------- events */
  const modalOpen = () => document.getElementById('modal-root').children.length > 0;

  const onClick = (e) => {
    const t = e.target.closest('[data-add],[data-cat],[data-act],[data-pick]');
    if (!t || !el.contains(t)) return;
    if (t.dataset.add) return addItem(t.dataset.add);
    if ('cat' in t.dataset) { cat = t.dataset.cat; renderCats(); renderGrid(); return; }
    if (t.dataset.pick !== undefined) return selectCustomer(custResults[Number(t.dataset.pick)]);
    const i = Number(t.dataset.i);
    switch (t.dataset.act) {
      case 'inc': cart.lines[i].qty = round(cart.lines[i].qty + 1, 3); return changed();
      case 'dec':
        if (cart.lines[i].qty > 1) cart.lines[i].qty = round(cart.lines[i].qty - 1, 3);
        else cart.lines.splice(i, 1);
        return changed();
      case 'remove': cart.lines.splice(i, 1); return changed();
      case 'edit': return editLine(i);
      case 'discount': return editDiscount();
      case 'cust-new': return newCustomer();
      case 'cust-clear': cart.customer = null; return changed();
      case 'hold': return hold();
      case 'held': return showHeld();
      case 'clear':
        return confirmDialog('Clear all items from this bill?', { ok: 'Clear bill', danger: true }).then((yes) => { if (yes) { cart = emptyCart(); changed(); } });
      case 'pay': return checkout();
      case 'mcart': return $('#cart', el).scrollIntoView({ behavior: 'smooth' });
      case 'reload':
        return busy(t, async () => { await loadItems(); renderCats(); renderGrid(); renderCart(); toast('Items and prices refreshed'); });
      default:
    }
  };

  const onChange = (e) => {
    const t = e.target;
    if (t.dataset.qty !== undefined) {
      const i = Number(t.dataset.qty);
      const q = round(String(t.value).replace(',', '.'), 3);
      if (q > 0) cart.lines[i].qty = q;
      else cart.lines.splice(i, 1);
      changed();
    } else if (t.id === 'posstate') {
      cart.pos = t.value || S.state_code;
      changed();
    }
  };

  const renderGridSoon = debounce(renderGrid, 60);
  const onInput = (e) => {
    if (e.target.id === 'q') renderGridSoon();
    else if (e.target.id === 'custq') searchCustomers(e.target.value);
  };

  const onKey = (e) => {
    const t = e.target;
    if (t.id === 'q') {
      if (e.key === 'Enter') { e.preventDefault(); onSearchEnter(); }
      else if (e.key === 'Escape') { t.value = ''; renderGrid(); }
    } else if (t.id === 'custq') {
      if (e.key === 'Enter' && custResults.length && !$('#custdd', el).classList.contains('hidden')) { e.preventDefault(); selectCustomer(custResults[0]); }
      else if (e.key === 'Escape') $('#custdd', el)?.classList.add('hidden');
    } else if (t.dataset.qty !== undefined && e.key === 'Enter') {
      e.preventDefault();
      t.blur();
      $('#q', el)?.focus();
    }
  };

  const onGlobalKey = (e) => {
    if (modalOpen() || !$('#q', el)) return;
    if (e.key === 'F2') { e.preventDefault(); $('#q', el).focus(); return; }
    if (e.key === 'F4') { e.preventDefault(); checkout(); return; }
    // Route barcode-scanner keystrokes into the search box when nothing else has focus.
    const a = document.activeElement;
    if ((!a || a === document.body) && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const q = $('#q', el);
      q.focus();
      q.value += e.key;
      e.preventDefault();
      renderGridSoon();
    }
  };

  const onDocDown = (e) => {
    const dd = $('#custdd', el);
    if (dd && !e.target.closest('.cust-box')) dd.classList.add('hidden');
  };

  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
  el.addEventListener('keydown', onKey);
  document.addEventListener('keydown', onGlobalKey);
  document.addEventListener('mousedown', onDocDown);
  disposers.push(() => document.removeEventListener('keydown', onGlobalKey), () => document.removeEventListener('mousedown', onDocDown));

  await start();
  return () => disposers.forEach((d) => d());
}
