-- Local/offline demonstration only.
create table runs (run_id text primary key, stream_id text not null, status text not null, envelope_json text not null);
create table batches (run_id text not null, batch_id text not null, idempotency_key text not null, payload_hash text not null, primary key (run_id, batch_id));
create table findings (run_id text not null, finding_id text not null, finding_type text not null, payload_json text not null, primary key (run_id, finding_id));
create table evidence (run_id text not null, evidence_id text not null, payload_json text not null, primary key (run_id, evidence_id));
