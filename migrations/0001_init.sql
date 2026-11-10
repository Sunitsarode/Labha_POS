-- Niwas POS — initial schema (Cloudflare D1 / SQLite)
-- Amounts are stored in rupees, rounded to 2 decimals by the application.

-- Single-row store configuration (company, GSTIN, invoice series, POS behaviour) as JSON.
CREATE TABLE settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'cashier' CHECK (role IN ('admin', 'cashier')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Login sessions: only a SHA-256 of the cookie token is stored.
CREATE TABLE auth_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

-- Failed login attempts, for brute-force throttling.
CREATE TABLE login_attempts (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  key  TEXT NOT NULL,
  ts   INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts_key ON login_attempts(key, ts);

-- Item master (ERPNext "Item"): HSN/SAC, GST treatment & rate, UQC, barcode, stock.
CREATE TABLE items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  category       TEXT NOT NULL DEFAULT '',
  hsn            TEXT NOT NULL DEFAULT '',
  is_service     INTEGER NOT NULL DEFAULT 0,
  uom            TEXT NOT NULL DEFAULT 'NOS',
  rate           REAL NOT NULL DEFAULT 0,
  mrp            REAL NOT NULL DEFAULT 0,
  gst_treatment  TEXT NOT NULL DEFAULT 'Taxable'
                 CHECK (gst_treatment IN ('Taxable', 'Nil-Rated', 'Exempted', 'Non-GST')),
  gst_rate       REAL NOT NULL DEFAULT 0,
  cess_rate      REAL NOT NULL DEFAULT 0,
  barcode        TEXT NOT NULL DEFAULT '',
  track_stock    INTEGER NOT NULL DEFAULT 1,
  stock_qty      REAL NOT NULL DEFAULT 0,
  reorder_level  REAL NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_items_barcode ON items(barcode);
CREATE INDEX idx_items_category ON items(category);

-- Stock ledger (audit trail of every stock change).
CREATE TABLE stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  qty         REAL NOT NULL,
  reason      TEXT NOT NULL,
  ref         TEXT NOT NULL DEFAULT '',
  user_id     INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_stock_moves_item ON stock_moves(item_id);

CREATE TABLE customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  gstin       TEXT NOT NULL DEFAULT '',
  state_code  TEXT NOT NULL DEFAULT '',
  address     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_customers_phone ON customers(phone);
CREATE INDEX idx_customers_gstin ON customers(gstin);

-- Cashier shifts (ERPNext "POS Opening Entry" / "POS Closing Entry").
CREATE TABLE pos_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Closed')),
  opening_cash  REAL NOT NULL DEFAULT 0,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  closing       TEXT,
  notes         TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX uq_pos_sessions_one_open ON pos_sessions(user_id) WHERE status = 'Open';

-- Gap-free document numbering per series, e.g. "INV/26-27/".
CREATE TABLE series_counters (
  series  TEXT PRIMARY KEY,
  last    INTEGER NOT NULL DEFAULT 0
);

-- Sales invoices and credit notes (returns). Customer / GST details are snapshotted.
CREATE TABLE invoices (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  uid                      TEXT NOT NULL UNIQUE,
  doc_type                 TEXT NOT NULL CHECK (doc_type IN ('Invoice', 'Return')),
  series                   TEXT NOT NULL,
  seq                      INTEGER NOT NULL,
  number                   TEXT NOT NULL UNIQUE,
  date                     TEXT NOT NULL,
  time                     TEXT NOT NULL,
  fy                       TEXT NOT NULL,
  status                   TEXT NOT NULL,
  return_status            TEXT NOT NULL DEFAULT '',
  return_against           INTEGER REFERENCES invoices(id),
  customer_id              INTEGER REFERENCES customers(id),
  customer_name            TEXT NOT NULL DEFAULT '',
  customer_phone           TEXT NOT NULL DEFAULT '',
  customer_gstin           TEXT NOT NULL DEFAULT '',
  customer_address         TEXT NOT NULL DEFAULT '',
  customer_state           TEXT NOT NULL DEFAULT '',
  place_of_supply          TEXT NOT NULL,
  supply_type              TEXT NOT NULL CHECK (supply_type IN ('INTRA', 'INTER')),
  gst_section              TEXT NOT NULL,
  tax_regime               TEXT NOT NULL DEFAULT 'Regular',
  prices_include_tax       INTEGER NOT NULL DEFAULT 1,
  reverse_charge           INTEGER NOT NULL DEFAULT 0,
  total_qty                REAL NOT NULL DEFAULT 0,
  gross_total              REAL NOT NULL DEFAULT 0,
  discount_total           REAL NOT NULL DEFAULT 0,
  taxable_total            REAL NOT NULL DEFAULT 0,
  cgst_total               REAL NOT NULL DEFAULT 0,
  sgst_total               REAL NOT NULL DEFAULT 0,
  igst_total               REAL NOT NULL DEFAULT 0,
  cess_total               REAL NOT NULL DEFAULT 0,
  tax_total                REAL NOT NULL DEFAULT 0,
  round_off                REAL NOT NULL DEFAULT 0,
  grand_total              REAL NOT NULL DEFAULT 0,
  paid_total               REAL NOT NULL DEFAULT 0,
  tendered_total           REAL NOT NULL DEFAULT 0,
  change_amount            REAL NOT NULL DEFAULT 0,
  outstanding              REAL NOT NULL DEFAULT 0,
  invoice_discount_pct     REAL NOT NULL DEFAULT 0,
  invoice_discount_amount  REAL NOT NULL DEFAULT 0,
  notes                    TEXT NOT NULL DEFAULT '',
  session_id               INTEGER REFERENCES pos_sessions(id),
  user_id                  INTEGER REFERENCES users(id),
  cancelled_at             TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoices_date ON invoices(date);
CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_session ON invoices(session_id);
CREATE INDEX idx_invoices_return_against ON invoices(return_against);

CREATE TABLE invoice_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  idx              INTEGER NOT NULL,
  item_id          INTEGER REFERENCES items(id),
  ref_line_id      INTEGER REFERENCES invoice_items(id),
  item_code        TEXT NOT NULL DEFAULT '',
  item_name        TEXT NOT NULL,
  hsn              TEXT NOT NULL DEFAULT '',
  uom              TEXT NOT NULL DEFAULT 'NOS',
  is_service       INTEGER NOT NULL DEFAULT 0,
  qty              REAL NOT NULL,
  rate             REAL NOT NULL,
  gross            REAL NOT NULL DEFAULT 0,
  discount_pct     REAL NOT NULL DEFAULT 0,
  discount_amount  REAL NOT NULL DEFAULT 0,
  gst_treatment    TEXT NOT NULL DEFAULT 'Taxable',
  gst_rate         REAL NOT NULL DEFAULT 0,
  cess_rate        REAL NOT NULL DEFAULT 0,
  taxable_value    REAL NOT NULL DEFAULT 0,
  cgst             REAL NOT NULL DEFAULT 0,
  sgst             REAL NOT NULL DEFAULT 0,
  igst             REAL NOT NULL DEFAULT 0,
  cess             REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
CREATE INDEX idx_invoice_items_item ON invoice_items(item_id);
CREATE INDEX idx_invoice_items_ref ON invoice_items(ref_line_id);

-- Payments (and refunds, as negative amounts), tied to the shift that took them.
CREATE TABLE invoice_payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,
  amount      REAL NOT NULL,
  reference   TEXT NOT NULL DEFAULT '',
  session_id  INTEGER REFERENCES pos_sessions(id),
  date        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_invoice_payments_invoice ON invoice_payments(invoice_id);
CREATE INDEX idx_invoice_payments_session ON invoice_payments(session_id);
CREATE INDEX idx_invoice_payments_date ON invoice_payments(date);

-- Parked / held carts (ERPNext "Hold" / draft POS invoices).
CREATE TABLE held_carts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  total       REAL NOT NULL DEFAULT 0,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
