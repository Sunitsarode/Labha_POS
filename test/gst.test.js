import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round, r2, validateGSTIN, gstinCheckChar, validateHSN, computeInvoice, prorateReturn, taxBreakup,
  amountInWords, numberToIndianWords, fyFor, istNow, docSeries, docNumber, gstSection, docTitle,
  upiLink, fmtINR, fmtDate, stateLabel, sgstLabel,
} from '../public/js/gst.js';

test('commercial rounding is immune to float noise and symmetric', () => {
  assert.equal(r2(1.005), 1.01);
  assert.equal(r2(-1.005), -1.01);
  assert.equal(r2(2.675), 2.68);
  assert.equal(r2(0.285), 0.29);
  assert.equal(r2(1234567.895), 1234567.9);
  assert.equal(round(99.5, 0), 100);
  assert.equal(round(-99.5, 0), -100);
  assert.ok(Object.is(r2(-0.001), 0));
});

test('GSTIN validation with check digit', () => {
  const ok = validateGSTIN(' 27aapfu0939f1zv ');
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.state, '27');
  assert.equal(ok.ok && ok.pan, 'AAPFU0939F');
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
  assert.equal(validateGSTIN('27AAPFU0939F1ZA').ok, false); // wrong check digit
  assert.equal(validateGSTIN('00AAPFU0939F1ZV').ok, false); // bad state
  assert.equal(validateGSTIN('27AAPFU0939F1Z').ok, false); // short
  const built = '29ABCDE1234F1Z';
  assert.equal(validateGSTIN(built + gstinCheckChar(built)).ok, true);
});

test('HSN / SAC validation', () => {
  assert.equal(validateHSN('1905', false), null);
  assert.equal(validateHSN('19053100', false), null);
  assert.equal(validateHSN('998599', true), null);
  assert.match(validateHSN('190', false), /4, 6 or 8/);
  assert.match(validateHSN('1905', true), /start with 99/);
  assert.match(validateHSN('998599', false), /service/);
  assert.equal(validateHSN('', false), null);
});

test('inclusive price, intra-state: CGST = SGST and total equals the shelf price', () => {
  const inv = computeInvoice({ lines: [{ qty: 1, rate: 100, gst_rate: 18 }], inclusive: true, roundOff: true });
  const l = inv.lines[0];
  assert.deepEqual([l.taxable_value, l.cgst, l.sgst, l.igst], [84.74, 7.63, 7.63, 0]);
  assert.equal(l.total, 100);
  assert.equal(inv.grand_total, 100);
  assert.equal(inv.round_off, 0);
});

test('exclusive price, inter-state: IGST', () => {
  const inv = computeInvoice({ lines: [{ qty: 2, rate: 50, gst_rate: 5 }], inclusive: false, interState: true });
  assert.deepEqual([inv.taxable_total, inv.igst_total, inv.cgst_total, inv.grand_total], [100, 5, 0, 105]);
});

test('invoice discount is allocated pro-rata and totals stay exact', () => {
  const inv = computeInvoice({
    lines: [{ qty: 1, rate: 100, gst_rate: 18 }, { qty: 1, rate: 50, gst_rate: 5 }],
    inclusive: true, discountAmount: 15, roundOff: true,
  });
  assert.deepEqual(inv.lines.map((l) => l.discount_amount), [10, 5]);
  assert.deepEqual(inv.lines.map((l) => l.total), [90, 45]);
  assert.equal(inv.discount_total, 15);
  assert.equal(inv.net_total, 135);
  assert.equal(inv.grand_total, 135);
  const rates = taxBreakup(inv.lines);
  assert.deepEqual(rates.map((r) => r.gst_rate), [5, 18]);
});

test('line discount % + round off to the rupee', () => {
  const inv = computeInvoice({
    lines: [{ qty: 3, rate: 33.3, gst_rate: 12, discount_pct: 10 }], inclusive: false, roundOff: true,
  });
  // gross 99.90, disc 9.99, taxable 89.91, cgst=sgst=5.39 → 100.69 → 101
  assert.equal(inv.taxable_total, 89.91);
  assert.equal(inv.cgst_total, 5.39);
  assert.equal(inv.net_total, 100.69);
  assert.equal(inv.grand_total, 101);
  assert.equal(inv.round_off, 0.31);
});

test('nil-rated / exempt lines and composition dealers carry no tax', () => {
  const a = computeInvoice({ lines: [{ qty: 1, rate: 60, gst_rate: 18, gst_treatment: 'Exempted' }], inclusive: true });
  assert.deepEqual([a.taxable_total, a.tax_total, a.lines[0].gst_rate], [60, 0, 0]);
  const b = computeInvoice({ lines: [{ qty: 1, rate: 60, gst_rate: 18 }], inclusive: true, noTax: true });
  assert.equal(b.tax_total, 0);
  assert.equal(b.grand_total, 60);
});

