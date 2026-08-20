# Decisions

- Comparable means the same immutable job and policy identity with all four
  proof layers present; outcomes may legitimately differ by topology.
- Require at least three distinct deployment topologies in a matrix.
- Reuse the M8 telemetry vocabulary and M9 ingress vocabulary rather than
  inventing provider-specific fields.
- Store provider invocation identity only as a digest in this contract.
- Keep live-provider setup, account authentication, and raw execution context
  in adapters and future append-only sidecars.
