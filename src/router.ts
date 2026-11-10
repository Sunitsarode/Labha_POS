import { currentUser } from './auth';
import { HttpError, json } from './http';
import type { User } from './types';

/** public: anyone · user: any signed-in user · admin: admins only */
export type Access = 'public' | 'user' | 'admin';

export interface Ctx {
  req: Request;
  env: Env;
  url: URL;
  params: Record<string, string>;
  /** Signed-in user (only meaningful on 'user' / 'admin' routes). */
  user: User;
  /** Trimmed query-string value ('' when absent). */
  q(name: string): string;
  body<T = any>(): Promise<T>;
  /** true when served over HTTPS (controls the Secure cookie flag). */
  secure: boolean;
}

type Handler = (c: Ctx) => Promise<Response>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  access: Access;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  private add(method: string, path: string, handler: Handler, access: Access) {
    const keys: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_m, k: string) => {
      keys.push(k);
      return '([^/]+)';
    });
    this.routes.push({ method, re: new RegExp(`^${pattern}/?$`), keys, access, handler });
  }

  get(path: string, handler: Handler, access: Access = 'user') { this.add('GET', path, handler, access); }
  post(path: string, handler: Handler, access: Access = 'user') { this.add('POST', path, handler, access); }
  put(path: string, handler: Handler, access: Access = 'user') { this.add('PUT', path, handler, access); }
  delete(path: string, handler: Handler, access: Access = 'user') { this.add('DELETE', path, handler, access); }

  async handle(req: Request, env: Env, url: URL): Promise<Response> {
    const allowed = new Set<string>();
    for (const route of this.routes) {
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      if (route.method !== req.method) {
        allowed.add(route.method);
        continue;
      }
      if (req.method !== 'GET') assertSameOriginJson(req, url);

      let user: User | null = null;
      if (route.access !== 'public') {
        user = await currentUser(req, env.DB);
        if (!user) throw new HttpError(401, 'Please sign in to continue');
        if (route.access === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Only an admin can do this');
      }

      let body: Promise<any> | undefined;
      const ctx: Ctx = {
        req,
        env,
        url,
        user: user as User,
        params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])),
        q: (name) => (url.searchParams.get(name) ?? '').trim(),
        body: () =>
          (body ??= req.json().catch(() => {
            throw new HttpError(400, 'Request body must be valid JSON');
          })),
        secure: url.protocol === 'https:',
      };
      return route.handler(ctx);
    }
    if (allowed.size) {
      return json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: [...allowed].join(', ') } });
    }
    return json({ error: 'Not found' }, { status: 404 });
  }
}

/**
 * CSRF defence for cookie-authenticated writes: the browser must be on our own origin, and the
 * request must be JSON (a cross-site HTML form cannot send application/json without CORS).
 */
function assertSameOriginJson(req: Request, url: URL) {
  const origin = req.headers.get('Origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request blocked');
  const type = (req.headers.get('Content-Type') || '').toLowerCase();
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Requests must be sent as application/json');
}
