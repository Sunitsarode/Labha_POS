import {
  clearSessionCookie, createSession, currentUser, destroySession, hashPassword, sessionTokenHash, verifyPassword,
} from '../auth';
import { first, prep, run } from '../db';
import { bad, forbidden, HttpError, json } from '../http';
import type { Router } from '../router';
import { sampleStatements } from '../sample';
import { getSettings, validateSettings } from '../settings';
import { bool, str } from '../validate';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export function checkUsername(v: unknown): string {
  const u = str(v, 40);
  if (!USERNAME_RE.test(u)) bad('Username must be 3–32 characters: letters, digits, dot, dash or underscore');
  return u;
}

export function checkPassword(v: unknown): string {
  const p = typeof v === 'string' ? v : '';
  if (p.length < 8) bad('Password must be at least 8 characters');
  if (p.length > 200) bad('Password is too long');
  return p;
}

const setupKey = (env: Env) => (env as unknown as { SETUP_KEY?: string }).SETUP_KEY || '';

export function registerAuth(r: Router) {
  /** First call the app makes: is the store set up, who am I, and the store settings. */
  r.get('/api/bootstrap', async (c) => {
    const db = c.env.DB;
    const anyUser = await first(db, 'SELECT id FROM users LIMIT 1');
    if (!anyUser) {
      return json({ setup_done: false, setup_key_required: !!setupKey(c.env), user: null, settings: null });
    }
    const [user, settings] = await Promise.all([currentUser(c.req, db), getSettings(db)]);
    return json({
      setup_done: true,
      user,
      settings: user ? settings : { company_name: settings.company_name },
    });
  }, 'public');

  /** First-run wizard (Frappe Books style): company + GST details and the admin account. */
  r.post('/api/setup', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const key = setupKey(c.env);
    if (key && b.setup_key !== key) forbidden('Invalid setup key');
    if (await first(db, 'SELECT id FROM users LIMIT 1')) forbidden('This store is already set up');

    const settings = validateSettings(b.company);
    const username = checkUsername(b.admin?.username);
    const password = checkPassword(b.admin?.password);
    const stmts = [
      // Plain INSERT (no upsert): if two setup requests race, the second one fails atomically.
      prep(db, 'INSERT INTO settings (id, data) VALUES (1, ?)', JSON.stringify(settings)),
      prep(db, "INSERT INTO users (username, full_name, password_hash, role) VALUES (?, ?, ?, 'admin')",
        username, str(b.admin?.full_name, 80), await hashPassword(password)),
    ];
    if (bool(b.sample_data)) stmts.push(...sampleStatements(db, settings.state_code));
    await db.batch(stmts);

    const user = await first<{ id: number }>(db, 'SELECT id FROM users WHERE username = ?', username);
    const cookie = await createSession(db, user!.id, c.secure);
    return json({ ok: true }, { status: 201, headers: { 'Set-Cookie': cookie } });
  }, 'public');

  r.post('/api/auth/login', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const username = str(b.username, 40);
    const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
    if (!username || !password) bad('Enter your username and password');

    const now = Date.now();
    const ip = c.req.headers.get('CF-Connecting-IP') || 'local';
    const kUser = `u:${username.toLowerCase()}`;
    const kIp = `ip:${ip}`;
    const recent = await first<{ u: number | null; i: number | null }>(
      db,
      `SELECT SUM(CASE WHEN key = ? THEN 1 ELSE 0 END) AS u, SUM(CASE WHEN key = ? THEN 1 ELSE 0 END) AS i
         FROM login_attempts WHERE key IN (?, ?) AND ts > ?`,
      kUser, kIp, kUser, kIp, now - ATTEMPT_WINDOW_MS,
    );
    if ((recent?.u ?? 0) >= 10 || (recent?.i ?? 0) >= 50) {
      throw new HttpError(429, 'Too many failed sign-in attempts. Please wait 15 minutes and try again.');
    }

    const user = await first<{ id: number; password_hash: string }>(
      db, 'SELECT id, password_hash FROM users WHERE username = ? AND active = 1', username,
    );
    const ok = user ? await verifyPassword(password, user.password_hash) : false;
    if (!user || !ok) {
      await db.batch([
        prep(db, 'INSERT INTO login_attempts (key, ts) VALUES (?, ?)', kUser, now),
        prep(db, 'INSERT INTO login_attempts (key, ts) VALUES (?, ?)', kIp, now),
      ]);
      throw new HttpError(401, 'Incorrect username or password');
    }
    await run(db, 'DELETE FROM login_attempts WHERE key = ? OR ts < ?', kUser, now - 24 * 3600 * 1000);
    const cookie = await createSession(db, user.id, c.secure);
    return json({ ok: true }, { headers: { 'Set-Cookie': cookie } });
  }, 'public');

  r.post('/api/auth/logout', async (c) => {
    await destroySession(c.env.DB, c.req);
    return json({ ok: true }, { headers: { 'Set-Cookie': clearSessionCookie(c.secure) } });
  }, 'public');

  /** Change own password; signs out the user's other devices. */
  r.post('/api/auth/password', async (c) => {
    const db = c.env.DB;
    const b = await c.body<any>();
    const row = await first<{ password_hash: string }>(db, 'SELECT password_hash FROM users WHERE id = ?', c.user.id);
    if (!row || !(await verifyPassword(String(b.current_password ?? ''), row.password_hash))) {
      bad('Current password is incorrect');
    }
    const next = checkPassword(b.new_password);
    await db.batch([
      prep(db, 'UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(next), c.user.id),
      prep(db, 'DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?', c.user.id, await sessionTokenHash(c.req)),
    ]);
    return json({ ok: true });
  });
}
