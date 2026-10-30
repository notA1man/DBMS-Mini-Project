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

## Evidence boundaries (commercial run, 2026-10-25)

That run used a test fixture for the operations tables. Since then the commercial tests load
the real operations migrations (see the operations section below), so the boundaries listed at
the time — operations constraints, graph search, rebooking, outbox delivery, benchmarks — are now
covered there. Cloud deployment and the final combined report remain outside this document.

# Aditya's operations verification — 2026-10-26

Environment: PostgreSQL 16.15 + pgvector 0.6, Node 22, Next.js 15 production build. MongoDB and
Neo4j were **not** reachable in this environment; the suites that need them skip themselves
(see "Not yet run" below).

## Results

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | clean |
| Lint | `npm run lint` | clean |
| Unit / integration (all suites) | `npm test` | **53 passed**, 8 skipped (store suites); `mongo-commercial.test.ts` fails at its hook only because MongoDB is unreachable here |
| — operations SQL | `src/server/tests/ops.test.ts` | 22 / 22 |
| — outbox dispatcher | `src/server/tests/outbox.test.ts` | 5 / 5 |
| — commercial (now on the real ops schema) | `src/server/tests/commercial.test.ts` | 26 / 26 |
| Production build | `npm run build` | passes (45 app routes) |
| Ops browser journey | `npm run test:e2e:ops` | **11 / 11** |
| Index benchmark | `npm run bench:indexes` | [benchmarks.md](benchmarks.md) |

All database tests run in a uniquely named disposable database built from the real
`db/postgres/init/*.sql`, through the least-privilege `skyops_app` role, and drop it afterwards.

## Operations SQL tests (`ops.test.ts`)

Constraints and triggers — each with an accepted and a refused case:
seat maps must match aircraft capacity (deferred, checked at COMMIT) · seat-map generator assigns
window/middle/aisle and exit rows · airport time zones validated against IANA · an aircraft
cannot fly overlapping sectors or skip its 45-minute turnaround (`EXCLUDE`, SQLSTATE 23P01) ·
fare buckets only for cabins the aircraft has · only ops staff can schedule and the app role
cannot write tables directly · flight status state machine.

Crew: the legality report explains each rule · illegal assignments are refused naming the rule ·
a full legal crew completes the flight · crew must be at the departure airport and cannot
overlap duties · boarding is blocked until the crew is complete · RLS: crew see their own duties
and colleagues on those flights, passengers see no crew · salaries hidden from the app role ·
recursive supervisor chain survives a cycle.

Disruption: a delay pushes the aircraft's rotation (knock-on) and moves crew duties, releasing
a crew member's later conflicting duty · cancelling disrupts tickets and bookings, frees crew and
queues notifications · ops re-books a disrupted passenger on the same PNR at no extra cost.

Outbox and analytics: two dispatchers never claim the same event (`FOR UPDATE SKIP LOCKED`, two
concurrent transactions) · failures back off exponentially and completion is idempotent · state
changes and audit entries commit together · the revenue materialized view refreshes concurrently.

## Outbox dispatcher tests (`outbox.test.ts`)

Real PostgreSQL outbox, in-memory Mongo/Neo4j stand-ins: one snapshot becomes typed time-series
events with stable idempotency keys · boarding/cancellation/retime types · each event type
reaches its consumers and is marked processed · a failing consumer only fails its own events,
which back off and are retried · without Neo4j configured, graph events stay pending.

## Browser journey (`test:e2e:ops`)

Production build against a freshly seeded disposable database:

1. Database seeded (flights, crew, rosters, staff logins); Mongo absent so fallbacks exercised
2. Ops staff land on the ops console with live KPIs
3. Scheduling works; a turnaround clash is rejected by `flight_aircraft_no_overlap`
4. Crew picker shows rule-by-rule legality and assigns a legal purser
5. A 150-minute delay propagates to the aircraft's next sector
6. Cancelling a booked flight disrupts its tickets and bookings in one transaction
7. The disrupted passenger is re-booked on the same PNR at no extra cost (booking back to Confirmed)
8. DB showcase demonstrates the exclusion constraint with a savepoint rollback
9. Public departures board renders; the itinerary API answers (recursive-CTE source here)
10. Crew see their roster and assigned manifests only; ops pages and APIs are denied
11. Admin analytics, fleet and outbox screens render

Two real bugs were found and fixed by this run: zod 4's `z.record(enum, …)` requires every key
(fares are now `z.partialRecord`), and the crew picker briefly kept the previous role's
candidates clickable after switching role (now keyed by role).

## Later local run — 2026-10-30

`npm run typecheck`, `npm run lint` and `npm run build` are clean. `npm test` is **60 passed, 2 skipped**
(the Neo4j store cases still run only under `npm run test:stores`). `npm run test:e2e:ops` is **11 / 11**
and `npm run test:e2e:commercial` passes the full passenger journey, including a 390px check that the
landing page does not scroll sideways.
That browser run points the server at an unreachable bolt port so re-routing uses the recursive CTE:
the disposable database is not loaded into the shared Neo4j, and a live demo graph would otherwise
offer flight ids that do not exist in the test database.

# Full run against the Compose services — 2026-10-30 (evening)

Environment: Linux, Node 22.23, Docker PostgreSQL 17.11 + pgvector 0.8, MongoDB 7 (replica set),
Neo4j 5.26; production build; Chromium (Google Chrome) for the browser runs.

| Check | Command | Result |
|---|---|---|
| Typecheck, lint, build | `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| All Vitest suites, Mongo reachable | `npm test` | **60 passed**, 2 skipped (the Neo4j cases below); `mongo-commercial.test.ts` now runs and passes |
| MongoDB + Neo4j stores | `npm run test:stores` | **5 / 5**, then the graph was rebuilt with `graph:reconcile` |
| Ops browser journey | `npm run test:e2e:ops` | **11 / 11** |
| Commercial browser journey | `npm run test:e2e:commercial` | passes |
| Fresh-volume init | throwaway `pgvector/pgvector:pg17` container with `db/postgres/init` mounted | all 17 scripts apply; 22 tables, 15 baselined migrations, 32 airports, `skyops_app` can log in |
| Health | `GET /api/health` | PostgreSQL, MongoDB and Neo4j all ok |

**Visual inspection.** A Playwright crawl signed in as guest, passenger, ops, crew and admin and
opened every screen at 1440 px and 390 px, recording console errors, failed requests (HTTP ≥ 400)
and horizontal overflow, and saving full-page screenshots for review. Result: no console errors,
no failed requests, no page wider than the viewport, and every role is redirected away from areas
it may not open. Curated screenshots are committed under [screenshots/](screenshots/).

Bugs found and fixed in this pass:

- `/admin/users` rendered all ~4,000 accounts with an edit form each and froze the page. It now
  shows staff by default, filters by role and email, and renders at most 100 rows.
- The landing page's network figures (routes, airports, daily flights) were hard-coded and did not
  match the data; they are now read from PostgreSQL (`opsQueries.networkStats`, refreshed every
  five minutes).
- Login/register headline read "The skyis yours." on phones (the line break was hidden without a
  space).
- Crew and ops manifests showed the raw `NotCheckedIn` value.
- The admin overview grid left two empty cells on wide screens.

## Not run

- Cloud deployment.
- `npm run bench:indexes` was not re-run; [benchmarks.md](benchmarks.md) is from 2026-10-26.
