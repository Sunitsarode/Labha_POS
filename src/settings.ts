import { isValidState, validateGSTIN } from '../public/js/gst.js';
import { first } from './db';
import { bad, HttpError } from './http';
import type { Regime, Settings } from './types';
import { bool, num, oneOf, str, text } from './validate';

export const DEFAULT_SETTINGS: Settings = {
  company_name: '',
  legal_name: '',
  gstin: '',
  registration_type: 'Regular',
  state_code: '',
  address: '',
  city: '',
  pincode: '',
  phone: '',
  email: '',
  invoice_prefix: 'INV',
  return_prefix: 'CN',
  prices_include_tax: true,
  round_off: true,
  allow_negative_stock: true,
  cashier_can_edit_price: false,
  cashier_max_discount: 10,
  payment_modes: ['Cash', 'UPI', 'Card'],
  upi_id: '',
  print_format: 'thermal',
  auto_print: false,
  receipt_footer: 'Thank you for shopping with us!',
  terms: '',
  bank_details: '',
  b2cl_limit: 100000,
  composition_rate: 1,
};

export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await first<{ data: string }>(db, 'SELECT data FROM settings WHERE id = 1');
  if (!row) throw new HttpError(409, 'The store has not been set up yet');
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.data) as Partial<Settings>) };
}

const REGIMES: readonly Regime[] = ['Regular', 'Composition', 'Unregistered'];
const PREFIX_RE = /^[A-Z0-9]{1,4}$/;

/** Validates a full settings object. Missing keys fall back to `base` (partial updates). */
export function validateSettings(input: any, base: Settings = DEFAULT_SETTINGS): Settings {
  const v = { ...base, ...(input && typeof input === 'object' ? input : {}) };
  const s: Settings = { ...DEFAULT_SETTINGS };

  s.company_name = str(v.company_name, 120);
  if (!s.company_name) bad('Business name is required');
  s.legal_name = str(v.legal_name, 160);

  s.registration_type = oneOf(v.registration_type, REGIMES, 'Regular');
  if (s.registration_type === 'Unregistered') {
    s.gstin = '';
    s.state_code = str(v.state_code, 2);
    if (!isValidState(s.state_code)) bad('Select the state where the business is located');
  } else {
    const g = validateGSTIN(v.gstin);
    if (!g.ok) bad(g.error);
    s.gstin = g.gstin;
    s.state_code = g.state; // the state always follows the GSTIN
  }

  s.address = text(v.address, 300);
  s.city = str(v.city, 60);
  s.pincode = str(v.pincode, 6);
  if (s.pincode && !/^[1-9][0-9]{5}$/.test(s.pincode)) bad('PIN code must be 6 digits');
  s.phone = str(v.phone, 20);
  s.email = str(v.email, 120);

  s.invoice_prefix = str(v.invoice_prefix, 4).toUpperCase();
  s.return_prefix = str(v.return_prefix, 4).toUpperCase();
  if (!PREFIX_RE.test(s.invoice_prefix) || !PREFIX_RE.test(s.return_prefix)) {
    bad('Document prefixes must be 1–4 letters or digits (GST invoice numbers are limited to 16 characters)');
  }
  if (s.invoice_prefix === s.return_prefix) bad('Invoice and credit note prefixes must be different');

  s.prices_include_tax = bool(v.prices_include_tax);
  s.round_off = bool(v.round_off);
  s.allow_negative_stock = bool(v.allow_negative_stock);
  s.cashier_can_edit_price = bool(v.cashier_can_edit_price);
  s.cashier_max_discount = Math.min(100, Math.max(0, num(v.cashier_max_discount)));

  const modes: string[] = (Array.isArray(v.payment_modes) ? v.payment_modes : String(v.payment_modes ?? '').split(','))
    .map((m: unknown) => str(m, 20))
    .filter((m: string) => m && !['cash', 'credit'].includes(m.toLowerCase()));
  s.payment_modes = ['Cash', ...new Set(modes)].slice(0, 8);

  s.upi_id = str(v.upi_id, 100);
  if (s.upi_id && !/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9.-]{1,64}$/.test(s.upi_id)) {
    bad('UPI ID should look like yourshop@okaxis');
  }

  s.print_format = oneOf(v.print_format, ['thermal', 'a4'] as const, 'thermal');
  s.auto_print = bool(v.auto_print);
  s.receipt_footer = text(v.receipt_footer, 300);
  s.terms = text(v.terms, 1000);
  s.bank_details = text(v.bank_details, 300);
  const limit = num(v.b2cl_limit, 100000);
  s.b2cl_limit = limit > 0 ? limit : 100000;
  s.composition_rate = Math.min(10, Math.max(0, num(v.composition_rate, 1)));
  return s;
}
