import type { FieldKey, Json, Violation } from '@docreview/shared';
import { LINE_AMOUNT_KEYS } from '@docreview/shared';

/** One cent of rounding is legitimate; two is a discrepancy. Compared in integer
 *  cents because 108.50 - 108.51 is not 0.01 in binary floating point. */
const TOLERANCE_CENTS = 1;
const differs = (a: number, b: number) => Math.abs(Math.round(a * 100) - Math.round(b * 100)) > TOLERANCE_CENTS;

const money = (v: Json | null | undefined): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Arithmetic consistency across the field set. Pure. A violation means something
 * provably *is* wrong — which is stronger evidence than any grounding verdict,
 * and is why violations outrank everything in triage.
 *
 * Returns violations keyed by every field implicated, so each row can show it.
 */
export function checkInvariants(
  values: Record<FieldKey, Json | null>,
  /**
   * The verbatim text each value was read from, where there is one. Only the
   * ambiguous-date rule needs it: once "02/09/2024" has been parsed into an ISO
   * date, the ambiguity is gone and nothing downstream can recover it. Absent
   * for human-entered and derived values, which is correct — a human who typed
   * a date is not guessing at it.
   */
  sources: Record<FieldKey, string | null> = {},
): Record<FieldKey, Violation[]> {
  const out: Record<FieldKey, Violation[]> = {};
  const add = (keys: FieldKey[], v: Violation) => {
    for (const k of keys) (out[k] ??= []).push(v);
  };

  const lines = LINE_AMOUNT_KEYS.filter((k) => money(values[k]) !== null);
  const subtotal = money(values.subtotal);
  const tax = money(values.tax);
  const total = money(values.total);

  if (lines.length > 0 && subtotal !== null) {
    const sum = lines.reduce((a, k) => a + money(values[k])!, 0);
    if (differs(sum, subtotal)) {
      add([...lines, 'subtotal'], {
        rule: 'lines_sum_to_subtotal',
        message: `Line items sum to ${fmt(sum)} but subtotal reads ${fmt(subtotal)}.`,
        operands: [...lines, 'subtotal'],
      });
    }
  }

  if (subtotal !== null && total !== null) {
    const expected = subtotal + (tax ?? 0);
    if (differs(expected, total)) {
      const withTax = tax !== null ? ` plus tax ${fmt(tax)}` : '';
      add(tax !== null ? ['subtotal', 'tax', 'total'] : ['subtotal', 'total'], {
        rule: 'subtotal_plus_tax_is_total',
        message: `Subtotal ${fmt(subtotal)}${withTax} gives ${fmt(expected)}, but total reads ${fmt(total)}.`,
        operands: tax !== null ? ['subtotal', 'tax', 'total'] : ['subtotal', 'total'],
      });
    }
  }

  const invoiceDate = typeof values.invoice_date === 'string' ? values.invoice_date : null;
  const dueDate = typeof values.due_date === 'string' ? values.due_date : null;
  if (invoiceDate && dueDate && dueDate < invoiceDate) {
    add(['invoice_date', 'due_date'], {
      rule: 'due_after_invoice',
      message: `Due date ${dueDate} is before the invoice date ${invoiceDate}.`,
      operands: ['invoice_date', 'due_date'],
    });
  }

  // A slash date whose first two components are both <= 12 has two readings and
  // no way to choose between them. The parser picks one; saying so is the only
  // honest option, because a silently wrong date is the exact failure this tool
  // exists to prevent and nothing downstream can detect it.
  for (const key of ['invoice_date', 'due_date'] as const) {
    const raw = sources[key];
    if (typeof raw !== 'string') continue;
    const m = raw.match(/^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\s*$/);
    if (!m) continue;
    const [, a, b] = m;
    if (Number(a) > 12 || Number(b) > 12 || a === b) continue;
    add([key], {
      rule: 'ambiguous_date',
      message: `"${raw.trim()}" could be ${Number(a)}/${Number(b)} or ${Number(b)}/${Number(a)} — read as ${values[key]}. Confirm against the document.`,
      operands: [key],
    });
  }

  if (total !== null && total < 0) {
    add(['total'], {
      rule: 'total_non_negative',
      message: `Total is negative (${fmt(total)}). Credit notes are not supported by this schema.`,
      operands: ['total'],
    });
  }

  return out;
}
