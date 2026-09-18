import type { FieldType, FieldKey } from './types.js';

export const SCHEMA_VERSION = 1;

export type FieldDef = {
  key: FieldKey;
  label: string;
  type: FieldType;
  group: 'header' | 'totals' | 'lines';
  required: boolean;
  /** Triage multiplier. A wrong total costs more than a wrong PO number. */
  importance: number;
  describe: string;
};

export const LINE_ITEM_COUNT = 5;

const lineFields: FieldDef[] = Array.from({ length: LINE_ITEM_COUNT }, (_, i) => {
  const n = i + 1;
  return [
    {
      key: `line_${n}_description`,
      label: `Line ${n} — description`,
      type: 'text' as const,
      group: 'lines' as const,
      required: false,
      importance: 0.6,
      describe: `Description of line item ${n}. Null if there is no line ${n}.`,
    },
    {
      key: `line_${n}_amount`,
      label: `Line ${n} — amount`,
      type: 'money' as const,
      group: 'lines' as const,
      required: false,
      importance: 1.2,
      describe: `Line total for item ${n} (not unit price). Null if there is no line ${n}.`,
    },
  ];
}).flat();

export const FIELDS: FieldDef[] = [
  { key: 'vendor_name',    label: 'Vendor',         type: 'text',    group: 'header', required: true,  importance: 1.3, describe: 'Legal name of the party issuing the invoice (not the bill-to party).' },
  { key: 'invoice_number', label: 'Invoice number', type: 'text',    group: 'header', required: true,  importance: 1.4, describe: 'The invoice identifier.' },
  { key: 'invoice_date',   label: 'Invoice date',   type: 'date',    group: 'header', required: true,  importance: 1.2, describe: 'Date the invoice was issued, ISO 8601 (YYYY-MM-DD).' },
  { key: 'due_date',       label: 'Due date',       type: 'date',    group: 'header', required: false, importance: 1.2, describe: 'Payment due date, ISO 8601. Null if absent.' },
  { key: 'po_number',      label: 'PO number',      type: 'text',    group: 'header', required: false, importance: 0.7, describe: 'Purchase order reference. Null if absent.' },
  { key: 'currency',       label: 'Currency',       type: 'text',    group: 'header', required: false, importance: 0.9, describe: 'ISO 4217 code, e.g. USD. Null if not stated.' },
  ...lineFields,
  { key: 'subtotal',       label: 'Subtotal',       type: 'money',   group: 'totals', required: true,  importance: 1.5, describe: 'Sum of line items before tax.' },
  { key: 'tax',            label: 'Tax',            type: 'money',   group: 'totals', required: false, importance: 1.4, describe: 'Total tax charged. Null if none.' },
  { key: 'total',          label: 'Total',          type: 'money',   group: 'totals', required: true,  importance: 2.0, describe: 'Grand total payable.' },
];

export const FIELD_BY_KEY: Record<string, FieldDef> = Object.fromEntries(
  FIELDS.map((f) => [f.key, f]),
);

export const GROUPS = ['header', 'lines', 'totals'] as const;
export type Group = (typeof GROUPS)[number];

export const GROUP_LABEL: Record<Group, string> = {
  header: 'Header',
  lines: 'Line items',
  totals: 'Totals',
};

export const LINE_AMOUNT_KEYS = Array.from(
  { length: LINE_ITEM_COUNT },
  (_, i) => `line_${i + 1}_amount`,
);
