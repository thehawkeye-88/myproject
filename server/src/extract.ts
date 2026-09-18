import { FIELDS, FIELD_BY_KEY, LINE_ITEM_COUNT, LINE_AMOUNT_KEYS } from '@docreview/shared';
import type { Json } from '@docreview/shared';
import { parseByType, parseMoney } from './parse.js';
import type { Candidate } from './verify.js';

/**
 * A deterministic, rule-based invoice reader. No model, no network, no API key.
 *
 * It does two different things and is careful to say which is which:
 *   - **reads** a value off the page, reporting the exact text it read, or
 *   - **derives** one from other fields, reporting the rule and its operands.
 *
 * Everything it cannot do either way is reported as absent or unreadable rather
 * than guessed at. Its failures are real failures of these rules on these
 * layouts — which is the point: the verifier downstream has something genuine
 * to catch.
 */

export type ExtractionResult = {
  candidates: Map<string, Candidate>;
  stats: { read: number; derived: number; absent: number; unreadable: number };
};

/** Longest label wins, so "Invoice Date" beats "Date" and "Subtotal" beats "Total". */
const LABELS: Record<string, string[]> = {
  vendor_name:    ['vendor', 'supplier', 'sold by', 'bill from', 'from'],
  invoice_number: ['invoice number', 'invoice no.', 'invoice no', 'invoice #', 'inv no', 'inv #', 'reference'],
  invoice_date:   ['invoice date', 'date of issue', 'date issued', 'issued', 'date'],
  due_date:       ['payment due', 'due date', 'due by', 'due'],
  po_number:      ['purchase order', 'p.o. number', 'po number', 'po no', 'po #'],
  currency:       ['currency'],
  subtotal:       ['subtotal', 'sub-total', 'sub total', 'net amount', 'net total'],
  tax:            ['sales tax', 'tax', 'vat', 'gst'],
  total:          ['total due', 'amount due', 'balance due', 'grand total', 'total payable', 'total'],
};

type Labelled = { key: string; label: string };

const LABEL_INDEX: Labelled[] = Object.entries(LABELS)
  .flatMap(([key, labels]) => labels.map((label) => ({ key, label })))
  .sort((a, b) => b.label.length - a.label.length);

const MONEY_AT_END = /([($]?-?[\d][\d,.\s]*\d(?:\s*[-)])?\s*\*?)\s*$/;
const TABLE_HEAD = /(description|item|details|service)/i;
const TABLE_AMOUNT = /(amount|total|price|charge)/i;

