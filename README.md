# Document Review

A small full-stack invoice-review tool built around one idea:

> **The machine can extract values. The product's job is to tell a reviewer which values deserve attention, why, and where the evidence is.**

The app reads invoice PDFs, verifies the extracted values against the document, ranks the fields that need human attention, lets the reviewer correct them, and blocks unreviewed export by default.

It is intentionally deterministic: **no AI model, no API key, and no network call are required.**

---

## 1. The problem

A normal "PDF → JSON" extractor gives you values, but not a useful answer to the harder question:

**Which values can I trust, and which ones should I check?**

This project treats every machine-written value as a claim that needs evidence.

A good review system should therefore:

- show the source text behind a value;
- independently check that the extracted value matches that source;
- detect contradictions between fields, such as `subtotal + tax != total`;
- distinguish different kinds of failure instead of turning everything into a blank;
- explain every reason a field entered the review queue;
- never let a retry overwrite a human correction.

That is the product. Extraction is only one step in the pipeline.

---

## 2. How it works

```text
PDF
 ↓
text layer
 ↓
extract
 ↓
locate source text
 ↓
verify extracted value
 ↓
check invoice invariants
 ↓
triage fields
 ↓
human review / correction
 ↓
export
```

### Extraction

`server/src/extract.ts` is a rule-based reader. It currently uses:

1. labelled-field matching, including multiple labels on one line;
2. a simple line-item table reader;
3. a vendor-name fallback using the letterhead;
4. a small number of explicit derivation rules.

Important rule: **derived values are marked as derived.**

For example, a missing subtotal can be computed from the line items, but the UI tells the reviewer that the number was computed rather than read from the invoice.

Tax is never derived from `total - subtotal`, because doing that would make the arithmetic check pass by construction and hide the very discrepancy the verifier is supposed to find.

### Verification

The verifier independently reads the located document text and parses it again using the field's type. The extracted value only counts as grounded when that second reading agrees.

It also checks invoice-wide invariants such as:

```text
sum(line items) ≈ subtotal
subtotal + tax ≈ total
```

Currency/date/number parsing is centralized rather than repeated in the UI.

### Triage

The queue is not just a confidence score. Each flagged field receives:

- a priority; and
- a concrete, human-readable reason.

For example:

> `Subtotal 6,285.00 plus tax 565.65 gives 6,850.65, but total reads 9,000.00.`

That reason is part of the product contract because a reviewer needs to be able to understand and challenge the system's judgement.

### Human edits

A human edit becomes the authoritative value for that field.

Machine retries may fill or correct machine-owned values, but the write path contains an explicit SQL guard so a machine write cannot overwrite a human-owned value.

Undo restores the machine's original state, including whether the value was empty and where it was grounded.

---

## 3. The field state model

There are three separate concepts:

### Value state

```text
filled

empty:
  not_attempted
  not_present
  extraction_failed
  unparseable
```

### Evidence / grounding

```text
grounded:
  exact
  normalized
  fuzzy

mismatch
ungrounded
derived
```

### Review state

```text
pending
accepted
rejected
```

They are intentionally independent.

A value can be perfectly grounded and still be wrong because the invoice itself is inconsistent. That is why a single `confidence` field is not enough.

The four empty states are also important:

- `not_attempted` — this run did not produce a result yet;
- `not_present` — the field appears to be absent from the document;
- `extraction_failed` — the extraction operation failed;
- `unparseable` — text was found, but it could not be converted into the expected type.

---

## 4. Product behavior worth seeing

The UI is designed around keyboard-first review:

```text
j / k   move through the queue

Enter   accept and advance

e       edit

x       mark wrong and edit

u       undo the human correction

g       jump to evidence in the PDF

r       retry a failed field

?       show shortcuts

Esc     cancel
```

The PDF is evidence, not an editable canvas. Corrections live in the data layer with provenance.

Export is blocked when fields are still `pending`. An explicit override is available, but the exported result is marked as unreviewed so it cannot silently look approved.

---

## 5. Reviewer samples

The `samples/` directory contains seven synthetic invoices designed to exercise different review scenarios. The filenames describe the expected behavior, so a reviewer can choose a case without first reading the implementation.

| Sample | Expected behavior |
|---|---|
| `clean-invoice-no-issues.pdf` | No issues flagged |
| `clean-invoice-all-fields-present.pdf` | Complete invoice with all supported fields present |
| `total-cannot-be-read.pdf` | Total cannot be parsed and requires review |
| `discount-causes-total-mismatch.pdf` | Discount causes an arithmetic mismatch |
| `subtotal-missing-derived-from-line-items.pdf` | Missing subtotal is derived from line items |
| `ambiguous-dates-and-total-mismatch.pdf` | Ambiguous dates and an inconsistent total |
| `unreadable-total-and-derived-subtotal-multipage.pdf` | Multi-page invoice with a derived subtotal and unreadable total |

