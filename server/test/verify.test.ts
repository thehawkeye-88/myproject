import { describe, it, expect } from 'vitest';
import { verifyField, pageOf } from '../src/verify.js';
import { FIELD_BY_KEY } from '@docreview/shared';
import type { PageGeometry } from '@docreview/shared';

const TEXT = 'Invoice Number:  INV-2024-0042\nInvoice Date:  14 March 2024\nTotal:  2,267.65';
const GEO: PageGeometry[] = [{ page: 1, width: 612, height: 792, charStart: 0, charEnd: TEXT.length }];

const total = FIELD_BY_KEY.total;
const num = FIELD_BY_KEY.invoice_number;
const date = FIELD_BY_KEY.invoice_date;

describe('verifyField', () => {
  it('grounds a value that matches its quoted source', () => {
    const v = verifyField(total, { key: 'total', quote: '2,267.65', value: 2267.65 }, TEXT, GEO);
    expect(v.state).toBe('filled');
    if (v.state !== 'filled') return;
    expect(v.grounding.kind).toBe('grounded');
    if (v.grounding.kind !== 'grounded') return;
    expect(v.grounding.how).toBe('exact');
    expect(TEXT.slice(v.grounding.span.start, v.grounding.span.end)).toBe('2,267.65');
  });

  it('reports a mismatch when the cited source disagrees with the value', () => {
    const v = verifyField(total, { key: 'total', quote: '2,267.65', value: 2276.65 }, TEXT, GEO);
    if (v.state !== 'filled') throw new Error('expected filled');
    expect(v.grounding.kind).toBe('mismatch');
    if (v.grounding.kind !== 'mismatch') return;
    expect(v.grounding.sourceText).toBe('2,267.65');
  });

  it('is ungrounded — not wrong — when the quote is nowhere in the document', () => {
    const v = verifyField(num, { key: 'invoice_number', quote: 'INV-9999', value: 'INV-9999' }, TEXT, GEO);
    if (v.state !== 'filled') throw new Error('expected filled');
    expect(v.grounding.kind).toBe('ungrounded');
  });

  it('distinguishes the four kinds of empty', () => {
    expect(verifyField(total, undefined, TEXT, GEO)).toEqual({ state: 'empty', reason: 'not_attempted' });
    expect(verifyField(total, { key: 'total', quote: null, value: null, notPresent: true }, TEXT, GEO))
      .toEqual({ state: 'empty', reason: 'not_present' });
    expect(verifyField(total, { key: 'total', quote: 'about two thousand', value: null }, TEXT, GEO))
      .toEqual({ state: 'empty', reason: 'unparseable' });
  });

  it('normalizes dates before comparing, so format is not a mismatch', () => {
    const v = verifyField(date, { key: 'invoice_date', quote: '14 March 2024', value: '2024-03-14' }, TEXT, GEO);
    if (v.state !== 'filled') throw new Error('expected filled');
    expect(v.grounding.kind).toBe('grounded');
  });

  it('reports a computed value as derived rather than failing to ground it', () => {
    const v = verifyField(
      total,
      { key: 'total', quote: null, value: 2267.65, derived: { rule: 'subtotal_plus_tax', operands: ['subtotal', 'tax'] } },
      TEXT, GEO,
    );
    if (v.state !== 'filled') throw new Error('expected filled');
    if (v.grounding.kind !== 'derived') throw new Error('expected derived');
    expect(v.grounding.operands).toEqual(['subtotal', 'tax']);
  });
});

describe('pageOf', () => {
  it('maps a char offset onto its page', () => {
    const geo: PageGeometry[] = [
      { page: 1, width: 1, height: 1, charStart: 0, charEnd: 100 },
      { page: 2, width: 1, height: 1, charStart: 100, charEnd: 200 },
    ];
    expect(pageOf(geo, 0)).toBe(1);
    expect(pageOf(geo, 99)).toBe(1);
    expect(pageOf(geo, 100)).toBe(2);
  });
});

describe('attempted vs never asked', () => {
  it('separates "we never asked" from "we asked and got nothing back"', () => {
    expect(verifyField(total, undefined, TEXT, GEO, false))
      .toEqual({ state: 'empty', reason: 'not_attempted' });
    expect(verifyField(total, undefined, TEXT, GEO, true))
      .toEqual({ state: 'empty', reason: 'extraction_failed' });
  });
});
