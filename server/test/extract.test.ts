import { describe, it, expect } from 'vitest';
import { extract } from '../src/extract.js';

const CLEAN = [
  'Acme Supply Co.',
  'INVOICE',
  'Vendor:           Acme Supply Co.',
  'Invoice Number:   INV-2024-0042',
  'Invoice Date:     14 March 2024',
  'Due Date:         13 April 2024',
  'PO Number:        PO-88231',
  'Currency:         USD',
  '       Description                                        Amount',
  'Item 1 Steel fasteners 10mm, 500 units                     1,250.00',
  'Item 2 Anodized brackets, 120 units                          840.00',
  'Subtotal:         2,090.00',
  'Tax:                177.65',
  'Total:            2,267.65',
  'Payment due within 30 days. Remit via demo payment instructions.',
].join('\n');

const get = (text: string, key: string) => extract(text).candidates.get(key);

describe('extract', () => {
  it('reads labelled fields and quotes the text it read them from', () => {
    const c = get(CLEAN, 'invoice_number')!;
    expect(c.value).toBe('INV-2024-0042');
    expect(CLEAN).toContain(c.quote!);
    expect(c.derived).toBeUndefined();
  });

  it('does not let "Total" match inside "Subtotal"', () => {
    expect(get(CLEAN, 'subtotal')!.value).toBe(2090);
    expect(get(CLEAN, 'total')!.value).toBe(2267.65);
  });

  it('does not let "Invoice" match inside "Invoice Number"', () => {
    expect(get(CLEAN, 'invoice_date')!.value).toBe('2024-03-14');
  });

  it('prefers a label hit that parses over prose that merely starts with the label', () => {
    // "Payment due within 30 days" is a genuine hit on the label "payment due".
    expect(get(CLEAN, 'due_date')!.value).toBe('2024-04-13');
  });

  it('reads the item table and reports the unused rows as absent, not failed', () => {
    const r = extract(CLEAN);
    expect(r.candidates.get('line_1_description')!.value).toBe('Steel fasteners 10mm, 500 units');
    expect(r.candidates.get('line_2_amount')!.value).toBe(840);
    expect(r.candidates.get('line_3_amount')!.notPresent).toBe(true);
  });

  it('derives a missing subtotal from the lines and says that it did', () => {
    const noSubtotal = CLEAN.replace('Subtotal:         2,090.00\n', '');
    const c = get(noSubtotal, 'subtotal')!;
    expect(c.value).toBe(2090);
    expect(c.derived).toEqual({ rule: 'sum_of_line_items', operands: ['line_1_amount', 'line_2_amount'] });
    expect(c.quote).toBeNull();
  });

  it('never derives tax, which would make the arithmetic check pass by construction', () => {
    const noTax = CLEAN.replace('Tax:                177.65\n', '');
    expect(get(noTax, 'tax')!.notPresent).toBe(true);
  });

  it('falls back to the letterhead when there is no vendor row', () => {
    const noVendor = CLEAN.replace('Vendor:           Acme Supply Co.\n', '');
    expect(get(noVendor, 'vendor_name')!.value).toBe('Acme Supply Co.');
  });

  it('keeps an unreadable value as a quote with no value, not as an absence', () => {
    const footnoted = CLEAN.replace('2,267.65', '2,267.65 *');
    const c = get(footnoted, 'total')!;
    expect(c.value).toBeNull();
    expect(c.quote).toBe('2,267.65 *');
    expect(c.notPresent).toBeUndefined();
  });

  it('honours a scoped re-run', () => {
    const r = extract(CLEAN, ['total']);
    expect(r.candidates.size).toBe(1);
    expect(r.candidates.get('total')!.value).toBe(2267.65);
  });
});
