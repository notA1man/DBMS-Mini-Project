# Aiman's commercial verification — 2026-10-25

## Results

| Check | Verified result |
|---|---|
| `npm test` | 29 tests pass across PostgreSQL and Mongo integration suites |
| `npm run typecheck` | Pass |
| `npm run lint` | Pass |
| `npm run build` | Production build passes with Next.js 15.5.28 |
| `npm run test:e2e:commercial` | Production-server Chromium journey passes against disposable databases |
| Local embedding model | 384 dimensions; measured vector norm 1.0000000238474636 |
| `npm audit --omit=dev` | 0 reported vulnerabilities; PostCSS pinned to 8.5.31 via override |
| `npm run db:migrate` with current operations placeholders | Expected refusal before applying any migration |
| Docker baseline helper | Bash syntax validated; full fresh-volume initialization awaits operations implementation |

Environment: Windows, Node 22.17.0, Docker PostgreSQL 17 + pgvector and MongoDB 7,
Chromium 156 through Playwright. These are real service tests, not mocked
database responses. Test databases have unique `skyops_commercial_test_*` or
`skyops_commercial_e2e_*` names and are dropped in cleanup. Existing application
databases and Docker volumes are not reset.

## Database and Mongo coverage

- 50 concurrent attempts for one seat: exactly one success and no orphan bookings.
- Fare-bucket capacity remains enforced without assigned seats; an invalid second
  itinerary leg rolls back the entire booking.
- Server-priced tickets synchronize totals; incompatible fare-class seats fail.
- Passenger RLS hides other users' rows; spoofing `app.role=ADMIN` does not bypass it.
- Crew can see only assigned manifests and cannot read financial rows.
- No direct app writes to commercial tables or user roles; no SELECT of hashes.
- Partial/final payments create one receipt each, reject overpayment and support
  stable-reference replay. Outbox failure rolls back payment, receipt and confirmation.
- Unpaid/out-of-window check-in fails; valid check-in issues a reusable boarding code.
- Per-ticket baggage totals enforce class limits; cancellation releases seats,
  clears boarding codes and computes a simulated refund.
- Atomic registration, bcrypt authentication, five-attempt lockout and expiry;
  persisted request budgets; immediate API denial for disabled accounts.
- Admin-only staff creation/role changes; self-demotion prevented.
- pgcrypto passport encryption/decryption checked with a test key; foreign-user
  writes rejected. No real passport data is used.
- Hybrid vector/FTS retrieval, keyword fallback and category filters;
  staff similarity executes with restricted app-role privileges.
- Origin-airport date filtering includes flights just after local midnight even
  when their UTC date is the previous day.
- Strict Mongo validation, review uniqueness, feedback scorecard and tag aggregation.
- Notification replay preserves read state and the original 90-day TTL timestamp.
- Commercial audit outbox events carry the database actor without credentials.

## Browser and real-model coverage

The browser runner seeds all 25 authored policy documents using the real local
MiniLM model, confirms semantic baggage retrieval, then starts a production Next
server with temporary PostgreSQL/Mongo database names and an ephemeral auth secret.

The journey registers and signs in, searches a direct flight, reserves a seat,
pays, checks in and fetches a PNG boarding QR. It tests the rollback-only
double-booking showcase and EXPLAIN output, explicit keyword fallback, feedback
after a test flight is marked Landed, the feedback-index repair CLI and real
staff complaint similarity. The demo-passenger seed is run twice to check safe
reuse. The notification handler is manually replayed, independent of the pending
shared dispatcher. A second account cannot fetch the booking/boarding pass;
passengers cannot access admin APIs; cross-origin writes fail; an admin can
disable an existing session's account and subsequent API requests are denied.

The runner checks a 390px viewport for horizontal overflow and saves desktop/mobile
screenshots under ignored `test-results/`. It also writes
`test-results/commercial-e2e.txt`. These are generated test artifacts, not committed
submission screenshots. The test fixture temporarily updates flight times/status
to exercise completed-flight feedback; it never changes production flights.
Desktop/mobile landing screenshots and the boarding-pass/feedback screen were
visually inspected for layout. This is not a full visual acceptance pass over
every role and form.

## Evidence boundaries and remaining work

Operations tables are supplied by a **test fixture**, not Aditya's production SQL.
Therefore these results do not establish working operations exclusion constraints,
graph search, flight-disruption rebooking, actual outbox polling/delivery, or full
fresh-volume Docker initialization. The connection-search response contract is
proposed in `commercial.md` and still needs agreement.

Performance benchmarks on 100k tickets, pgTAP, joint disruption E2E, cloud deployment,
the final combined report/PDF and full application visual acceptance remain pending.
No index speedup or deployment success is claimed. Browser checks cover the core
passenger flow; SQL tests cover cancellation, baggage and companion permissions.
