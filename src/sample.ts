import { gstinCheckChar } from '../public/js/gst.js';
import { prep } from './db';

/**
 * Demo master data loaded by the setup wizard ("Load sample items").
 * GST rates reflect the Sept-2025 rationalisation for common retail goods, but they are
 * illustrative only. Verify the HSN code and rate of every product you actually sell.
 */
type SampleItem = [code: string, name: string, category: string, hsn: string, uom: string, rate: number, mrp: number,
  treatment: 'Taxable' | 'Nil-Rated' | 'Exempted', gst: number, stock: number, service?: boolean];

const ITEMS: SampleItem[] = [
  ['RICE-BAS-1K', 'Basmati Rice 1 kg', 'Grocery', '1006', 'NOS', 135, 150, 'Taxable', 5, 40],
  ['ATTA-5K', 'Whole Wheat Atta 5 kg', 'Grocery', '1101', 'NOS', 265, 285, 'Taxable', 5, 25],
  ['DAL-TOOR-1K', 'Toor Dal 1 kg', 'Grocery', '0713', 'NOS', 165, 180, 'Taxable', 5, 30],
  ['SUGAR-LOOSE', 'Sugar (loose)', 'Grocery', '1701', 'KGS', 46, 0, 'Taxable', 5, 100],
  ['TEA-250', 'Assam Tea 250 g', 'Beverages', '0902', 'NOS', 140, 150, 'Taxable', 5, 30],
  ['COFFEE-50', 'Instant Coffee 50 g', 'Beverages', '2101', 'NOS', 160, 175, 'Taxable', 5, 20],
  ['COLA-750', 'Cola Soft Drink 750 ml', 'Beverages', '2202', 'NOS', 40, 40, 'Taxable', 40, 48],
  ['WATER-1L', 'Packaged Drinking Water 1 L', 'Beverages', '2201', 'NOS', 20, 20, 'Taxable', 5, 60],
  ['BISCUIT-200', 'Glucose Biscuits 200 g', 'Snacks', '1905', 'NOS', 25, 25, 'Taxable', 5, 80],
  ['NAMKEEN-400', 'Bhujia Namkeen 400 g', 'Snacks', '2106', 'NOS', 110, 120, 'Taxable', 5, 30],
  ['CHOCO-50', 'Milk Chocolate 50 g', 'Snacks', '1806', 'NOS', 50, 50, 'Taxable', 5, 50],
  ['MILK-500', 'Fresh Milk 500 ml', 'Dairy', '0401', 'NOS', 30, 30, 'Exempted', 0, 40],
  ['PANEER-200', 'Paneer 200 g', 'Dairy', '0406', 'NOS', 95, 100, 'Nil-Rated', 0, 20],
  ['GHEE-500', 'Cow Ghee 500 ml', 'Dairy', '0405', 'NOS', 340, 360, 'Taxable', 5, 15],
  ['SOAP-100', 'Bathing Soap 100 g', 'Personal Care', '3401', 'NOS', 45, 48, 'Taxable', 5, 60],
  ['SHAMPOO-180', 'Shampoo 180 ml', 'Personal Care', '3305', 'NOS', 160, 175, 'Taxable', 5, 25],
  ['PASTE-150', 'Toothpaste 150 g', 'Personal Care', '3306', 'NOS', 99, 105, 'Taxable', 5, 30],
  ['DETERGENT-1K', 'Detergent Powder 1 kg', 'Household', '3402', 'NOS', 120, 130, 'Taxable', 18, 30],
  ['NOTEBOOK-172', 'Notebook 172 pages', 'Stationery', '4820', 'NOS', 45, 50, 'Nil-Rated', 0, 50],
  ['CHARGER-USB', 'USB Mobile Charger', 'Electronics', '8504', 'NOS', 499, 599, 'Taxable', 18, 3],
  ['SVC-DELIVERY', 'Home Delivery Charges', 'Services', '996813', 'NOS', 30, 0, 'Taxable', 18, 0, true],
  ['SVC-GIFTWRAP', 'Gift Wrapping', 'Services', '998599', 'NOS', 20, 0, 'Taxable', 18, 0, true],
];

/** In-store EAN-13 (prefix 2xx is reserved for restricted circulation, so no clash with real products). */
function ean13(d12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return d12 + ((10 - (sum % 10)) % 10);
}

function demoGstin(state: string, pan: string): string {
  const base = `${state}${pan}1Z`;
  return base + gstinCheckChar(base);
}

export function sampleStatements(db: D1Database, companyState: string): D1PreparedStatement[] {
  const stmts = ITEMS.map(([code, name, category, hsn, uom, rate, mrp, treatment, gst, stock, service], i) =>
    prep(
      db,
      `INSERT INTO items (code, name, category, hsn, is_service, uom, rate, mrp, gst_treatment, gst_rate, barcode,
                          track_stock, stock_qty, reorder_level)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code, name, category, hsn, service ? 1 : 0, uom, rate, mrp, treatment, gst,
      service ? '' : ean13(`2000000${String(i + 1).padStart(5, '0')}`),
      service ? 0 : 1, stock, service ? 0 : 5,
    ),
  );
  stmts.push(
    prep(db, `INSERT INTO stock_moves (item_id, qty, reason, ref) SELECT id, stock_qty, 'Opening', 'Sample data' FROM items WHERE stock_qty <> 0`),
  );

  const otherState = companyState === '27' ? '29' : '27';
  const customers: [string, string, string, string, string][] = [
    ['Ravi Kumar', '9876543210', '', companyState, ''],
    ['Sharma Traders (demo B2B)', '9812345678', demoGstin(companyState, 'ABCPS1234K'), companyState, 'Shop 12, Main Market'],
    ['Mehta Enterprises (demo, other state)', '9822012345', demoGstin(otherState, 'AAKFM5678Q'), otherState, 'Plot 7, Industrial Area'],
  ];
  for (const [name, phone, gstin, state, address] of customers) {
    stmts.push(prep(db, 'INSERT INTO customers (name, phone, gstin, state_code, address) VALUES (?, ?, ?, ?, ?)', name, phone, gstin, state, address));
  }
  return stmts;
}
