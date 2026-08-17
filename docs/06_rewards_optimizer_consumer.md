# Rewards Optimizer consumer boundary

The Rewards Optimizer is a separate project. It pins Agent Feed protocol `0.1` and receives signed `finding.submitted` events through its own internal endpoint.

```text
Agent Feed Finding
  → transport receipt/idempotency
  → Rewards SourceObservation
  → domain semantic fingerprint
  → evidence-acquisition request
  → canonical source snapshot/evidence
  → extraction candidate
  → reviewed RewardRuleVersion
```

The consumer must not:

- turn a generic finding directly into a reward rule;
- treat agent confidence as source authority;
- reuse an Agent Feed artifact as canonical evidence without permission, hashing, and review;
- query Agent Feed's database;
- depend on Agent Feed Realtime channels.

The reference event and expected observation are in `examples/rewards-optimizer/`.
