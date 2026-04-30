# Archived migrations

These are historical Prisma migrations from before the baseline
reconciliation. They were never applied to the current `dev.db`
(its schema was built up via `prisma db push`), and a consolidated
`init` migration in the active path now covers everything they
described plus the four models that were added by `db push` only
(`TrackerBox`, `TrackerEntry`, `DebtTransfer`, `PendingRedemption`).

Prisma ignores this directory — only files under
`agent-tab/prisma/migrations/` are part of the active migration
history that `prisma migrate deploy` runs.

**Do not add new migrations here.** New schema changes go through
`prisma migrate dev` and land under `agent-tab/prisma/migrations/`.
