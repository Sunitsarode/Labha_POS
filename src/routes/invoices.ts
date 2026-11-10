import {
  computeInvoice, docSeries, fyFor, gstSection, isValidState, istNow, prorateReturn, r2, round,
} from '../../public/js/gst.js';
import { all, first, prep } from '../db';
import { bad, json, notFound } from '../http';
import type { Router } from '../router';
import { getSettings } from '../settings';
import type { CustomerRow, InvoiceRow, ItemRow, LineRow } from '../types';
import { clampInt, int, isDate, num, str, text } from '../validate';
import { openSessionFor } from './sessions';

const MAX_LINES = 300;

const DOC_COLS = ['uid', 'doc_type', 'series', 'date', 'time', 'fy', 'status', 'return_against', 'customer_id', 'customer_name',
  'customer_phone', 'customer_gstin', 'customer_address', 'customer_state', 'place_of_supply', 'supply_type', 'gst_section',
  'tax_regime', 'prices_include_tax', 'total_qty', 'gross_total', 'discount_total', 'taxable_total', 'cgst_total', 'sgst_total',
  'igst_total', 'cess_total', 'tax_total', 'round_off', 'grand_total', 'paid_total', 'tendered_total', 'change_amount',
  'outstanding', 'invoice_discount_pct', 'invoice_discount_amount', 'notes', 'session_id', 'user_id'] as const;
type Doc = Record<(typeof DOC_COLS)[number], unknown>;

const LINE_COLS = ['idx', 'item_id', 'ref_line_id', 'item_code', 'item_name', 'hsn', 'uom', 'is_service', 'qty', 'rate', 'gross',
  'discount_pct', 'discount_amount', 'gst_treatment', 'gst_rate', 'cess_rate', 'taxable_value', 'cgst', 'sgst', 'igst', 'cess', 'total'] as const;

interface Payment { mode: string; amount: number; reference: string }

/** Next number in a series. Runs inside the same D1 batch (transaction) as the insert → gap-free and unique. */
const bumpCounter = (db: D1Database, series: string) =>
  prep(db, 'INSERT INTO series_counters (series, last) VALUES (?, 1) ON CONFLICT(series) DO UPDATE SET last = last + 1', series);

function insertDoc(db: D1Database, d: Doc) {
  return prep(db,
    `INSERT INTO invoices (${DOC_COLS.join(', ')}, seq, number)
     VALUES (${DOC_COLS.map(() => '?').join(', ')},
             (SELECT last FROM series_counters WHERE series = ?),
             ? || printf('%05d', (SELECT last FROM series_counters WHERE series = ?)))`,
    ...DOC_COLS.map((k) => d[k]), d.series, d.series, d.series);
}

function insertLine(db: D1Database, uid: string, l: Record<string, unknown>) {
  return prep(db,
    `INSERT INTO invoice_items (invoice_id, ${LINE_COLS.join(', ')})
     VALUES ((SELECT id FROM invoices WHERE uid = ?), ${LINE_COLS.map(() => '?').join(', ')})`,
    uid, ...LINE_COLS.map((k) => l[k]));
}

function insertPayment(db: D1Database, uid: string, p: Payment, sessionId: number, date: string) {
  return prep(db,
    `INSERT INTO invoice_payments (invoice_id, mode, amount, reference, session_id, date)
     VALUES ((SELECT id FROM invoices WHERE uid = ?), ?, ?, ?, ?, ?)`,
    uid, p.mode, p.amount, p.reference, sessionId, date);
}

/** Stock change + ledger row, applied only to items that track stock. `uid` identifies the document. */
function stockMove(db: D1Database, itemId: number, delta: number, reason: string, uid: string, userId: number) {
  return [
    prep(db, "UPDATE items SET stock_qty = round(stock_qty + ?, 3), updated_at = datetime('now') WHERE id = ? AND track_stock = 1",
      delta, itemId),
    prep(db, `INSERT INTO stock_moves (item_id, qty, reason, ref, user_id)
              SELECT ?, ?, ?, (SELECT number FROM invoices WHERE uid = ?), ?
               WHERE EXISTS (SELECT 1 FROM items WHERE id = ? AND track_stock = 1)`,
      itemId, delta, reason, uid, userId, itemId),
  ];
}

