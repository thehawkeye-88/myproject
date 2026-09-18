import type { FieldType, Json } from '@docreview/shared';

export type ParseResult = { ok: true; value: Json } | { ok: false; why: string };

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Money -> number. Handles symbols, thousands separators, both negative forms. */
export function parseMoney(raw: string): ParseResult {
  let s = raw.trim();
  if (!s) return { ok: false, why: 'empty' };

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s)) { negative = true; s = s.replace(/-\s*$/, ''); }

  s = s.replace(/[A-Za-z$£€¥₹\s]/g, '');
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }

  // European form: 1.234,56 -> comma is the decimal separator.
  if (/,\d{1,2}$/.test(s) && /\./.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/,\d{1,2}$/.test(s) && !/\./.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');

  if (!/^\d*\.?\d+$/.test(s)) return { ok: false, why: `not a number: ${raw}` };
  const n = Number(s);
  if (!Number.isFinite(n)) return { ok: false, why: `not finite: ${raw}` };
  return { ok: true, value: Math.round((negative ? -n : n) * 100) / 100 };
}

/** Date -> ISO 8601 (YYYY-MM-DD). Ambiguous D/M vs M/D resolves US-first, then sanity. */
export function parseDate(raw: string): ParseResult {
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return { ok: false, why: 'empty' };

  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3], raw);

  // 12 March 2024 / March 12, 2024 / 12-Mar-2024
  m = s.match(/(\d{1,2})[ \-]([A-Za-z]{3,})[ \-,]+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[1], raw);
  }
  m = s.match(/([A-Za-z]{3,})[ \-]+(\d{1,2})(?:st|nd|rd|th)?[ ,\-]+(\d{4})/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[2], raw);
  }

  m = s.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    let year = +y;
    if (year < 100) year += year < 70 ? 2000 : 1900;
    let mo = +a, day = +b;
    if (mo > 12 && day <= 12) { [mo, day] = [day, mo]; }
    return iso(year, mo, day, raw);
  }

  return { ok: false, why: `unrecognised date: ${raw}` };
}

function iso(y: number, m: number, d: number, raw: string): ParseResult {
  if (m < 1 || m > 12 || d < 1 || d > 31) return { ok: false, why: `out of range: ${raw}` };
  const pad = (n: number) => String(n).padStart(2, '0');
  return { ok: true, value: `${y}-${pad(m)}-${pad(d)}` };
}

export function parseInteger(raw: string): ParseResult {
  const s = raw.trim().replace(/[,\s]/g, '');
  if (!/^-?\d+$/.test(s)) return { ok: false, why: `not an integer: ${raw}` };
  return { ok: true, value: Number(s) };
}

export function parseText(raw: string): ParseResult {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s ? { ok: true, value: s } : { ok: false, why: 'empty' };
}

export function parseByType(type: FieldType, raw: string): ParseResult {
  switch (type) {
    case 'money': return parseMoney(raw);
    case 'date': return parseDate(raw);
    case 'integer': return parseInteger(raw);
    case 'text': return parseText(raw);
    default: {
      const never: never = type;
      return { ok: false, why: `unknown type ${never}` };
    }
  }
}

/** Equality that tolerates formatting, not meaning. */
export function valuesAgree(type: FieldType, a: Json, b: Json): boolean {
  if (a === null || b === null) return a === b;
  if (type === 'money') return Math.abs(Number(a) - Number(b)) < 0.005;
  if (type === 'integer') return Number(a) === Number(b);
  if (type === 'date') return String(a) === String(b);
  return norm(String(a)) === norm(String(b));
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
