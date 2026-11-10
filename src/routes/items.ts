import { GST_RATES, GST_TREATMENTS, r2, round, UQC_CODES, validateHSN } from '../../public/js/gst.js';
import { all, first, prep, run } from '../db';
import { bad, json, notFound } from '../http';
import type { Router } from '../router';
import type { ItemRow } from '../types';
import { bool, clampInt, int, num, oneOf, str } from '../validate';

const COLS = `id, code, name, category, hsn, is_service, uom, rate, mrp, gst_treatment, gst_rate, cess_rate, barcode,
              track_stock, stock_qty, reorder_level, active, updated_at`;

interface ItemInput {
  code: string; name: string; category: string; hsn: string; is_service: number; uom: string; rate: number; mrp: number;
  gst_treatment: string; gst_rate: number; cess_rate: number; barcode: string; track_stock: number; reorder_level: number; active: number;
}

/** Validates an item; `prefix` is prepended to error messages (used by CSV import). */
export function validateItem(b: any, prefix = ''): ItemInput {
  const fail = (m: string): never => bad(prefix + m);
  const code = str(b.code, 40);
  if (!code) fail('Item code is required');
  const name = str(b.name, 140);
  if (!name) fail('Item name is required');
  const is_service = bool(b.is_service);
  const hsn = str(b.hsn, 12).replace(/\s+/g, '');
  const hsnError = validateHSN(hsn, is_service);
  if (hsnError) fail(hsnError);

  const uomIn = str(b.uom, 3).toUpperCase();
  const uom = UQC_CODES.has(uomIn) ? uomIn : 'NOS';
  const gst_treatment = oneOf(b.gst_treatment, GST_TREATMENTS as readonly string[], 'Taxable');
  let gst_rate = 0;
  let cess_rate = 0;
  if (gst_treatment === 'Taxable') {
    gst_rate = num(b.gst_rate, -1);
    if (!(GST_RATES.includes(gst_rate) && gst_rate > 0)) fail('Choose a valid GST rate (e.g. 5, 18 or 40), or mark the item Nil-Rated / Exempted');
    cess_rate = num(b.cess_rate);
    if (cess_rate < 0 || cess_rate > 400) fail('Cess rate must be between 0 and 400%');
  }
  const rate = r2(num(b.rate));
  if (rate < 0 || rate > 1e8) fail('Invalid selling price');
  const mrp = r2(num(b.mrp));
  if (mrp < 0 || mrp > 1e8) fail('Invalid MRP');
  const reorder_level = round(num(b.reorder_level), 3);
  if (reorder_level < 0) fail('Re-order level cannot be negative');

  return {
    code, name, category: str(b.category, 60), hsn, is_service: is_service ? 1 : 0, uom, rate, mrp,
    gst_treatment, gst_rate, cess_rate, barcode: str(b.barcode, 64),
    track_stock: !is_service && (b.track_stock === undefined || bool(b.track_stock)) ? 1 : 0,
    reorder_level, active: b.active === undefined || bool(b.active) ? 1 : 0,
  };
}

const FIELDS = ['code', 'name', 'category', 'hsn', 'is_service', 'uom', 'rate', 'mrp', 'gst_treatment', 'gst_rate', 'cess_rate',
  'barcode', 'track_stock', 'reorder_level', 'active'] as const;

function insertItem(db: D1Database, it: ItemInput, stock: number) {
  return prep(db, `INSERT INTO items (${FIELDS.join(', ')}, stock_qty) VALUES (${FIELDS.map(() => '?').join(', ')}, ?)`,
    ...FIELDS.map((f) => it[f]), stock);
}