function normalisePayments(raw: unknown, allowed: string[]): Payment[] {
  const byMode = new Map<string, Payment>();
  for (const p of Array.isArray(raw) ? raw : []) {
    const mode = str(p?.mode, 20);
    const amount = r2(num(p?.amount));
    if (!amount) continue;
    if (amount < 0 || amount > 1e9) bad('Payment amounts must be positive');
    if (!allowed.includes(mode)) bad(`Unknown payment mode "${mode}"`);
    const cur = byMode.get(mode);
    if (cur) cur.amount = r2(cur.amount + amount);
    else byMode.set(mode, { mode, amount, reference: str(p?.reference, 60) });
  }
  return [...byMode.values()];
}

async function itemsById(db: D1Database, ids: number[]) {
  const map = new Map<number, ItemRow>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await all<ItemRow>(db, `SELECT * FROM items WHERE id IN (${chunk.map(() => '?').join(', ')})`, ...chunk);
    for (const row of rows) map.set(row.id, row);
  }
  return map;
}

const neg = (x: number) => (x ? -x : 0);

/** Full document: header, lines (with already-returned qty), payments, linked returns / original. */
export async function loadInvoice(db: D1Database, id: number) {
  const invoice = await first<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id);
  if (!invoice) notFound('Invoice not found');
  const [lines, payments, returns, against, cashier, returnedRows] = await Promise.all([
    all<LineRow>(db, 'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY idx', id),
    all(db, 'SELECT id, mode, amount, reference, date, created_at FROM invoice_payments WHERE invoice_id = ? ORDER BY id', id),
    all(db, 'SELECT id, number, date, grand_total, status FROM invoices WHERE return_against = ? ORDER BY id', id),
    invoice.return_against ? first(db, 'SELECT id, number, date FROM invoices WHERE id = ?', invoice.return_against) : null,
    invoice.user_id ? first(db, 'SELECT username, full_name FROM users WHERE id = ?', invoice.user_id) : null,
    all<{ ref_line_id: number; qty: number }>(db,
      `SELECT l.ref_line_id, -SUM(l.qty) AS qty FROM invoice_items l JOIN invoices r ON r.id = l.invoice_id
        WHERE r.return_against = ? AND r.status <> 'Cancelled' GROUP BY l.ref_line_id`, id),
  ]);
  const returned = new Map(returnedRows.map((x) => [x.ref_line_id, round(x.qty, 3)]));
  return {
    invoice,
    lines: lines.map((l) => ({ ...l, returned_qty: returned.get(l.id) ?? 0 })),
    payments,
    returns,
    return_against: against,
    cashier,
  };
}

