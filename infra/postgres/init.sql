-- Runs once, as the superuser, when the local data volume is first created.
-- It stands in for the operator step on managed Postgres: extensions need superuser
-- (or the provider's equivalent), which the migration role (task 0.5) will not have.
-- Roles and grants belong to task 0.5, not here.

create extension if not exists vector;