test('returns: partial returns add up exactly to the original line', () => {
  const inv = computeInvoice({ lines: [{ qty: 3, rate: 99.99, gst_rate: 18 }], inclusive: true });
  const orig = inv.lines[0];
  const first = prorateReturn(orig, 1);
  const second = prorateReturn(orig, 2, first);
  for (const k of ['taxable_value', 'cgst', 'sgst', 'total']) {
    assert.equal(r2(first[k] + second[k]), orig[k], k);
  }
  assert.deepEqual(prorateReturn(orig, 3), { ...prorateReturn(orig, 3), total: orig.total });
});

test('returns: one of two ₹100 items credits exactly ₹100 (no paisa drift)', () => {
  const orig = computeInvoice({ lines: [{ qty: 2, rate: 100, gst_rate: 18 }], inclusive: true }).lines[0];
  const half = prorateReturn(orig, 1);
  assert.equal(half.total, 100);
  assert.equal(half.cgst, half.sgst);
  assert.equal(r2(half.taxable_value + half.cgst + half.sgst), 100);
  const rest = prorateReturn(orig, 1, half);
  assert.equal(r2(half.total + rest.total), orig.total);
  assert.equal(r2(half.taxable_value + rest.taxable_value), orig.taxable_value);
});

test('amount in words (Indian numbering)', () => {
  assert.equal(amountInWords(123456.78), 'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
  assert.equal(amountInWords(10000000), 'Rupees One Crore Only');
  assert.equal(amountInWords(0), 'Rupees Zero Only');
  assert.equal(numberToIndianWords(1500000000), 'One Hundred Fifty Crore');
  assert.equal(amountInWords(-5.5), 'Minus Rupees Five and Fifty Paise Only');
});

test('financial year, IST clock and document numbers', () => {
  assert.equal(fyFor('2026-03-31'), '2025-26');
  assert.equal(fyFor('2026-04-01'), '2026-27');
  assert.equal(fyFor('2099-12-31'), '2099-00');
  // 2026-11-10 20:00 UTC is already 11-Nov in India
  assert.deepEqual(istNow(Date.UTC(2026, 10, 10, 20, 0, 0)), { date: '2026-11-11', time: '01:30:00' });
  const n = docNumber(docSeries('INV', '2026-27'), 7);
  assert.equal(n, 'INV/26-27/00007');
  assert.ok(n.length <= 16, 'GST invoice numbers must be ≤ 16 characters');
});

test('GSTR-1 section classification', () => {
  assert.equal(gstSection({ docType: 'Invoice', customerGstin: '29ABCDE1234F1Z5' }), 'B2B');
  assert.equal(gstSection({ docType: 'Invoice', interState: true, grandTotal: 100001 }), 'B2CL');
  assert.equal(gstSection({ docType: 'Invoice', interState: true, grandTotal: 100000 }), 'B2CS');
  assert.equal(gstSection({ docType: 'Invoice', interState: false, grandTotal: 900000 }), 'B2CS');
  assert.equal(gstSection({ docType: 'Return', origSection: 'B2B' }), 'CDNR');
  assert.equal(gstSection({ docType: 'Return', origSection: 'B2CL' }), 'CDNUR');
  assert.equal(gstSection({ docType: 'Invoice', regime: 'Composition' }), 'NONE');
});

test('document titles and labels', () => {
  assert.equal(docTitle({ doc_type: 'Invoice', tax_regime: 'Regular' }, [{ gst_rate: 5 }]), 'Tax Invoice');
  assert.equal(docTitle({ doc_type: 'Invoice', tax_regime: 'Regular' }, [{ gst_rate: 0, gst_treatment: 'Exempted' }]), 'Bill of Supply');
  assert.equal(docTitle({ doc_type: 'Invoice', tax_regime: 'Composition' }), 'Bill of Supply');
  assert.equal(docTitle({ doc_type: 'Return' }), 'Credit Note');
  assert.equal(stateLabel('29'), '29-Karnataka');
  assert.equal(sgstLabel('04'), 'UTGST');
  assert.equal(sgstLabel('29'), 'SGST');
});

test('formatting and UPI link', () => {
  assert.equal(fmtINR(123456.5), '₹1,23,456.50');
  assert.equal(fmtINR(-10), '-₹10.00');
  assert.equal(fmtDate('2026-11-10'), '10-Nov-2026');
  assert.equal(
    upiLink({ vpa: 'shop@okaxis', name: 'Niwas Store', amount: 450, note: 'Bill 12' }),
    'upi://pay?pa=shop@okaxis&pn=Niwas%20Store&am=450.00&cu=INR&tn=Bill%2012',
  );
});
