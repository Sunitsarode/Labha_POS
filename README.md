# Niwas POS: GST-ready point of sale on Cloudflare Workers

A web POS for Indian retail shops, modelled on **ERPNext POS** (shifts, held bills, split payments, returns)
and **Frappe Books** (setup wizard, simple masters, GST reports). It runs entirely on a Cloudflare Worker:
a TypeScript JSON API backed by **D1** (SQLite), plus a no-build HTML/CSS/JS front end served as static assets.

## Features

**Billing (POS)**
- Item grid with search, category chips and **barcode scanning** (scanner input is caught even when no field has focus).
- Cart with quantity stepper, line discount %, bill-level discount (% or ₹) and live GST totals.
- Walk-in or saved customers; quick-add a customer with **GSTIN validation (check digit)**. The customer's state comes from the GSTIN.
- **Place of supply** per bill: CGST + SGST/UTGST within the state, IGST across states.
- Checkout with **split payments** (Cash / UPI / Card / custom modes), quick-cash buttons, change calculation, and credit sales for named customers.
- **Dynamic UPI QR** with the exact amount at checkout (set your UPI ID in Settings).
- Hold / resume bills; the cart survives a page reload.
- **Shifts** (ERPNext POS opening/closing entry): opening float, expected vs counted amount per payment mode, X/Z reports.
- Printing: 80 mm thermal receipt, or an A4 **tax invoice / bill of supply / credit note** with HSN summary and amount in words.

**GST**
- Shared GST engine (`public/js/gst.js`). The browser uses it for live totals and the Worker recomputes every invoice with it on save, so client totals are never trusted.
- Tax-inclusive (MRP-style) or tax-exclusive prices. With inclusive prices CGST always equals SGST, and the bill total equals the shelf price.
- GST treatment per item: **Taxable / Nil-rated / Exempted / Non-GST**, HSN/SAC validation, GST UQC units, optional cess.
- Every slab (0.1 to 40%), including the Sept-2025 "GST 2.0" structure (5 / 18 / 40%).
- Gap-free invoice numbering per financial year (`INV/26-27/00001`, ≤ 16 characters, restarts each 1 April). Numbering, stock and payments are written in one D1 transaction.
- Composition dealers print a *Bill of Supply* with the mandatory declaration and charge no tax; unregistered businesses are supported too.
- Rule 46 prompt for B2C bills of ₹50,000 or more without customer details.
- Returns create **credit notes** with exact pro-rata tax. Credit sales are settled before any refund. Admins can cancel invoices.
- **GSTR-1** for any month or date range:
  - B2B (4A), B2CL (5, ₹1 lakh limit, configurable), B2CS (7, net of credit notes), CDNR / CDNUR (9B)
  - nil / exempt / non-GST supplies (8), HSN summary split B2B / B2C (12), documents issued (13)
  - CSV in the GST Offline Tool layouts, plus a portal-format JSON draft
- **GSTR-3B** summary (3.1(a), (c), (e) and 3.2), or the CMP-08 turnover summary for composition dealers.
- Sales register, item-wise sales and an owner dashboard.

**Security**
- PBKDF2-SHA256 password hashing. HttpOnly session cookies, with only a SHA-256 of the token stored.
- Login throttling, admin / cashier roles, CSRF defence (same-origin + JSON-only writes), and a strict CSP via `public/_headers`.
- Cashiers cannot change prices or exceed the discount limit unless an admin allows it. Admins also manage items, reports, settings and users.

## Project layout

```
wrangler.jsonc            Worker config: static assets (./public) + D1 binding "DB"
migrations/0001_init.sql  D1 schema
src/                      Worker (TypeScript)
  index.ts                /api/* → router, everything else → static assets
  router.ts auth.ts http.ts db.ts settings.ts validate.ts sample.ts
  routes/                 auth, admin (settings, users), items, customers, sessions (shifts),
                          invoices (sales, returns, cancel, payments, held), reports (GST)
public/                   Front end (no build step)
  index.html print.html _headers css/ js/
  js/gst.js               Shared GST engine (also imported by the Worker)
  js/views/               pos, invoices, items, customers, reports, dashboard, shifts, settings
test/gst.test.js          Unit tests for the GST engine (node --test)
test/api.smoke.mjs        End-to-end API test against a running instance
```

## Run locally

```bash
npm install
npm run db:migrate:local      # create the local D1 schema
npm run dev                   # http://127.0.0.1:8787
```

The first visit opens the setup wizard: business name, GSTIN (or composition / unregistered), and the
admin account. Tick *Load sample items* to get about 20 demo products and 3 customers to try billing straight away.

Tests:

```bash
npm test                      # GST engine unit tests
npm run smoke                 # API end-to-end test (needs `npm run dev`; fresh DB or POS_USER/POS_PASS)
npm run typecheck
```

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler d1 create niwas-pos-db           # copy the printed database_id into wrangler.jsonc
npm run db:migrate:remote                      # create the schema in the remote D1
npx wrangler secret put SETUP_KEY              # optional but recommended: protects the setup wizard
npm run deploy
```

Open the `*.workers.dev` URL (or add a custom domain in the dashboard) and finish the setup wizard straight away.
If you set `SETUP_KEY`, the wizard asks for it. Run future schema changes as new files in `migrations/`, then
`npm run db:migrate:remote`.

## Using it day to day

1. **Settings**: check the GSTIN and state, document prefixes, inclusive pricing, payment modes, UPI ID and print format. Add cashier users.
2. **Items**: add items or import a CSV (download the template on the Items page). Every item needs the right HSN/SAC and GST rate.
3. **POS**: open a shift, then bill. F2 searches, F4 pays, and a barcode scan adds the item. Close the shift at day end and count the drawer.
4. **GST & reports**: at month end, review GSTR-1, download the CSVs (or the JSON draft), and cross-check GSTR-3B.

## GST notes and limitations

- **Place of supply.** Over-the-counter goods are taxed in your own state (IGST Act s.10(1)(c)), so the POS defaults to it. Change it only when goods are delivered to, or services are supplied to a registered business in, another state.
- **Rates and HSN codes are your responsibility.** The sample items are illustrative. Many rates changed on 22-Sep-2025.
- **GSTR-1 JSON** follows the portal layout but is a draft. Import it into the GST Offline Tool (or your GSP) to validate it before uploading. The CSVs match the Offline Tool sheets.
- **Cancellation** is only for invoices not yet reported in a filed GSTR-1. Otherwise issue a return (credit note).
- **Not included:** e-invoicing (IRN/QR via the IRP, mandatory above ₹5 crore AATO for B2B), e-way bills, purchases/ITC, exports/SEZ, multi-branch, loyalty and offline mode.
- Times and financial years use IST (UTC+05:30) regardless of the Worker's location.
