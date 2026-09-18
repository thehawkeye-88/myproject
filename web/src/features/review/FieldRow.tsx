import { memo, useEffect, useRef, useState } from 'react';
import type { Field, FieldValue, Grounding } from '@docreview/shared';
import type { Editing } from './reducer';

export type RowProps = {
  field: Field;
  selected: boolean;
  editing: Editing | null;
  conflict: Field | null;
  onSelect: () => void;
  onDraft: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onReject: () => void;
  onRevert: () => void;
  onEdit: () => void;
  onEvidence: () => void;
  onResolveConflict: (keepMine: boolean) => void;
};

export const FieldRow = memo(function FieldRow(p: RowProps) {
  const { field: f } = p;
  const ref = useRef<HTMLLIElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const flash = useChangeFlash(f.value);

  useEffect(() => {
    if (p.selected && !p.editing) ref.current?.focus({ preventScroll: false });
  }, [p.selected, p.editing]);

  const editingKey = p.editing?.key;
  useEffect(() => {
    if (editingKey) input.current?.select();
  }, [editingKey]);

  const severity = severityOf(f);
  const cls = [
    'row',
    `sev-${severity}`,
    p.selected && 'selected',
    flash && 'flash',
    p.editing?.error && 'invalid',
  ].filter(Boolean).join(' ');

  return (
    <li
      ref={ref}
      className={cls}
      tabIndex={p.selected ? 0 : -1}
      role="option"
      aria-selected={p.selected}
      aria-label={`${f.label}. ${describe(f)}`}
      onClick={p.onSelect}
    >
      <div className="row-head">
        <span className="row-label">{f.label}</span>
        <span className="row-badges">
          {f.source === 'human' && <Badge kind="human">edited</Badge>}
          {f.review === 'accepted' && <Badge kind="ok">accepted</Badge>}
          {f.review === 'rejected' && <Badge kind="bad">rejected</Badge>}
          <GroundingBadge value={f.value} />
        </span>
      </div>

      <div className="row-value">
        {p.editing ? (
          <>
            <input
              ref={input}
              className={`editor${p.editing.error ? ' editor-invalid' : ''}`}
              value={p.editing.draft}
              aria-invalid={Boolean(p.editing.error)}
              aria-describedby={p.editing.error ? `err-${f.key}` : undefined}
              onChange={(e) => p.onDraft(e.target.value)}
              onBlur={p.onCommit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') { e.preventDefault(); p.onCommit(); }
                if (e.key === 'Escape') { e.preventDefault(); p.onCancel(); }
              }}
              aria-label={`Edit ${f.label}`}
            />
            {p.editing.error && (
              <p className="row-invalid" id={`err-${f.key}`} role="alert">
                {p.editing.error} — fix it and press <kbd>↵</kbd>, or <kbd>Esc</kbd> to discard.
              </p>
            )}
          </>
        ) : (
          <ValueDisplay value={f.value} />
        )}
      </div>

      {f.value.state === 'filled' &&
        f.value.violations.map((v) => (
          <p key={v.rule} className="row-violation">{v.message}</p>
        ))}

      {f.value.state === 'filled' && f.value.grounding.kind === 'mismatch' && (
        <p className="row-mismatch">
          Source reads <q>{f.value.grounding.sourceText.trim()}</q>
        </p>
      )}

      {/* The reason is usually the most useful line in the row, but when triage
          picked up a violation verbatim, showing it twice is just noise. */}
      {!duplicatesViolation(f) && <p className="row-reason">{f.priorityReason}</p>}

      {f.review === 'rejected' && !p.editing && (
        <p className="row-hint">
          Marked wrong, but the value below it is still the extracted one. Press{' '}
          <kbd>e</kbd> to enter the correct value.
        </p>
      )}

      {p.conflict && (
        <div className="row-conflict" role="alert">
          <p>Changed in another tab.</p>
          <div className="conflict-pair">
            <span>Yours: <b>{String(valueOf(f.value) ?? '—')}</b></span>
            <span>Theirs: <b>{String(valueOf(p.conflict.value) ?? '—')}</b></span>
          </div>
          <div className="row-actions">
            <button onClick={() => p.onResolveConflict(true)}>Keep mine</button>
            <button onClick={() => p.onResolveConflict(false)}>Use theirs</button>
          </div>
        </div>
      )}

      {p.selected && !p.editing && !p.conflict && (
        <div className="row-actions">
          <button onClick={p.onAccept}>Accept <kbd>↵</kbd></button>
          <button onClick={p.onReject}>Wrong <kbd>x</kbd></button>
          <button onClick={p.onEdit}>Edit <kbd>e</kbd></button>
          {f.source === 'human' && <button onClick={p.onRevert}>Revert <kbd>u</kbd></button>}
          {hasSpan(f.value) && <button onClick={p.onEvidence}>Evidence <kbd>g</kbd></button>}
        </div>
      )}
    </li>
  );
});

/**
 * Flash a row whose value changed underneath the reviewer. Background
 * extraction results land silently by design — nothing modal, nothing
 * focus-stealing — so this is the only visual signal that something moved.
 * It doubles as save confirmation on the reviewer's own edits.
 */
function useChangeFlash(value: FieldValue): boolean {
  const serialized = JSON.stringify(value);
  const previous = useRef(serialized);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (previous.current === serialized) return;
    previous.current = serialized;
    setOn(true);
    const t = setTimeout(() => setOn(false), 900);
    return () => clearTimeout(t);
  }, [serialized]);

  return on;
}

function ValueDisplay({ value }: { value: FieldValue }) {
  if (value.state === 'empty') {
    const copy: Record<typeof value.reason, string> = {
      not_attempted: 'Not attempted',
      not_present: 'Not in document',
      extraction_failed: 'Extraction failed',
      unparseable: 'Could not be read',
    };
    return <span className={`empty empty-${value.reason}`}>{copy[value.reason]}</span>;
  }
  return <span className="value">{String(value.value)}</span>;
}

function GroundingBadge({ value }: { value: FieldValue }) {
  if (value.state === 'empty') return null;
  const g: Grounding = value.grounding;
  switch (g.kind) {
    case 'grounded': return <Badge kind="ok">{`grounded · ${g.how}`}</Badge>;
    case 'mismatch': return <Badge kind="bad">mismatch</Badge>;
    case 'derived': return <Badge kind="info">derived</Badge>;
    case 'ungrounded': return <Badge kind="warn">no source</Badge>;
    default: {
      const never: never = g;
      return <Badge kind="warn">{JSON.stringify(never)}</Badge>;
    }
  }
}

function Badge({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

function duplicatesViolation(f: Field): boolean {
  return (
    f.value.state === 'filled' &&
    f.value.violations.some((v) => v.message === f.priorityReason)
  );
}

export function hasSpan(v: FieldValue): boolean {
  return v.state === 'filled' && (v.grounding.kind === 'grounded' || v.grounding.kind === 'mismatch');
}

export function valueOf(v: FieldValue) {
  return v.state === 'filled' ? v.value : null;
}

function severityOf(f: Field): 'none' | 'low' | 'mid' | 'high' {
  if (f.review !== 'pending') return 'none';
  if (f.priority >= 80) return 'high';
  if (f.priority >= 40) return 'mid';
  if (f.priority >= 15) return 'low';
  return 'none';
}

function describe(f: Field): string {
  const v = f.value.state === 'filled' ? String(f.value.value) : `empty, ${f.value.reason}`;
  return `${v}. ${f.priorityReason}`;
}
