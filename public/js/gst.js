// @ts-check
/**
 * Indian GST engine — shared by the browser (live cart totals) and the Worker
 * (authoritative re-calculation when an invoice is saved). Keep it dependency-free
 * and side-effect-free so the exact same maths runs on both sides.
 */

/* ------------------------------------------------------------------ masters */

/** GST state / UT codes, as used in GSTINs and "Place of Supply". */
export const STATES = /** @type {const} */ ([
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'],
  ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
  ['97', 'Other Territory'],
]);
/** @type {Map<string, string>} */
const STATE_MAP = new Map(STATES);

/** Union territories without a legislature levy UTGST instead of SGST. */
export const UTGST_CODES = new Set(['04', '26', '31', '35', '38', '97']);

/** GST rates accepted by the GST portal. Since 22-Sep-2025 ("GST 2.0") the main slabs are 5 / 18 / 40. */
export const GST_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40];

/** Taxable supplies carry a rate; the others are reported in GSTR-1 Table 8 / GSTR-3B 3.1(c),(e). */
export const GST_TREATMENTS = ['Taxable', 'Nil-Rated', 'Exempted', 'Non-GST'];

/** GST Unit Quantity Codes (UQC). "NA" is used for services in the HSN summary. */
export const UQC = /** @type {const} */ ([
  ['NOS', 'Numbers'], ['PCS', 'Pieces'], ['KGS', 'Kilograms'], ['GMS', 'Grammes'], ['LTR', 'Litres'],
  ['MLT', 'Millilitre'], ['MTR', 'Meters'], ['CMS', 'Centimeters'], ['BOX', 'Box'], ['PAC', 'Packs'],
  ['BTL', 'Bottles'], ['BAG', 'Bags'], ['CTN', 'Cartons'], ['DOZ', 'Dozens'], ['PRS', 'Pairs'], ['SET', 'Sets'],
  ['UNT', 'Units'], ['TBS', 'Tablets'], ['ROL', 'Rolls'], ['TUB', 'Tubes'], ['CAN', 'Cans'], ['BDL', 'Bundles'],
  ['BUN', 'Bunches'], ['SQF', 'Square Feet'], ['SQM', 'Square Meters'], ['SQY', 'Square Yards'], ['YDS', 'Yards'],
  ['KLR', 'Kilolitre'], ['CBM', 'Cubic Meters'], ['CCM', 'Cubic Centimeters'], ['QTL', 'Quintal'], ['TON', 'Tonnes'],
  ['MTS', 'Metric Ton'], ['DRM', 'Drums'], ['GRS', 'Gross'], ['THD', 'Thousands'], ['OTH', 'Others'],
  ['NA', 'Not Applicable'],
]);
/** @type {Set<string>} */
export const UQC_CODES = new Set(UQC.map((u) => u[0]));

/** @param {string} code */
export function stateName(code) { return STATE_MAP.get(code) || ''; }
/** "29-Karnataka" — the format the GST offline tool uses for Place Of Supply. @param {string} code */
export function stateLabel(code) { const n = stateName(code); return n ? `${code}-${n}` : code || ''; }
/** @param {unknown} code */
export function isValidState(code) { return typeof code === 'string' && STATE_MAP.has(code); }
/** @param {string} companyState */
export function sgstLabel(companyState) { return UTGST_CODES.has(companyState) ? 'UTGST' : 'SGST'; }

/* ----------------------------------------------------------------- numbers */

/** @param {unknown} v */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Commercial rounding (half away from zero) that is immune to binary float noise:
 * round(1.005) === 1.01, round(-2.675) === -2.68.
 * @param {unknown} x @param {number} [d]
 */
export function round(x, d = 2) {
  const n = num(x);
  if (n === 0) return 0;
  const f = 10 ** d;
  return (Math.sign(n) * Math.round(Number((Math.abs(n) * f).toPrecision(15)))) / f || 0;
}
/** @param {unknown} x */
export const r2 = (x) => round(x, 2);

