create table if not exists documents (
  id            text primary key,
  filename      text not null,
  sha256        text not null,
  status        text not null,
  page_count    int  not null default 0,
  text_layer    text not null default '',
  page_geometry jsonb not null default '[]',
  char_boxes    jsonb not null default '[]',
  text_density  real not null default 0,
  created_at    timestamptz not null default now()
);

create table if not exists extraction_runs (
  id             text primary key,
  document_id    text not null references documents(id),
  schema_version int  not null,
  model          text not null,
  status         text not null,
  scope          jsonb not null default 'null',
  claimed_at     timestamptz,
  attempts       int not null default 0,
  started_at     timestamptz,
  finished_at    timestamptz,
  usage          jsonb,
  error          text,
  created_at     timestamptz not null default now()
);

create table if not exists field_values (
  id             text primary key,
  document_id    text not null references documents(id),
  run_id         text,
  field_key      text not null,
  value          jsonb,
  empty_reason   text,
  grounding      jsonb not null default '{"kind":"ungrounded"}',
  violations     jsonb not null default '[]',
  source         text not null default 'model',
  -- What the machine left, snapshotted the first time a human touches the row so
  -- that `u` can put it back. All three move together: a field whose extracted
  -- state was *empty* has no original value, and restoring only the value would
  -- silently turn an unreadable field into a filled one.
  original_value        jsonb,
  original_empty_reason text,
  original_grounding    jsonb,
  review         text not null default 'pending',
  version        int  not null default 1,
  updated_at     timestamptz not null default now()
);

create unique index if not exists field_values_doc_key on field_values (document_id, field_key);
create index if not exists field_values_doc on field_values (document_id);
create index if not exists documents_sha on documents (sha256);
