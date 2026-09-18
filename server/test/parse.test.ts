import { describe, it, expect } from 'vitest';
import { parseMoney, parseDate, parseByType, valuesAgree } from '../src/parse.js';

describe('parseMoney', () => {
  it('handles symbols and thousands separators', () => {
    expect(parseMoney('$1,250.00')).toEqual({ ok: true, value: 1250 });
    expect(parseMoney('USD 2 267.65')).toEqual({ ok: true, value: 2267.65 });
  });
  it('handles both negative conventions', () => {
    expect(parseMoney('(45.00)')).toEqual({ ok: true, value: -45 });
    expect(parseMoney('45.00-')).toEqual({ ok: true, value: -45 });
  });
  it('handles the European decimal comma', () => {
    expect(parseMoney('1.234,56')).toEqual({ ok: true, value: 1234.56 });
    expect(parseMoney('1234,56')).toEqual({ ok: true, value: 1234.56 });
  });
  it('rejects prose', () => {
    expect(parseMoney('see attached').ok).toBe(false);
  });
});

describe('parseDate', () => {
  it('reads the formats the seed corpus actually contains', () => {
    expect(parseDate('2024-07-31')).toEqual({ ok: true, value: '2024-07-31' });
    expect(parseDate('14 March 2024')).toEqual({ ok: true, value: '2024-03-14' });
    expect(parseDate('August 5, 2024')).toEqual({ ok: true, value: '2024-08-05' });
    expect(parseDate('02/09/2024')).toEqual({ ok: true, value: '2024-02-09' });
  });
  it('swaps an impossible month into the day position', () => {
    expect(parseDate('25/12/2024')).toEqual({ ok: true, value: '2024-12-25' });
  });
  it('rejects what it cannot read rather than guessing', () => {
    expect(parseDate('next Tuesday').ok).toBe(false);
  });
});

describe('valuesAgree', () => {
  it('tolerates formatting, not meaning', () => {
    expect(valuesAgree('money', 1250, 1250.004)).toBe(true);
    expect(valuesAgree('money', 1250, 1250.02)).toBe(false);
    expect(valuesAgree('text', 'Acme Supply Co.', 'acme  supply co')).toBe(true);
    expect(valuesAgree('text', 'Acme Supply', 'Acme Holdings')).toBe(false);
  });
});

describe('parseByType', () => {
  it('dispatches by declared field type', () => {
    expect(parseByType('integer', '1,024')).toEqual({ ok: true, value: 1024 });
    expect(parseByType('text', '  Acme   Co. ')).toEqual({ ok: true, value: 'Acme Co.' });
  });
});
