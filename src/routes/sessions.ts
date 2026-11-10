import { istNow, r2 } from '../../public/js/gst.js';
import { all, first, run } from '../db';
import { bad, forbidden, json, notFound } from '../http';
import type { Router } from '../router';
import { getSettings } from '../settings';
import type { SessionRow, User } from '../types';
import { clampInt, int, num, text } from '../validate';

export function openSessionFor(db: D1Database, userId: number) {
  return first<SessionRow>(db, "SELECT * FROM pos_sessions WHERE user_id = ? AND status = 'Open'", userId);
}

const nowStamp = () => { const t = istNow(); return `${t.date} ${t.time}`; };

/** Shift summary (ERPNext "POS Closing Entry"): sales, returns and expected money per payment mode. */
export async function sessionSummary(db: D1Database, s: SessionRow) {
  const [docs, pays, cancelled] = await Promise.all([
    all(db, `SELECT doc_type, COUNT(*) AS n, SUM(grand_total) AS total, SUM(taxable_total) AS taxable, SUM(tax_total) AS tax,
                    SUM(discount_total) AS discount, SUM(outstanding) AS credit
               FROM invoices WHERE session_id = ? AND status <> 'Cancelled' GROUP BY doc_type`, s.id),
    all<{ mode: string; amount: number }>(db, `SELECT p.mode, SUM(p.amount) AS amount FROM invoice_payments p
               JOIN invoices i ON i.id = p.invoice_id
              WHERE p.session_id = ? AND i.status <> 'Cancelled' GROUP BY p.mode ORDER BY p.mode`, s.id),
    first(db, `SELECT COUNT(*) AS n, COALESCE(SUM(grand_total), 0) AS total FROM invoices WHERE session_id = ? AND status = 'Cancelled'`, s.id),
  ]);
  const pick = (t: string) => {
    const d = docs.find((x) => x.doc_type === t);
    return { count: d?.n ?? 0, total: r2(d?.total), taxable: r2(d?.taxable), tax: r2(d?.tax), discount: r2(d?.discount), credit: r2(d?.credit) };
  };
  const payments: Record<string, number> = {};
  for (const p of pays) payments[p.mode] = r2(p.amount);
  const expected: Record<string, number> = { Cash: r2(s.opening_cash + (payments.Cash ?? 0)) };
  for (const [mode, amount] of Object.entries(payments)) if (mode !== 'Cash') expected[mode] = amount;
  return { sales: pick('Invoice'), returns: pick('Return'), payments, expected, cancelled: { count: cancelled?.n ?? 0, total: r2(cancelled?.total) } };
}

async function loadSession(db: D1Database, id: number, user: User) {
  const s = await first<SessionRow & { username: string; full_name: string }>(db,
    'SELECT s.*, u.username, u.full_name FROM pos_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', id);
  if (!s) notFound('Shift not found');
  if (user.role !== 'admin' && s.user_id !== user.id) forbidden('You can only view your own shifts');
  return s;
}

export function registerSessions(r: Router) {
  r.get('/api/sessions/current', async (c) => {
    const s = await openSessionFor(c.env.DB, c.user.id);
    return json({ session: s, summary: s ? await sessionSummary(c.env.DB, s) : null });
  });

  r.post('/api/sessions/open', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    if (await openSessionFor(db, c.user.id)) bad('You already have an open shift');
    const opening = r2(num(b.opening_cash));
    if (opening < 0 || opening > 1e8) bad('Invalid opening cash amount');
    await run(db, "INSERT INTO pos_sessions (user_id, status, opening_cash, opened_at, notes) VALUES (?, 'Open', ?, ?, ?)",
      c.user.id, opening, nowStamp(), text(b.notes, 300));
    const s = await openSessionFor(db, c.user.id);
    return json({ session: s, summary: await sessionSummary(db, s!) }, { status: 201 });
  });

  r.get('/api/sessions', async (c) => {
    const limit = clampInt(c.q('limit'), 1, 200, 50);
    const mine = c.user.role !== 'admin';
    const sessions = await all(c.env.DB,
      `SELECT s.id, s.status, s.opening_cash, s.opened_at, s.closed_at, s.closing, u.username, u.full_name,
              (SELECT COUNT(*) FROM invoices i WHERE i.session_id = s.id AND i.doc_type = 'Invoice' AND i.status <> 'Cancelled') AS bills,
              (SELECT COALESCE(SUM(grand_total), 0) FROM invoices i WHERE i.session_id = s.id AND i.status <> 'Cancelled') AS net
         FROM pos_sessions s JOIN users u ON u.id = s.user_id
        ${mine ? 'WHERE s.user_id = ?' : ''} ORDER BY s.id DESC LIMIT ?`,
      ...(mine ? [c.user.id] : []), limit);
    return json({ sessions: sessions.map((s) => ({ ...s, closing: s.closing ? JSON.parse(s.closing) : null })) });
  });

  r.get('/api/sessions/:id', async (c) => {
    const s = await loadSession(c.env.DB, int(c.params.id), c.user);
    return json({ session: { ...s, closing: s.closing ? JSON.parse(s.closing) : null }, summary: await sessionSummary(c.env.DB, s) });
  });

  /** Close a shift with the counted amounts per payment mode; differences are recorded. */
  r.post('/api/sessions/:id/close', async (c) => {
    const db = c.env.DB;
    const s = await loadSession(db, int(c.params.id), c.user);
    if (s.status !== 'Open') bad('This shift is already closed');
    const b = await c.body<any>();
    const [summary, settings] = await Promise.all([sessionSummary(db, s), getSettings(db)]);
    const modes = [...new Set([...settings.payment_modes, ...Object.keys(summary.expected)])];
    const counted: Record<string, number> = {};
    const difference: Record<string, number> = {};
    for (const m of modes) {
      counted[m] = r2(num(b.counted?.[m], summary.expected[m] ?? 0));
      difference[m] = r2(counted[m] - (summary.expected[m] ?? 0));
    }
    const closing = { expected: summary.expected, counted, difference, sales: summary.sales, returns: summary.returns, cancelled: summary.cancelled };
    const res = await run(db,
      "UPDATE pos_sessions SET status = 'Closed', closed_at = ?, closing = ?, notes = trim(notes || ' ' || ?) WHERE id = ? AND status = 'Open'",
      nowStamp(), JSON.stringify(closing), text(b.notes, 300), s.id);
    if (!res.meta.changes) bad('This shift is already closed');
    return json({ ok: true, closing });
  });
}
