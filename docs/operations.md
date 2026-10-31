# Operations, graph and outbox — design and implementation (Aditya)

Aiman owns the commercial side (passengers, bookings, tickets, payments, identity, feedback,
policy retrieval; see [commercial.md](commercial.md)). This document covers the operations half
and the joint parts: the airline's network and fleet, schedule, crew, disruption handling, the
transactional outbox that keeps MongoDB and Neo4j in step with PostgreSQL, and the screens for
operations controllers, crew and administrators.

ER diagram: [diagrams/er.svg](diagrams/er.svg) (source [diagrams/er.mmd](diagrams/er.mmd)).
Index benchmark: [benchmarks.md](benchmarks.md). Test evidence: [testing.md](testing.md).

## 1. Store responsibilities

| Store | Holds | Why this store |
|---|---|---|
| PostgreSQL | Every fact that must be consistent: airports, aircraft, seats, flights, fares, crew, assignments, the outbox, plus Aiman's commercial tables | Constraints that span rows (no double-booked aircraft or crew), transactions across sales and operations, RLS |
| MongoDB | Flight event history (time series), live flight status, maintenance logs, audit log, notifications, feedback | Append-heavy, schema-flexible documents; TTL; change streams for the live board; aggregation pipelines |
| Neo4j | Airports, flights, `CONNECTS_TO` edges between connectable flights, route statistics, crew pairings | Multi-leg itinerary search and network analytics are path problems |

PostgreSQL is the only source of truth. Mongo and Neo4j are fed exclusively through the outbox
(except native Mongo documents such as maintenance logs and crew reports), so either can be
dropped and rebuilt: `npm run graph:reconcile`, `npm run outbox:drain`.

## 2. Relational schema (operations)

All files are in `db/postgres/init/` and run in order on a fresh volume.

| Table | Key | Notable rules |
|---|---|---|
| `airport` | `airport_code` (`d_iata_code`) | IANA timezone checked by trigger against `pg_timezone_names`; generated `name_search` tsvector + trigram index for the airport picker |
| `aircraft` | `aircraft_id`; `registration` unique (`VT-XXX`) | `type_rating` (A20N, AT76, B789, A359); `capacity` must equal the number of seats — enforced by a pair of *deferred* constraint triggers so a seat map can be rebuilt inside one transaction |
| `seat` | (`aircraft_id`, `seat_number`) — weak entity | Class, window/middle/aisle position, exit row; generated from a layout string by `ops_generate_seat_map` |
| `flight` | `flight_id`; unique (`flight_number`, `departure_time`) | Status state machine (trigger); `duration_minutes` generated; `delay_reason` required whenever `delay_minutes > 0`; `cancel_reason` required when cancelled; **`EXCLUDE USING gist (aircraft_id WITH =, ops_turnaround_range(departure, arrival) WITH &&) WHERE status <> 'Cancelled'`** — an aircraft can never be scheduled on two overlapping sectors including a 45-minute turnaround; deferrable so knock-on delays can shift a whole rotation in one statement |
| `flight_fare` | (`flight_id`, `fare_class`) — weak | Seats allocated per class must fit the aircraft's seats of that class (trigger) |
| `crew` | `crew_id`; `license_number` unique | Self-referencing `supervisor_id`; `salary` is hidden by a column-level grant |
| `crew_certification` | (`crew_id`, `certification`) — multivalued | `TYPE:A20N`, `MEDICAL`, `SEP` (safety & emergency procedures), `CRM` with expiry dates |
| `crew_assignment` | (`crew_id`, `flight_id`) — M:N with attributes | Role, duty window (departure − 30 min to arrival + 15 min), `standby_status`; duty ≤ 21 h CHECK; **`EXCLUDE USING gist (crew_id WITH =, tstzrange(duty_start, duty_end) WITH &&)`** — nobody can be on two duties at once |
| `outbox_event` | `event_id` identity | Aggregate, type, JSON payload, `processed_at`, `attempts`, `last_error`, `next_attempt_at`; partial index on pending rows |

Joint addition (`72_disruption_joint.sql`): `ticket.replaces_seq` links a rebooked ticket to the
disrupted one it replaces (self-FK within the booking, CHECK that it differs from itself).

`ops_turnaround_range(timestamptz, timestamptz)` exists because `timestamptz + interval` is only
STABLE and cannot appear in an index expression; the wrapper is declared IMMUTABLE (the interval
is a constant, so it is genuinely time-zone independent).

