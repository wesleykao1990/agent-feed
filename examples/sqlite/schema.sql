-- Agent Feed SQLite portability reference.
--
-- This schema is for the executable local/offline example in this directory.
-- It mirrors the producer lifecycle invariants without claiming to be the
-- PostgreSQL delivery schema. Delivery/outbox state intentionally remains
-- outside this reference.

pragma foreign_keys = on;

create table if not exists runs (
  internal_id text primary key,
  tenant_id text not null,
  wire_run_id text not null,
  trace_id text not null,
  stream_id text not null,
  producer_id text not null,
  begin_idempotency_key text not null,
  begin_payload_hash text not null,
  status text not null check (status in ('running', 'completed', 'partial', 'failed', 'cancelled')),
  envelope_json text not null,
  started_at text not null,
  completed_at text,
  actual_scope_json text,
  error_summary text,
  complete_idempotency_key text,
  complete_payload_hash text,
  sources_attempted integer not null default 0 check (typeof(sources_attempted) = 'integer' and sources_attempted >= 0),
  sources_succeeded integer not null default 0 check (typeof(sources_succeeded) = 'integer' and sources_succeeded >= 0 and sources_succeeded <= sources_attempted),
  created_at text not null,
  unique (tenant_id, wire_run_id),
  unique (tenant_id, producer_id, stream_id, begin_idempotency_key),
  check (completed_at is null or length(completed_at) > 0),
  check (
    (status = 'running'
      and completed_at is null
      and actual_scope_json is null
      and complete_idempotency_key is null
      and complete_payload_hash is null)
    or
    (status <> 'running'
      and completed_at is not null
      and actual_scope_json is not null
      and complete_idempotency_key is not null
      and complete_payload_hash is not null)
  )
);

create table if not exists batches (
  id text primary key,
  run_internal_id text not null references runs(internal_id) on delete restrict,
  batch_id text not null,
  idempotency_key text not null,
  sequence_number integer not null check (sequence_number >= 1),
  payload_hash text not null,
  submitted_at text not null,
  metadata_json text not null,
  accepted_at text not null,
  unique (run_internal_id, batch_id),
  unique (run_internal_id, idempotency_key),
  unique (run_internal_id, sequence_number)
);

create table if not exists findings (
  id text primary key,
  run_internal_id text not null references runs(internal_id) on delete restrict,
  batch_id text not null references batches(id) on delete restrict,
  finding_key text not null,
  payload_json text not null,
  created_at text not null,
  unique (run_internal_id, finding_key)
);

create table if not exists evidence (
  id text primary key,
  run_internal_id text not null references runs(internal_id) on delete restrict,
  batch_id text not null references batches(id) on delete restrict,
  evidence_key text not null,
  payload_json text not null,
  created_at text not null,
  unique (run_internal_id, evidence_key)
);

create table if not exists finding_evidence (
  finding_id text not null references findings(id) on delete restrict,
  evidence_id text not null references evidence(id) on delete restrict,
  primary key (finding_id, evidence_id)
);

-- Liveness is an operational ledger, separate from accepted protocol rows.
-- A recovery updates the expectation and marks its open incident resolved; it
-- never deletes the incident receipt.
create table if not exists stream_expectations (
  tenant_id text not null,
  stream_id text not null,
  expected_cadence_seconds integer not null check (expected_cadence_seconds >= 3600),
  grace_seconds integer not null default 0 check (grace_seconds >= 0),
  enabled integer not null default 1 check (enabled in (0, 1)),
  expected_scope_json text not null,
  owner text not null,
  notes text not null default '',
  last_terminal_run_at text,
  last_terminal_status text check (last_terminal_status in ('completed', 'partial', 'failed', 'cancelled')),
  next_due_at text,
  created_at text not null,
  updated_at text not null,
  primary key (tenant_id, stream_id)
);

create table if not exists stream_liveness_incidents (
  id text primary key,
  tenant_id text not null,
  stream_id text not null,
  incident_type text not null check (incident_type in ('missed_run', 'repeated_failure', 'scope_degradation')),
  status text not null check (status in ('open', 'acknowledged', 'resolved')),
  detected_at text not null,
  expected_by text,
  resolved_at text,
  details_json text not null,
  check (resolved_at is null or resolved_at >= detected_at),
  foreign key (tenant_id, stream_id) references stream_expectations(tenant_id, stream_id) on delete restrict
);

-- Incident receipts are append-only. The only permitted mutation is an
-- explicit recovery transition from open/acknowledged to resolved; detection
-- identity and evidence cannot be rewritten or deleted.
drop trigger if exists stream_liveness_incidents_recovery_only;
create trigger stream_liveness_incidents_recovery_only
before update on stream_liveness_incidents
for each row begin
  select case when old.status = 'resolved'
      or new.id <> old.id
      or new.tenant_id <> old.tenant_id
      or new.stream_id <> old.stream_id
      or new.incident_type <> old.incident_type
      or new.detected_at <> old.detected_at
      or new.expected_by is not old.expected_by
      or new.details_json <> old.details_json
      or new.status <> 'resolved'
      or new.resolved_at is null
    then raise(abort, 'liveness incident is append-only except for recovery') end;
end;

drop trigger if exists stream_liveness_incidents_no_delete;
create trigger stream_liveness_incidents_no_delete
before delete on stream_liveness_incidents
for each row begin
  select raise(abort, 'liveness incidents cannot be deleted');
end;

create unique index if not exists stream_liveness_one_open_incident_idx
  on stream_liveness_incidents (tenant_id, stream_id, incident_type)
  where status in ('open', 'acknowledged');

create index if not exists runs_stream_started_idx on runs (stream_id, started_at desc);
create index if not exists runs_status_idx on runs (status);
create index if not exists batches_run_idx on batches (run_internal_id, sequence_number);
create index if not exists findings_run_idx on findings (run_internal_id);
create index if not exists evidence_run_idx on evidence (run_internal_id);

