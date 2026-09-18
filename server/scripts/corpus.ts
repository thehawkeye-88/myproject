import PDFDocument from 'pdfkit';
import type { Json } from '@docreview/shared';

/**
 * The sample corpus: sixteen invoices from made-up vendors, in eleven different
 * layouts, each with a declared ground truth.
 *
 * Everything here is invented. The vendors are ABC/DEF/GHI placeholders on
 * purpose, so nothing in this repository can be mistaken for a real supplier's
 * document. What is *not* invented is the layout variation — abbreviated
 * labels, two-column headers, discount rows, footnote markers and ambiguous
 * slash dates are all things real invoices do, and they are the reason a
 * rule-based reader is hard.
 *
 * Because these are generated, the correct answer for all 19 fields of all 16
 * documents is known exactly. That is what makes `./run eval` possible, and it
 * is the only reason the accuracy numbers in the README can exist at all.
 *
 * `truth` is what the document *says*, not what it ought to say. An invoice
 * whose own arithmetic is wrong has a truthful total that fails an invariant —
 * extraction is correct and the flag is correct, and the harness must be able
 * to tell that apart from a false alarm. Hence `expectViolation`.
 */

export type Layout =
  | 'standard'        // every field on its own labelled row
  | 'no-subtotal'     // no subtotal row; it has to be derived from the lines
  | 'discount'        // a discount row the schema has no field for
  | 'footnote-total'  // a footnote marker printed against the total
  | 'letterhead'      // no vendor row; the name is only in the letterhead
  | 'abbrev'          // "Inv #", "Amt Due" — abbreviations, not full labels
  | 'two-column'      // two header fields sharing one line
  | 'symbol-currency' // no currency row; only "$" against the amounts
  | 'rounding'        // a legitimate one-cent rounding difference
  | 'bad-arithmetic'  // the vendor's own total does not add up
  | 'minimal';        // one line, no PO, no tax

export type Spec = {
  file: string;
  layout: Layout;
  vendor: string;
  number: string;
  /** As printed on the page. */
  invoiceDate: string;
  dueDate: string;
  /** What those printed dates mean. Not always what a US-first parser will say. */
  invoiceDateISO: string;
  dueDateISO: string;
  po: string | null;
  /** null when the document never names a currency. */
  currency: string | null;
  lines: [string, number][];
  taxLabel?: string;
  tax: number | null;
  /** null when no subtotal is printed. */
  subtotalPrinted: number | null;
  totalPrinted: number;
  discount?: number;
  /** The document's own figures do not reconcile. A flag here is correct. */
  expectViolation?: boolean;
  /** Why this document is in the corpus. */
  tests: string;
};

const L = (desc: string, amt: number): [string, number] => [desc, amt];
const sum = (lines: [string, number][]) => round(lines.reduce((a, l) => a + l[1], 0));
const round = (n: number) => Math.round(n * 100) / 100;

