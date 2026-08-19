# Occurrence-core decisions

| ID | Decision | Reason |
| --- | --- | --- |
| M7-OC-D001 | Keep occurrence normalization, materialization, matching, and policies pure. | PostgreSQL, Supabase, SQLite, and provider adapters need the same fail-closed decisions without coupling cadence proof to a storage or executor implementation. |
| M7-OC-D002 | Treat expectation ID and expectation version as immutable key inputs. | A schedule/policy change must create a new history line; otherwise old nominal times can be silently relinked under changed semantics. |
| M7-OC-D003 | Anchor intervals to immutable UTC `anchorAt` and compute each nominal time arithmetically. | Run completion and delivery latency must never shift a fixed cadence. |
| M7-OC-D004 | Accept exactly five cron fields and pin `cron-parser` to 5.10.0. | Five-field cron is the provider-neutral contract; parser defaults that accept seconds, macros, or extensions would create ambiguous cross-provider behavior. |
| M7-OC-D005 | Validate IANA timezone IDs and persist only UTC materialized instants. | Timezone interpretation belongs at schedule evaluation; durable occurrence identity must be comparable across hosts and providers. |
| M7-OC-D006 | Bound every materialization to 10,000 occurrences and catch-up to 100. | A malformed range or dense cadence must not create an unbounded loop or transaction. Overflow is an explicit error/deferred result. |
| M7-OC-D007 | Make normal matching scheduled-only; reserve legacy matching for legacy mode. | Manual, test, retry, replay, backfill, and event runs are separate proof paths and must not advance scheduled liveness. |
| M7-OC-D008 | Reject window ambiguity and duplicate links rather than selecting a winner. | A run cannot prove multiple nominal occurrences, and fail-closed ambiguity is safer than silently moving liveness. |
| M7-OC-D009 | Keep zero findings distinct from absence. | A completed invocation with no findings is successful execution; no invocation is an absence/liveness condition. |
| M7-OC-D010 | Represent overlap skip as suppression, not misfire. | The scheduler intentionally declined an overlapping invocation; it did not observe a missed occurrence. |