/* ------------------------------------------------------------------- GSTIN */

const CODE_POINTS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Check character for the first 14 characters of a GSTIN (GSTN mod-36 algorithm). @param {string} first14 */
export function gstinCheckChar(first14) {
  let total = 0;
  for (let i = 0; i < 14; i++) {
    const cp = CODE_POINTS.indexOf(first14[i]);
    if (cp < 0) return '';
    const product = cp * (i % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return CODE_POINTS[(36 - (total % 36)) % 36];
}

/**
 * @param {unknown} input
 * @returns {{ ok: true, gstin: string, state: string, pan: string } | { ok: false, error: string }}
 */
export function validateGSTIN(input) {
  const g = String(input ?? '').trim().toUpperCase();
  if (!g) return { ok: false, error: 'GSTIN is required' };
  if (g.length !== 15) return { ok: false, error: 'GSTIN must be exactly 15 characters' };
  if (!/^[0-9]{2}[0-9A-Z]{13}$/.test(g)) return { ok: false, error: 'GSTIN can only contain letters and digits' };
  const state = g.slice(0, 2);
  if (!STATE_MAP.has(state)) return { ok: false, error: `"${state}" is not a valid GST state code` };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) {
    return { ok: false, error: 'GSTIN check digit does not match. Please re-check for typos' };
  }
  return { ok: true, gstin: g, state, pan: g.slice(2, 12) };
}

/* --------------------------------------------------------------------- HSN */

/**
 * HSN (goods) must be 4, 6 or 8 digits; SAC (services) are 6 digits starting with 99.
 * Returns an error message, or null when valid / empty.
 * @param {unknown} code @param {boolean} isService
 */
export function validateHSN(code, isService) {
  const c = String(code ?? '').trim();
  if (!c) return null;
  if (!/^\d{4}(\d{2}){0,2}$/.test(c)) return 'HSN/SAC code must be 4, 6 or 8 digits';
  if (isService && !c.startsWith('99')) return 'SAC codes for services start with 99';
  if (!isService && c.startsWith('99')) return 'Codes starting with 99 are SAC (services). Mark the item as a service';
  return null;
}

/* ---------------------------------------------------------- tax calculation */

/**
 * @typedef {Object} LineInput
 * @property {number} qty
 * @property {number} rate              unit price (GST-inclusive when `inclusive` is set)
 * @property {number} [discount_pct]    line discount %
 * @property {number} gst_rate
 * @property {number} [cess_rate]
 * @property {string} [gst_treatment]   Taxable | Nil-Rated | Exempted | Non-GST
 */

/**
 * Tax on one line amount (already net of discounts).
 * Inclusive prices: tax is worked out on the back-calculated base and the taxable value is
 * the remainder, so CGST == SGST and the line total equals the price the customer saw.
 * @param {number} amount @param {number} g @param {number} c @param {boolean} inclusive @param {boolean} inter
 */
function taxOn(amount, g, c, inclusive, inter) {
  if (!g && !c) return { taxable_value: amount, cgst: 0, sgst: 0, igst: 0, cess: 0 };
  const base = inclusive ? amount / (1 + (g + c) / 100) : amount;
  const igst = inter ? r2((base * g) / 100) : 0;
  const cgst = inter ? 0 : r2((base * g) / 200);
  const cess = r2((base * c) / 100);
  const taxable_value = inclusive ? r2(amount - igst - 2 * cgst - cess) : amount;
  return { taxable_value, cgst, sgst: cgst, igst, cess };
}

/**
 * Computes a complete GST invoice. Quantities must be positive (returns use prorateReturn).
 * @template {LineInput} L
 * @param {{ lines: L[], inclusive?: boolean, interState?: boolean, noTax?: boolean,
 *           discountPct?: number, discountAmount?: number, roundOff?: boolean }} p
 */
export function computeInvoice(p) {
  const inclusive = !!p.inclusive;
  const inter = !!p.interState;
  const noTax = !!p.noTax;

  const work = (p.lines || []).map((l) => {
    const qty = round(l.qty, 3);
    const rate = r2(l.rate);
    const gross = r2(qty * rate);
    const discount_pct = clamp(num(l.discount_pct), 0, 100);
    const lineDisc = Math.min(r2((gross * discount_pct) / 100), gross);
    const taxed = !noTax && (l.gst_treatment || 'Taxable') === 'Taxable';
    return {
      line: l, qty, rate, gross, discount_pct, lineDisc, net: r2(gross - lineDisc),
      gst_rate: taxed ? num(l.gst_rate) : 0,
      cess_rate: taxed ? num(l.cess_rate) : 0,
    };
  });

  // Invoice-level discount (ERPNext "additional discount"), allocated pro-rata to lines so the
  // taxable value of every line (and so HSN / rate-wise GST reporting) stays correct.
  const netSum = r2(work.reduce((a, w) => a + w.net, 0));
  let invDisc = 0;
  if (netSum > 0) {
    invDisc = Math.min(
      r2((netSum * clamp(num(p.discountPct), 0, 100)) / 100 + Math.max(0, num(p.discountAmount))),
      netSum,
    );
  }
  let lastIdx = -1;
  work.forEach((w, i) => { if (w.net > 0) lastIdx = i; });
  let left = invDisc;

  const lines = work.map((w, i) => {
    let share = 0;
    if (left > 0 && w.net > 0) {
      share = i === lastIdx ? Math.min(left, w.net) : Math.min(left, w.net, r2((invDisc * w.net) / netSum));
    }
    left = r2(left - share);
    const t = taxOn(r2(w.net - share), w.gst_rate, w.cess_rate, inclusive, inter);
    return {
      ...w.line,
      qty: w.qty, rate: w.rate, gross: w.gross, discount_pct: w.discount_pct,
      discount_amount: r2(w.lineDisc + share),
      gst_rate: w.gst_rate, cess_rate: w.cess_rate,
      ...t,
      total: r2(t.taxable_value + t.cgst + t.sgst + t.igst + t.cess),
    };
  });

  /** @param {'gross'|'discount_amount'|'taxable_value'|'cgst'|'sgst'|'igst'|'cess'} k */
  const sum = (k) => r2(lines.reduce((a, l) => a + l[k], 0));
  const taxable_total = sum('taxable_value');
  const cgst_total = sum('cgst');
  const sgst_total = sum('sgst');
  const igst_total = sum('igst');
  const cess_total = sum('cess');
  const tax_total = r2(cgst_total + sgst_total + igst_total + cess_total);
  const net_total = r2(taxable_total + tax_total);
  const grand_total = p.roundOff ? round(net_total, 0) : net_total;
  return {
    lines,
    total_qty: round(lines.reduce((a, l) => a + l.qty, 0), 3),
    gross_total: sum('gross'),
    discount_total: sum('discount_amount'),
    invoice_discount: r2(invDisc - left),
    taxable_total, cgst_total, sgst_total, igst_total, cess_total, tax_total, net_total,
    round_off: r2(grand_total - net_total),
    grand_total,
  };
}

const TAX_KEYS = /** @type {const} */ (['taxable_value', 'cgst', 'sgst', 'igst', 'cess']);

/**
 * Rate-wise tax summary (printed under the invoice and used for GST returns).
 * @param {Array<Record<string, any>>} lines
 */
export function taxBreakup(lines) {
  /** @type {Map<string, Record<string, number>>} */
  const m = new Map();
  for (const l of lines) {
    const key = `${num(l.gst_rate)}|${num(l.cess_rate)}`;
    const g = m.get(key) || { gst_rate: num(l.gst_rate), cess_rate: num(l.cess_rate), taxable_value: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    for (const k of TAX_KEYS) g[k] = r2(g[k] + num(l[k]));
    m.set(key, g);
  }
  return [...m.values()].sort((a, b) => a.gst_rate - b.gst_rate);
}

/**
 * HSN-wise summary of an invoice (A4 tax invoice footer).
 * @param {Array<Record<string, any>>} lines
 */
export function hsnSummary(lines) {
  /** @type {Map<string, Record<string, any>>} */
  const m = new Map();
  for (const l of lines) {
    const key = `${l.hsn || ''}|${num(l.gst_rate)}`;
    const g = m.get(key) || { hsn: l.hsn || '', gst_rate: num(l.gst_rate), qty: 0, taxable_value: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
    g.qty = round(g.qty + num(l.qty), 3);
    for (const k of TAX_KEYS) g[k] = r2(g[k] + num(l[k]));
    m.set(key, g);
  }
  return [...m.values()];
}

const PRORATE_KEYS = /** @type {const} */ (['gross', 'discount_amount', 'taxable_value', 'cgst', 'sgst', 'igst', 'cess']);

/**
 * Amounts for returning `qty` units of an original invoice line (credit note).
 * When the whole remaining quantity is returned, the exact remaining amounts are used, so
 * the sum of all credit notes can never drift from the original invoice by a paisa.
 * @param {Record<string, any>} orig  original invoice line
 * @param {number} qty               quantity being returned now (positive)
 * @param {Record<string, any>} [done] totals already returned for this line (positive)
 */
export function prorateReturn(orig, qty, done = {}) {
  const q = round(qty, 3);
  const remaining = round(num(orig.qty) - num(done.qty), 3);
  const everything = Math.abs(q - remaining) < 0.0005;
  /** @type {Record<string, number>} */
  const out = { qty: q };
  for (const k of PRORATE_KEYS) {
    out[k] = everything ? r2(num(orig[k]) - num(done[k])) : r2((num(orig[k]) * q) / num(orig.qty));
  }
  if (everything) {
    out.total = r2(out.taxable_value + out.cgst + out.sgst + out.igst + out.cess);
  } else {
    // Prorate the line total itself (1 of 2 items sold for ₹200 is exactly ₹100) and let the
    // taxable value absorb the paisa difference, exactly as tax-inclusive billing does.
    out.total = r2((num(orig.total) * q) / num(orig.qty));
    out.taxable_value = r2(out.total - out.cgst - out.sgst - out.igst - out.cess);
  }
  return out;
}

/* ---------------------------------------------------- GSTR-1 classification */

/**
 * GSTR-1 table an invoice / credit note belongs to.
 * B2B: recipient has a GSTIN. B2CL: unregistered, inter-state, invoice value above the limit
 * (₹1,00,000 since Aug-2024; was ₹2,50,000). B2CS: all other B2C.
 * Credit notes: CDNR (against B2B), CDNUR (against B2CL), else netted in B2CS.
 * @param {{ docType: string, customerGstin?: string, interState?: boolean, grandTotal?: number,
 *           origSection?: string, regime?: string, b2clLimit?: number }} p
 */
export function gstSection(p) {
  if ((p.regime || 'Regular') !== 'Regular') return 'NONE';
  if (p.docType === 'Return') {
    if (p.origSection === 'B2B') return 'CDNR';
    if (p.origSection === 'B2CL') return 'CDNUR';
    return 'B2CS';
  }
  if (p.customerGstin) return 'B2B';
  if (p.interState && num(p.grandTotal) > (p.b2clLimit ?? 100000)) return 'B2CL';
  return 'B2CS';
}

/**
 * Document title as required by the CGST Rules (Rule 46 tax invoice / Rule 49 bill of supply).
 * @param {{ doc_type: string, tax_regime?: string, tax_total?: number }} inv
 * @param {Array<{ gst_treatment?: string, gst_rate?: number }>} [lines]
 */
export function docTitle(inv, lines = []) {
  if (inv.doc_type === 'Return') return 'Credit Note';
  if (inv.tax_regime === 'Composition') return 'Bill of Supply';
  if (inv.tax_regime === 'Unregistered') return 'Invoice';
  const anyTaxable = lines.length
    ? lines.some((l) => (l.gst_treatment || 'Taxable') === 'Taxable' && num(l.gst_rate) > 0)
    : num(inv.tax_total) > 0;
  return anyTaxable ? 'Tax Invoice' : 'Bill of Supply';
}

/* ------------------------------------------------------------ amount → words */

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
/** @param {number} n */
const upto99 = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ''));
/** @param {number} n */
const upto999 = (n) => [Math.floor(n / 100) ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? upto99(n % 100) : '']
  .filter(Boolean).join(' ');

/** Indian numbering system: thousand, lakh, crore. @param {number} value @returns {string} */
export function numberToIndianWords(value) {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  return [
    crore ? `${numberToIndianWords(crore)} Crore` : '',
    lakh ? `${upto99(lakh)} Lakh` : '',
    thousand ? `${upto99(thousand)} Thousand` : '',
    n ? upto999(n) : '',
  ].filter(Boolean).join(' ');
}

/** "Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only" @param {number} amount */
export function amountInWords(amount) {
  const v = r2(amount);
  const abs = Math.abs(v);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  return `${v < 0 ? 'Minus ' : ''}Rupees ${numberToIndianWords(rupees)}${paise ? ` and ${upto99(paise)} Paise` : ''} Only`;
}

/* ------------------------------------------------------ dates & numbering */

/** Indian financial year (April–March) of an ISO date: "2026-27". @param {string} date */
export function fyFor(date) {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Current date & time in IST (UTC+05:30), independent of the runtime's time zone. */
export function istNow(ms = Date.now()) {
  const iso = new Date(ms + 330 * 60_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
}

/** "INV/26-27/" — GST allows up to 16 characters, unique per financial year. @param {string} prefix @param {string} fy */
export function docSeries(prefix, fy) { return `${prefix}/${fy.slice(2)}/`; }
/** @param {string} series @param {number} seq */
export function docNumber(series, seq) { return series + String(seq).padStart(5, '0'); }

/* --------------------------------------------------------------------- UPI */

/** UPI deep link for a dynamic QR (NPCI "upi://pay"). @param {{ vpa: string, name?: string, amount: number, note?: string }} p */
export function upiLink(p) {
  const enc = (/** @type {string} */ s) => encodeURIComponent(s).replace(/%40/g, '@');
  const q = [`pa=${enc(p.vpa)}`, `pn=${enc(p.name || '')}`, `am=${r2(p.amount).toFixed(2)}`, 'cu=INR'];
  if (p.note) q.push(`tn=${enc(p.note)}`);
  return `upi://pay?${q.join('&')}`;
}

/* -------------------------------------------------------------- formatting */

const NF2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 1,23,456.78 (Indian digit grouping) @param {unknown} n */
export function fmtAmount(n) { const v = r2(n); return (v < 0 ? '-' : '') + NF2.format(Math.abs(v)); }
/** ₹1,23,456.78 @param {unknown} n */
export function fmtINR(n) { const v = r2(n); return (v < 0 ? '-₹' : '₹') + NF2.format(Math.abs(v)); }
/** @param {unknown} n */
export function fmtQty(n) { return String(round(n, 3)); }
/** "10-Nov-2026" @param {string | null | undefined} d */
export function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.slice(0, 10).split('-');
  return `${day}-${MONTHS[Number(m) - 1] || m}-${y}`;
}
/** Percentage without trailing zeros: 18 → "18", 0.25 → "0.25" @param {unknown} n */
export function fmtRate(n) { return String(round(n, 3)); }