export const CORPUS: Spec[] = [
  {
    file: 'abc-supply-INV-1001.pdf', layout: 'standard', vendor: 'ABC Supply Co.',
    number: 'INV-1001', invoiceDate: '14 March 2024', invoiceDateISO: '2024-03-14',
    dueDate: '13 April 2024', dueDateISO: '2024-04-13', po: 'PO-88231', currency: 'USD',
    lines: [L('Steel fasteners 10mm, 500 units', 1250), L('Anodized brackets, 120 units', 840), L('Freight and handling', 95.5)],
    tax: 185.77, subtotalPrinted: 2185.5, totalPrinted: 2371.27,
    tests: 'the clean case — nothing should be flagged',
  },
  {
    file: 'def-logistics-DL-2087.pdf', layout: 'no-subtotal', vendor: 'DEF Logistics Ltd.',
    number: 'DL-2087', invoiceDate: '3 April 2024', invoiceDateISO: '2024-04-03',
    dueDate: '3 May 2024', dueDateISO: '2024-05-03', po: 'PO-41190', currency: 'USD',
    lines: [L('Container drayage, Port of Example', 2240), L('Chassis rental, 6 days', 390)],
    tax: null, subtotalPrinted: null, totalPrinted: 2630,
    tests: 'a subtotal that must be derived, and said to be derived',
  },
  {
    file: 'ghi-print-GP-3307.pdf', layout: 'footnote-total', vendor: 'GHI Print Works',
    number: 'GP-3307', invoiceDate: 'August 5, 2024', invoiceDateISO: '2024-08-05',
    dueDate: 'September 4, 2024', dueDateISO: '2024-09-04', po: 'PO-77012', currency: 'USD',
    lines: [L('Offset print run, 5000 copies', 4820), L('Spot UV finishing', 660), L('Proof revisions, 3 rounds', 225), L('Palletized delivery', 180), L('Rush surcharge', 400)],
    tax: 565.65, subtotalPrinted: 6285, totalPrinted: 6850.65,
    tests: 'the single most important number on the page is unreadable',
  },
  {
    file: 'jkl-components-JC-4412.pdf', layout: 'discount', vendor: 'JKL Components Inc.',
    number: 'JC-4412', invoiceDate: '2024-07-31', invoiceDateISO: '2024-07-31',
    dueDate: '2024-08-30', dueDateISO: '2024-08-30', po: 'PO-55120', currency: 'USD',
    lines: [L('Injection moulded housings, 400 units', 2240), L('Tooling amortisation', 390), L('Expedite fee', 610), L('Documentation fee', 75)],
    tax: 191.56, subtotalPrinted: 3315, totalPrinted: 3256.56, discount: 250, expectViolation: true,
    tests: 'a discount the schema cannot express — the arithmetic must not silently close',
  },
  {
    file: 'lmn-consulting-LC-5590.pdf', layout: 'letterhead', vendor: 'LMN Consulting Group',
    number: 'LC-5590', invoiceDate: '11 June 2024', invoiceDateISO: '2024-06-11',
    dueDate: '11 July 2024', dueDateISO: '2024-07-11', po: null, currency: 'USD',
    lines: [L('Discovery workshop, 2 days', 6400), L('Architecture review', 3200)],
    tax: 816, subtotalPrinted: 9600, totalPrinted: 10416,
    tests: 'no vendor row — the name exists only in the letterhead',
  },
  {
    file: 'mno-freight-MF-6120.pdf', layout: 'abbrev', vendor: 'MNO Freight Services',
    number: 'MF-6120', invoiceDate: '22 May 2024', invoiceDateISO: '2024-05-22',
    dueDate: '21 June 2024', dueDateISO: '2024-06-21', po: 'PO-30014', currency: 'USD',
    lines: [L('LTL shipment, 3 pallets', 1180), L('Liftgate service', 95), L('Fuel surcharge', 142.5)],
    tax: 118.34, subtotalPrinted: 1417.5, totalPrinted: 1535.84,
    tests: 'abbreviated labels rather than full words',
  },
  {
    file: 'pqr-software-PS-7043.pdf', layout: 'two-column', vendor: 'PQR Software Ltd.',
    number: 'PS-7043', invoiceDate: '2024-02-19', invoiceDateISO: '2024-02-19',
    dueDate: '2024-03-20', dueDateISO: '2024-03-20', po: 'PO-90881', currency: 'USD',
    lines: [L('Platform licence, annual', 24000), L('Onboarding and migration', 4500)],
    tax: 2422.5, subtotalPrinted: 28500, totalPrinted: 30922.5,
    tests: 'two header fields sharing one line — the hardest layout here',
  },
  {
    file: 'stu-catering-SC-8215.pdf', layout: 'symbol-currency', vendor: 'STU Catering Co.',
    number: 'SC-8215', invoiceDate: '9 September 2024', invoiceDateISO: '2024-09-09',
    dueDate: '9 October 2024', dueDateISO: '2024-10-09', po: 'PO-12277', currency: null,
    lines: [L('Conference lunch, 120 covers', 3600), L('Barista service, 2 stations', 780)],
    tax: 372.3, subtotalPrinted: 4380, totalPrinted: 4752.3,
    tests: 'currency never named — only a symbol, so it must be inferred and marked derived',
  },
  {
    file: 'vwx-equipment-VE-9004.pdf', layout: 'rounding', vendor: 'VWX Equipment Rental',
    number: 'VE-9004', invoiceDate: '17 January 2024', invoiceDateISO: '2024-01-17',
    dueDate: '16 February 2024', dueDateISO: '2024-02-16', po: 'PO-66710', currency: 'USD',
    lines: [L('Scissor lift, 14 days', 333.33), L('Telehandler, 9 days', 333.33), L('Delivery and collection', 333.34)],
    tax: 85, subtotalPrinted: 1000, totalPrinted: 1085.01,
    tests: 'a legitimate one-cent rounding difference, which must NOT be flagged',
  },
  {
    file: 'xyz-industrial-XI-1150.pdf', layout: 'bad-arithmetic', vendor: 'XYZ Industrial Supply',
    number: 'XI-1150', invoiceDate: '4 November 2024', invoiceDateISO: '2024-11-04',
    dueDate: '4 December 2024', dueDateISO: '2024-12-04', po: 'PO-70233', currency: 'USD',
    lines: [L('Hydraulic seals, 200 units', 1400), L('Bearing assemblies, 40 units', 600)],
    tax: 160, subtotalPrinted: 2000, totalPrinted: 2260, expectViolation: true,
    tests: "the vendor's own total is wrong by $100 — extraction is right and the flag is right",
  },
  {
    file: 'abc-supply-INV-1188.pdf', layout: 'minimal', vendor: 'ABC Supply Co.',
    number: 'INV-1188', invoiceDate: '28 February 2024', invoiceDateISO: '2024-02-28',
    dueDate: '29 March 2024', dueDateISO: '2024-03-29', po: null, currency: 'USD',
    lines: [L('Annual maintenance contract', 5400)],
    tax: null, subtotalPrinted: 5400, totalPrinted: 5400,
    tests: 'a one-line invoice with no PO and no tax — four legitimate absences',
  },
  {
    file: 'def-logistics-DL-2211.pdf', layout: 'standard', vendor: 'DEF Logistics Ltd.',
    number: 'DL-2211', invoiceDate: '02/09/2024', invoiceDateISO: '2024-09-02',
    dueDate: '02/10/2024', dueDateISO: '2024-10-02', po: 'PO-41255', currency: 'USD',
    lines: [L('Groupage consolidation', 1850), L('Customs clearance', 320)],
    tax: 173.6, subtotalPrinted: 2170, totalPrinted: 2343.6,
    tests: 'slash dates written day-first — a US-first parser will read them wrong',
  },
  {
    file: 'ghi-print-GP-3401.pdf', layout: 'standard', vendor: 'GHI Print Works',
    number: 'GP-3401', invoiceDate: '30 October 2024', invoiceDateISO: '2024-10-30',
    dueDate: '29 November 2024', dueDateISO: '2024-11-29', po: 'PO-77190', currency: 'USD',
    lines: [L('Perfect-bound catalogues, 2000 copies', 7300), L('Lamination, gloss', 540), L('Sample mailing', 210), L('Artwork correction', 160), L('Warehouse handling', 290)],
    tax: 763.2, subtotalPrinted: 8500, totalPrinted: 9263.2,
    tests: 'a full five-line table with nothing unusual about it',
  },
  {
    file: 'jkl-components-JC-4530.pdf', layout: 'no-subtotal', vendor: 'JKL Components Inc.',
    number: 'JC-4530', invoiceDate: '8 August 2024', invoiceDateISO: '2024-08-08',
    dueDate: '7 September 2024', dueDateISO: '2024-09-07', po: 'PO-55298', currency: 'USD',
    lines: [L('CNC machined flanges, 150 units', 4350), L('Surface treatment', 620), L('Inspection report', 180)],
    taxLabel: 'VAT', tax: 322.5, subtotalPrinted: null, totalPrinted: 5472.5,
    tests: 'a derived subtotal plus "VAT" instead of "Tax"',
  },
  {
    file: 'mno-freight-MF-6288.pdf', layout: 'standard', vendor: 'MNO Freight Services',
    number: 'MF-6288', invoiceDate: '15 July 2024', invoiceDateISO: '2024-07-15',
    dueDate: '14 August 2024', dueDateISO: '2024-08-14', po: null, currency: 'USD',
    lines: [L('Reefer transport, 480 miles', 2900), L('Temperature monitoring', 175)],
    tax: 246, subtotalPrinted: 3075, totalPrinted: 3321,
    tests: 'a standard layout with a legitimately absent PO number',
  },
  {
    file: 'xyz-industrial-XI-1302.pdf', layout: 'footnote-total', vendor: 'XYZ Industrial Supply',
    number: 'XI-1302', invoiceDate: '21 December 2024', invoiceDateISO: '2024-12-21',
    dueDate: '20 January 2025', dueDateISO: '2025-01-20', po: 'PO-70410', currency: 'USD',
    lines: [L('Pneumatic actuators, 60 units', 5100), L('Mounting kits', 720), L('Calibration service', 450)],
    tax: 507.6, subtotalPrinted: 6270, totalPrinted: 6777.6,
    tests: 'a second unreadable total, to check the first was not a one-off',
  },
];