### Views

| View | Purpose |
|---|---|
| `v_aircraft_age` | Fleet age from year of manufacture (Lab 04 derived attribute) |
| `v_flight_load` | Sold vs allocated seats per flight and class (load factor) |
| `v_flight_manifest` | Passengers, seats, check-in and bags per flight |
| `v_crew_roster` | Each crew member's duties with local times |
| `v_crew_coverage` | Flights in the next days whose crew is incomplete (`GROUP BY … HAVING`) |
| `mv_route_revenue_monthly` | Materialized revenue per route per month; unique index so `REFRESH … CONCURRENTLY` works (`sp_refresh_analytics`) |

## 3. Procedures and functions (`70_functions_ops.sql`)

Every write the app makes goes through a `SECURITY DEFINER` routine that re-checks the caller's
role from `app_user` (`fn_assert_role`) — the `strata_app` role has no INSERT/UPDATE/DELETE on the
operations tables, so a bug in the web tier cannot bypass the rules. Each routine also writes an
audit event (`fn_emit_ops_audit`) into the outbox in the same transaction.

| Routine | What it does |
|---|---|
| `fn_schedule_flight` | Validates route, aircraft type, times; creates the flight and its fares |
| `fn_add_aircraft`, `sp_generate_seat_map`, `sp_set_aircraft_status` | Fleet management; seat map from a layout such as `ABC DEF` per cabin (spaces are aisles) |
| `sp_upsert_airport` | Airport maintenance with timezone validation |
| `fn_crew_legality(crew, flight, role)` | Returns one row per rule with pass/fail and a specific message: ACTIVE, ROLE (rank may fly the role), TYPE_RATING, MEDICAL, SAFETY (SEP), FLIGHT_OPEN, NOT_ASSIGNED, ROLE_SLOT (one captain, one FO, cabin crew = ⌈seats / 50⌉), NO_OVERLAP, POSITION (crew is at the departure airport after their previous duty), POSITION_NEXT (their next duty departs from where this one lands), DUTY_PERIOD (≤ 13 h duty within any 20 h window) |
| `sp_assign_crew`, `sp_unassign_crew` | Assign only if every rule passes (the exclusion constraint is the final guard) |
| `fn_flight_crew_complete` | Required before a flight may move to Boarding |
| `sp_update_flight_status(flight, status, delay, gate, reason)` | Status changes, delays and gate changes. An increased delay requires a reason. **Knock-on propagation** (`ops_propagate_delay`): later sectors of the same aircraft that no longer have a 45-minute turnaround are pushed back with reason *Late inbound aircraft*, recursively along the rotation; crew duties move with their flights, and any later duty of the same crew that now overlaps is released (it reappears in coverage). The exclusion constraints are deferred for the duration and re-checked at COMMIT. Returns the knock-on list. |
| `sp_cancel_flight(flight, reason)` | Cancels, marks every ticket and booking on it *Disrupted*, releases the crew and emits `FLIGHT_CANCELLED` with the affected bookings (notifications) |
| `fn_disrupted_tickets()` / `sp_rebook_ticket(pnr, seq, flights[])` | Joint disruption flow: lists disrupted tickets with the latest acceptable arrival, then rebooks one onto a direct or connecting itinerary in the **same PNR** — new tickets reference the old one via `replaces_seq`, the first leg carries the original fare, later legs are free; capacity is re-checked |
| `fn_crew_chain(crew)` | Recursive CTE up the supervisor hierarchy, cycle-safe |
| `fn_crew_admin`, `fn_route_revenue`, `fn_ops_overview` | Admin-only salary view, revenue report, dashboard counters |
| `fn_outbox_claim(limit)` | `SELECT … ORDER BY event_id LIMIT n FOR UPDATE SKIP LOCKED` so several workers never deliver the same event |
| `fn_outbox_complete`, `fn_outbox_fail` | Mark delivered; on failure `attempts + 1` and back-off of 2^(attempts+1) s capped at 1 h |
| `fn_outbox_admin`, `sp_outbox_retry` | Outbox monitor and manual retry for the admin screen |
| `fn_seats_remaining(flight, class)` | SECURITY DEFINER seat count so anonymous search sees real availability despite RLS on tickets |

## 4. Triggers (`80_triggers_ops.sql`)

