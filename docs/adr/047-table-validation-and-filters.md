# ADR-047 — Table schema changes, row validation and filter semantics

Status: proposed · Date: 2026-11-15 · Tasks: 9.1, 9.2, 9.4

## Context

Architecture §§2.3 and 10 put rows in JSONB keyed by stable column ID. The table contract defines
the types, AST and limits. It leaves open how to enforce uniqueness across concurrent writes, what
a column change does to existing rows, how missing values compare, and which scope owns the table
count limit. The Studio needs a revision boundary for schema edits.

## Options

1. Serialize writes by table, validate against the locked schema and make schema changes atomic.
   Keep filter evaluation on the same validated data types.
2. Maintain a separate typed value table for required and unique checks. It adds a second stored
   representation of every constrained value and needs atomic updates alongside row JSONB.
3. Read the schema and check the rows before an unlocked write. Concurrent writes can admit
   duplicates or leave rows incompatible with an updated schema.

## Recommendation

Choose option 1.

- Reserve the default limit of 50 tables per bot and 100,000 rows per table. Serialize table
  creation by locking its bot and enforce the table limit in that transaction. Lock the table for
  every schema or row mutation, including batches and CSV import. Validate the proposed writes
  before commit and maintain the persisted row count in the same transaction. Use forced RLS and
  composite parent foreign keys that include the workspace ID.
- Require a non-null value for a required column. Optional columns may be omitted or null.
  Validate non-null values against their declared type. Store dates as ISO date or timestamp
  strings canonicalized to UTC timestamps. Enum values match declared strings exactly.
  Reject keys absent from the current schema and cap UTF-8 serialized row data at 16 KiB.
- Ignore missing or null values for uniqueness. Compare non-null values by equality on canonical
  typed values. Compare JSON values by PostgreSQL JSONB equality. Check both existing rows and
  values within the proposed batch while holding the table lock. Resolve upsert by one declared
  unique column with a non-null match value.
- Rename a column without rewriting its values. Reject schema edits that leave existing rows
  invalid, including required or unique edits and enum value changes. Reject a type change while
  the column contains non-null values and report the offending column. Explicitly deleting a
  column removes its values and updates searchable text in the same transaction. Searchable
  text uses the shared Arabic normalizer.
- Resolve filter column names against the current schema and use the resolved column ID as a
  bound JSONB key. Bound filter values and use only fixed SQL fragments for the operators.
  A leaf condition can contain multiple columns joined by AND. Reject empty leaves and type
  mismatches. Sort comparisons use number, timestamp or string ordering for corresponding typed
  columns. Allow literal substring and prefix matches on strings and enums. Use null tests for
  omitted or null values. Treat a non-null comparison against a missing or null value as false
  before applying logical operators. Booleans and JSON support equality and membership.
- Use cursor pagination with the complete sort tuple and row ID as the final tie-breaker. Put
  nulls last for both sort directions. Scope cursors to their table, query and schema revision.
  Use workspace and bot scope for table CRUD and an opaque revision ETag with If-Match for
  mutations. Verify parent scope for every row lookup.

## Consequences

Concurrent writes to a single table are serialized. Reads can continue under PostgreSQL MVCC.
Tests need competing unique writes, conflicting schema edits and a filter fuzz check that verifies
tenant values travel separately from the SQL text. Existing contracts and §10 limits remain the
basis for row operations. Mutable API shapes will be added with their implementing tasks.