function updateItem(db: D1Database, id: number, it: ItemInput) {
  return prep(db, `UPDATE items SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...FIELDS.map((f) => it[f]), id);
}

function openingMove(db: D1Database, code: string, qty: number, ref: string, userId: number) {
  return prep(db, `INSERT INTO stock_moves (item_id, qty, reason, ref, user_id) SELECT id, ?, 'Opening', ?, ? FROM items WHERE code = ?`,
    qty, ref, userId, code);
}

async function assertUniqueBarcode(db: D1Database, barcode: string, exceptId = 0) {
  if (!barcode) return;
  const other = await first<{ name: string }>(db, 'SELECT name FROM items WHERE barcode = ? AND id <> ? LIMIT 1', barcode, exceptId);
  if (other) bad(`Barcode ${barcode} is already used by "${other.name}"`);
}

export function registerItems(r: Router) {
  r.get('/api/items', async (c) => {
    const where: string[] = [];
    const args: unknown[] = [];
    const status = c.q('status') || 'active';
    if (status === 'active') where.push('active = 1');
    else if (status === 'inactive') where.push('active = 0');
    const category = c.q('category');
    if (category) { where.push('category = ?'); args.push(category); }
    const q = c.q('q');
    if (q) {
      where.push('(name LIKE ? OR code LIKE ? OR barcode = ? OR hsn LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, q, `${q}%`);
    }
    if (c.q('low') === '1') where.push('track_stock = 1 AND stock_qty <= reorder_level');
    const limit = clampInt(c.q('limit'), 1, 20000, 1000);
    const items = await all(c.env.DB,
      `SELECT ${COLS} FROM items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name COLLATE NOCASE LIMIT ?`,
      ...args, limit);
    return json({ items });
  });

  r.get('/api/items/categories', async (c) => {
    const rows = await all<{ category: string }>(c.env.DB, "SELECT DISTINCT category FROM items WHERE category <> '' ORDER BY category COLLATE NOCASE");
    return json({ categories: rows.map((x) => x.category) });
  });

  r.post('/api/items', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const it = validateItem(b);
    if (await first(db, 'SELECT id FROM items WHERE code = ?', it.code)) bad(`Item code ${it.code} already exists`);
    await assertUniqueBarcode(db, it.barcode);
    const stock = it.track_stock ? round(num(b.opening_stock), 3) : 0;
    const stmts = [insertItem(db, it, stock)];
    if (stock) stmts.push(openingMove(db, it.code, stock, 'Opening stock', c.user.id));
    await db.batch(stmts);
    return json({ item: await first(db, `SELECT ${COLS} FROM items WHERE code = ?`, it.code) }, { status: 201 });
  }, 'admin');

  r.put('/api/items/:id', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    if (!(await first(db, 'SELECT id FROM items WHERE id = ?', id))) notFound('Item not found');
    const it = validateItem(await c.body());
    if (await first(db, 'SELECT id FROM items WHERE code = ? AND id <> ?', it.code, id)) bad(`Item code ${it.code} already exists`);
    await assertUniqueBarcode(db, it.barcode, id);
    await db.batch([updateItem(db, id, it)]);
    return json({ item: await first(db, `SELECT ${COLS} FROM items WHERE id = ?`, id) });
  }, 'admin');

  /** Deletes an unused item; items already billed are archived instead (invoices keep their history). */
  r.delete('/api/items/:id', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    if (await first(db, 'SELECT id FROM invoice_items WHERE item_id = ? LIMIT 1', id)) {
      await run(db, "UPDATE items SET active = 0, updated_at = datetime('now') WHERE id = ?", id);
      return json({ archived: true });
    }
    await run(db, 'DELETE FROM items WHERE id = ?', id);
    return json({ deleted: true });
  }, 'admin');

  /** Stock adjustment (ERPNext "Stock Reconciliation"): set the counted quantity, or add/remove. */
  r.post('/api/items/:id/stock', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const b = await c.body<any>();
    const it = await first<ItemRow>(db, 'SELECT * FROM items WHERE id = ?', id);
    if (!it) notFound('Item not found');
    if (!it.track_stock) bad('Stock is not tracked for this item');
    const qty = round(num(b.qty), 3);
    const delta = b.mode === 'set' ? round(qty - it.stock_qty, 3) : qty;
    if (delta) {
      await db.batch([
        prep(db, "UPDATE items SET stock_qty = round(stock_qty + ?, 3), updated_at = datetime('now') WHERE id = ?", delta, id),
        prep(db, "INSERT INTO stock_moves (item_id, qty, reason, ref, user_id) VALUES (?, ?, 'Adjustment', ?, ?)",
          id, delta, str(b.reason, 80) || (b.mode === 'set' ? 'Stock count' : 'Manual'), c.user.id),
      ]);
    }
    return json({ item: await first(db, `SELECT ${COLS} FROM items WHERE id = ?`, id) });
  }, 'admin');

  r.get('/api/items/:id/moves', async (c) => {
    const moves = await all(c.env.DB,
      `SELECT m.qty, m.reason, m.ref, m.created_at, u.username FROM stock_moves m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 100`, int(c.params.id));
    return json({ moves });
  });

  /** Bulk import / update from CSV rows (matched on item code). */
  r.post('/api/items/import', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
    if (!rows.length) bad('No rows to import');
    if (rows.length > 2000) bad('Import at most 2000 rows at a time');

    const existing = new Map(
      (await all<{ id: number; code: string }>(db, 'SELECT id, code FROM items')).map((x) => [x.code.toLowerCase(), x.id]),
    );
    const stmts: D1PreparedStatement[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    let created = 0;
    let updated = 0;
    rows.forEach((row, i) => {
      try {
        const it = validateItem(row, `Row ${i + 2}: `);
        const key = it.code.toLowerCase();
        if (seen.has(key)) bad(`Row ${i + 2}: duplicate item code ${it.code} in file`);
        seen.add(key);
        const id = existing.get(key);
        if (id) {
          stmts.push(updateItem(db, id, it));
          updated++;
        } else {
          const stock = it.track_stock ? round(num(row.stock ?? row.opening_stock), 3) : 0;
          stmts.push(insertItem(db, it, stock));
          if (stock) stmts.push(openingMove(db, it.code, stock, 'CSV import', c.user.id));
          created++;
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    });
    if (errors.length) return json({ error: `${errors.length} row(s) have problems. Nothing was imported.`, errors: errors.slice(0, 50) }, { status: 400 });
    for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
    return json({ created, updated });
  }, 'admin');
}