| Trigger | Rule |
|---|---|
| `trg_*_updated_at` | Maintains `updated_at` (used as the version for out-of-order event handling) |
| `trg_airport_validate` | Timezone must be a real IANA zone |
| `trg_flight_status_transition` | Allowed transitions only: Scheduled/Delayed → Boarding → Departed → Landed, anything open → Cancelled; new flights must start as Scheduled and the aircraft must be Active |
| `trg_flight_fare_validate` | Fare-class allocation fits the cabin |
| `trg_crew_assignment_validate` | Duty window derived from the flight; role valid for the rank |
| `trg_seat_capacity`, `trg_aircraft_capacity` | Deferred constraint triggers: capacity = seat count at COMMIT |
| `trg_flight_outbox`, `trg_airport_outbox`, `trg_aircraft_outbox`, `trg_flight_fare_outbox` | Write snapshot events (`FLIGHT_UPSERT` with the full row, the changed columns and the acting user; `FLIGHT_DELETED`; `AIRPORT_UPSERT`; `AIRCRAFT_UPSERT`; `FLIGHT_FARE_UPSERT`) in the same transaction as the change |

## 5. Security (`91_rls_grants_ops.sql`)

- `strata_app` gets SELECT on operations tables and EXECUTE on the routines; no direct DML.
- `crew.salary` is excluded from the column grant; only `fn_crew_admin` (ADMIN) returns it.
- RLS on `crew` (staff and crew only — passengers cannot list crew), `crew_certification`
  (ADMIN/OPS see all, a crew member their own) and `crew_assignment` (ADMIN/OPS see all, a crew
  member their own duties plus who else is on those flights).
- `strata_readonly` (showcase) reads only airports, aircraft, flights, fares and `v_aircraft_age`.
- The outbox and the revenue materialized view are not granted at all; they are reached only
  through `fn_outbox_*` and `fn_route_revenue`.
- Middleware gates `/ops` (OPS, ADMIN), `/crew` (CREW), `/admin` (ADMIN); every API action
  re-checks the role server-side, and the database checks it a third time.

## 6. Transactional outbox

```
PostgreSQL transaction ──► outbox_event (same COMMIT)
                                │  fn_outbox_claim (SKIP LOCKED)
                 ┌──────────────┼───────────────┬──────────────────┐
           Neo4j sync     flight_events     flight_status     audit_log / notifications
         (UNWIND MERGE)   (time series)   (newest wins)      (_id = outbox:<id>)
```

- **Delivery**: `src/lib/outbox/dispatcher.ts` routes each event type to its consumers and marks
  the batch processed only for consumers that succeeded; a failing consumer only fails its own
  events, which back off and retry. Triggered three ways: right after a mutating API call
  (`after()` in `src/server/outbox.ts`), by the long-running worker (`npm run worker`), and by a
  daily cron (`/api/cron/outbox`, protected by `CRON_SECRET`; `vercel.json`).
- **Idempotency**: every consumer can see the same event twice. Time-series documents carry
  `sourceEventId = <event_id>:<TYPE>` with a unique index; audit and notification documents use
  `_id = outbox:<event_id>`; graph writes are `MERGE`.
- **Ordering**: payloads are full snapshots with `updatedAt`; Mongo `flight_status` and Neo4j
  nodes ignore a snapshot older than what they hold, so out-of-order delivery is harmless.
- **No Neo4j configured**: graph events stay pending rather than being marked delivered.

## 7. MongoDB and Neo4j

See [`db/mongo/README.md`](../db/mongo/README.md) and [`db/neo4j/README.md`](../db/neo4j/README.md)
for collection validators, indexes, pipelines and the graph model.

Itinerary search (`/api/search/itineraries`, consumed by Aiman's search screen with the response
contract in commercial.md): Neo4j finds candidate paths over `CONNECTS_TO` (≤ 2 connections,
45–360 min layovers, no airport revisited); PostgreSQL then re-reads each leg for live status,
seats and price. If Neo4j is down, a circuit breaker switches to an equivalent recursive CTE for
60 s — the response says which `source` was used. A test asserts both give identical results.

## 8. Application

