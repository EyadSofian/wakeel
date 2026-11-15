# Trace payload retention

The worker's `trace-retention` maintenance job prepares the current and next UTC month
partitions and expires a bounded page of spans for each workspace. Set
`TRACE_RETENTION_BY_PLAN` to a JSON object mapping plan names to positive days if a plan
needs a different window. Plans absent from the map use 30 days. Use `TRACE_PII_PATTERNS`
for deployment-owned redaction expressions in addition to secret-value redaction.

Set an object-store lifecycle expiration rule for the `traces/` prefix only. Keep the age
longer than the maximum of the configured plan windows and the 30-day default. This is the
backstop for uploads whose database write failed and for objects left after deleting an
entire workspace. Normal expiry uses the pending-delete queue and retries failed deletes.
Leave uploaded knowledge source objects outside this lifecycle rule.
