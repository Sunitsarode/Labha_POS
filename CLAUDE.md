# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Niwas POS: an Indian GST point-of-sale web app (modelled on ERPNext POS and Frappe Books) running as one
Cloudflare Worker. The TypeScript JSON API sits under `/api/*`, D1 (SQLite) holds the data, and the front end
is no-build HTML/JS served as Workers Static Assets from `public/`. `README.md` has the user-facing feature
list and deploy steps.

## Commands

```bash
npm run db:migrate:local     # apply migrations/ to the local D1 (needed after a fresh clone or a database_id change)
npm run dev                  # wrangler dev → http://127.0.0.1:8787 (hot-reloads src/ and public/)
npm test                     # GST engine unit tests (node:test)
node --test --test-name-pattern="GSTIN" test/gst.test.js   # run a single test by name
npm run smoke                # end-to-end API test against a running dev server (see below)
npm run typecheck            # tsc --noEmit (TypeScript 7); covers src/ only
npm run types                # regenerate worker-configuration.d.ts after changing wrangler.jsonc bindings
npm run db:migrate:remote    # apply migrations to the production D1
npm run deploy               # wrangler deploy → https://niwas-pos.niwas-pos.workers.dev
```

- There is no linter and no front-end build. Check browser modules with `node --check public/js/views/x.js` (package.json is `"type": "module"`).
- `test/api.smoke.mjs` runs the setup wizard itself on an empty database, otherwise it needs `POS_USER` / `POS_PASS` (admin). `POS_URL` targets another host. It creates data, so reset the local DB (`Remove-Item -Recurse .wrangler/state/v3/d1`, then `db:migrate:local`) for a clean run. Exact shift-cash assertions only run when the test opened the shift itself.
- Local D1 storage is keyed by `database_id` in `wrangler.jsonc`. Changing the id starts an empty local DB.
- `compatibility_date` must not be newer than the workerd bundled with wrangler, or `wrangler dev` fails.
- Development is on Windows: the shell is PowerShell, and git-bash is also available.

## Architecture

### One GST engine, two runtimes
`public/js/gst.js` is plain JS (JSDoc-typed, side-effect free). The browser uses it for live cart totals, and the
Worker **imports the same file** (`import … from '../public/js/gst.js'`, bundled by wrangler; `allowJs` in tsconfig).
On save the server recomputes everything from item masters and never trusts client totals. The client sends
`expected_total`, and a mismatch is rejected so a stale cart can't be billed. Any GST maths change goes in this
one file and in `test/gst.test.js`.

Key rules encoded there:
- `round()` / `r2()` round half away from zero with float-noise protection.
- With tax-inclusive prices, tax is computed on the back-calculated base and taxable value = amount − taxes, so CGST == SGST and the line total equals the shelf price.
- A bill-level discount is allocated pro-rata to lines before tax; the last line absorbs the remainder.
- `prorateReturn()` handles credit notes. For a partial return it prorates the total and taxes and derives taxable as the remainder. Returning everything that remains uses exact `original − already returned`, so credit notes never drift by a paisa.
- `gstSection()` decides the GSTR-1 table, and the B2CL limit is a setting (₹1 lakh).
- Non-`Taxable` treatments (Nil-Rated / Exempted / Non-GST) force the rate to 0. Composition and unregistered regimes charge no tax.

### Worker (`src/`)
`index.ts` sends `/api/*` to a small regex `Router` (`router.ts`) and everything else to `env.ASSETS`. Each route
declares its access level: `'public' | 'user' | 'admin'`. Every non-GET request must be `application/json` with a
same-origin `Origin` (the CSRF defence), so the front end's `api.js` always sends JSON, including DELETE bodies.
Handlers throw `HttpError` / `bad()`; `errorResponse()` turns "no such table" into a 503 hint to run migrations.

Database access goes through `db.ts` (`prep/all/first/run`). Its `toBind()` maps undefined→NULL and boolean→0/1,
because D1 rejects `undefined`. D1 allows **at most 100 bound parameters per statement**: the invoice insert uses
~42, and `itemsById` chunks `IN (...)` lists by 90.

