Constraint, trigger, procedure and RLS tests run through Vitest against a disposable database built
from the real migrations (no mocks): `src/server/tests/commercial.test.ts` (Aiman) and
`src/server/tests/ops.test.ts` (Aditya). Each constraint is exercised with an accepted and a refused
case, through the least-privilege `strata_app` role. `fixtures/ops_data.sql` is test-only data.
