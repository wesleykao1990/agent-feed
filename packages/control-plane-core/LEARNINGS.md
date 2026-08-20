# Learnings

- A production dashboard cannot distinguish failures if its underlying
  contract is delivery-only.
- Aggregate totals need exact state reconciliation or unknown/new states can be
  silently hidden from operators.
