import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Field, Filter } from '@docreview/shared';
import { GROUPS, FIELD_BY_KEY, needsReview } from '@docreview/shared';
import { api } from './api';
import {
  useDocument, useDocuments, useFields, usePatchField, useRetry, useUpload,
  type ConflictState,
} from './queries';
import { setUrl, useUrl, selectDoc, selectField, selectFilter } from './urlState';
import { charRangeToRects } from './lib/geometry';
import { reviewReducer, initialReviewState } from './features/review/reducer';
import { FieldList } from './features/review/FieldList';
import { hasSpan, valueOf } from './features/review/FieldRow';
import { PdfViewer, type ScrollTarget } from './features/viewer/PdfViewer';

export default function App() {
  const docId = useUrl(selectDoc);
  return docId ? <Review key={docId} docId={docId} /> : <Library />;
}

// ---------------------------------------------------------------------------

function Library() {
  const { data, isLoading } = useDocuments();
  const upload = useUpload();
  const [dragging, setDragging] = useState(false);

  const send = (f: File | undefined) => {
    if (f) upload.mutate(f, { onSuccess: (r) => setUrl({ doc: r.id, field: null }) });
  };

  return (
    <div className="library">
      <header className="library-head">
        <h1>Document review</h1>
        <p className="sub">
          Machine-extracted values, each with a verdict about whether it can be trusted.
        </p>
      </header>

      <label
        className={`upload${dragging ? ' dragging' : ''}${upload.isPending ? ' busy' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); send(e.dataTransfer.files?.[0]); }}
      >
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => { send(e.target.files?.[0]); e.target.value = ''; }}
        />
        <span>{upload.isPending ? 'Reading the document…' : 'Drop a PDF invoice here, or click to choose one'}</span>
      </label>
      {upload.error && <p className="error">{(upload.error as Error).message}</p>}

      {isLoading && <p className="muted">Loading…</p>}
      {data && data.length === 0 && (
        <div className="list-empty">
          <p><b>No documents yet.</b></p>
          <p>Drop a PDF above, or run <code>./run seed</code> for four sample invoices.</p>
        </div>
      )}

      <ul className="doc-list">
        {data?.map((d) => (
          <li key={d.id}>
            <button onClick={() => setUrl({ doc: d.id, field: null })}>
              <span className="doc-name">{d.filename}</span>
              <span className="doc-meta">
                {d.status === 'extracting' ? (
                  <em className="working">extracting…</em>
                ) : d.counts.needsReview > 0 ? (
                  <><b>{d.counts.needsReview}</b> of {d.counts.total} need review</>
                ) : (
                  <span className="clear">nothing flagged · {d.counts.total} fields</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Review({ docId }: { docId: string }) {
  const doc = useDocument(docId);
  const fieldsQ = useFields(docId);
  const filter = useUrl(selectFilter);
  const urlField = useUrl(selectField);

  const [state, dispatch] = useReducer(reviewReducer, initialReviewState);
  const [conflict, setConflict] = useState<ConflictState>(null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget>(null);
  // null zoom means 'follow the pane width'. An arbitrary default makes the
  // document smaller than it needs to be on every screen but one.
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState<number | null>(null);
  const [announcement, setAnnounce] = useState('');
  const [toast, setToast] = useState<{ text: string; kind: 'info' | 'error' } | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [exportPrompt, setExportPrompt] = useState(false);

  const say = useCallback((text: string, kind: 'info' | 'error' = 'info') => {
    setToast({ text, kind });
    setAnnounce(text);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const patch = usePatchField(docId, {
    onConflict: setConflict,
    onInvalid: (key, draft, message) => {
      dispatch({ t: 'edit/invalid', key, draft, message });
      setAnnounce(`${key} not saved: ${message}`);
    },
    onFailure: (message) => say(message, 'error'),
  });
  const retry = useRetry(docId);
  const workspace = useRef<HTMLDivElement>(null);
  const viewerPane = useRef<HTMLElement>(null);

  const pageWidth = doc.data?.pageGeometry?.[0]?.width ?? 612;
  useLayoutEffect(() => {
    const el = viewerPane.current;
    if (!el) return;
    const measure = () =>
      setFit(Math.min(3, Math.max(0.4, round((el.clientWidth - 72) / pageWidth))));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageWidth, doc.data]);

  const scale = zoom ?? fit ?? 1.25;

  const all = fieldsQ.data?.fields ?? [];
  const counts = fieldsQ.data?.counts;
  const extracting = fieldsQ.data?.status === 'extracting';

  const visible = useMemo(() => orderFields(all, filter), [all, filter]);
  const order = useMemo(() => visible.map((f) => f.key), [visible]);

  // The cursor lives in the reducer but is mirrored to the URL so a refresh or a
  // shared link lands on the same field.
  const cursorKey = state.cursorKey ?? urlField ?? order[0] ?? null;
  const selected = all.find((f) => f.key === cursorKey) ?? null;

  useEffect(() => {
    if (cursorKey && cursorKey !== urlField) setUrl({ field: cursorKey }, { replace: true });
  }, [cursorKey, urlField]);

  // Seed the reducer from the URL once the list exists, so j/k continues from a
  // deep link rather than snapping back to the top of the queue.
  useEffect(() => {
    if (!state.cursorKey && cursorKey) dispatch({ t: 'cursor/set', key: cursorKey });
  }, [state.cursorKey, cursorKey]);

  // The keyboard loop is the product; it must work before anything is clicked.
  useEffect(() => { workspace.current?.focus(); }, []);

  const prevCount = useRef<number | null>(null);
  useEffect(() => {
    if (!counts) return;
    if (prevCount.current !== null && prevCount.current !== counts.needsReview) {
      setAnnounce(`${counts.needsReview} of ${counts.total} fields need review.`);
    }
    prevCount.current = counts.needsReview;
  }, [counts]);

  const highlights = useMemo(() => {
    if (!doc.data || !selected || selected.value.state !== 'filled') return [];
    const g = selected.value.grounding;
    if (g.kind !== 'grounded' && g.kind !== 'mismatch') return [];
    return charRangeToRects(doc.data.charBoxes, g.span, scale);
  }, [doc.data, selected, scale]);

  const jumpToEvidence = useCallback(() => {
    if (!selected || !hasSpan(selected.value)) {
      say('This field has no located source span.');
      return;
    }
    const first = highlights[0];
    if (first) setScrollTarget({ page: first.page, y: first.rect.y / scale, nonce: Date.now() });
  }, [selected, highlights, scale, say]);

  // Selecting a field reveals its evidence. That is the core interaction; it
  // should not require a second keystroke.
  useEffect(() => {
    const first = highlights[0];
    if (first) setScrollTarget({ page: first.page, y: first.rect.y / scale, nonce: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorKey]);

  const editable = useCallback(
    (f: Field | null): f is Field => {
      if (!f) return false;
      if (f.version === 0) {
        say('This field has no result yet — wait for extraction, or press r to retry.');
        return false;
      }
      return true;
    },
    [say],
  );

  const act = useCallback(
    (f: Field, body: { value?: any; review?: any; revert?: boolean }) => {
      if (!editable(f)) return;
      patch.mutate({ field: f, body });
    },
    [patch, editable],
  );

  const beginEdit = useCallback(
    (f: Field) => {
      if (!editable(f)) return;
      dispatch({ t: 'edit/begin', key: f.key, initial: String(valueOf(f.value) ?? '') });
    },
    [editable],
  );

  // "Wrong" and "here is the right answer" are usually the same thought, so
  // rejecting drops straight into the editor. Escaping out leaves it rejected.
  const reject = useCallback(
    (f: Field) => {
      if (!editable(f)) return;
      patch.mutate(
        { field: f, body: { review: 'rejected' } },
        { onSuccess: (updated) => beginEdit(updated) },
      );
    },
    [patch, editable, beginEdit],
  );

  const commitEdit = useCallback(() => {
    const editing = state.editing;
    if (!editing) return;
    const f = all.find((x) => x.key === editing.key);
    dispatch({ t: 'edit/commit' });
    if (!f) return;
    const original = String(valueOf(f.value) ?? '');
    if (editing.draft.trim() === original.trim()) return;
    act(f, { value: editing.draft });
  }, [state.editing, all, act]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (state.editing) return;
    const f = selected;
    const k = e.key;

    if (k === '?') { setShowHelp((s) => !s); return; }
    if (k === 'Escape') { setShowHelp(false); setExportPrompt(false); return; }
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); dispatch({ t: 'cursor/move', dir: 1, order }); return; }
    if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); dispatch({ t: 'cursor/move', dir: -1, order }); return; }
    if (!f) return;

    if (k === 'Enter') { e.preventDefault(); act(f, { review: 'accepted' }); dispatch({ t: 'cursor/move', dir: 1, order }); return; }
    if (k === 'x') { e.preventDefault(); reject(f); return; }
    if (k === 'u' && f.source === 'human') { e.preventDefault(); act(f, { revert: true }); return; }
    if (k === 'g') { e.preventDefault(); jumpToEvidence(); return; }
    if (k === 'e') { e.preventDefault(); beginEdit(f); return; }
    if (k === 'r') { e.preventDefault(); doRetry(); return; }
  };

  const doRetry = useCallback(() => {
    retry.mutate('failed', {
      onError: (err) => say((err as Error).message, 'error'),
      onSuccess: () => say('Retrying the failed fields. Anything you edited is excluded.'),
    });
  }, [retry, say]);

  const handlers = useCallback(
    (f: Field) => ({
      onSelect: () => dispatch({ t: 'cursor/set', key: f.key }),
      onDraft: (v: string) => dispatch({ t: 'edit/change', draft: v }),
      onCommit: commitEdit,
      onCancel: () => dispatch({ t: 'edit/cancel' }),
      onAccept: () => act(f, { review: 'accepted' }),
      onReject: () => reject(f),
      onRevert: () => act(f, { revert: true }),
      onEdit: () => beginEdit(f),
      onEvidence: jumpToEvidence,
      onResolveConflict: (keepMine: boolean) => {
        const theirs = conflict?.theirs;
        setConflict(null);
        if (!theirs) return;
        if (keepMine) act({ ...f, version: theirs.version }, { value: valueOf(f.value) });
        else fieldsQ.refetch();
      },
    }),
    [act, reject, beginEdit, commitEdit, jumpToEvidence, conflict, fieldsQ],
  );

  if (doc.isLoading) return <p className="muted pad">Loading document…</p>;
  if (doc.error) return <p className="error pad">{(doc.error as Error).message}</p>;
  if (!doc.data) return null;

  const failedCount = all.filter(
    (f) => f.value.state === 'empty' &&
      (f.value.reason === 'extraction_failed' || f.value.reason === 'not_attempted'),
  ).length;
  const unreviewed = counts?.pending ?? 0;

  return (
    <div className="workspace" ref={workspace} onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="topbar">
        <button className="back" onClick={() => setUrl({ doc: null, field: null })}>
          <span aria-hidden="true">←</span> All documents
        </button>
        <h1>{doc.data.filename}</h1>
        <div className="spacer" />
        {extracting && <span className="pill pill-busy"><i className="dot" />extracting</span>}
        {counts && (
          <span className="pill">
            {counts.needsReview > 0 ? <><b>{counts.needsReview}</b> flagged</> : 'nothing flagged'}
            {' · '}{counts.pending} unreviewed of {counts.total}
          </span>
        )}
        {failedCount > 0 && (
          <button onClick={doRetry} disabled={retry.isPending}>
            Retry {failedCount} failed
          </button>
        )}
        <div className="export-wrap">
          <button onClick={() => (unreviewed > 0 ? setExportPrompt(true) : download('csv'))}>
            Export
          </button>
          {exportPrompt && (
            <ExportGate
              unreviewed={unreviewed}
              total={counts?.total ?? 0}
              onClose={() => setExportPrompt(false)}
              onExport={(fmt) => { download(fmt, true); setExportPrompt(false); }}
            />
          )}
        </div>
        <button onClick={() => setShowHelp((s) => !s)} aria-label="Keyboard shortcuts">?</button>
      </header>

      {doc.data.runError && (
        <p className="banner banner-error">Extraction error: {doc.data.runError}</p>
      )}

      <div className="panes">
        <section className="pane pane-review" aria-label="Review queue">
          <FilterBar filter={filter} fields={all} />
          {fieldsQ.isLoading ? (
            <Skeletons />
          ) : (
            <FieldList
              fields={visible}
              cursorKey={cursorKey}
              editing={state.editing}
              conflict={conflict}
              handlers={handlers}
            />
          )}
          {!fieldsQ.isLoading && filter === 'needs-review' && all.length > 0 && (
            <p className="queue-foot">
              {visible.length === 0 ? (
                <><b>Nothing is flagged.</b> All {all.length} fields were located in the document
                  and the arithmetic is consistent.</>
              ) : (
                <>The other <b>{all.length - visible.length}</b> of {all.length} fields were located
                  in the document and raised nothing.</>
              )}{' '}
              <button className="linkish" onClick={() => setUrl({ filter: 'all' })}>
                Review them anyway
              </button>
            </p>
          )}
          {failedCount > 0 && (
            <p className="note">
              Retry only touches machine values. Anything you have edited is excluded and will
              not be overwritten.
            </p>
          )}
        </section>

        <section className="pane pane-viewer" aria-label="Document" ref={viewerPane}>
          <div className="viewer-bar">
            <button onClick={() => setZoom(Math.max(0.4, round(scale - 0.25)))} aria-label="Zoom out">−</button>
            <span className="zoom">{Math.round(scale * 100)}%</span>
            <button onClick={() => setZoom(Math.min(3, round(scale + 0.25)))} aria-label="Zoom in">+</button>
            <button
              className={zoom === null ? 'active' : ''}
              onClick={() => setZoom(null)}
              aria-pressed={zoom === null}
            >
              Fit
            </button>
            <div className="spacer" />
            <span className="muted">{doc.data.pageCount} page{doc.data.pageCount === 1 ? '' : 's'}</span>
          </div>
          <PdfViewer
            url={`/api/documents/${docId}/file`}
            geometry={doc.data.pageGeometry}
            scale={scale}
            highlights={highlights}
            scrollTarget={scrollTarget}
          />
        </section>
      </div>

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.text}</div>}
      {showHelp && <Help onClose={() => setShowHelp(false)} />}
    </div>
  );

  function download(format: 'csv' | 'json', force = false) {
    window.location.href = api.exportUrl(docId, format, force);
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------

function ExportGate({
  unreviewed, total, onClose, onExport,
}: {
  unreviewed: number; total: number;
  onClose: () => void; onExport: (f: 'csv' | 'json') => void;
}) {
  return (
    <div className="popover" role="dialog" aria-label="Export with unreviewed fields">
      <p className="popover-title">{unreviewed} of {total} fields are unreviewed.</p>
      <p className="popover-body">
        Exporting now produces a file that looks checked but is not. The export will
        record which fields were unreviewed.
      </p>
      <div className="popover-actions">
        <button onClick={onClose}>Keep reviewing</button>
        <button className="danger" onClick={() => onExport('csv')}>Export CSV anyway</button>
        <button className="danger" onClick={() => onExport('json')}>JSON</button>
      </div>
    </div>
  );
}

function FilterBar({ filter, fields }: { filter: Filter; fields: Field[] }) {
  const n = (f: Filter) => orderFields(fields, f).length;
  const tabs: Array<[Filter, string]> = [
    ['needs-review', 'Needs review'],
    ['empty', 'Empty'],
    ['accepted', 'Reviewed'],
    ['all', 'All'],
  ];
  return (
    <div className="filters" role="tablist" aria-label="Filter fields">
      {tabs.map(([key, label]) => (
        <button
          key={key}
          role="tab"
          aria-selected={filter === key}
          className={filter === key ? 'active' : ''}
          onClick={() => setUrl({ filter: key })}
        >
          {label} <span className="count">{n(key)}</span>
        </button>
      ))}
    </div>
  );
}

function Skeletons() {
  return (
    <ul className="field-list" aria-busy="true" aria-label="Loading fields">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="row skeleton" style={{ animationDelay: `${i * 70}ms` }}>
          <span /><span />
        </li>
      ))}
    </ul>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['j / k', 'Move between fields'],
    ['Enter', 'Accept and advance'],
    ['x', 'Mark wrong, then correct it'],
    ['e', 'Edit the value'],
    ['Esc', 'Cancel the edit'],
    ['u', 'Revert to the extracted value'],
    ['g', 'Jump to the evidence in the document'],
    ['r', 'Retry the failed fields'],
    ['?', 'Toggle this sheet'],
  ];
  return (
    <div className="sheet" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="sheet-body" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard</h2>
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
          ))}
        </dl>
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Filters map explicitly onto the four-way empty taxonomy rather than onto a
 * vague notion of "problem". Within a group, the highest-priority field comes
 * first, so the queue is the reading order.
 */
function orderFields(fields: Field[], filter: Filter): Field[] {
  const keep = fields.filter((f) => {
    switch (filter) {
      case 'all': return true;
      case 'accepted': return f.review !== 'pending';
      case 'empty': return f.value.state === 'empty';
      case 'needs-review': {
        const def = FIELD_BY_KEY[f.key];
        return def ? needsReview(def, f.value, f.review) : true;
      }
      default: {
        const never: never = filter;
        throw new Error(`unknown filter ${never}`);
      }
    }
  });

  return keep.sort((a, b) => {
    const g = GROUPS.indexOf(a.group as any) - GROUPS.indexOf(b.group as any);
    if (g !== 0) return g;
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.key.localeCompare(b.key);
  });
}
