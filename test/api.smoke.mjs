#!/usr/bin/env node
/**
 * End-to-end API smoke test against a running instance (default: local `npm run dev`).
 *   Fresh database  → runs the setup wizard itself.
 *   Existing store  → set POS_USER and POS_PASS (an admin account).
 *   Other host      → set POS_URL (e.g. https://niwas-pos.<you>.workers.dev). It creates test data!
 */
import { gstinCheckChar, r2 } from '../public/js/gst.js';

const BASE = (process.env.POS_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
let failures = 0;

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const h = { ...headers };
    if (body !== undefined && !('Content-Type' in h)) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const m = /^pos_sid=([^;]*)/.exec(c);
      if (m) cookie = m[1] ? `pos_sid=${m[1]}` : '';
    }
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: res.status, data, headers: res.headers };
  };
}

function check(cond, msg, extra) {
  if (cond) console.log(`  ✔ ${msg}`);
  else {
    failures++;
    console.log(`  ✘ ${msg}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500));
  }
}
const gstin = (state, pan) => { const b = `${state}${pan}1Z`; return b + gstinCheckChar(b); };

const admin = client();
const anon = client();
console.log(`Smoke testing ${BASE}\n`);

/* ---------------------------------------------------------------- setup */
console.log('Setup & auth');
const boot = await admin('GET', '/api/bootstrap');
check(boot.status === 200, 'bootstrap responds', boot);
if (!boot.data.setup_done) {
  const s = await admin('POST', '/api/setup', {
    company: {
      company_name: 'Niwas Smoke Test Store', gstin: gstin('29', 'ABCDE1234F'), registration_type: 'Regular',
      address: '1 MG Road', city: 'Bengaluru', pincode: '560001', phone: '9900000000',
    },
    admin: { username: 'admin', full_name: 'Store Admin', password: 'admin@12345' },
    sample_data: true,
  });
  check(s.status === 201, 'setup wizard creates the store and admin', s);
  const again = await anon('POST', '/api/setup', { company: {}, admin: {} });
  check(again.status === 403, 'setup cannot be run twice', again);
} else {
  if (!process.env.POS_USER || !process.env.POS_PASS) {
    console.error('Store is already set up: set POS_USER and POS_PASS to an admin login.');
    process.exit(2);
  }
  const l = await admin('POST', '/api/auth/login', { username: process.env.POS_USER, password: process.env.POS_PASS });
  check(l.status === 200, 'admin login', l);
}
const me = await admin('GET', '/api/bootstrap');
check(me.data.user?.role === 'admin', 'signed in as admin', me.data);
const settings = me.data.settings;
const home = settings.state_code;
const away = home === '27' ? '29' : '27';

check((await anon('GET', '/api/items')).status === 401, 'API requires a session');
check((await anon('POST', '/api/auth/login', { username: 'admin', password: 'wrong-password' })).status === 401, 'wrong password rejected');
check((await admin('POST', '/api/held', { label: 'x' }, { 'Content-Type': 'text/plain' })).status === 415, 'non-JSON writes rejected (CSRF)');
check((await admin('POST', '/api/held', { label: 'x' }, { Origin: 'https://evil.example' })).status === 403, 'cross-origin writes rejected (CSRF)');

/* -------------------------------------------------------------- masters */
console.log('\nMasters');
const stamp = Date.now().toString(36).toUpperCase();
async function mkItem(code, body) {
  const res = await admin('POST', '/api/items', { code: `${code}-${stamp}`, uom: 'NOS', opening_stock: 50, ...body });
  check(res.status === 201, `create item ${code}`, res);
  return res.data.item;
}
const A = await mkItem('BISC', { name: 'Smoke Biscuits', hsn: '1905', rate: 100, gst_rate: 18 });
const B = await mkItem('RICE', { name: 'Smoke Rice', hsn: '1006', rate: 50, gst_rate: 5 });
const C = await mkItem('MILK', { name: 'Smoke Milk', hsn: '0401', rate: 30, gst_treatment: 'Exempted' });
const D = await mkItem('TV', { name: 'Smoke TV', hsn: '8528', rate: 52500, gst_rate: 18 });
const S = await mkItem('SVC', { name: 'Smoke Service', hsn: '998599', rate: 20, gst_rate: 18, is_service: true });
check(S.track_stock === 0, 'services do not track stock', S);
const badHsn = await admin('POST', '/api/items', { code: `BAD-${stamp}`, name: 'x', hsn: '123', rate: 1, gst_rate: 18 });
check(badHsn.status === 400, 'invalid HSN rejected', badHsn);
const badRate = await admin('POST', '/api/items', { code: `BAD2-${stamp}`, name: 'x', hsn: '1905', rate: 1, gst_rate: 13 });
check(badRate.status === 400, 'invalid GST rate rejected', badRate);

async function mkCustomer(body) {
  const res = await admin('POST', '/api/customers', body);
  check(res.status === 201, `create customer ${body.name}`, res);
  return res.data.customer;
}
const b2bHome = await mkCustomer({ name: `Smoke B2B Local ${stamp}`, gstin: gstin(home, 'ABCPS1234K').toLowerCase() });
check(b2bHome.state_code === home && b2bHome.gstin === b2bHome.gstin.toUpperCase(), 'customer state taken from GSTIN', b2bHome);
const b2bAway = await mkCustomer({ name: `Smoke B2B Away ${stamp}`, gstin: gstin(away, 'AAKFM5678Q') });
const retail = await mkCustomer({ name: `Smoke Credit ${stamp}`, phone: '9876500000', state_code: home });
const badGstin = await admin('POST', '/api/customers', { name: 'x', gstin: '29ABCDE1234F1ZZ' });
check(badGstin.status === 400 && /check digit/i.test(badGstin.data.error), 'bad GSTIN check digit rejected', badGstin);

/* ---------------------------------------------------------------- shift */
console.log('\nPOS shift');
let freshShift = false;
let cur = await admin('GET', '/api/sessions/current');
if (!cur.data.session) {
  const o = await admin('POST', '/api/sessions/open', { opening_cash: 1000 });
  check(o.status === 201, 'open shift with ₹1000 float', o);
  freshShift = true;
  cur = await admin('GET', '/api/sessions/current');
}
const sessionId = cur.data.session.id;

/* ---------------------------------------------------------------- sales */
console.log('\nSales');
const sell = (body) => admin('POST', '/api/invoices', body);
const inv1 = await sell({
  lines: [{ item_id: A.id, qty: 1 }, { item_id: B.id, qty: 2 }],
  payments: [{ mode: 'Cash', amount: 500 }], expected_total: 200,
});
const i1 = inv1.data.invoice;
check(inv1.status === 201, 'walk-in cash sale saved', inv1);
check(/^INV\/\d\d-\d\d\/\d{5}$/.test(i1.number) && i1.number.length <= 16, `GST-compliant number ${i1.number}`);
check(i1.grand_total === 200 && i1.change_amount === 300 && i1.status === 'Paid', 'inclusive totals, ₹300 change', i1);
check(i1.gst_section === 'B2CS' && i1.supply_type === 'INTRA' && i1.cgst_total === i1.sgst_total && i1.igst_total === 0, 'B2CS intra-state CGST = SGST', i1);
check(r2(i1.taxable_total + i1.tax_total + i1.round_off) === i1.grand_total, 'taxable + tax + round-off = total', i1);

const inv2 = await sell({ customer_id: b2bHome.id, lines: [{ item_id: A.id, qty: 10, discount_pct: 5 }], payments: [{ mode: 'UPI', amount: 950, reference: 'UTR123' }] });
check(inv2.status === 201 && inv2.data.invoice.gst_section === 'B2B' && inv2.data.invoice.grand_total === 950, 'B2B intra-state invoice with 5% discount', inv2);

const inv3 = await sell({ customer_id: b2bAway.id, place_of_supply: away, lines: [{ item_id: B.id, qty: 4 }], payments: [{ mode: 'Card', amount: 200 }] });
const i3 = inv3.data.invoice;
check(inv3.status === 201 && i3.supply_type === 'INTER' && i3.igst_total > 0 && i3.cgst_total === 0, 'inter-state B2B charges IGST', i3);

const inv4 = await sell({ place_of_supply: away, lines: [{ item_id: D.id, qty: 2 }], payments: [{ mode: 'Card', amount: 105000 }] });
check(inv4.status === 201 && inv4.data.invoice.gst_section === 'B2CL', 'inter-state B2C above ₹1 lakh is B2CL', inv4);

const inv5 = await sell({ customer_id: retail.id, lines: [{ item_id: A.id, qty: 2 }, { item_id: C.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 100 }] });
const i5 = inv5.data.invoice;
check(inv5.status === 201 && i5.outstanding === 130 && i5.status === 'Partly Paid', 'credit sale keeps ₹130 outstanding', i5);
const pay5 = await admin('POST', `/api/invoices/${i5.id}/payment`, { mode: 'UPI', amount: 30 });
check(pay5.status === 200 && pay5.data.invoice.outstanding === 100, 'receive ₹30 against the credit sale', pay5);

const inv6 = await sell({ lines: [{ item_id: B.id, qty: 3 }], payments: [{ mode: 'Cash', amount: 150 }] });
check(inv6.status === 201, 'sale to be cancelled', inv6);

const inv7 = await sell({ lines: [{ item_id: S.id, qty: 1 }], payments: [{ mode: 'UPI', amount: 20 }] });
check(inv7.status === 201 && inv7.data.invoice.cgst_total > 0, 'service (SAC) sale', inv7);

check((await sell({ lines: [{ item_id: A.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 50 }] })).status === 400, 'walk-in cannot leave a balance due');
check((await sell({ lines: [{ item_id: A.id, qty: 1 }], payments: [{ mode: 'UPI', amount: 500 }] })).status === 400, 'UPI cannot exceed the bill');
check((await sell({ lines: [{ item_id: A.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 100 }], expected_total: 99 })).status === 400, 'stale cart total detected');
check((await sell({ lines: [{ item_id: A.id, qty: 0 }], payments: [] })).status === 400, 'zero quantity rejected');

/* ----------------------------------------------------- returns & cancel */
console.log('\nReturns & cancellation');
const line = (inv, item) => inv.data.lines.find((l) => l.item_id === item.id);
const ret5 = await admin('POST', `/api/invoices/${i5.id}/return`, { lines: [{ line_id: line(inv5, A).id, qty: 1 }], refund_mode: 'Cash' });
check(ret5.status === 201 && ret5.data.refund === 0 && ret5.data.credit_adjusted === 100, 'return on credit sale reduces dues, no cash refund', ret5);
check(/^CN\//.test(ret5.data.invoice.number) && ret5.data.invoice.grand_total === -100, `credit note ${ret5.data.invoice?.number}`, ret5.data.invoice);
const after5 = await admin('GET', `/api/invoices/${i5.id}`);
check(after5.data.invoice.outstanding === 0 && after5.data.invoice.return_status === 'Partly Returned', 'original shows partly returned and settled', after5.data.invoice);

const ret1 = await admin('POST', `/api/invoices/${i1.id}/return`, { lines: [{ line_id: line(inv1, B).id, qty: 1 }], refund_mode: 'Cash' });
check(ret1.status === 201 && ret1.data.refund === 50 && ret1.data.invoice.gst_section === 'B2CS', '₹50 cash refund, credit note netted in B2CS', ret1);
const over = await admin('POST', `/api/invoices/${i1.id}/return`, { lines: [{ line_id: line(inv1, B).id, qty: 5 }] });
check(over.status === 400, 'cannot return more than was sold', over);

const ret2 = await admin('POST', `/api/invoices/${inv2.data.invoice.id}/return`, { lines: [{ line_id: inv2.data.lines[0].id, qty: 2 }], refund_mode: 'UPI' });
check(ret2.status === 201 && ret2.data.invoice.gst_section === 'CDNR', 'B2B return goes to CDNR', ret2);

const cancel = await admin('POST', `/api/invoices/${inv6.data.invoice.id}/cancel`, { reason: 'Smoke test' });
check(cancel.status === 200 && cancel.data.invoice.status === 'Cancelled', 'admin cancels an invoice', cancel);
check((await admin('POST', `/api/invoices/${i1.id}/cancel`, {})).status === 400, 'invoice with returns cannot be cancelled');

const items = (await admin('GET', `/api/items?q=${stamp}&status=all`)).data.items;
const stockOf = (it) => items.find((x) => x.id === it.id)?.stock_qty;
check(stockOf(A) === 40, `stock A: 50 − 13 sold + 3 returned = 40 (got ${stockOf(A)})`);
check(stockOf(B) === 45, `stock B: 50 − 9 sold + 3 cancelled + 1 returned = 45 (got ${stockOf(B)})`);

/* --------------------------------------------------------- held carts */
const hold = await admin('POST', '/api/held', { label: 'Table 4', total: 120, data: { lines: [{ item_id: A.id, qty: 1 }] } });
const held = await admin('GET', '/api/held');
const h = held.data.held.find((x) => x.label === 'Table 4');
check(hold.status === 201 && h?.data?.lines?.length === 1, 'hold a cart and list it', held);
check((await admin('DELETE', `/api/held/${h.id}`, {})).status === 200, 'delete held cart');

/* ------------------------------------------------------------- cashier */
console.log('\nCashier permissions');
const cashier = client();
const cname = `cashier_${stamp.toLowerCase()}`;
check((await admin('POST', '/api/users', { username: cname, full_name: 'Smoke Cashier', password: 'cashier@123', role: 'cashier' })).status === 201, 'admin adds a cashier');
check((await cashier('POST', '/api/auth/login', { username: cname, password: 'cashier@123' })).status === 200, 'cashier signs in');
check((await cashier('POST', '/api/sessions/open', { opening_cash: 0 })).status === 201, 'cashier opens own shift');
check((await cashier('POST', '/api/invoices', { lines: [{ item_id: A.id, qty: 1, rate: 1 }], payments: [] })).status === 400, 'cashier cannot change prices');
check((await cashier('POST', '/api/invoices', { lines: [{ item_id: A.id, qty: 1, discount_pct: 50 }], payments: [] })).status === 400, 'cashier discount limit enforced');
check((await cashier('GET', '/api/reports/dashboard')).status === 403, 'cashier cannot open reports');
check((await cashier('PUT', '/api/settings', { company_name: 'x' })).status === 403, 'cashier cannot change settings');
const csale = await cashier('POST', '/api/invoices', { lines: [{ item_id: B.id, qty: 1 }], payments: [{ mode: 'Cash', amount: 50 }] });
check(csale.status === 201, 'cashier bills normally', csale);
const cs = (await cashier('GET', '/api/sessions/current')).data.session;
check((await cashier('POST', `/api/sessions/${cs.id}/close`, { counted: { Cash: 50 } })).status === 200, 'cashier closes own shift');

/* ------------------------------------------------------------- reports */
console.log('\nGST reports');
const month = i1.date.slice(0, 7);
const g1 = await admin('GET', `/api/reports/gstr1?month=${month}`);
const g = g1.data;
check(g1.status === 200, `GSTR-1 for ${month}`, g1);
check(g.b2b.some((d) => d.number === inv2.data.invoice.number) && g.b2b.some((d) => d.number === i3.number), 'B2B table has both B2B invoices', g.b2b.map((d) => d.number));
check(g.b2b.find((d) => d.number === i3.number)?.rows[0]?.iamt > 0, 'inter-state B2B reported with IGST');
check(g.b2cl.some((d) => d.number === inv4.data.invoice.number), 'B2CL table has the large inter-state sale');
check(g.cdnr.some((d) => d.number === ret2.data.invoice.number && d.rows[0].txval > 0), 'CDNR has the B2B credit note (positive values)');
check(g.b2cs.length > 0 && g.hsn_b2b.length > 0 && g.hsn_b2c.length > 0, 'B2CS + HSN (B2B / B2C) summaries present');
check(g.nil.find((x) => x.sply_ty === 'INTRAB2C').expt_amt >= 30, 'exempt milk in Table 8 (nil/exempt)');
check(g.hsn_b2c.some((x) => x.hsn === '998599' && x.uqc === 'NA' && x.qty === 0), 'services reported in HSN summary with UQC NA', g.hsn_b2c);
const invDocs = g.docs.find((d) => d.doc_num === 1);
check(invDocs && invDocs.cancelled >= 1 && g.docs.some((d) => d.doc_num === 5), 'documents issued incl. cancelled & credit notes', g.docs);
const j = await admin('GET', `/api/reports/gstr1?month=${month}&format=json`);
check(j.status === 200 && /attachment/.test(j.headers.get('content-disposition')) && j.data.gstin === settings.gstin && j.data.b2b?.length, 'GSTR-1 JSON download', j.headers.get('content-disposition'));
const g3 = await admin('GET', `/api/reports/gstr3b?month=${month}`);
check(g3.status === 200 && g3.data.outward_taxable.txval > 0 && g3.data.inter_state_unregistered.some((x) => x.pos === away), 'GSTR-3B 3.1(a) and 3.2', g3.data);
const dash = await admin('GET', '/api/reports/dashboard');
check(dash.status === 200 && dash.data.today.bills >= 6 && dash.data.trend.length === 14, 'dashboard', dash.data.today);
const reg = await admin('GET', `/api/reports/sales-register?month=${month}`);
check(reg.status === 200 && reg.data.rows.some((x) => x.status === 'Cancelled'), 'sales register lists cancelled invoices too');
const isales = await admin('GET', `/api/reports/item-sales?month=${month}`);
const ia = isales.data.rows.find((x) => x.item_id === A.id);
check(ia && ia.sold_qty === 13 && ia.returned_qty === 3 && ia.net_qty === 10, 'item-wise sales nets returns', ia);

/* ------------------------------------------------------------ close shift */
console.log('\nClose shift');
const sum = (await admin('GET', `/api/sessions/${sessionId}`)).data.summary;
if (freshShift) {
  check(sum.expected.Cash === 1250, `expected cash 1000 + 200 + 100 − 50 refund = 1250 (got ${sum.expected.Cash})`, sum);
  check(sum.expected.UPI === r2(950 + 30 + 20 - ret2.data.refund), `expected UPI 950 + 30 + 20 − ${ret2.data.refund} refund (got ${sum.expected.UPI})`, sum);
  check(sum.expected.Card === 105200, `expected card 200 + 105000 (got ${sum.expected.Card})`, sum);
  check(sum.cancelled.count === 1, 'cancelled invoice excluded from the drawer', sum.cancelled);
}
const close = await admin('POST', `/api/sessions/${sessionId}/close`, { counted: sum.expected });
check(close.status === 200 && Object.values(close.data.closing.difference).every((d) => d === 0), 'shift closed with no differences', close.data);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
