export const CONTROL_PLANE_QUERIES = Object.freeze({
  jobs: `/* m10:jobs */
    with latest as (
      select distinct on (job_key) lifecycle_state
        from agent_feed.job_definition_versions
       where tenant_id = $1
       order by job_key, version desc, created_at desc, id desc
    )
    select lifecycle_state as state, count(*)::text as count
      from latest group by lifecycle_state order by lifecycle_state`,

  occurrences: `/* m10:occurrences */
    with classified as (
      select case
        when link.id is null and occurrence.window_end < $3::timestamptz then 'absent'
        when link.id is null then 'pending'
        when run.status = 'running' then 'running'
        when run.status = 'completed' and exists (
          select 1 from agent_feed.findings finding
           where finding.tenant_id = $1 and finding.run_id = run.id
        ) then 'completed'
        when run.status = 'completed' then 'completed_zero'
        else run.status
      end as state
      from agent_feed.expected_occurrences occurrence
      left join agent_feed.run_occurrence_links link
        on link.tenant_id = occurrence.tenant_id and link.occurrence_id = occurrence.id
      left join agent_feed.runs run
        on run.tenant_id = link.tenant_id and run.id = link.run_id
      where occurrence.tenant_id = $1
        and occurrence.expected_at >= $2::timestamptz
        and occurrence.expected_at <= $3::timestamptz
    )
    select state, count(*)::text as count from classified group by state order by state`,

  runs: `/* m10:runs */
    select status as state, count(*)::text as count
      from agent_feed.runs
     where tenant_id = $1 and started_at >= $2::timestamptz and started_at <= $3::timestamptz
     group by status order by status`,

  assessments: `/* m10:assessments */
    select assessment.verdict as state, count(*)::text as count
      from agent_feed.run_assessments assessment
      join agent_feed.assessment_receipt_seals seal
        on seal.tenant_id = assessment.tenant_id and seal.assessment_id = assessment.id
     where assessment.tenant_id = $1
       and assessment.created_at >= $2::timestamptz and assessment.created_at <= $3::timestamptz
     group by assessment.verdict order by assessment.verdict`,

  deliveries: `/* m10:deliveries */
    select case state
      when 'pending' then 'queued'
      when 'in_flight' then 'leased'
      when 'retry_wait' then 'retry'
      else state
    end as state, count(*)::text as count
      from agent_feed.consumer_deliveries
     where tenant_id = $1 and created_at >= $2::timestamptz and created_at <= $3::timestamptz
     group by state order by state`,

  failures: `/* m10:failures */
    with sealed_assessments as (
      select assessment.verdict, assessment.failure_class
        from agent_feed.run_assessments assessment
        join agent_feed.assessment_receipt_seals seal
          on seal.tenant_id = assessment.tenant_id and seal.assessment_id = assessment.id
       where assessment.tenant_id = $1
         and assessment.created_at >= $2::timestamptz and assessment.created_at <= $3::timestamptz
    ), signals as (
      select 'provider'::text as state, count(*)::bigint as count from sealed_assessments
       where failure_class in ('provider', 'rate_limit')
      union all
      select 'gateway', count(*)::bigint from sealed_assessments
       where failure_class in ('authentication', 'authorization', 'network')
      union all
      select 'execution', count(*)::bigint from agent_feed.runs
       where tenant_id = $1 and started_at >= $2::timestamptz and started_at <= $3::timestamptz
         and status in ('failed', 'cancelled')
      union all
      select 'validation', count(*)::bigint from sealed_assessments
       where verdict in ('failed', 'inconclusive')
      union all
      select 'delivery', count(*)::bigint from agent_feed.consumer_deliveries
       where tenant_id = $1 and created_at >= $2::timestamptz and created_at <= $3::timestamptz
         and state in ('retry_wait', 'dead_letter')
    )
    select state, count::text as count from signals order by state`,
});
