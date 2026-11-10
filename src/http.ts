export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function bad(message: string): never {
  throw new HttpError(400, message);
}
export function notFound(message = 'Not found'): never {
  throw new HttpError(404, message);
}
export function forbidden(message = 'You are not allowed to do this'): never {
  throw new HttpError(403, message);
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message }, { status: e.status });
  const msg = e instanceof Error ? e.message : String(e);
  if (/no such table/i.test(msg)) {
    return json(
      { error: 'Database is not initialised. Run the D1 migrations: npm run db:migrate:local (or db:migrate:remote).' },
      { status: 503 },
    );
  }
  console.error('Unhandled error', e);
  return json({ error: 'Something went wrong on the server. Please try again.' }, { status: 500 });
}

export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function cookieHeader(name: string, value: string, maxAge: number, secure: boolean): string {
  return [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, secure ? 'Secure' : '']
    .filter(Boolean)
    .join('; ');
}
