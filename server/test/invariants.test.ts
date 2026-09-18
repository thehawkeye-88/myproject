import { describe, it, expect } from 'vitest';
import { checkInvariants } from '../src/invariants.js';

describe('checkInvariants', () => {
  it('stays silent on a consistent invoice', () => {
    const v = checkInvariants({
      line_1_amount: 1250, line_2_amount: 840, line_3_amount: 95.5,
      subtotal: 2185.5, tax: 185.77, total: 2371.27,
    });
    expect(Object.keys(v)).toHaveLength(0);
  });

  it('flags a subtotal that does not match its lines, and names both sides', () => {
    const v = checkInvariants({ line_1_amount: 100, line_2_amount: 200, subtotal: 350 });
    expect(v.subtotal?.[0].rule).toBe('lines_sum_to_subtotal');
    expect(v.line_1_amount?.[0].message).toContain('300.00');
    expect(v.line_1_amount?.[0].message).toContain('350.00');
  });

  it('flags subtotal + tax disagreeing with the total', () => {
    const v = checkInvariants({ subtotal: 100, tax: 10, total: 120 });
    expect(v.total?.[0].rule).toBe('subtotal_plus_tax_is_total');
  });

  it('tolerates a cent of rounding', () => {
    expect(checkInvariants({ subtotal: 100, tax: 8.5, total: 108.51 })).toEqual({});
  });

  it('cannot check what is missing', () => {
    expect(checkInvariants({ subtotal: 100, total: null })).toEqual({});
  });

  it('flags a due date before the invoice date', () => {
    const v = checkInvariants({ invoice_date: '2024-03-14', due_date: '2024-02-13' });
    expect(v.due_date?.[0].rule).toBe('due_after_invoice');
  });

  it('flags a slash date that has two readings, and only when it really does', () => {
    const ambiguous = checkInvariants(
      { invoice_date: '2024-02-09', due_date: '2024-10-02' },
      { invoice_date: '02/09/2024', due_date: '02/10/2024' },
    );
    expect(ambiguous.invoice_date?.[0]?.rule).toBe('ambiguous_date');
    expect(ambiguous.due_date?.[0]?.rule).toBe('ambiguous_date');

    const unambiguous = checkInvariants(
      { invoice_date: '2024-07-31', due_date: '2024-08-30' },
      { invoice_date: '31/07/2024', due_date: '30 August 2024' },
    );
    expect(unambiguous.invoice_date ?? []).toEqual([]);
    expect(unambiguous.due_date ?? []).toEqual([]);
  });

  it('does not question a date a human typed', () => {
    const out = checkInvariants({ invoice_date: '2024-02-09' }, { invoice_date: null });
    expect(out.invoice_date ?? []).toEqual([]);
  });
});