-- A running run may receive exactly one terminal completion. Once terminal,
-- its identity and completion receipt cannot be changed by direct SQL either.
drop trigger if exists runs_protect_terminal;
create trigger runs_protect_terminal
before update on runs
for each row begin
  select case when old.status <> 'running'
    then raise(abort, 'terminal Agent Feed run is immutable') end;
  select case when new.internal_id <> old.internal_id
      or new.tenant_id <> old.tenant_id
      or new.wire_run_id <> old.wire_run_id
      or new.trace_id <> old.trace_id
      or new.stream_id <> old.stream_id
      or new.producer_id <> old.producer_id
      or new.begin_idempotency_key <> old.begin_idempotency_key
      or new.begin_payload_hash <> old.begin_payload_hash
      or new.started_at <> old.started_at
      or new.status = 'running'
    then raise(abort, 'run identity fields are immutable') end;
  select case when json_valid(new.envelope_json) <> 1
    then raise(abort, 'terminal run envelope must be valid JSON') end;
  select case when json_type(new.envelope_json, '$') <> 'object'
      or json_extract(new.envelope_json, '$.protocol_version') is not '0.1'
      or json_extract(new.envelope_json, '$.run_id') is not new.wire_run_id
      or json_extract(new.envelope_json, '$.stream_id') is not new.stream_id
      or json_extract(new.envelope_json, '$.started_at') is not new.started_at
      or json_extract(new.envelope_json, '$.status') is not new.status
      or json_extract(new.envelope_json, '$.completed_at') is not new.completed_at
      or json_type(new.envelope_json, '$.actual_scope') <> 'object'
      or json_valid(new.actual_scope_json) <> 1
      or json(new.actual_scope_json) is not json(json_extract(new.envelope_json, '$.actual_scope'))
    then raise(abort, 'terminal run envelope does not match immutable columns') end;
  select case when json_type(new.envelope_json, '$.stats') <> 'object'
      or json_type(new.envelope_json, '$.stats.sources_attempted') <> 'integer'
      or json_type(new.envelope_json, '$.stats.sources_succeeded') <> 'integer'
      or json_type(new.envelope_json, '$.stats.findings_submitted') <> 'integer'
      or json_type(new.envelope_json, '$.stats.evidence_submitted') <> 'integer'
      or json_type(new.envelope_json, '$.stats.batches_submitted') <> 'integer'
      or json_extract(new.envelope_json, '$.stats.sources_attempted') is not new.sources_attempted
      or json_extract(new.envelope_json, '$.stats.sources_succeeded') is not new.sources_succeeded
      or json_extract(new.envelope_json, '$.stats.sources_succeeded') > json_extract(new.envelope_json, '$.stats.sources_attempted')
      or json_extract(new.envelope_json, '$.stats.findings_submitted') is not (select count(*) from findings where run_internal_id = new.internal_id)
      or json_extract(new.envelope_json, '$.stats.evidence_submitted') is not (select count(*) from evidence where run_internal_id = new.internal_id)
      or json_extract(new.envelope_json, '$.stats.batches_submitted') is not (select count(*) from batches where run_internal_id = new.internal_id)
    then raise(abort, 'terminal run envelope statistics do not reconcile') end;
  select case when new.completed_at is null
      or new.actual_scope_json is null
      or new.complete_idempotency_key is null
      or new.complete_payload_hash is null
    then raise(abort, 'terminal run requires completion payload fields') end;
end;

drop trigger if exists runs_protect_terminal_delete;
create trigger runs_protect_terminal_delete
before delete on runs
for each row begin
  select raise(abort, 'Agent Feed runs are append-only');
end;

drop trigger if exists batches_append_only;
create trigger batches_append_only
before update on batches
for each row begin
  select raise(abort, 'accepted Agent Feed batches are immutable');
end;

drop trigger if exists batches_append_only_delete;
create trigger batches_append_only_delete
before delete on batches
for each row begin
  select raise(abort, 'accepted Agent Feed batches are immutable');
end;

drop trigger if exists findings_append_only;
create trigger findings_append_only
before update on findings
for each row begin
  select raise(abort, 'accepted Agent Feed findings are immutable');
end;

drop trigger if exists findings_append_only_delete;
create trigger findings_append_only_delete
before delete on findings
for each row begin
  select raise(abort, 'accepted Agent Feed findings are immutable');
end;

drop trigger if exists evidence_append_only;
create trigger evidence_append_only
before update on evidence
for each row begin
  select raise(abort, 'accepted Agent Feed evidence is immutable');
end;

drop trigger if exists evidence_append_only_delete;
create trigger evidence_append_only_delete
before delete on evidence
for each row begin
  select raise(abort, 'accepted Agent Feed evidence is immutable');
end;

drop trigger if exists finding_evidence_append_only;
create trigger finding_evidence_append_only
before update on finding_evidence
for each row begin
  select raise(abort, 'accepted Agent Feed evidence links are immutable');
end;

drop trigger if exists finding_evidence_append_only_delete;
create trigger finding_evidence_append_only_delete
before delete on finding_evidence
for each row begin
  select raise(abort, 'accepted Agent Feed evidence links are immutable');
end;

-- Foreign keys protect existence, while this trigger protects the trust
-- boundary: a finding may only reference evidence accepted in its own run.
drop trigger if exists finding_evidence_same_run;
create trigger finding_evidence_same_run
before insert on finding_evidence
for each row begin
  select case when
    (select run_internal_id from findings where id = new.finding_id)
      <> (select run_internal_id from evidence where id = new.evidence_id)
    then raise(abort, 'finding and evidence must belong to the same run') end;
end;
