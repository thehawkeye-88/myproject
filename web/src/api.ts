import type { DocumentDetail, DocumentSummary, Field, Json, ReviewStatus } from '@docreview/shared';

export class ApiError extends Error {
  constructor(public status: number, public body: any) {
    super(typeof body?.error === 'string' ? body.error : `HTTP ${status}`);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export type FieldsResponse = {
  status: string;
  counts: { total: number; pending: number; needsReview: number };
  fields: Field[];
};

export const api = {
  listDocuments: () => req<DocumentSummary[]>('/documents'),
  getDocument: (id: string) => req<DocumentDetail>(`/documents/${id}`),
  getFields: (id: string) => req<FieldsResponse>(`/documents/${id}/fields`),
  upload: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return req<{ id: string; status: string; duplicate?: boolean }>('/documents', {
      method: 'POST',
      body: form,
    });
  },
  retry: (id: string, scope: 'all' | 'failed' | string[] = 'failed') =>
    req<{ runId: string }>(`/documents/${id}/extract`, {
      method: 'POST',
      body: JSON.stringify({ scope }),
    }),
  patchField: (
    fieldId: string,
    body: { value?: Json; review?: ReviewStatus; revert?: boolean; version: number },
  ) => req<Field>(`/fields/${fieldId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  exportUrl: (id: string, format: 'json' | 'csv', force = false) =>
    `/api/documents/${id}/export?format=${format}${force ? '&force=1' : ''}`,
};
