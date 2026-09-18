# Design Decisions

This file records the small set of decisions that shape the system.

The goal is not to document every implementation detail. It is to make the important reasoning easy to reconstruct during a code review or interview.

---

## D1. Build a review system, not a "PDF → JSON" demo

**Decision:** Optimize the system around trustworthy review rather than extraction alone.

**Why:** Extraction can return a plausible value and still be wrong. The useful product question is which values need human attention and why.

**Result:** provenance, verification, triage, human ownership, and export gating are first-class parts of the design.

---

## D2. Use a deterministic rule-based extractor

**Decision:** `extract.ts` uses explicit rules instead of an external AI model.

**Why:** For this submission, determinism makes the pipeline easy to test, reproduce, and run without credentials or network access.

**Tradeoff:** A rule-based extractor is narrower than a model on unfamiliar layouts. That is accepted and stated explicitly.

**Important consequence:** The verifier is extractor-agnostic. It checks the machine's output rather than trusting the mechanism that produced it.

---

## D3. Extract the PDF text layer once and make it canonical

**Decision:** Parse the PDF server-side with pdf.js into one canonical text representation plus page geometry/character boxes.

**Why:** The same representation should power extraction, source lookup, and PDF highlighting. Re-deriving text independently in the browser would create another opportunity for disagreement.

**Tradeoff:** A text-first approach is weaker for image-only scans and layout-heavy PDFs. Those cases are outside the current validated scope.

---

## D4. Locate first, then verify independently

**Decision:** A machine value is not trusted merely because it came from a plausible location.

The system:

1. gets a quoted/source string for the value;
2. locates it in the canonical document text;
3. parses the located text again using the field type;
4. compares the second reading with the extracted value;
5. checks invoice-wide arithmetic invariants.

**Why:** A value can be wrong while still matching text in the document. Independent re-parsing catches a different class of errors than extraction alone.

---

## D5. Keep evidence, correctness, review, and emptiness separate

**Decision:** Do not collapse field state into one confidence score.

A field separately tracks:

```text
value state
  filled | not_attempted | not_present | extraction_failed | unparseable

grounding
  grounded | mismatch | ungrounded | derived

review
  pending | accepted | rejected
```

**Why:** These represent different questions.

Example: a value may be exactly grounded to the PDF and still violate `subtotal + tax = total` because the invoice itself is inconsistent.

---

## D6. Triage must explain itself

**Decision:** Every queued field gets both a priority and a human-readable reason.

**Why:** "Low confidence" is not actionable. A reviewer needs to know what failed and what to inspect.

Example:

> `Text was found but could not be read as a valid value.`

or:

> `Subtotal 3,315.00 plus tax 191.56 gives 3,506.56, but total reads 3,256.56.`

**Tradeoff:** More logic than a numeric confidence score, but the output is much easier to review and debug.

---

## D7. Derive only when the derivation is honest

**Decision:** Derived values are explicitly marked as derived. Tax is never reconstructed from `total - subtotal`.

**Why:** A derived subtotal from line items is a legitimate calculation. Deriving tax from the total would make the reconciliation check circular and could hide an incorrect invoice.

**Result:** The verifier can still tell the reviewer when a number was not actually printed on the page.

---

## D8. Protect human edits in the database

**Decision:** Human ownership is enforced by the SQL write condition, not only by application logic.

Conceptually:

```sql
UPDATE ...
WHERE id = ?
  AND version = ?
  AND source = 'model';
```

**Why:** A retry or future machine-writing code path must not be able to overwrite a human correction accidentally.

**Tradeoff:** The internal column is still named `source = 'model'` even though the current extractor is rule-based. It means "machine-written" in the current schema; changing the name would be a migration without behavioral benefit.

---

## D9. Store current field state in one row per document/field

**Decision:** `field_values` represents the current state of each field using a unique `(document_id, field_key)` pair.

**Why:** Reads stay simple, and re-extraction can update machine-owned values without rebuilding "latest run per field" history at query time.

**Tradeoff:** There is no full audit-event table. The product only needs enough history to undo a human correction back to the original machine state.

---

## D10. Keep background extraction in the same process

**Decision:** Use an in-process job loop rather than a separate worker service.

**Why:** Extraction is long-running, so it should not block the upload HTTP request. But a separate worker would add another deployable, configuration surface, and operational path for a single-user demo.

**Tradeoff:** CPU-heavy PDF work can compete with HTTP requests. The targeted future fix would be a worker thread for that CPU-bound function, not a second service.

