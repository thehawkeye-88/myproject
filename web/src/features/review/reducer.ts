import type { FieldKey } from '@docreview/shared';

export type Editing = {
  key: FieldKey;
  draft: string;
  /** Set when the server refused the draft. Cleared as soon as the user types. */
  error: string | null;
};

export type ReviewState = {
  cursorKey: FieldKey | null;
  editing: Editing | null;
};

export type Action =
  | { t: 'cursor/set'; key: FieldKey }
  | { t: 'cursor/move'; dir: 1 | -1; order: FieldKey[] }
  | { t: 'edit/begin'; key: FieldKey; initial: string }
  | { t: 'edit/change'; draft: string }
  | { t: 'edit/commit' }
  | { t: 'edit/cancel' }
  | { t: 'edit/invalid'; key: FieldKey; draft: string; message: string };

export const initialReviewState: ReviewState = { cursorKey: null, editing: null };

/**
 * Pure. `cursor/move` receives the visible order as an argument rather than
 * reading it from a query, which is what makes the cursor-stability test
 * trivial: reorder the list, replay the action, assert nothing moved.
 *
 * The cursor is keyed by FieldKey, never by index. Background extraction
 * results reorder the list; an index-keyed cursor would slide under the user
 * mid-keystroke.
 */
export function reviewReducer(state: ReviewState, action: Action): ReviewState {
  switch (action.t) {
    case 'cursor/set':
      return state.cursorKey === action.key ? state : { ...state, cursorKey: action.key };

    case 'cursor/move': {
      const { order, dir } = action;
      if (order.length === 0) return state;
      const at = state.cursorKey ? order.indexOf(state.cursorKey) : -1;
      const next = at === -1 ? (dir === 1 ? 0 : order.length - 1) : clamp(at + dir, order.length);
      return { ...state, cursorKey: order[next] };
    }

    case 'edit/begin':
      return {
        ...state,
        cursorKey: action.key,
        editing: { key: action.key, draft: action.initial, error: null },
      };

    case 'edit/change':
      return state.editing
        ? { ...state, editing: { ...state.editing, draft: action.draft, error: null } }
        : state;

    case 'edit/commit':
    case 'edit/cancel':
      return state.editing ? { ...state, editing: null } : state;

    // The server refused the value. Reopen the editor with what the reviewer
    // actually typed — discarding it and silently reverting the row is the
    // behaviour this action exists to prevent.
    case 'edit/invalid':
      return {
        ...state,
        cursorKey: action.key,
        editing: { key: action.key, draft: action.draft, error: action.message },
      };

    default: {
      const never: never = action;
      throw new Error(`unhandled action ${JSON.stringify(never)}`);
    }
  }
}

const clamp = (i: number, len: number) => Math.max(0, Math.min(len - 1, i));