For a quick walkthrough, start with a clean invoice, then try a document with a single review issue, and finish with the multi-page example to exercise evidence navigation and manual correction.

All sample documents contain synthetic data.

---

## 6. The architecture in one page

| Layer | Responsibility |
|---|---|
| `web/` | React UI, PDF viewer, keyboard review flow, server state via TanStack Query |
| `server/` | PDF text extraction, rule-based extraction, verification, triage, jobs, persistence, HTTP API |
| `shared/` | Shared field definitions, validation schemas, field/review state types |
| `data/` | Local PGlite database and uploaded PDFs; regenerable and intentionally not durable |

The runtime is deliberately small:

```text
Browser
   │
   │ HTTP
   ▼
Node / Hono server
   ├── REST API
   ├── in-process extraction job loop
   ├── PGlite database
   └── uploaded PDFs

Browser also receives the built React app
from the same Node process in production.
```

There is one deployable application, not separate frontend/backend services.

---

## 7. Why some state lives where it does

There are three state owners:

- **Server / TanStack Query:** anything authoritative on the server;
- **URL:** document, selected field, and filter — things worth surviving refresh or sharing;
- **local reducer:** edit draft and keyboard cursor — transient interaction state.

There is no global store because no fourth state owner was necessary.

---

## 8. Evaluation

The regression corpus used by the evaluation harness is separate from the seven reviewer samples in `samples/`.

It contains **16 generated invoices across 11 layouts**, covering **304 fields**.

Current regression results:

| Metric | Result |
|---|---:|
| Escape rate — wrong/missing and not flagged | **0.3% (1 field)** |
| Review load | **4.6%** |
| Field accuracy | **98.0%** |
| Queue precision | **78.6%** |

The most important metric is **escape rate**: a wrong value that enters the review queue is visible; a wrong value that does not enter the queue is silent.

Two implementation defects were found by the evaluation harness that were not obvious:

1. a two-column header caused one field to swallow the next field;
2. a required field reported as `not_present` was not being flagged.

Both were fixed by the implementation rather than by changing the expected results.

### Important limitation

The corpus is synthetic and generated alongside the parser. It is useful as a regression suite and as a way to expose known failure modes, but **98.0% is not a claim about accuracy on real supplier invoices**.

See [`EVAL.md`](EVAL.md) for the per-document breakdown and the exact escapes/false alarms.

---

## 9. Run locally

Requirements: Node.js 22+.

```bash
npm ci

./run dev
```

Then open:

```text
http://localhost:5173
```

Useful commands:

```bash
./run seed    # generate the sample corpus and load it into the running app

./run eval    # run the evaluation harness and regenerate EVAL.md

./run test    # run the server test suite

./run smoke   # run the browser smoke test

./run reset   # clear local database and uploaded files
```

Seven reviewer sample PDFs are checked in under `samples/`. They can be uploaded directly into the UI without generating anything first.

### Deployment

The repository includes a `render.yaml` that defines the production web service.

The deployed application uses the same Node/Hono server to serve both the API and the built React application, so no separate frontend deployment is required.

For a demo deployment, the app can run on Render's free web-service tier.

Because the demo uses local PGlite storage and the local filesystem, uploaded documents and database state are not durable across instance restarts or redeployments. This deployment is therefore intended for demonstration rather than production data.

---

## 10. What is deliberately out of scope

This version does not try to solve every document problem.

- Scanned/image-only PDFs are not the primary path; the current pipeline assumes a usable text layer.
- Rotated and unusual page geometry is not broadly validated by the corpus.
- The rule-based extractor is intentionally narrow; unfamiliar layouts can fail to extract rather than being guessed.
- There is no authentication or multi-user authorization.
- Local PGlite/file storage is suitable for a demo, not durable production storage.
- Accessibility and human time-to-review need more real-world validation.

These limitations are explicit because the central design principle is:

**fail visibly rather than manufacture confidence.**

---

## Documentation map

Only three root Markdown files are intended to be part of the submission:

| File | Purpose |
|---|---|
| `README.md` | Product, architecture, behavior, evaluation, and how to run/deploy it |
| `DECISIONS.md` | The important design choices, tradeoffs, and rejected alternatives |
| `EVAL.md` | Generated regression results |

**Start with this file, then read `DECISIONS.md`.**

Everything else in the repository should be understandable from those two documents plus the code.