export function extract(text: string, scope?: string[]): ExtractionResult {
  const wanted = new Set(scope?.length ? scope : FIELDS.map((f) => f.key));
  const lines = text.split('\n');
  const candidates = new Map<string, Candidate>();

  /** Record what was read, and the verbatim text it was read from. */
  const read = (key: string, raw: string, _q?: string) => {
    if (!wanted.has(key) || candidates.has(key)) return;
    const def = FIELD_BY_KEY[key];
    if (!def) return;
    const parsed = parseByType(def.type, raw);
    candidates.set(key, { key, quote: raw, value: parsed.ok ? parsed.value : null });
  };

  const derive = (key: string, value: Json, rule: string, operands: string[]) => {
    if (!wanted.has(key) || candidates.has(key)) return;
    candidates.set(key, { key, quote: null, value, derived: { rule, operands } });
  };

  const absent = (key: string) => {
    if (!wanted.has(key) || candidates.has(key)) return;
    candidates.set(key, { key, quote: null, value: null, notPresent: true });
  };

  // ---- pass 1: labelled fields -------------------------------------------
  const consumed = new Set<number>();
  const hits = new Map<string, string[]>();
  lines.forEach((line, i) => {
    const found = matchLabels(line);
    if (!found.length) return;
    consumed.add(i);
    for (const hit of found) hits.set(hit.key, [...(hits.get(hit.key) ?? []), hit.value]);
  });

  for (const [key, found] of hits) {
    const def = FIELD_BY_KEY[key];
    if (!def) continue;
    // Prefer a hit that actually parses. A footer reading "Payment due within
    // 30 days" is a real match on the label "payment due" and a useless one;
    // the dated row above it is the field. Keep a non-parsing hit when it is
    // the only one, so it surfaces as unreadable rather than silently absent.
    read(key, found.find((v) => parseByType(def.type, v).ok) ?? found[0], '');
  }

  // ---- pass 2: the line-item table ---------------------------------------
  const items = readTable(lines, consumed);
  items.slice(0, LINE_ITEM_COUNT).forEach((item, i) => {
    read(`line_${i + 1}_description`, item.description, item.description);
    read(`line_${i + 1}_amount`, item.amount, item.amount);
  });
  for (let n = items.length + 1; n <= LINE_ITEM_COUNT; n++) {
    absent(`line_${n}_description`);
    absent(`line_${n}_amount`);
  }

  // ---- pass 3: the letterhead, when no vendor label exists ---------------
  if (!candidates.has('vendor_name')) {
    const head = lines.find((l) => l.trim().length > 2 && !/^invoice$/i.test(l.trim()));
    if (head) read('vendor_name', head.trim(), head.trim());
  }

  // ---- pass 4: derivation, clearly marked as such ------------------------
  const num = (key: string) => {
    const c = candidates.get(key);
    return typeof c?.value === 'number' ? c.value : null;
  };

  const lineKeys = LINE_AMOUNT_KEYS.filter((k) => num(k) !== null);
  if (!candidates.has('subtotal') && lineKeys.length > 0) {
    const sum = lineKeys.reduce((a, k) => a + num(k)!, 0);
    derive('subtotal', round(sum), 'sum_of_line_items', lineKeys);
  }

  // Tax is never derived. Inferring it from total minus subtotal would make the
  // arithmetic check pass by construction, which is precisely the discrepancy
  // the check exists to surface.
  if (!candidates.has('total')) {
    const sub = num('subtotal');
    if (sub !== null) {
      const tax = num('tax') ?? 0;
      derive('total', round(sub + tax), 'subtotal_plus_tax', num('tax') !== null ? ['subtotal', 'tax'] : ['subtotal']);
    }
  }

  if (!candidates.has('currency')) {
    const sym = text.match(/[$£€¥₹]/)?.[0];
    const code = sym && { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' }[sym];
    if (code) derive('currency', code, 'currency_symbol', []);
  }

  // ---- pass 5: everything else is genuinely absent -----------------------
  for (const def of FIELDS) absent(def.key);

  return { candidates, stats: summarise(candidates) };
}

type Hit = { key: string; value: string };

/**
 * Every labelled field on one line, not just the first.
 *
 * Two-column headers print "Invoice Number:  PS-7043   Invoice Date: 2024-02-19",
 * and reading only the first label makes the invoice number
 * "PS-7043 Invoice Date: 2024-02-19" — a value that is wrong, is verbatim in the
 * document, grounds perfectly against it, and is therefore never flagged. A
 * wrong value nobody is warned about is the worst thing this codebase can
 * produce, which is what the second pass here is for. (Splitting on runs of
 * whitespace does not work: pdf.js collapses the column padding to one space.)
 *
 * Mid-line a label must carry a colon. At line start it may be followed by
 * whitespace alone, because plenty of invoices align columns instead of
 * punctuating them.
 */
function matchLabels(line: string): Hit[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();

  type Mark = { key: string; start: number; valueAt: number };
  const marks: Mark[] = [];
  const claimed = new Array<boolean>(trimmed.length).fill(false);

  // Longest label first, so "Invoice Date" is claimed before bare "Date" can
  // match inside it, and "Subtotal" before "Total".
  for (const { key, label } of LABEL_INDEX) {
    if (marks.some((m) => m.key === key)) continue;
    for (let at = lower.indexOf(label); at !== -1; at = lower.indexOf(label, at + 1)) {
      if (at !== 0 && !/\s/.test(trimmed[at - 1])) continue;
      if (claimed.slice(at, at + label.length).some(Boolean)) continue;
      const rest = trimmed.slice(at + label.length);
      const sep = at === 0
        ? rest.match(/^\s*[:\-–]\s*/) ?? rest.match(/^\s*[:\-–]?\s+/)
        : rest.match(/^\s*[:\-–]\s*/);
      if (!sep || !rest.slice(sep[0].length).trim()) continue;
      for (let i = at; i < at + label.length; i++) claimed[i] = true;
      marks.push({ key, start: at, valueAt: at + label.length + sep[0].length });
      break;
    }
  }

  marks.sort((a, b) => a.start - b.start);
  return marks
    .map((m, i) => ({ key: m.key, value: trimmed.slice(m.valueAt, marks[i + 1]?.start).trim() }))
    .filter((h) => h.value);
}

type Item = { description: string; amount: string };

function readTable(lines: string[], consumed: Set<number>): Item[] {
  const headIndex = lines.findIndex((l) => TABLE_HEAD.test(l) && TABLE_AMOUNT.test(l));
  if (headIndex === -1) return [];

  const items: Item[] = [];
  for (let i = headIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { if (items.length) break; else continue; }
    // A totals row ends the table.
    if (consumed.has(i) || matchLabels(line).length > 0) break;

    const m = trimmed.match(MONEY_AT_END);
    if (!m) continue;
    const amount = m[1].trim();
    if (!parseMoney(amount).ok) continue;

    const description = trimmed.slice(0, trimmed.length - m[1].length)
      .replace(/^item\s+\d+[.)]?\s*/i, '')
      .replace(/[.\s]+$/, '')
      .trim();
    if (!description) continue;
    items.push({ description, amount });
  }
  return items;
}

function summarise(candidates: Map<string, Candidate>) {
  let read = 0, derived = 0, absent = 0, unreadable = 0;
  for (const c of candidates.values()) {
    if (c.derived) derived++;
    else if (c.notPresent) absent++;
    else if (c.value === null) unreadable++;
    else read++;
  }
  return { read, derived, absent, unreadable };
}

const round = (n: number) => Math.round(n * 100) / 100;