export function registerInvoices(r: Router) {
  /* ------------------------------------------------------------ new sale */
  r.post('/api/invoices', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const [settings, session] = await Promise.all([getSettings(db), openSessionFor(db, c.user.id)]);
    if (!session) bad('Open your POS shift before billing');

    const rawLines: any[] = Array.isArray(b.lines) ? b.lines : [];
    if (!rawLines.length) bad('The cart is empty');
    if (rawLines.length > MAX_LINES) bad(`An invoice can have at most ${MAX_LINES} lines`);

    const items = await itemsById(db, [...new Set(rawLines.map((l) => int(l?.item_id)))].filter((x) => x > 0));
    const isAdmin = c.user.role === 'admin';
    const canEditPrice = isAdmin || settings.cashier_can_edit_price;
    const maxDiscount = isAdmin ? 100 : settings.cashier_max_discount;

    const inputs = rawLines.map((l, i) => {
      const it = items.get(int(l?.item_id));
      if (!it || !it.active) bad(`Line ${i + 1}: item not found or disabled`);
      const qty = round(num(l.qty), 3);
      if (!(qty > 0) || qty > 1e6) bad(`${it.name}: quantity must be more than zero`);
      let rate = it.rate;
      if (l.rate !== undefined && l.rate !== null && r2(num(l.rate)) !== r2(it.rate)) {
        if (!canEditPrice) bad(`The price of ${it.name} is now ₹${it.rate}. Refresh the POS to load the latest prices`);
        rate = r2(num(l.rate));
        if (rate < 0 || rate > 1e8) bad(`${it.name}: invalid price`);
      }
      const discount_pct = Math.min(100, Math.max(0, num(l.discount_pct)));
      if (discount_pct > maxDiscount) bad(`${it.name}: discount above ${maxDiscount}% needs an admin`);
      return {
        item_id: it.id, ref_line_id: null, item_code: it.code, item_name: it.name, hsn: it.hsn, uom: it.uom,
        is_service: it.is_service, qty, rate, discount_pct, gst_treatment: it.gst_treatment, gst_rate: it.gst_rate,
        cess_rate: it.cess_rate, track: !!it.track_stock,
      };
    });

    let cust: CustomerRow | null = null;
    if (b.customer_id) {
      cust = await first<CustomerRow>(db, 'SELECT * FROM customers WHERE id = ?', int(b.customer_id));
      if (!cust) bad('Customer not found');
    }
    // Over-the-counter sale: place of supply is the shop's state unless goods are delivered elsewhere.
    const pos = str(b.place_of_supply, 2) || settings.state_code;
    if (!isValidState(pos)) bad('Invalid place of supply');
    const inter = pos !== settings.state_code;

    const discountPct = Math.min(100, Math.max(0, num(b.discount_pct)));
    const discountAmount = Math.max(0, r2(num(b.discount_amount)));
    const calc = computeInvoice({
      lines: inputs, inclusive: settings.prices_include_tax, interState: inter,
      noTax: settings.registration_type !== 'Regular', discountPct, discountAmount, roundOff: settings.round_off,
    });
    if (!isAdmin && calc.gross_total > 0 && (calc.discount_total / calc.gross_total) * 100 > maxDiscount + 0.01) {
      bad(`Total discount is above the ${maxDiscount}% cashier limit`);
    }
    if (b.expected_total !== undefined && Math.abs(r2(num(b.expected_total)) - calc.grand_total) > 0.009) {
      bad(`The bill total is ₹${calc.grand_total} on the server. Please review the cart and try again`);
    }

    if (!settings.allow_negative_stock) {
      const need = new Map<number, number>();
      for (const l of inputs) if (l.track) need.set(l.item_id, round((need.get(l.item_id) ?? 0) + l.qty, 3));
      for (const [id, q] of need) {
        const it = items.get(id)!;
        if (it.stock_qty < q) bad(`Only ${it.stock_qty} ${it.uom} of ${it.name} in stock`);
      }
    }

    // Payments: card/UPI can never exceed the bill; change is only given from cash.
    const pays = normalisePayments(b.payments, settings.payment_modes);
    const tendered = r2(pays.reduce((a, p) => a + p.amount, 0));
    const cashIn = r2(pays.filter((p) => p.mode === 'Cash').reduce((a, p) => a + p.amount, 0));
    if (r2(tendered - cashIn) > calc.grand_total) bad('Card / UPI payments cannot be more than the bill amount');
    const change = r2(Math.max(0, tendered - calc.grand_total));
    const paid = r2(tendered - change);
    const outstanding = r2(calc.grand_total - paid);
    if (outstanding > 0 && !cust) bad(`₹${outstanding} is still due. Select a customer to record it as a credit sale`);
    const applied = pays
      .map((p) => (p.mode === 'Cash' ? { ...p, amount: r2(p.amount - change) } : p))
      .filter((p) => p.amount > 0);

    const { date, time } = istNow();
    const fy = fyFor(date);
    const uid = crypto.randomUUID();
    const doc: Doc = {
      uid, doc_type: 'Invoice', series: docSeries(settings.invoice_prefix, fy), date, time, fy,
      status: outstanding <= 0 ? 'Paid' : paid > 0 ? 'Partly Paid' : 'Unpaid',
      return_against: null,
      customer_id: cust?.id ?? null,
      customer_name: cust?.name || 'Walk-in Customer',
      customer_phone: cust?.phone ?? '',
      customer_gstin: cust?.gstin ?? '',
      customer_address: cust?.address ?? '',
      customer_state: cust?.state_code ?? '',
      place_of_supply: pos,
      supply_type: inter ? 'INTER' : 'INTRA',
      gst_section: gstSection({
        docType: 'Invoice', customerGstin: cust?.gstin, interState: inter, grandTotal: calc.grand_total,
        regime: settings.registration_type, b2clLimit: settings.b2cl_limit,
      }),
      tax_regime: settings.registration_type,
      prices_include_tax: settings.prices_include_tax ? 1 : 0,
      total_qty: calc.total_qty, gross_total: calc.gross_total, discount_total: calc.discount_total,
      taxable_total: calc.taxable_total, cgst_total: calc.cgst_total, sgst_total: calc.sgst_total,
      igst_total: calc.igst_total, cess_total: calc.cess_total, tax_total: calc.tax_total,
      round_off: calc.round_off, grand_total: calc.grand_total,
      paid_total: paid, tendered_total: tendered, change_amount: change, outstanding,
      invoice_discount_pct: discountPct, invoice_discount_amount: discountAmount,
      notes: text(b.notes, 300), session_id: session.id, user_id: c.user.id,
    };

    const stmts = [bumpCounter(db, doc.series as string), insertDoc(db, doc)];
    calc.lines.forEach((l, i) => stmts.push(insertLine(db, uid, { ...l, idx: i + 1 })));
    for (const p of applied) stmts.push(insertPayment(db, uid, p, session.id, date));
    for (const l of calc.lines) if (l.track) stmts.push(...stockMove(db, l.item_id, -l.qty, 'Sale', uid, c.user.id));
    if (b.held_id) stmts.push(prep(db, 'DELETE FROM held_carts WHERE id = ? AND user_id = ?', int(b.held_id), c.user.id));
    await db.batch(stmts);

    const row = await first<{ id: number }>(db, 'SELECT id FROM invoices WHERE uid = ?', uid);
    return json(await loadInvoice(db, row!.id), { status: 201 });
  });

  /* ------------------------------------------------------------- listing */
  r.get('/api/invoices', async (c) => {
    const db = c.env.DB;
    const where = ['date BETWEEN ? AND ?'];
    const args: unknown[] = [isDate(c.q('from')) ? c.q('from') : '0000-01-01', isDate(c.q('to')) ? c.q('to') : '9999-12-31'];
    const q = c.q('q');
    if (q) {
      where.push('(number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR customer_gstin LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const type = c.q('type');
    if (type === 'Invoice' || type === 'Return') { where.push('doc_type = ?'); args.push(type); }
    const status = c.q('status');
    if (status === 'due') where.push("outstanding > 0 AND status <> 'Cancelled'");
    if (status === 'cancelled') where.push("status = 'Cancelled'");
    const customer = int(c.q('customer_id'));
    if (customer) { where.push('customer_id = ?'); args.push(customer); }
    const W = where.join(' AND ');
    const limit = clampInt(c.q('limit'), 1, 500, 100);
    const offset = clampInt(c.q('offset'), 0, 1e9, 0);
    const [invoices, totals] = await Promise.all([
      all(db, `SELECT id, number, doc_type, date, time, customer_name, customer_gstin, gst_section, place_of_supply, supply_type,
                      taxable_total, tax_total, grand_total, outstanding, status, return_status
                 FROM invoices WHERE ${W} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, limit, offset),
      first(db, `SELECT COUNT(*) AS n, SUM(CASE WHEN status <> 'Cancelled' THEN grand_total ELSE 0 END) AS total
                   FROM invoices WHERE ${W}`, ...args),
    ]);
    return json({ invoices, count: totals?.n ?? 0, total: r2(totals?.total) });
  });

  r.get('/api/invoices/:id', async (c) => json(await loadInvoice(c.env.DB, int(c.params.id))));

  /* -------------------------------------------- sales return / credit note */
  r.post('/api/invoices/:id/return', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const b = await c.body<any>();
    const [settings, session, orig] = await Promise.all([
      getSettings(db), openSessionFor(db, c.user.id), first<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id),
    ]);
    if (!orig || orig.doc_type !== 'Invoice') notFound('Invoice not found');
    if (orig.status === 'Cancelled') bad('This invoice is cancelled');
    if (!session) bad('Open your POS shift to process a return');

    const origLines = await all<LineRow>(db, 'SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY idx', id);
    const doneRows = await all<Record<string, number>>(db,
      `SELECT l.ref_line_id, -SUM(l.qty) AS qty, -SUM(l.gross) AS gross, -SUM(l.discount_amount) AS discount_amount,
              -SUM(l.taxable_value) AS taxable_value, -SUM(l.cgst) AS cgst, -SUM(l.sgst) AS sgst, -SUM(l.igst) AS igst, -SUM(l.cess) AS cess
         FROM invoice_items l JOIN invoices r ON r.id = l.invoice_id
        WHERE r.return_against = ? AND r.status <> 'Cancelled' GROUP BY l.ref_line_id`, id);
    const done = new Map(doneRows.map((d) => [d.ref_line_id, d]));

    const thisQty = new Map<number, number>();
    const retLines: Record<string, any>[] = [];
    for (const req of Array.isArray(b.lines) ? b.lines : []) {
      const qty = round(num(req?.qty), 3);
      if (!qty) continue;
      const ol = origLines.find((l) => l.id === int(req.line_id));
      if (!ol) bad('A return line does not belong to this invoice');
      if (thisQty.has(ol.id)) bad(`${ol.item_name} is listed twice`);
      const already = done.get(ol.id) ?? {};
      const remaining = round(ol.qty - num(already.qty), 3);
      if (qty < 0 || qty > remaining + 0.0005) bad(`${ol.item_name}: at most ${remaining} can be returned`);
      thisQty.set(ol.id, qty);
      const pr = prorateReturn(ol, qty, already);
      retLines.push({
        idx: retLines.length + 1, item_id: ol.item_id, ref_line_id: ol.id, item_code: ol.item_code, item_name: ol.item_name,
        hsn: ol.hsn, uom: ol.uom, is_service: ol.is_service, qty: neg(pr.qty), rate: ol.rate, gross: neg(pr.gross),
        discount_pct: ol.discount_pct, discount_amount: neg(pr.discount_amount), gst_treatment: ol.gst_treatment,
        gst_rate: ol.gst_rate, cess_rate: ol.cess_rate, taxable_value: neg(pr.taxable_value), cgst: neg(pr.cgst),
        sgst: neg(pr.sgst), igst: neg(pr.igst), cess: neg(pr.cess), total: neg(pr.total),
      });
    }
    if (!retLines.length) bad('Choose at least one item to return');

    const sum = (k: string) => r2(retLines.reduce((a, l) => a + l[k], 0));
    const taxable_total = sum('taxable_value');
    const cgst_total = sum('cgst');
    const sgst_total = sum('sgst');
    const igst_total = sum('igst');
    const cess_total = sum('cess');
    const tax_total = r2(cgst_total + sgst_total + igst_total + cess_total);
    const net_total = r2(taxable_total + tax_total);
    const grand_total = settings.round_off ? round(net_total, 0) : net_total;

    // Credit sale? First reduce what the customer still owes, refund only the rest.
    const due = neg(grand_total);
    const creditAdjust = Math.min(r2(orig.outstanding), due);
    const refund = r2(due - creditAdjust);
    const refundMode = settings.payment_modes.includes(str(b.refund_mode, 20)) ? str(b.refund_mode, 20) : 'Cash';

    const { date, time } = istNow();
    const fy = fyFor(date);
    const uid = crypto.randomUUID();
    const doc: Doc = {
      uid, doc_type: 'Return', series: docSeries(settings.return_prefix, fy), date, time, fy, status: 'Paid',
      return_against: orig.id, customer_id: orig.customer_id, customer_name: orig.customer_name,
      customer_phone: orig.customer_phone, customer_gstin: orig.customer_gstin, customer_address: orig.customer_address,
      customer_state: orig.customer_state, place_of_supply: orig.place_of_supply, supply_type: orig.supply_type,
      gst_section: gstSection({ docType: 'Return', origSection: orig.gst_section, regime: orig.tax_regime }),
      tax_regime: orig.tax_regime, prices_include_tax: orig.prices_include_tax,
      total_qty: round(retLines.reduce((a, l) => a + l.qty, 0), 3), gross_total: sum('gross'), discount_total: sum('discount_amount'),
      taxable_total, cgst_total, sgst_total, igst_total, cess_total, tax_total,
      round_off: r2(grand_total - net_total), grand_total,
      paid_total: neg(refund), tendered_total: neg(refund), change_amount: 0, outstanding: 0,
      invoice_discount_pct: 0, invoice_discount_amount: 0, notes: text(b.reason, 300), session_id: session.id, user_id: c.user.id,
    };

    const fullyReturned = origLines.every((ol) =>
      round(ol.qty - num(done.get(ol.id)?.qty) - (thisQty.get(ol.id) ?? 0), 3) <= 0);
    const newOutstanding = r2(orig.outstanding - creditAdjust);
    const stmts = [bumpCounter(db, doc.series as string), insertDoc(db, doc)];
    for (const l of retLines) stmts.push(insertLine(db, uid, l));
    if (refund > 0) stmts.push(insertPayment(db, uid, { mode: refundMode, amount: neg(refund), reference: '' }, session.id, date));
    for (const l of retLines) if (l.item_id) stmts.push(...stockMove(db, l.item_id, -l.qty, 'Return', uid, c.user.id));
    stmts.push(prep(db, 'UPDATE invoices SET return_status = ?, outstanding = ?, status = ? WHERE id = ?',
      fullyReturned ? 'Returned' : 'Partly Returned', newOutstanding,
      newOutstanding > 0 ? (orig.paid_total > 0 ? 'Partly Paid' : 'Unpaid') : 'Paid', orig.id));
    await db.batch(stmts);

    const row = await first<{ id: number }>(db, 'SELECT id FROM invoices WHERE uid = ?', uid);
    return json({ ...(await loadInvoice(db, row!.id)), refund, credit_adjusted: creditAdjust }, { status: 201 });
  });

  /* ------------------------------------------------------------- cancel */
  r.post('/api/invoices/:id/cancel', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const b = await c.body<any>();
    const inv = await first<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id);
    if (!inv || inv.doc_type !== 'Invoice') notFound('Invoice not found');
    if (inv.status === 'Cancelled') bad('This invoice is already cancelled');
    if (await first(db, "SELECT id FROM invoices WHERE return_against = ? AND status <> 'Cancelled' LIMIT 1", id)) {
      bad('This invoice has returns against it, so it cannot be cancelled');
    }
    const lines = await all<LineRow>(db, 'SELECT * FROM invoice_items WHERE invoice_id = ?', id);
    const reason = str(b.reason, 120) || 'No reason given';
    const stmts = [prep(db,
      "UPDATE invoices SET status = 'Cancelled', outstanding = 0, cancelled_at = datetime('now'), notes = trim(notes || ' [Cancelled: ' || ? || ']') WHERE id = ?",
      reason, id)];
    for (const l of lines) if (l.item_id) stmts.push(...stockMove(db, l.item_id, l.qty, 'Cancelled', inv.uid, c.user.id));
    await db.batch(stmts);
    return json(await loadInvoice(db, id));
  }, 'admin');

  /* ------------------------------------------- receive payment on credit */
  r.post('/api/invoices/:id/payment', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const b = await c.body<any>();
    const [settings, session, inv] = await Promise.all([
      getSettings(db), openSessionFor(db, c.user.id), first<InvoiceRow>(db, 'SELECT * FROM invoices WHERE id = ?', id),
    ]);
    if (!inv || inv.doc_type !== 'Invoice') notFound('Invoice not found');
    if (inv.status === 'Cancelled') bad('This invoice is cancelled');
    if (!session) bad('Open your POS shift to receive payments');
    const [p] = normalisePayments([b], settings.payment_modes);
    if (!p) bad('Enter the amount received');
    if (p.amount > r2(inv.outstanding)) bad(`Only ₹${inv.outstanding} is due on this invoice`);
    const outstanding = r2(inv.outstanding - p.amount);
    await db.batch([
      insertPayment(db, inv.uid, p, session.id, istNow().date),
      prep(db, 'UPDATE invoices SET paid_total = round(paid_total + ?, 2), outstanding = ?, status = ? WHERE id = ?',
        p.amount, outstanding, outstanding > 0 ? 'Partly Paid' : 'Paid', id),
    ]);
    return json(await loadInvoice(db, id));
  });

  /* --------------------------------------------------- held / parked carts */
  r.get('/api/held', async (c) => {
    const rows = await all(c.env.DB, 'SELECT id, label, total, data, created_at FROM held_carts WHERE user_id = ? ORDER BY id DESC', c.user.id);
    return json({ held: rows.map((h) => ({ ...h, data: JSON.parse(h.data) })) });
  });

  r.post('/api/held', async (c) => {
    const b = await c.body<any>();
    const data = JSON.stringify(b.data ?? {});
    if (data.length > 100_000) bad('This cart is too large to hold');
    const count = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM held_carts WHERE user_id = ?', c.user.id);
    if ((count?.n ?? 0) >= 30) bad('You have 30 held bills. Resume or delete some first');
    await c.env.DB.prepare('INSERT INTO held_carts (user_id, label, total, data) VALUES (?, ?, ?, ?)')
      .bind(c.user.id, str(b.label, 60), r2(num(b.total)), data).run();
    return json({ ok: true }, { status: 201 });
  });

  r.delete('/api/held/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM held_carts WHERE id = ? AND user_id = ?').bind(int(c.params.id), c.user.id).run();
    return json({ ok: true });
  });
}
