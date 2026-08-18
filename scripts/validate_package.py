#!/usr/bin/env python3
from __future__ import annotations
import json, sys
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
from check_protocol_compatibility import check_baseline, check_protocol
from generate_protocol_types import check_outputs, outputs
BASE=Path(__file__).resolve().parents[1]
SCHEMAS=BASE/'packages/schema/contracts'
EXPECTED={'run-envelope.schema.json','finding.schema.json','evidence.schema.json','begin-run.schema.json','submit-batch.schema.json','complete-run.schema.json','delivery-event.schema.json','run-bundle.schema.json','stream-expectation.schema.json'}
class Failure(AssertionError): pass
def fail(x): raise Failure(x)
def load(p): return json.loads(p.read_text(encoding='utf-8'))
def registry(schemas):
 resources=[]
 for n,s in schemas.items():
  Draft202012Validator.check_schema(s); resources.append((s['$id'],Resource.from_contents(s)))
 return Registry().with_resources(resources)
def validate(obj,schema,reg,label):
 v=Draft202012Validator(schema,registry=reg,format_checker=FormatChecker()); e=sorted(v.iter_errors(obj),key=lambda x:list(x.absolute_path))
 if e: fail('\n'.join(f"{label}:{'/'.join(map(str,x.absolute_path)) or '<root>'}: {x.message}" for x in e))
def main():
 files={p.name for p in SCHEMAS.glob('*.json')}
 if files!=EXPECTED: fail(f'schema set mismatch missing={EXPECTED-files} extra={files-EXPECTED}')
 schemas={n:load(SCHEMAS/n) for n in EXPECTED}; reg=registry(schemas)
 generated_failures=check_outputs(outputs(schemas))
 if generated_failures: fail('generated protocol types are stale')
 compatibility_failures=check_protocol(schemas)+check_baseline(schemas)
 if compatibility_failures: fail('protocol compatibility check failed: '+ '; '.join(compatibility_failures))
 manifest=load(BASE/'package-manifest.json')
 if manifest['version']!='0.1.1' or manifest['protocol_version']!='0.1': fail('manifest version mismatch')
 if manifest['counts']['json_schemas']!=len(schemas): fail('manifest schema count mismatch')
 ex=BASE/'examples/rewards-optimizer'
 begin=load(ex/'begin-run.example.json'); batch=load(ex/'submit-batch.example.json'); complete=load(ex/'complete-run.example.json'); env=load(ex/'run-envelope.example.json'); bundle=load(ex/'run-bundle.example.json'); event=load(ex/'delivery-event.example.json')
 for obj,name in [(begin,'begin-run.schema.json'),(batch,'submit-batch.schema.json'),(complete,'complete-run.schema.json'),(env,'run-envelope.schema.json'),(bundle,'run-bundle.schema.json'),(event,'delivery-event.schema.json')]: validate(obj,schemas[name],reg,name)
 zero=load(BASE/'examples/run-bundle.zero-findings.example.json'); validate(zero,schemas['run-bundle.schema.json'],reg,'zero-bundle')
 stream=load(BASE/'examples/stream-expectation.example.json'); validate(stream,schemas['stream-expectation.schema.json'],reg,'stream-expectation')
 hostile=load(BASE/'examples/security/hostile-run-bundle.json'); validate(hostile,schemas['run-bundle.schema.json'],reg,'hostile-run-bundle')
 if batch['run_id']!=complete['run_id'] or batch['run_id']!=env['run_id'] or batch['run_id']!=bundle['run_id'] or batch['run_id']!=event['run_id']: fail('run ids do not reconcile')
 evidence_ids={x['evidence_id'] for x in batch['evidence']}
 for finding in batch['findings']:
  missing=set(finding['evidence_refs'])-evidence_ids
  if missing: fail(f'finding has unresolved evidence refs: {missing}')
 stats=complete['stats']
 if stats['findings_submitted']!=len(batch['findings']) or stats['evidence_submitted']!=len(batch['evidence']) or stats['batches_submitted']!=1: fail('completion stats do not reconcile')
 if zero['run_id'] != zero['complete']['run_id']: fail('zero-finding bundle run id mismatch')
 if zero['batches'] or any(zero['complete']['stats'][k] for k in ('findings_submitted','evidence_submitted','batches_submitted')): fail('zero-finding bundle is not zero')
 finding_schema_text=(SCHEMAS/'finding.schema.json').read_text(encoding='utf-8').lower()
 if 'source_authority_claim' not in finding_schema_text: fail('finding schema must label producer authority as a claim')
 hostile_finding=hostile['batches'][0]['findings'][0]
 if not {'embedded_instruction','attempted_authority_escalation'} <= set(hostile_finding['security_flags']): fail('hostile bundle lacks security flags')
 if hostile_finding['attributes'].get('attempted_action')!='publish_automatically': fail('hostile bundle does not exercise authority escalation')
 if 'verified_fact' in finding_schema_text or 'verified fact' in finding_schema_text: fail('finding schema must not represent verified facts')
 required_docs={
  'docs/02_trust_model.md':['Finding is not fact','Submitted evidence is not canonical evidence'],
  'docs/04_storage_and_delivery.md':['at-least-once','Realtime is optional'],
  'docs/07_chatgpt_monitoring.md':['installed plugins','`begin_run`','Secure MCP Tunnel','run-bundle','missing run'],
  'docs/operations/chatgpt-scheduled-task.md':['agent-feed-mcp-stdio','npm start','ChatGPT workspace','Run now'],
  'docs/08_supabase_reference.md':['separate Supabase project','Realtime: optional'],
  'skills/chatgpt/SKILL.md':['Scheduled Tasks','run-bundle.schema.json'],
 'docs/06_rewards_optimizer_consumer.md':['separate project','must not'],
 'docs/10_semantic_invariants.md':['terminal run state is immutable','idempotency key with a different payload','missing run is not equivalent'],
 'docs/11_protocol_compatibility.md':['protocol `0.1`','snake_case','--check'],
 'docs/operations/github-installation.md':['bin/agent-feed setup','bin/agent-feed doctor','never prints secrets','explicit account-side'],
 'docs/15_milestone_5a_installability.md':['Milestone 5A','Remaining Milestone 5 roadmap','protocol-clean MCP launcher']
 }
 for rel,markers in required_docs.items():
  text=(BASE/rel).read_text(encoding='utf-8')
  for m in markers:
   if m not in text: fail(f'{rel} missing marker {m}')
 sql=(BASE/'examples/postgres/0001_reference_schema.sql').read_text(encoding='utf-8').lower()
 for m in ('agent_feed.runs','agent_feed.batches','agent_feed.findings','agent_feed.submitted_evidence','agent_feed.outbox_events','idempotency_key','agent_feed.stream_expectations','sweep_overdue_streams','protect_terminal_run'):
  if m not in sql: fail(f'reference SQL missing {m}')
 print('Agent Feed foundation v0.1.1 validation passed')
 print(f'  JSON Schemas: {len(schemas)}')
 print('  Reward-monitor example: begin/batch/event/complete reconciled')
 print('  Zero-finding run: completed and unambiguous')
 print('  Trust boundary: finding/evidence remain unverified submissions')
 return 0
if __name__=='__main__':
 try: raise SystemExit(main())
 except Exception as e: print(f'VALIDATION FAILED: {e}',file=sys.stderr); raise SystemExit(1)