**Writes are atomic through `db.batch()`** (D1's only transaction mechanism, with no interactive transactions).
The invoice/return pattern in `routes/invoices.ts`:
1. `bumpCounter(series)` upserts `series_counters` (series = `INV/26-27/`).
2. `insertDoc()` reads `seq`/`number` from that counter in subqueries, giving gap-free numbers.
3. Lines, payments and stock moves find their parent with `(SELECT id FROM invoices WHERE uid = ?)`, using a `crypto.randomUUID()` generated beforehand.
4. Stock updates apply only `WHERE track_stock = 1`.

Data conventions:
- Amounts are REAL rupees rounded with `r2`.
- **Credit notes (`doc_type='Return'`) store negative qty and amounts.** Reports and print negate them for display, and GSTR-1 CDNR/CDNUR report positive values.
- Invoices snapshot customer and GST data and store `gst_section`, `supply_type` and `tax_regime` at write time, so reports filter on those columns rather than re-deriving them.
- `invoice_payments` rows carry their own `session_id` and `date`, because credit payments and refunds can happen in a later shift. Shift reconciliation (`sessionSummary`) and collection reports read payments, not invoices.
- Cancelled invoices are kept (`status='Cancelled'`) and excluded everywhere except the Table 13 documents-issued count.
- Settings are a single JSON row (`settings.id = 1`), merged over `DEFAULT_SETTINGS` and fully validated by `validateSettings()`. When registered, the state always comes from the GSTIN.
- Dates and times are IST, from `istNow()` (the Worker runs in UTC). The financial year runs April–March (`fyFor`).

Auth (`auth.ts`):
- Passwords use PBKDF2-SHA256 with 100k iterations, the workerd maximum.
- The session cookie `pos_sid` holds a random token; only its SHA-256 is stored in `auth_sessions`. The `Secure` flag is set only over https, so local http works.
- Failed logins are throttled through `login_attempts`.
- First-run `/api/setup` works only while `users` is empty; an optional `SETUP_KEY` secret gates it.

### Front end (`public/`)
- No framework. `app.js` does the bootstrap (`/api/bootstrap`), the hash router (`#/pos`, `#/invoices/12`), the sidebar, and role-based navigation through the `NAV` table.
- Each view module exports `mount(el, params)` and may return a cleanup function. Every navigation mounts into a fresh host node, so a slow, superseded view can't overwrite the current one.
- **Templating is `html\`\`` from `ui.js`, which auto-escapes every interpolation.** Use `raw()` only for trusted markup (icons, `qrSvg`). Rendering is `innerHTML` plus event delegation.
- CSP (`public/_headers`) forbids inline scripts and inline event handlers (`onclick=`); inline `style=` is allowed.
- Printing: `printDoc()` loads `/print#inv=<id>&f=thermal|a4&auto=1` (or `#session=<id>`) in a hidden iframe. Link to `/print`, not `/print.html`: static assets redirect `.html` URLs.
- `print.js` renders the thermal receipt, A4 tax invoice and shift report, and uses `public/js/vendor/qrcode.mjs` (vendored MIT `qrcode-generator`) for UPI QR codes.
- The POS keeps the cart draft in `localStorage` (`niwas-pos-cart-<userId>`) and routes stray keystrokes into the search box, for barcode scanners.
- Colours are CSS tokens in `public/css/app.css`, with light and dark sets. The dashboard chart is a hand-written single-series SVG (`views/dashboard.js`).

## Gotchas
- Driving the UI with browser automation: never click Print or enable auto-print. `window.print()` opens a native dialog that blocks automation.
- In this environment, screenshots time out while a selected `<input>` has focus (the POS search and open-shift fields). Blur the active element before capturing.
- `tsc` does not check `public/js`. Front-end import mistakes only show up in the browser, so verify named imports and exports when moving functions between modules.
- Sample items (`src/sample.ts`) use illustrative post-Sept-2025 GST rates and in-store EAN-13 barcodes (prefix 200).
