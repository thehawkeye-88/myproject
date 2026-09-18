import { useSyncExternalStore, useCallback } from 'react';
import type { Filter } from '@docreview/shared';

/**
 * The URL is the state container for anything a reviewer would want after a
 * refresh or would paste to a colleague: which document, which field, which
 * filter. Everything else lives in the query cache or the review reducer.
 *
 * `useUrl(select)` subscribes to a *slice*, so moving the cursor does not
 * re-render the document pane and changing the filter does not re-render the
 * cursor. That selective subscription is the only reason a router was ever
 * under consideration; forty lines deliver it for a single-route app.
 */

export type UrlState = { doc: string | null; field: string | null; filter: Filter };

const FILTERS: Filter[] = ['all', 'needs-review', 'empty', 'accepted'];

function read(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const filter = p.get('filter') as Filter | null;
  return {
    doc: p.get('doc'),
    field: p.get('field'),
    filter: filter && FILTERS.includes(filter) ? filter : 'needs-review',
  };
}

let snapshot = read();
const listeners = new Set<() => void>();

function refresh() {
  const next = read();
  if (
    next.doc !== snapshot.doc ||
    next.field !== snapshot.field ||
    next.filter !== snapshot.filter
  ) {
    snapshot = next;
  }
  for (const l of listeners) l();
}

window.addEventListener('popstate', refresh);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function setUrl(patch: Partial<UrlState>, opts: { replace?: boolean } = {}) {
  const next = { ...snapshot, ...patch };
  const p = new URLSearchParams();
  if (next.doc) p.set('doc', next.doc);
  if (next.field) p.set('field', next.field);
  if (next.filter !== 'needs-review') p.set('filter', next.filter);
  const url = `${window.location.pathname}${p.toString() ? `?${p}` : ''}`;
  // Cursor movement uses replace so j/k does not fill the history stack.
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  refresh();
}

export function useUrl<T>(select: (s: UrlState) => T): T {
  const get = useCallback(() => select(snapshot), [select]);
  return useSyncExternalStore(subscribe, get, get);
}

export const selectDoc = (s: UrlState) => s.doc;
export const selectField = (s: UrlState) => s.field;
export const selectFilter = (s: UrlState) => s.filter;
