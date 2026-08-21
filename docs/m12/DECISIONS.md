# Milestone 12 decisions

| ID | Decision | Reason |
|---|---|---|
| M12-D001 | Inject authenticated consumer ownership separately from feedback. | A submission body cannot choose its tenant or consumer authority. |
| M12-D002 | Make dispositions events rather than a mutable current-status field. | Surfacing, saving, acting, promotion, and later rejection can all be legitimate history. |
| M12-D003 | Reference targets only by immutable IDs or digest. | Utility evidence must not rewrite producer claims or artifact content. |
| M12-D004 | Represent ratios as exact integer numerator/denominator pairs. | Floating point and zero-denominator conventions would create false comparisons. |
| M12-D005 | Preserve definition and policy scope on every metric snapshot. | Optimization evidence is meaningless if revisions are silently pooled. |
| M12-D006 | Keep recommendations pending, digest-only, and separately approved. | Analysis must not become an unauthorized prompt or schedule mutation. |
| M12-D007 | Persist utility records in additive sidecar tables rather than producer or assessment tables. | Consumer claims must not mutate producer facts or independent proof. |
| M12-D008 | Revalidate canonical hashes, projections, target ownership, and immutability in PostgreSQL. | Trusted service validation alone would leave direct SQL as a bypass. |
| M12-D009 | Keep the application service provider-neutral and inject a repository interface. | OpenAI, Codex, Claude, or another consumer can share the same trust and persistence boundary. |
| M12-D010 | Treat Codex cached login and `OPENAI_API_KEY` as separate credential modes. | A ChatGPT-authenticated Codex session is not evidence that API-key authentication is configured. |
| M12-D011 | Require exact JSON object keys and null-safe database projections. | A valid digest proves byte consistency, not that an attacker followed the public contract. |
