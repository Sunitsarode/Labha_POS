import { hashPassword } from '../auth';
import { all, first, prep, run } from '../db';
import { bad, json, notFound } from '../http';
import type { Router } from '../router';
import { getSettings, validateSettings } from '../settings';
import type { Role } from '../types';
import { bool, int, oneOf, str } from '../validate';
import { checkPassword, checkUsername } from './auth';

const ROLES: readonly Role[] = ['admin', 'cashier'];

export function registerAdmin(r: Router) {
  r.get('/api/settings', async (c) => json({ settings: await getSettings(c.env.DB) }));

  r.put('/api/settings', async (c) => {
    const db = c.env.DB;
    const next = validateSettings(await c.body(), await getSettings(db));
    await run(db, "UPDATE settings SET data = ?, updated_at = datetime('now') WHERE id = 1", JSON.stringify(next));
    return json({ settings: next });
  }, 'admin');

  r.get('/api/users', async (c) => {
    const users = await all(c.env.DB, 'SELECT id, username, full_name, role, active, created_at FROM users ORDER BY id');
    return json({ users });
  }, 'admin');

  r.post('/api/users', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const username = checkUsername(b.username);
    const password = checkPassword(b.password);
    if (await first(db, 'SELECT id FROM users WHERE username = ?', username)) bad('That username is already taken');
    await run(db, 'INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)',
      username, str(b.full_name, 80), await hashPassword(password), oneOf(b.role, ROLES, 'cashier'));
    return json({ ok: true }, { status: 201 });
  }, 'admin');

  r.put('/api/users/:id', async (c) => {
    const db = c.env.DB;
    const id = int(c.params.id);
    const b = await c.body<any>();
    const u = await first<{ id: number; full_name: string; role: Role; active: number }>(db, 'SELECT id, full_name, role, active FROM users WHERE id = ?', id);
    if (!u) notFound('User not found');

    const role = oneOf(b.role, ROLES, u.role);
    const active = b.active === undefined ? !!u.active : bool(b.active);
    if (u.role === 'admin' && (role !== 'admin' || !active)) {
      const others = await first<{ n: number }>(db, "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND id <> ?", id);
      if (!others?.n) bad('There must be at least one active admin');
    }
    const stmts = [prep(db, 'UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?',
      b.full_name === undefined ? u.full_name : str(b.full_name, 80), role, active ? 1 : 0, id)];
    if (b.password) stmts.push(prep(db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(checkPassword(b.password)), id));
    // Sign the user out everywhere when their access changes (but never the admin making the change).
    if (id !== c.user.id && (b.password || !active || role !== u.role)) {
      stmts.push(prep(db, 'DELETE FROM auth_sessions WHERE user_id = ?', id));
    }
    await db.batch(stmts);
    return json({ ok: true });
  }, 'admin');
}
