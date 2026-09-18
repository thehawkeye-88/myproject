/**
 * The three statements that decide who owns a field value.
 *
 * They live here, as strings, so that `server/test/write-guard.test.ts` runs the
 * exact SQL the server runs. A test that pastes its own copy of a guard proves
 * only that the copy works.
 */

/**
 * A machine write. The `where` clause is the one invariant expressed in SQL
 * rather than application code: a retry may fill a gap and may correct its own
 * earlier value, and can never overwrite a human. In the database, so that no
 * future write path can forget it.
 */
export const MACHINE_WRITE = `
insert into field_values
  (id, document_id, run_id, field_key, value, empty_reason, grounding, violations,
   source, review, version, updated_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, 'model', 'pending', 1, now())
on conflict (document_id, field_key) do update
   set run_id       = excluded.run_id,
       value        = excluded.value,
       empty_reason = excluded.empty_reason,
       grounding    = excluded.grounding,
       violations   = excluded.violations,
       version      = field_values.version + 1,
       updated_at   = now()
 where field_values.source = 'model'`;

/**
 * A human correction, under optimistic concurrency on `version`.
 *
 * The three `case` expressions snapshot what the machine produced, on the FIRST
 * human edit only. `coalesce(original_value, value)` looks equivalent and is
 * not: when the machine left the field *empty* the snapshot is legitimately
 * null, so a second edit would record the reviewer's own first correction as
 * the "original" and undo would restore that instead of the extracted state.
 * Value, emptiness and grounding are snapshotted together because they are one
 * state — restoring the value alone would turn an unreadable field into a
 * filled one.
 */
export const HUMAN_EDIT = `
update field_values
   set value        = $3,
       empty_reason = null,
       source       = 'human',
       original_value        = case when source = 'human' then original_value        else value        end,
       original_empty_reason = case when source = 'human' then original_empty_reason else empty_reason end,
       original_grounding    = case when source = 'human' then original_grounding    else grounding    end,
       review    = 'accepted',
       grounding = jsonb_build_object('kind', 'ungrounded'),
       version   = version + 1,
       updated_at = now()
 where id = $1 and version = $2
returning *`;

/** Undo: put back exactly what the machine produced, and hand ownership back. */
export const REVERT = `
update field_values
   set value        = original_value,
       empty_reason = original_empty_reason,
       grounding    = coalesce(original_grounding, '{"kind":"ungrounded"}'::jsonb),
       original_value = null, original_empty_reason = null, original_grounding = null,
       source  = 'model',
       review  = 'pending',
       version = version + 1,
       updated_at = now()
 where id = $1 and version = $2
returning *`;