| Route | Role | Screen |
|---|---|---|
| `/` | public | Landing page with search |
| `/search` | public | Direct + connecting results |
| `/board` | public | Live departures (SSE from a Mongo change stream, polling fallback) |
| `/ops` | OPS | Dashboard: today's flights, delays, crew gaps, disrupted tickets |
| `/ops/schedule` | OPS | Day schedule per airport; schedule a flight with fares |
| `/ops/flights/[id]` | OPS | Flight console: status, delay with knock-on result, gate, cancel; crew list and legality-checked crew picker; load; Mongo event timeline; manifest |
| `/ops/disruptions` | OPS | Disrupted tickets → itinerary options → rebook |
| `/ops/crew` | OPS | Coverage gaps, roster, supervisor chain |
| `/ops/maintenance` | OPS | Maintenance logs (Mongo) |
| `/ops/network` | OPS | Hub ranking, shortest route, closure impact radius (Neo4j) |
| `/crew`, `/crew/flights/[id]` | CREW | My roster; flight details, crew list, crew reports (Mongo) |
| `/admin` + `fleet`, `airports`, `analytics`, `audit`, `outbox` | ADMIN | Fleet and seat maps, airports, SQL/Mongo/graph analytics, audit log, outbox monitor and retry |

Each section that reads Mongo or Neo4j fails soft: a per-store circuit breaker returns the SQL
parts immediately and shows "MongoDB unavailable" for the rest.

## 9. Running

```bash
npm run db:reset              # fresh volumes: runs every db/postgres/init/*.sql
npm run db:seed:ops           # crew, 5 weeks of flights (3 back, 2 ahead), rosters, fares
npm run db:mongo:commercial && npm run db:mongo:ops
npm run db:seed:commercial    # policies + embeddings (Aiman)
npm run db:seed:demo          # optional demo passengers (needs SEED_DEMO_PASSWORD)
npm run db:seed:traffic       # optional: synthetic bookings for realistic loads and analytics
npm run outbox:drain          # deliver everything queued so far to Mongo/Neo4j
npm run graph:reconcile       # (or) rebuild the graph from scratch
npm run worker                # keep delivering while the app runs
npm run dev
```

With `SEED_STAFF_PASSWORD` set, the ops seed creates `ops@strata.test`, `captain@strata.test` and
`purser@strata.test`. The seed is deterministic: aircraft rotations come from a greedy
scheduler (widebodies reposition between Indian hubs between long-haul rotations) and rosters are
built by calling the same legality check the UI uses, inside savepoints.

## 10. Changes made to Aiman's files during integration

Only what integration required; behaviour of the commercial features is unchanged.

| File | Change | Why |
|---|---|---|
| `src/app/*` pages | Moved into the `src/app/(app)/` route group (`git mv`) with his header in `(app)/layout.tsx` | The landing page owns `/` with its own full-screen layout; his app shell wraps everything else |
| `src/app/globals.css` | His styles nested under `.app-shell` | Keep landing and app styles from leaking into each other |
| `src/app/layout.tsx` | Root layout with self-hosted fonts | Google Fonts is unreachable at build time in CI |
| `src/middleware.ts` | Added `/ops`, `/crew`, `/admin/*` matchers and role redirects | New role-gated areas |
| `src/server/queries/commercial.ts` | `lookup` rewritten as a `UNION` (full-text branch + exact PNR branch with a `bpchar` cast); `directFlights` uses `fn_seats_remaining` | The `OR EXISTS` form defeated the GIN index and the text cast skipped the booking PK (1.0× → 353× in the benchmark); RLS hid sold seats from anonymous search |
| `src/components/search.tsx` | Accepts initial values and runs on load | `/search?from=…` links from the landing page |
| `src/components/login-form.tsx` | Redirects by role after sign-in | OPS/CREW/ADMIN land on their own area |
| `db/mongo/commercial.ts` | Added the `BOOKING_REBOOKED` notification kind | Joint rebooking |
| `src/lib/db/mongo.ts`, `neo4j.ts` | 5 s server selection / connection timeouts, plain-number integers | Fail fast so circuit breakers work |
| `src/server/tests/commercial.test.ts`, `scripts/test-commercial-e2e.ts` | Load the real migrations plus `db/postgres/tests/fixtures/ops_data.sql` instead of the stub contract; crew rows inserted through the real schema; E2E walks Boarding → Departed → Landed | The stub (`ops_contract.sql`, deleted) conflicted with the real operations tables |
| `vitest.config.mts` | `@` path alias | Shared imports in the ops tests |
| `docs/commercial.md` | Notes that the itinerary contract and dispatcher are implemented | Contract fulfilled |
