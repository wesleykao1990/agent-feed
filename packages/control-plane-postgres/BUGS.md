# Bugs encountered

- An unbounded historical aggregate would keep every old absence or dead
  letter permanently active. The adapter therefore introduced a required,
  visible observation window instead of hiding a lookback inside SQL.
- Immutable job-definition history can over-count a logical job. The job query
  selects the latest version of each tenant-scoped job key before grouping.
