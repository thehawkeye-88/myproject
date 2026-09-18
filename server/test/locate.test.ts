import { describe, it, expect } from 'vitest';
import { locate, normalize } from '../src/locate.js';

const TEXT = 'Invoice Number:   INV-2024-0042\nVendor:  Acme Supply Co.\nTotal:  2,267.65';

describe('locate', () => {
  it('prefers an exact match and reports it as exact', () => {
    const r = locate(TEXT, 'INV-2024-0042')!;
    expect(r.method).toBe('exact');
    expect(TEXT.slice(r.span.start, r.span.end)).toBe('INV-2024-0042');
  });

  it('falls back to normalized when only whitespace differs', () => {
    const r = locate(TEXT, 'Invoice Number: INV-2024-0042')!;
    expect(r.method).toBe('normalized');
    expect(TEXT.slice(r.span.start, r.span.end)).toContain('INV-2024-0042');
  });

  it('falls back to fuzzy when the model retyped rather than copied', () => {
    const r = locate(TEXT, 'Acme Supp1y C0.')!;
    expect(r.method).toBe('fuzzy');
    expect(TEXT.slice(r.span.start, r.span.end)).toBe('Acme Supply Co.');
  });

  it('returns null rather than a bad span when the text is absent', () => {
    expect(locate(TEXT, 'Northwind Components Limited')).toBeNull();
  });

  it('maps normalized offsets back to real ones', () => {
    const n = normalize('  A  b\n c ');
    expect(n.s).toBe('a b c');
    expect(n.map.length).toBe(n.s.length);
  });
});
