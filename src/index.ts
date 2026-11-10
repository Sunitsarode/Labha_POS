/**
 * Niwas POS — Cloudflare Worker entry point.
 * /api/* is handled here (D1-backed JSON API); everything else is the static POS front-end.
 */
import { errorResponse } from './http';
import { Router } from './router';
import { registerAdmin } from './routes/admin';
import { registerAuth } from './routes/auth';
import { registerCustomers } from './routes/customers';
import { registerInvoices } from './routes/invoices';
import { registerItems } from './routes/items';
import { registerReports } from './routes/reports';
import { registerSessions } from './routes/sessions';

const router = new Router();
for (const register of [registerAuth, registerAdmin, registerItems, registerCustomers, registerSessions, registerInvoices, registerReports]) {
  register(router);
}

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await router.handle(req, env, url);
      } catch (e) {
        return errorResponse(e);
      }
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
