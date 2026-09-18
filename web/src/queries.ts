import {
  useMutation, useQuery, useQueryClient, useIsMutating,
} from '@tanstack/react-query';
import type { Field, Json, ReviewStatus } from '@docreview/shared';
import { api, ApiError, type FieldsResponse } from './api';

export const keys = {
  documents: ['documents'] as const,
  document: (id: string) => ['document', id] as const,
  fields: (id: string) => ['fields', id] as const,
};

export function useDocuments() {
  return useQuery({ queryKey: keys.documents, queryFn: api.listDocuments, refetchInterval: 4000 });
}

export function useDocument(id: string | null) {
  return useQuery({
    queryKey: keys.document(id ?? ''),
    queryFn: () => api.getDocument(id!),
    enabled: Boolean(id),
    // The text layer is immutable once extracted, so this never needs refetching.
    staleTime: Infinity,
  });
}

export function useFields(id: string | null) {
  return useQuery({
    queryKey: keys.fields(id ?? ''),
    queryFn: () => api.getFields(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data?.status === 'extracting' ? 1200 : false),
  });
}

export type ConflictState = { fieldKey: string; theirs: Field } | null;

export type PatchCallbacks = {
  onConflict: (c: ConflictState) => void;
  /** The server refused the value. Carries the draft back so it is not lost. */
  onInvalid: (fieldKey: string, draft: string, message: string) => void;
  onFailure: (message: string) => void;
};

export function usePatchField(documentId: string, cb: PatchCallbacks) {
  const qc = useQueryClient();
  const mutationKey = ['patch', documentId] as const;
  const inFlight = useIsMutating({ mutationKey });

  return useMutation({
    mutationKey,
    mutationFn: (vars: {
      field: Field;
      body: { value?: Json; review?: ReviewStatus; revert?: boolean };
    }) => api.patchField(vars.field.id, { ...vars.body, version: vars.field.version }),

    onMutate: async ({ field, body }) => {
      await qc.cancelQueries({ queryKey: keys.fields(documentId) });
      const snapshot = qc.getQueryData<FieldsResponse>(keys.fields(documentId));

      qc.setQueryData<FieldsResponse>(keys.fields(documentId), (old) => {
        if (!old) return old;
        return {
          ...old,
          fields: old.fields.map((f) =>
            f.id !== field.id
              ? f
              : {
                  ...f,
                  review: body.review ?? (body.value !== undefined ? 'accepted' : f.review),
                  source: body.value !== undefined ? 'human' : f.source,
                  value:
                    body.value === undefined
                      ? f.value
                      : { state: 'filled', value: body.value, grounding: { kind: 'ungrounded' }, violations: [] },
                },
          ),
        };
      });
      return { snapshot };
    },

    // The server returns the authoritative row, including its new version.
    // Writing it straight into the cache means a second edit fired before the
    // refetch lands still carries the right version, instead of a spurious 409.
    onSuccess: (updated) => {
      qc.setQueryData<FieldsResponse>(keys.fields(documentId), (old) =>
        old
          ? { ...old, fields: old.fields.map((f) => (f.id === updated.id ? updated : f)) }
          : old,
      );
    },

    onError: (err, vars, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(keys.fields(documentId), ctx.snapshot);

      if (err instanceof ApiError && err.status === 409 && err.body?.current) {
        cb.onConflict({ fieldKey: vars.field.key, theirs: err.body.current as Field });
        return;
      }
      // A rejected value must come back to the reviewer with their text intact.
      if (vars.body.value !== undefined) {
        cb.onInvalid(vars.field.key, String(vars.body.value), (err as Error).message);
        return;
      }
      cb.onFailure((err as Error).message);
    },

    onSettled: () => {
      // Only the last mutation in a burst refetches. Without this gate a refetch
      // landing between two keystrokes flashes a stale machine value back into
      // a row the reviewer is actively editing.
      if (inFlight <= 1) qc.invalidateQueries({ queryKey: keys.fields(documentId) });
    },
  });
}

export function useRetry(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (scope: 'all' | 'failed' | string[]) => api.retry(documentId, scope),
    onSuccess: () => {
      qc.setQueryData<FieldsResponse>(keys.fields(documentId), (old) =>
        old ? { ...old, status: 'extracting' } : old,
      );
      qc.invalidateQueries({ queryKey: keys.fields(documentId) });
    },
  });
}

export function useUpload() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.upload(file),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.documents }),
  });
}
