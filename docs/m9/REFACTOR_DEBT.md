# Milestone 9 refactor debt

- Do not introduce a generic registry repository abstraction until a second
  durable backend exists. The pure core is already storage-neutral; premature
  persistence abstraction would add indirection without portability evidence.
- Capability version grammar is deliberately bounded numeric-dot comparison.
  Provider-specific semantic versions belong in adapters until multiple
  providers prove a universal richer contract.
