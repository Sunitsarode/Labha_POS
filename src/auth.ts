import { first, prep, run } from './db';
import { cookieHeader, getCookie } from './http';
import type { User } from './types';

export const SESSION_COOKIE = 'pos_sid';
const SESSION_TTL_S = 7 * 24 * 3600;
/** The Workers runtime caps PBKDF2 at 100k iterations. */
const PBKDF2_ITERATIONS = 100_000;
const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split('$');
  const iterations = Number(iter);
  if (alg !== 'pbkdf2_sha256' || !salt || !hash || !(iterations > 0 && iterations <= PBKDF2_ITERATIONS)) return false;
  const expected = unb64(hash);
  const actual = await pbkdf2(password, unb64(salt), iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
  return b64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Creates a session and returns the Set-Cookie header value. */
export async function createSession(db: D1Database, userId: number, secure: boolean): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    prep(db, 'DELETE FROM auth_sessions WHERE expires_at < ?', now),
    prep(db, 'INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256Hex(token), userId, now + SESSION_TTL_S * 1000),
  ]);
  return cookieHeader(SESSION_COOKIE, token, SESSION_TTL_S, secure);
}

export async function sessionTokenHash(req: Request): Promise<string | null> {
  const token = getCookie(req, SESSION_COOKIE);
  return token && token.length <= 100 ? sha256Hex(token) : null;
}

export async function destroySession(db: D1Database, req: Request): Promise<void> {
  const hash = await sessionTokenHash(req);
  if (hash) await run(db, 'DELETE FROM auth_sessions WHERE token_hash = ?', hash);
}

export function clearSessionCookie(secure: boolean): string {
  return cookieHeader(SESSION_COOKIE, '', 0, secure);
}

export async function currentUser(req: Request, db: D1Database): Promise<User | null> {
  const hash = await sessionTokenHash(req);
  if (!hash) return null;
  return first<User>(
    db,
    `SELECT u.id, u.username, u.full_name, u.role
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
    hash,
    Date.now(),
  );
}
