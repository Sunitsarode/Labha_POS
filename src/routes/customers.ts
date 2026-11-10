import { isValidState, validateGSTIN } from '../../public/js/gst.js';
import { all, first, run } from '../db';
import { bad, json, notFound } from '../http';
import type { Router } from '../router';
import { clampInt, int, str, text } from '../validate';

function validateCustomer(b: any) {
  const name = str(b.name, 120);
  if (!name) bad('Customer name is required');
  const phone = str(b.phone, 20);
  if (phone && !/^[0-9+\-\s()]{6,20}$/.test(phone)) bad('Phone number looks invalid');
  const email = str(b.email, 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad('Email address looks invalid');
  let gstin = str(b.gstin, 20).toUpperCase();
  let state_code = str(b.state_code, 2);
  if (gstin) {
    const g = validateGSTIN(gstin);
    if (!g.ok) bad(g.error);
    gstin = g.gstin;
    state_code = g.state; // a registered customer's state is fixed by the GSTIN
  }
  if (state_code && !isValidState(state_code)) bad('Invalid state');
  return { name, phone, email, gstin, state_code, address: text(b.address, 300) };
}

const LIST_SQL = `SELECT c.*, COALESCE((SELECT SUM(i.outstanding) FROM invoices i
                    WHERE i.customer_id = c.id AND i.status <> 'Cancelled'), 0) AS outstanding
                    FROM customers c`;

export function registerCustomers(r: Router) {
  r.get('/api/customers', async (c) => {
    const q = c.q('q');
    const limit = clampInt(c.q('limit'), 1, 1000, 200);
    const like = `%${q}%`;
    const customers = q
      ? await all(c.env.DB, `${LIST_SQL} WHERE c.name LIKE ? OR c.phone LIKE ? OR c.gstin LIKE ? ORDER BY c.name COLLATE NOCASE LIMIT ?`, like, like, like, limit)
      : await all(c.env.DB, `${LIST_SQL} ORDER BY c.name COLLATE NOCASE LIMIT ?`, limit);
    return json({ customers });
  });

  r.get('/api/customers/:id', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const customer = await first(db, `${LIST_SQL} WHERE c.id = ?`, id);
    if (!customer) notFound('Customer not found');
    const invoices = await all(db,
      `SELECT id, number, doc_type, date, grand_total, outstanding, status FROM invoices WHERE customer_id = ? ORDER BY id DESC LIMIT 50`, id);
    return json({ customer, invoices });
  });

  r.post('/api/customers', async (c) => {
    const db = c.env.DB;
    const v = validateCustomer(await c.body());
    const res = await run(db, 'INSERT INTO customers (name, phone, email, gstin, state_code, address) VALUES (?, ?, ?, ?, ?, ?)',
      v.name, v.phone, v.email, v.gstin, v.state_code, v.address);
    const customer = await first(db, `${LIST_SQL} WHERE c.id = ?`, res.meta.last_row_id);
    return json({ customer }, { status: 201 });
  });

  r.put('/api/customers/:id', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const v = validateCustomer(await c.body());
    const res = await run(db,
      `UPDATE customers SET name = ?, phone = ?, email = ?, gstin = ?, state_code = ?, address = ?, updated_at = datetime('now') WHERE id = ?`,
      v.name, v.phone, v.email, v.gstin, v.state_code, v.address, id);
    if (!res.meta.changes) notFound('Customer not found');
    return json({ customer: await first(db, `${LIST_SQL} WHERE c.id = ?`, id) });
  });
}
