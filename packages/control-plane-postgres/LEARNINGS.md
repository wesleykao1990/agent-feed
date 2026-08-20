# Learnings

- A sanitized output type is insufficient if the data adapter can select raw
  columns; the SQL inventory also needs an explicit negative contract.
- Snapshot consistency matters across jobs, occurrences, runs, assessments,
  and deliveries. Separate autocommit queries can describe different moments.
- Assessment rows are incomplete until sealed, so operational reads must join
  `assessment_receipt_seals` just as retry and registry reads do.
