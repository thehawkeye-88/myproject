export type FieldKey = string;
export type Json = string | number | boolean | null;

export type CharRange = { start: number; end: number };

/** How a value was located in the source document. Orthogonal to violations. */
export type Grounding =
  | { kind: 'grounded'; span: CharRange; page: number; how: LocateMethod }
  | { kind: 'derived'; rule: string; operands: FieldKey[] }
  | { kind: 'mismatch'; span: CharRange; page: number; sourceText: string }
  | { kind: 'ungrounded' };

export type LocateMethod = 'exact' | 'normalized' | 'fuzzy';

export type Violation = { rule: string; message: string; operands: FieldKey[] };

/** Four-way. Collapsing these into one blank cell is the bug this product exists to avoid. */
export type EmptyReason =
  | 'not_attempted'
  | 'not_present'
  | 'extraction_failed'
  | 'unparseable';

export type FieldValue =
  | { state: 'empty'; reason: EmptyReason }
  | { state: 'filled'; value: Json; grounding: Grounding; violations: Violation[] };

export type ReviewStatus = 'pending' | 'accepted' | 'rejected';

export type Field = {
  id: string;
  key: FieldKey;
  label: string;
  type: FieldType;
  group: string;
  value: FieldValue;
  source: 'model' | 'human';
  originalValue?: Json;
  review: ReviewStatus;
  version: number;
  priority: number;
  priorityReason: string;
};

export type FieldType = 'money' | 'date' | 'text' | 'integer';

export type PageGeometry = {
  page: number;
  width: number;
  height: number;
  charStart: number;
  charEnd: number;
};

export type CharBox = {
  charStart: number;
  charEnd: number;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type DocStatus =
  | 'uploaded'
  | 'text_extracted'
  | 'extracting'
  | 'ready'
  | 'failed';

export type DocumentSummary = {
  id: string;
  filename: string;
  status: DocStatus;
  pageCount: number;
  createdAt: string;
  counts: { total: number; pending: number; needsReview: number };
};

export type DocumentDetail = DocumentSummary & {
  textLayer: string;
  pageGeometry: PageGeometry[];
  charBoxes: CharBox[];
  runStatus: string | null;
  runError: string | null;
  usage: Record<string, number> | null;
};

export type Filter = 'all' | 'needs-review' | 'empty' | 'accepted';

export type PatchFieldBody = {
  value?: Json;
  review?: ReviewStatus;
  revert?: boolean;
  version: number;
};

export type ConflictResponse = { error: 'conflict'; current: Field };