/** The correct value for every field of one document. `null` means genuinely absent. */
export function truthOf(s: Spec): Record<string, Json | null> {
  const t: Record<string, Json | null> = {
    vendor_name: s.vendor,
    invoice_number: s.number,
    invoice_date: s.invoiceDateISO,
    due_date: s.dueDateISO,
    po_number: s.po,
    currency: s.currency ?? 'USD',
    subtotal: s.subtotalPrinted ?? sum(s.lines),
    tax: s.tax,
    total: s.totalPrinted,
  };
  for (let i = 1; i <= 5; i++) {
    const line = s.lines[i - 1];
    t[`line_${i}_description`] = line ? line[0] : null;
    t[`line_${i}_amount`] = line ? line[1] : null;
  }
  return t;
}

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ADDRESS: Record<string, string> = {};
const addressFor = (vendor: string) =>
  ADDRESS[vendor] ??= `Demo Address ${100 + (vendor.length * 7) % 800}, Test City`;

export function render(s: Spec): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const amt = (n: number) => (s.layout === 'symbol-currency' ? `$${money(n)}` : money(n));
  const row = (k: string, v: string) => doc.font('Courier').fontSize(10).text(`${k.padEnd(18)}${v}`);

  doc.font('Helvetica-Bold').fontSize(18).text(s.vendor);
  doc.font('Helvetica').fontSize(9).fillColor('#555').text(addressFor(s.vendor));
  doc.moveDown(1.2).fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(14).text('INVOICE');
  doc.moveDown(0.8);

  // --- header block -------------------------------------------------------
  if (s.layout === 'two-column') {
    doc.font('Courier').fontSize(10);
    doc.text(`Invoice Number:   ${s.number.padEnd(22)}Invoice Date:   ${s.invoiceDate}`);
    doc.text(`PO Number:        ${(s.po ?? '').padEnd(22)}Due Date:       ${s.dueDate}`);
    doc.text(`Vendor:           ${s.vendor.padEnd(22)}Currency:       ${s.currency ?? ''}`);
  } else if (s.layout === 'abbrev') {
    row('Inv #', s.number);
    row('Dt', s.invoiceDate);
    row('Due', s.dueDate);
    if (s.po) row('PO #', s.po);
    if (s.currency) row('Ccy', s.currency);
    row('Supplier', s.vendor);
  } else {
    if (s.layout !== 'letterhead') row('Vendor:', s.vendor);
    row('Invoice Number:', s.number);
    row('Invoice Date:', s.invoiceDate);
    row('Due Date:', s.dueDate);
    if (s.po) row('PO Number:', s.po);
    if (s.currency) row('Currency:', s.currency);
  }

  doc.moveDown(1).font('Helvetica-Bold').fontSize(10).text('Bill To: Demo Customer');
  doc.moveDown(1);

  // --- line items ---------------------------------------------------------
  doc.font('Courier-Bold').fontSize(10).text('       Description'.padEnd(60) + 'Amount');
  doc.font('Courier').fontSize(10);
  s.lines.forEach(([desc, n], i) => doc.text(`Item ${i + 1} ${desc}`.padEnd(60) + amt(n)));

  // --- totals block -------------------------------------------------------
  doc.moveDown(1);
  if (s.subtotalPrinted !== null) row('Subtotal:', amt(s.subtotalPrinted));
  if (s.discount) doc.font('Courier').fontSize(10).text(`${'Discount'.padEnd(18)}-${amt(s.discount)}`);
  if (s.tax !== null) row(`${s.taxLabel ?? 'Tax'}:`, amt(s.tax));
  doc.font('Courier-Bold');
  const totalLabel = s.layout === 'abbrev' ? 'Amt Due' : 'Total:';
  row(totalLabel, s.layout === 'footnote-total' ? `${amt(s.totalPrinted)} *` : amt(s.totalPrinted));

  if (s.layout === 'footnote-total') {
    doc.moveDown(0.8).font('Helvetica').fontSize(8).fillColor('#666')
       .text('* Includes surcharges; see terms overleaf.').fillColor('#000');
  }
  if (s.layout === 'letterhead') {
    doc.moveDown(0.8).font('Helvetica').fontSize(9)
       .text(`Raised against purchase order ${s.po ?? 'on file'}.`);
  }

  doc.moveDown(2).font('Helvetica').fontSize(8).fillColor('#666')
     .text('Payment due within 30 days. Remit via demo payment instructions.');
  doc.end();

  return new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
}
