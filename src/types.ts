export type Role = 'admin' | 'cashier';

export interface User {
  id: number;
  username: string;
  full_name: string;
  role: Role;
}

/** Registration type of the business under GST. */
export type Regime = 'Regular' | 'Composition' | 'Unregistered';

export interface Settings {
  company_name: string;
  legal_name: string;
  gstin: string;
  registration_type: Regime;
  state_code: string;
  address: string;
  city: string;
  pincode: string;
  phone: string;
  email: string;
  invoice_prefix: string;
  return_prefix: string;
  prices_include_tax: boolean;
  round_off: boolean;
  allow_negative_stock: boolean;
  cashier_can_edit_price: boolean;
  cashier_max_discount: number;
  payment_modes: string[];
  upi_id: string;
  print_format: 'thermal' | 'a4';
  auto_print: boolean;
  receipt_footer: string;
  terms: string;
  bank_details: string;
  b2cl_limit: number;
  composition_rate: number;
}

export interface ItemRow {
  id: number;
  code: string;
  name: string;
  category: string;
  hsn: string;
  is_service: number;
  uom: string;
  rate: number;
  mrp: number;
  gst_treatment: string;
  gst_rate: number;
  cess_rate: number;
  barcode: string;
  track_stock: number;
  stock_qty: number;
  reorder_level: number;
  active: number;
}

export interface CustomerRow {
  id: number;
  name: string;
  phone: string;
  email: string;
  gstin: string;
  state_code: string;
  address: string;
}

export interface SessionRow {
  id: number;
  user_id: number;
  status: 'Open' | 'Closed';
  opening_cash: number;
  opened_at: string;
  closed_at: string | null;
  closing: string | null;
  notes: string;
}

export interface InvoiceRow {
  id: number;
  uid: string;
  doc_type: 'Invoice' | 'Return';
  series: string;
  seq: number;
  number: string;
  date: string;
  time: string;
  fy: string;
  status: string;
  return_status: string;
  return_against: number | null;
  customer_id: number | null;
  customer_name: string;
  customer_phone: string;
  customer_gstin: string;
  customer_address: string;
  customer_state: string;
  place_of_supply: string;
  supply_type: 'INTRA' | 'INTER';
  gst_section: string;
  tax_regime: string;
  prices_include_tax: number;
  reverse_charge: number;
  total_qty: number;
  gross_total: number;
  discount_total: number;
  taxable_total: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  cess_total: number;
  tax_total: number;
  round_off: number;
  grand_total: number;
  paid_total: number;
  tendered_total: number;
  change_amount: number;
  outstanding: number;
  invoice_discount_pct: number;
  invoice_discount_amount: number;
  notes: string;
  session_id: number | null;
  user_id: number | null;
  cancelled_at: string | null;
  created_at: string;
}

export interface LineRow {
  id: number;
  invoice_id: number;
  idx: number;
  item_id: number | null;
  ref_line_id: number | null;
  item_code: string;
  item_name: string;
  hsn: string;
  uom: string;
  is_service: number;
  qty: number;
  rate: number;
  gross: number;
  discount_pct: number;
  discount_amount: number;
  gst_treatment: string;
  gst_rate: number;
  cess_rate: number;
  taxable_value: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  total: number;
}
