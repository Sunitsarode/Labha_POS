import { docNumber, istNow, r2, round, stateLabel } from '../../public/js/gst.js';
import { all, first } from '../db';
import { bad, json } from '../http';
import type { Ctx, Router } from '../router';
import { getSettings } from '../settings';
import type { Settings } from '../types';
import { isDate, num } from '../validate';

type Row = Record<string, any>;
const AMT_KEYS = ['txval', 'iamt', 'camt', 'samt', 'csamt'] as const;
type Amounts = Record<(typeof AMT_KEYS)[number], number>;

/** Reporting period from ?month=YYYY-MM or ?from=&to=. */
function period(c: Ctx) {
  const month = c.q('month');
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
  }
  const from = c.q('from');
  const to = c.q('to');
  if (!isDate(from) || !isDate(to)) bad('Choose a month or a from / to date range');
  if (from > to) bad('The start date is after the end date');
  return { from, to };
}

const amounts = (row: Row, sign = 1): Amounts => ({
  txval: r2(sign * num(row.txval)), iamt: r2(sign * num(row.iamt)), camt: r2(sign * num(row.camt)),
  samt: r2(sign * num(row.samt)), csamt: r2(sign * num(row.csamt)),
});
const isZero = (a: Amounts) => AMT_KEYS.every((k) => !a[k]);
function addUp(rows: Amounts[]): Amounts {
  const t: Amounts = { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
  for (const x of rows) for (const k of AMT_KEYS) t[k] = r2(t[k] + x[k]);
  return t;
}

const NIL_ROWS = [
  ['INTRB2B', 'Inter-State supplies to registered persons'],
  ['INTRAB2B', 'Intra-State supplies to registered persons'],
  ['INTRB2C', 'Inter-State supplies to unregistered persons'],
  ['INTRAB2C', 'Intra-State supplies to unregistered persons'],
] as const;

interface GstDoc { id: number; section: string; number: string; date: string; ctin: string; name: string; val: number; pos: string; rchrg: string; rows: (Amounts & { rt: number })[] }

/** All GSTR-1 tables for a period. Credit notes carry positive values (note type "C"). */
async function buildGstr1(db: D1Database, s: Settings, from: string, to: string) {
  const base = `FROM invoices i JOIN invoice_items l ON l.invoice_id = i.id
                WHERE i.date BETWEEN ? AND ? AND i.status <> 'Cancelled' AND i.tax_regime = 'Regular'`;
  const sums = 'SUM(l.taxable_value) AS txval, SUM(l.igst) AS iamt, SUM(l.cgst) AS camt, SUM(l.sgst) AS samt, SUM(l.cess) AS csamt';
  const [docRows, b2csRows, nilRows, hsnRows, issued, missing] = await Promise.all([
    all(db, `SELECT i.id, i.doc_type, i.number, i.date, i.customer_gstin, i.customer_name, i.grand_total, i.place_of_supply,
                    i.reverse_charge, i.gst_section, l.gst_rate AS rt, ${sums}
               ${base} AND i.gst_section IN ('B2B', 'B2CL', 'CDNR', 'CDNUR') AND l.gst_treatment = 'Taxable'
              GROUP BY i.id, l.gst_rate ORDER BY i.date, i.id, l.gst_rate`, from, to),
    all(db, `SELECT i.supply_type AS sply_ty, i.place_of_supply AS pos, l.gst_rate AS rt, ${sums}
               ${base} AND i.gst_section = 'B2CS' AND l.gst_treatment = 'Taxable'
              GROUP BY i.supply_type, i.place_of_supply, l.gst_rate ORDER BY i.place_of_supply, l.gst_rate`, from, to),
    all(db, `SELECT (CASE WHEN i.supply_type = 'INTER' THEN 'INTR' ELSE 'INTRA' END) ||
                    (CASE WHEN i.customer_gstin <> '' THEN 'B2B' ELSE 'B2C' END) AS sply_ty,
                    SUM(CASE WHEN l.gst_treatment = 'Nil-Rated' THEN l.taxable_value ELSE 0 END) AS nil_amt,
                    SUM(CASE WHEN l.gst_treatment = 'Exempted' THEN l.taxable_value ELSE 0 END) AS expt_amt,
                    SUM(CASE WHEN l.gst_treatment = 'Non-GST' THEN l.taxable_value ELSE 0 END) AS ngsup_amt
               ${base} AND l.gst_treatment <> 'Taxable' GROUP BY sply_ty`, from, to),
    all(db, `SELECT (CASE WHEN i.customer_gstin <> '' THEN 'B2B' ELSE 'B2C' END) AS grp, l.hsn, l.uom, l.gst_rate AS rt,
                    MAX(l.is_service) AS is_service, MAX(l.item_name) AS descr, SUM(l.qty) AS qty, SUM(l.total) AS val, ${sums}
               ${base} GROUP BY grp, l.hsn, l.uom, l.gst_rate ORDER BY grp, l.hsn, l.gst_rate`, from, to),
    all(db, `SELECT doc_type, series, MIN(seq) AS from_seq, MAX(seq) AS to_seq,
                    SUM(CASE WHEN status = 'Cancelled' THEN 1 ELSE 0 END) AS cancelled
               FROM invoices WHERE date BETWEEN ? AND ? AND tax_regime = 'Regular'
              GROUP BY doc_type, series ORDER BY doc_type, series`, from, to),
    first<{ n: number }>(db, `SELECT COUNT(*) AS n ${base} AND l.hsn = ''`, from, to),
  ]);

  const docs = new Map<number, GstDoc>();
  for (const row of docRows) {
    let d = docs.get(row.id);
    if (!d) {
      d = {
        id: row.id, section: row.gst_section, number: row.number, date: row.date, ctin: row.customer_gstin,
        name: row.customer_name, val: Math.abs(r2(row.grand_total)), pos: row.place_of_supply,
        rchrg: row.reverse_charge ? 'Y' : 'N', rows: [],
      };
      docs.set(row.id, d);
    }
    d.rows.push({ rt: num(row.rt), ...amounts(row, row.doc_type === 'Return' ? -1 : 1) });
  }
  const list = [...docs.values()];
  const section = (name: string) => list.filter((d) => d.section === name);

  const hsn = (grp: 'B2B' | 'B2C') => hsnRows.filter((x) => x.grp === grp).map((x) => {
    const service = !!x.is_service || String(x.hsn).startsWith('99');
    return {
      hsn: x.hsn as string, desc: String(x.descr ?? '').slice(0, 30), uqc: service ? 'NA' : (x.uom as string),
      qty: service ? 0 : round(x.qty, 3), rt: num(x.rt), val: r2(x.val), ...amounts(x),
    };
  });

  const result = {
    b2b: section('B2B'),
    b2cl: section('B2CL'),
    b2cs: b2csRows.map((x) => ({ sply_ty: x.sply_ty as string, pos: x.pos as string, rt: num(x.rt), ...amounts(x) })).filter((x) => !isZero(x)),
    cdnr: section('CDNR'),
    cdnur: section('CDNUR'),
    nil: NIL_ROWS.map(([key, desc]) => {
      const x = nilRows.find((n) => n.sply_ty === key) ?? {};
      return { sply_ty: key, desc, nil_amt: r2(x.nil_amt), expt_amt: r2(x.expt_amt), ngsup_amt: r2(x.ngsup_amt) };
    }),
    hsn_b2b: hsn('B2B'),
    hsn_b2c: hsn('B2C'),
    docs: issued.map((x) => ({
      doc_num: x.doc_type === 'Invoice' ? 1 : 5,
      nature: x.doc_type === 'Invoice' ? 'Invoices for outward supply' : 'Credit Note',
      from: docNumber(x.series, x.from_seq), to: docNumber(x.series, x.to_seq),
      total: x.to_seq - x.from_seq + 1, cancelled: num(x.cancelled),
    })),
  };

  const warnings: string[] = [];
  if (missing?.n) warnings.push(`${missing.n} invoice line(s) have no HSN/SAC code. Add HSN codes to those items before filing.`);
  if (s.registration_type !== 'Regular') warnings.push('GSTR-1 applies to regular taxpayers only. Your business is set up as ' + s.registration_type + '.');
  const summary = {
    b2b: { count: result.b2b.length, ...addUp(result.b2b.flatMap((d) => d.rows)) },
    b2cl: { count: result.b2cl.length, ...addUp(result.b2cl.flatMap((d) => d.rows)) },
    b2cs: { count: result.b2cs.length, ...addUp(result.b2cs) },
    cdnr: { count: result.cdnr.length, ...addUp(result.cdnr.flatMap((d) => d.rows)) },
    cdnur: { count: result.cdnur.length, ...addUp(result.cdnur.flatMap((d) => d.rows)) },
  };
  return { ...result, summary, warnings };
}

/**
 * GSTR-1 in the GST portal JSON layout. Treat it as a draft: import it into the GST Offline Tool
 * (or your GSP) to validate it before uploading, as the portal schema changes from time to time.
 */
function gstr1PortalJson(s: Settings, to: string, g: Awaited<ReturnType<typeof buildGstr1>>) {
  const dmy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
  const isInter = (pos: string) => pos !== s.state_code;
  const itms = (rows: GstDoc['rows'], inter: boolean) => rows.map((x, i) => ({
    num: i + 1,
    itm_det: { rt: x.rt, txval: x.txval, ...(inter ? { iamt: x.iamt } : { camt: x.camt, samt: x.samt }), csamt: x.csamt },
  }));
  const groupBy = <T>(arr: T[], key: (x: T) => string) => {
    const m = new Map<string, T[]>();
    for (const x of arr) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
    return [...m];
  };
  const out: Record<string, unknown> = { gstin: s.gstin, fp: to.slice(5, 7) + to.slice(0, 4), version: 'GST3.0.4', hash: 'hash' };
  if (g.b2b.length) {
    out.b2b = groupBy(g.b2b, (d) => d.ctin).map(([ctin, docs]) => ({
      ctin,
      inv: docs.map((d) => ({ inum: d.number, idt: dmy(d.date), val: d.val, pos: d.pos, rchrg: d.rchrg, inv_typ: 'R', itms: itms(d.rows, isInter(d.pos)) })),
    }));
  }
  if (g.b2cl.length) {
    out.b2cl = groupBy(g.b2cl, (d) => d.pos).map(([pos, docs]) => ({
      pos, inv: docs.map((d) => ({ inum: d.number, idt: dmy(d.date), val: d.val, itms: itms(d.rows, true) })),
    }));
  }
  if (g.b2cs.length) {
    out.b2cs = g.b2cs.map((x) => ({
      sply_ty: x.sply_ty, pos: x.pos, typ: 'OE', rt: x.rt, txval: x.txval,
      ...(x.sply_ty === 'INTER' ? { iamt: x.iamt } : { camt: x.camt, samt: x.samt }), csamt: x.csamt,
    }));
  }
  if (g.cdnr.length) {
    out.cdnr = groupBy(g.cdnr, (d) => d.ctin).map(([ctin, notes]) => ({
      ctin,
      nt: notes.map((d) => ({ ntty: 'C', nt_num: d.number, nt_dt: dmy(d.date), val: d.val, pos: d.pos, rchrg: d.rchrg, inv_typ: 'R', itms: itms(d.rows, isInter(d.pos)) })),
    }));
  }
  if (g.cdnur.length) {
    out.cdnur = g.cdnur.map((d) => ({ typ: 'B2CL', ntty: 'C', nt_num: d.number, nt_dt: dmy(d.date), val: d.val, pos: d.pos, itms: itms(d.rows, true) }));
  }
  const nil = g.nil.filter((x) => x.nil_amt || x.expt_amt || x.ngsup_amt);
  if (nil.length) out.nil = { inv: nil.map(({ desc: _desc, ...x }) => x) };
  const hsn = (rows: typeof g.hsn_b2b) => rows.map((x, i) => ({
    num: i + 1, hsn_sc: x.hsn, desc: x.desc, uqc: x.uqc, qty: x.qty, rt: x.rt,
    txval: x.txval, iamt: x.iamt, camt: x.camt, samt: x.samt, csamt: x.csamt,
  }));
  if (g.hsn_b2b.length || g.hsn_b2c.length) {
    out.hsn = { ...(g.hsn_b2b.length ? { hsn_b2b: hsn(g.hsn_b2b) } : {}), ...(g.hsn_b2c.length ? { hsn_b2c: hsn(g.hsn_b2c) } : {}) };
  }
  if (g.docs.length) {
    out.doc_issue = {
      doc_det: groupBy(g.docs, (d) => String(d.doc_num)).map(([docNum, docs]) => ({
        doc_num: Number(docNum), doc_typ: docs[0].nature,
        docs: docs.map((d, i) => ({ num: i + 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.total - d.cancelled })),
      })),
    };
  }
  return out;
}

export function registerReports(r: Router) {
  r.get('/api/reports/dashboard', async (c) => {
    const db = c.env.DB;
    const today = istNow().date;
    const monthStart = `${today.slice(0, 8)}01`;
    const start = istNow(Date.now() - 13 * 86_400_000).date;
    const live = "status <> 'Cancelled'";
    const [todayRow, monthRow, trendRows, modes, top, low, due] = await Promise.all([
      first(db, `SELECT SUM(CASE WHEN doc_type = 'Invoice' THEN 1 ELSE 0 END) AS bills, SUM(CASE WHEN doc_type = 'Return' THEN 1 ELSE 0 END) AS returns,
                        SUM(grand_total) AS net, SUM(tax_total) AS tax FROM invoices WHERE date = ? AND ${live}`, today),
      first(db, `SELECT SUM(CASE WHEN doc_type = 'Invoice' THEN 1 ELSE 0 END) AS bills, SUM(grand_total) AS net, SUM(tax_total) AS tax,
                        SUM(taxable_total) AS taxable FROM invoices WHERE date BETWEEN ? AND ? AND ${live}`, monthStart, today),
      all(db, `SELECT date, SUM(grand_total) AS net, SUM(CASE WHEN doc_type = 'Invoice' THEN 1 ELSE 0 END) AS bills
                 FROM invoices WHERE date BETWEEN ? AND ? AND ${live} GROUP BY date`, start, today),
      all(db, `SELECT p.mode, SUM(p.amount) AS amount FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
                WHERE p.date = ? AND i.${live} GROUP BY p.mode ORDER BY amount DESC`, today),
      all(db, `SELECT l.item_name AS name, SUM(l.qty) AS qty, SUM(l.total) AS amount FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
                WHERE i.date BETWEEN ? AND ? AND i.${live} GROUP BY l.item_id, l.item_name ORDER BY amount DESC LIMIT 5`, monthStart, today),
      all(db, `SELECT id, name, stock_qty, reorder_level, uom FROM items
                WHERE active = 1 AND track_stock = 1 AND stock_qty <= reorder_level ORDER BY stock_qty LIMIT 8`),
      first(db, `SELECT COUNT(*) AS n, SUM(outstanding) AS amount FROM invoices WHERE outstanding > 0 AND ${live}`),
    ]);
    const byDate = new Map(trendRows.map((x) => [x.date, x]));
    const trend = Array.from({ length: 14 }, (_, i) => {
      const date = istNow(Date.now() - (13 - i) * 86_400_000).date;
      const x = byDate.get(date);
      return { date, net: r2(x?.net), bills: num(x?.bills) };
    });
    return json({
      today: { date: today, bills: num(todayRow?.bills), returns: num(todayRow?.returns), net: r2(todayRow?.net), tax: r2(todayRow?.tax) },
      month: { from: monthStart, bills: num(monthRow?.bills), net: r2(monthRow?.net), tax: r2(monthRow?.tax), taxable: r2(monthRow?.taxable) },
      trend,
      payments: modes.map((x) => ({ mode: x.mode, amount: r2(x.amount) })),
      top_items: top.map((x) => ({ name: x.name, qty: round(x.qty, 3), amount: r2(x.amount) })),
      low_stock: low,
      receivables: { count: num(due?.n), amount: r2(due?.amount) },
    });
  }, 'admin');

  r.get('/api/reports/sales-register', async (c) => {
    const db = c.env.DB;
    const { from, to } = period(c);
    const [rows, modes] = await Promise.all([
      all(db, `SELECT id, number, doc_type, date, customer_name, customer_gstin, place_of_supply, gst_section, taxable_total,
                      cgst_total, sgst_total, igst_total, cess_total, round_off, grand_total, outstanding, status
                 FROM invoices WHERE date BETWEEN ? AND ? ORDER BY date, id`, from, to),
      all(db, `SELECT p.mode, SUM(p.amount) AS amount FROM invoice_payments p JOIN invoices i ON i.id = p.invoice_id
                WHERE p.date BETWEEN ? AND ? AND i.status <> 'Cancelled' GROUP BY p.mode ORDER BY amount DESC`, from, to),
    ]);
    const keys = ['taxable_total', 'cgst_total', 'sgst_total', 'igst_total', 'cess_total', 'round_off', 'grand_total', 'outstanding'];
    const totals: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const row of rows) if (row.status !== 'Cancelled') for (const k of keys) totals[k] = r2(totals[k] + num(row[k]));
    return json({ from, to, rows, totals, payments: modes.map((x) => ({ mode: x.mode, amount: r2(x.amount) })) });
  }, 'admin');

  r.get('/api/reports/item-sales', async (c) => {
    const { from, to } = period(c);
    const rows = await all(c.env.DB,
      `SELECT l.item_id, l.item_code, l.item_name, l.hsn, l.gst_rate,
              SUM(CASE WHEN l.qty > 0 THEN l.qty ELSE 0 END) AS sold_qty, -SUM(CASE WHEN l.qty < 0 THEN l.qty ELSE 0 END) AS returned_qty,
              SUM(l.taxable_value) AS taxable, SUM(l.cgst + l.sgst + l.igst + l.cess) AS tax, SUM(l.total) AS total
         FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id
        WHERE i.date BETWEEN ? AND ? AND i.status <> 'Cancelled'
        GROUP BY l.item_id, l.item_code, l.item_name ORDER BY total DESC`, from, to);
    return json({
      from, to,
      rows: rows.map((x) => ({
        ...x, sold_qty: round(x.sold_qty, 3), returned_qty: round(x.returned_qty, 3),
        net_qty: round(num(x.sold_qty) - num(x.returned_qty), 3), taxable: r2(x.taxable), tax: r2(x.tax), total: r2(x.total),
      })),
    });
  }, 'admin');

  r.get('/api/reports/gstr1', async (c) => {
    const db = c.env.DB;
    const { from, to } = period(c);
    const s = await getSettings(db);
    const g = await buildGstr1(db, s, from, to);
    if (c.q('format') === 'json') {
      const body = JSON.stringify(gstr1PortalJson(s, to, g), null, 2);
      const name = `GSTR1_${s.gstin || 'NOGSTIN'}_${to.slice(5, 7)}${to.slice(0, 4)}.json`;
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return json({ from, to, gstin: s.gstin, state_code: s.state_code, b2cl_limit: s.b2cl_limit, ...g });
  }, 'admin');

  r.get('/api/reports/gstr3b', async (c) => {
    const db = c.env.DB;
    const { from, to } = period(c);
    const s = await getSettings(db);
    const base = `FROM invoices i JOIN invoice_items l ON l.invoice_id = i.id WHERE i.date BETWEEN ? AND ? AND i.status <> 'Cancelled'`;
    if (s.registration_type !== 'Regular') {
      const t = await first(db, `SELECT SUM(l.taxable_value) AS turnover ${base}`, from, to);
      const turnover = r2(t?.turnover);
      const tax = r2((turnover * s.composition_rate) / 100);
      return json({ regime: s.registration_type, from, to, turnover, composition_rate: s.composition_rate, cgst: r2(tax / 2), sgst: r2(tax - r2(tax / 2)) });
    }
    const [a, unregistered] = await Promise.all([
      first(db, `SELECT SUM(CASE WHEN l.gst_treatment = 'Taxable' THEN l.taxable_value ELSE 0 END) AS txval,
                        SUM(l.igst) AS iamt, SUM(l.cgst) AS camt, SUM(l.sgst) AS samt, SUM(l.cess) AS csamt,
                        SUM(CASE WHEN l.gst_treatment IN ('Nil-Rated', 'Exempted') THEN l.taxable_value ELSE 0 END) AS nil_exempt,
                        SUM(CASE WHEN l.gst_treatment = 'Non-GST' THEN l.taxable_value ELSE 0 END) AS non_gst
                   ${base} AND i.tax_regime = 'Regular'`, from, to),
      all(db, `SELECT i.place_of_supply AS pos, SUM(l.taxable_value) AS txval, SUM(l.igst) AS iamt
                 ${base} AND i.tax_regime = 'Regular' AND i.supply_type = 'INTER' AND i.customer_gstin = '' AND l.gst_treatment = 'Taxable'
                GROUP BY i.place_of_supply ORDER BY i.place_of_supply`, from, to),
    ]);
    return json({
      regime: 'Regular', from, to,
      outward_taxable: amounts(a ?? {}),
      nil_exempt: r2(a?.nil_exempt),
      non_gst: r2(a?.non_gst),
      inter_state_unregistered: unregistered.map((x) => ({ pos: x.pos, pos_label: stateLabel(x.pos), txval: r2(x.txval), iamt: r2(x.iamt) })),
    });
  }, 'admin');
}