---

## D11. Poll job status instead of using SSE

**Decision:** While a document is extracting, the frontend polls the status about every 1.5 seconds.

**Why:** The product does not need sub-second progress updates or high fan-out streaming. Polling is simpler to reason about and works naturally with TanStack Query.

**Rejected:** SSE would add connection/reconnect/proxy behavior without solving the harder review-state problem.

---

## D12. Use REST with shared validation schemas

**Decision:** Hono exposes a small REST API; shared zod schemas/types live in `shared/` and the frontend uses a thin typed fetch layer.

**Why:** The boundary remains visible and inspectable with normal HTTP tools while request/response shapes still have one source of truth.

**Rejected:** tRPC would reduce some typing ceremony but would hide the HTTP boundary the product actually uses.

---

## D13. Keep URL state limited to reviewer-visible state

**Decision:** Put only shareable/refresh-worthy review state in the URL, such as the selected document, field, and filter.

**Why:** A refresh should preserve where the reviewer was, and a reviewer should be able to share a meaningful link.

**Not in the URL:** open editors, draft text, or transient UI state.

---

## D14. Use pdf.js directly in the viewer

**Decision:** Own the PDF canvas, text layer, and evidence overlays directly rather than hiding them behind a high-level React PDF wrapper.

**Why:** Evidence highlighting, page lifecycle, zoom, and scroll-to-field are central product behaviors. Direct control keeps those behaviors explicit.

**Tradeoff:** More code, but less fighting against a wrapper at the hardest part of the UI.

---

## D15. Use one deployable application

**Decision:** In production, Node/Hono serves both the API and the built React/Vite frontend.

**Why:** One origin means no frontend API URL configuration and no separate frontend deployment is needed.

**Result:** Render needs only one free web service for the demo.

---

## D16. Keep free deployment storage intentionally disposable

**Decision:** The demo keeps PGlite and uploaded PDFs on the local filesystem.

**Why:** It keeps the project free and simple.

**Tradeoff:** Free-host filesystem state is not durable. This is acceptable for a demo but not for real user data.

**Production path:** hosted Postgres + object storage for PDFs.

---

## D17. Make export safe by default

**Decision:** Export is blocked while fields remain `pending`.

**Why:** The dangerous failure mode is not a visible review flag; it is a file that looks approved even though nobody reviewed it.

**Tradeoff:** Users can explicitly override the block, but the output is marked as unreviewed rather than silently looking approved.

---

## D18. Test the claims, not just the functions

**Decision:** Keep an evaluation corpus with explicit ground truth and test the real pipeline against it.

**Why:** Unit tests tell us whether functions behave as coded. The evaluation harness asks whether the whole product catches wrong or missing fields without relying on the same local reasoning that produced the parser.

**Result:** The harness found two silent defects that ordinary code review had missed:

- a two-column header caused one field to consume the next field;
- a required field reported as absent did not enter the review queue.

Both bugs were fixed in code.

**Important limitation:** The corpus is synthetic and authored alongside the parser, so its results are a regression baseline, not a production accuracy estimate.

---

# Deliberately rejected ideas

These were considered and left out because they added complexity without solving a current need.

| Idea | Why it was rejected |
|---|---|
| Separate worker service | Too much operational complexity for one process and one user/demo. |
| SSE for job progress | Polling is sufficient at this scale and simpler to reason about. |
| Two independent grounding channels | More complexity without a stronger correctness signal in the current pipeline. |
| Full append-only field event log | Revert-to-original is enough for this product; a compliance audit log is out of scope. |
| Batch extraction mode | Adds a second job state machine for little benefit at this scale. |
| CI that calls a live external model/API | Slow, flaky, and credential-dependent; this project is intentionally deterministic/offline. |
| Automatically derive tax from the total | Would make reconciliation circular and hide errors. |
| Global client state store | URL, server cache, and a local reducer already have clear ownership. |
| High-level PDF wrapper | Hides the exact rendering/highlighting lifecycle the product needs. |

---

# Current tradeoffs to remember

1. **Determinism over recall.** The rule-based extractor is easy to reproduce and test, but it will miss layouts it was not designed for.
2. **Simple deployment over durability.** PGlite + local files keeps the demo free, but the data is disposable on free hosting.
3. **Explicit failure over guessing.** When the system cannot confidently read a field, it should surface the problem rather than manufacture a value.
4. **Small architecture over premature scale.** One Node process, one database, one HTTP API, and one frontend are enough for the current scope.
