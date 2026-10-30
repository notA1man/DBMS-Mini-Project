# SkyOps — project report

DBMS Experiential Learning, Level 3 project. **Team:** Aiman A Nawab (PES1UG24CS038) · Aditya.

This is the submission report. It follows the section order in the requirements
(`reference/DBMS Level 3 Project Requirements.pdf`) and links to the detailed write-ups
instead of repeating them:
[operations.md](operations.md) (operations, graph, outbox) ·
[commercial.md](commercial.md) (commercial, identity, vectors) ·
[benchmarks.md](benchmarks.md) · [testing.md](testing.md) ·
[db/mongo](../db/mongo/README.md) · [db/neo4j](../db/neo4j/README.md).

---

## 1. Problem statement

An airline sells seats and operates aircraft, and both sides share the same flights. When sales
and operations are separate systems, a cancellation can leave a passenger holding a seat that no
longer exists, two bookings can take the same seat, and a late aircraft can be scheduled out on
its next sector before the inbound flight has landed.

SkyOps is a disruption-aware airline platform that keeps both sides in one transactional
database. It projects the parts that are better stored as documents (event history, maintenance,
audit) or as a graph (connections between flights).

## 2. Objectives

1. Make double-booking of a seat, an aircraft or a crew member impossible at the database level.
2. Book, pay, check in and cancel in single transactions, with an audit trail.
3. Propagate a delay along an aircraft's rotation, and rebook disrupted passengers on the same PNR.
4. Search multi-leg itineraries as a graph-path problem, with an equivalent SQL fallback.
5. Answer policy questions and find similar complaints by meaning, not only by keywords.
6. Expose all of this through a Next.js application with four roles.

## 3. Scope

**In scope:** registration and login; direct and connecting flight search; booking with seat
selection; simulated payment and receipts; check-in and QR boarding passes; baggage limits;
cancellation with a simulated refund; feedback and notifications; a policy assistant; fleet,
seat maps and airports; scheduling; crew legality and rostering; delay knock-on; cancellation
and rebooking; a live departures board; network analytics; an audit log; an outbox monitor.

**Out of scope:** real payment gateways, real airline or government integrations, automatic
expiry of unpaid holds, and production cloud deployment. Fares come from a deterministic teaching
formula, not a revenue-management system. Policy text is written for SkyOps and is not copied from
any carrier.

## 4. Functional requirements

| # | Requirement | Role |
|---|---|---|
| F1 | Register, sign in, lock the account after five failed attempts, rate-limit sign-ins | Public |
| F2 | Search direct flights by route and local date, with live seats and price | Public |
| F3 | Search itineraries with up to two connections (45–360 min layovers) | Public |
| F4 | Book one or more passengers on one or more legs atomically, choosing seats | Passenger |
| F5 | Pay in instalments; one receipt per successful payment; confirm when fully paid | Passenger |
| F6 | Check in from 48 h to 1 h before departure; issue a QR boarding pass | Passenger |
| F7 | Add baggage within class allowances; cancel with a time-based refund | Passenger |
| F8 | Leave feedback after a flown flight; receive notifications | Passenger |
| F9 | Ask the policy assistant; get cited passages | Public |
| F10 | Schedule flights; reject aircraft overlaps including turnaround | Ops |
| F11 | Assign crew only when every legality rule passes, and explain any failure | Ops |
| F12 | Delay a flight and push the rest of the aircraft's rotation; cancel a flight | Ops |
| F13 | Rebook disrupted tickets onto direct or connecting itineraries in the same PNR | Ops |
| F14 | Look up passengers; find similar complaints; maintenance logs; network analytics | Ops |
| F15 | Crew see their own roster and the manifests of flights they are assigned to | Crew |
| F16 | Manage users and roles, fleet and seat maps, airports; analytics, audit log, outbox | Admin |
| F17 | Public live departures board that updates without a reload | Public |

## 5. ER diagram

![ER diagram](diagrams/er.svg)

Source: [diagrams/er.mmd](diagrams/er.mmd), extended from the Lab 04 airline ER
([reference/Airline_Operations_ER_Schema.pdf](reference/Airline_Operations_ER_Schema.pdf)).

Relationship types worth calling out:

| Relationship | Type | Implementation |
|---|---|---|
| Aircraft has Seat | 1:N, weak entity | PK `(aircraft_id, seat_number)`, `ON DELETE CASCADE` |
| Flight sells Fare | 1:N, weak entity | PK `(flight_id, fare_class)` |
| Booking contains Ticket | 1:N, weak entity | PK `(booking_id, ticket_seq)` |
| Ticket checks Baggage | weak of a weak entity | PK `(booking_id, ticket_seq, bag_seq)` |
| Crew works Flight | M:N with attributes | `crew_assignment` (role, duty window, standby) |
| Crew holds Certification, Passenger has Phone | multivalued attributes | own tables with composite keys |
| Crew supervises Crew | unary 1:N | `crew.supervisor_id` self-FK |
| Ticket replaces Ticket | unary, optional | `(booking_id, replaces_seq)` self-FK within a booking |
| Payment issues Receipt | 1:1 | `receipt.payment_id UNIQUE` |
| Airport is origin / destination of Flight | two 1:N roles | `flight.origin`, `flight.destination`, CHECK they differ |

## 6. Relational schema

Primary keys are in **bold**. All files are in `db/postgres/init/` and run in filename order on
an empty volume.

| Relation | Attributes | Foreign keys |
|---|---|---|
| airport | **airport_code**, airport_name, city, country, timezone, latitude, longitude, name_search, updated_at | — |
| aircraft | **aircraft_id**, registration, model, manufacturer, type_rating, capacity, year_of_manufacture, status, updated_at | — |
| seat | **aircraft_id**, **seat_number**, seat_class, seat_position, is_exit_row | aircraft_id → aircraft |
| flight | **flight_id**, flight_number, departure_time, arrival_time, flight_status, duration_minutes, aircraft_id, origin, destination, gate, delay_minutes, delay_reason, cancel_reason, updated_at | aircraft_id → aircraft; origin, destination → airport |
| flight_fare | **flight_id**, **fare_class**, base_fare, seats_allocated | flight_id → flight |
| crew | **crew_id**, crew_name, designation, license_number, salary, hire_date, supervisor_id, base_airport, is_active, updated_at | supervisor_id → crew; base_airport → airport |
| crew_certification | **crew_id**, **certification**, valid_until | crew_id → crew |
| crew_assignment | **crew_id**, **flight_id**, role_on_flight, duty_start, duty_end, standby_status, assigned_at | crew_id → crew; flight_id → flight |
| passenger | **passenger_id**, first_name, middle_name, last_name, gender, date_of_birth, email, passport_no_enc, nationality, name_search, created_at | — |
| passenger_phone | **passenger_id**, **phone_number** | passenger_id → passenger |
| booking | **booking_id**, booking_date, booking_status, total_amount, amount_paid, passenger_id, created_by_user, cancel_reason, refund_amount | passenger_id → passenger; created_by_user → app_user |
| ticket | **booking_id**, **ticket_seq**, fare_class, fare_amount, checkin_status, ticket_status, flight_id, passenger_id, aircraft_id, seat_number, boarding_pass_code, replaces_seq | booking_id → booking; flight_id → flight; passenger_id → passenger; (aircraft_id, seat_number) → seat; (booking_id, replaces_seq) → ticket |
| baggage | **booking_id**, **ticket_seq**, **bag_seq**, weight_kg, bag_type, tag_number | (booking_id, ticket_seq) → ticket |
| payment | **payment_id**, payment_date, amount, payment_mode, payment_status, gateway_ref, booking_id | booking_id → booking |
| receipt | **receipt_id**, receipt_date, receipt_number, payment_id | payment_id → payment |
| app_user | **user_id**, email, password_hash, role, passenger_id, crew_id, is_active, failed_logins, locked_until, created_at | passenger_id → passenger; crew_id → crew |
| auth_rate_limit | **key**, bucket_start, attempts | — |
| outbox_event | **event_id**, aggregate, aggregate_id, event_type, payload, created_at, processed_at, attempts, last_error, next_attempt_at | — |
| kb_document | **doc_id**, title, category, body, fts | — |
| kb_chunk | **chunk_id**, doc_id, chunk_index, content, fts, embedding | doc_id → kb_document |
| feedback_embedding | **feedback_oid**, flight_id, sentiment, created_at, embedding | flight_id → flight |
| skyops_migration | **name**, checksum, applied_at | — (migration bookkeeping) |

Size of the deployed schema: 22 tables, 7 views and 1 materialized view, 53 named functions and
procedures (`fn_*`, `sp_*`), 18 triggers, 66 indexes, 12 row-level security policies.

## 7. Database choice and justification

The data has three shapes, so three engines are used. PostgreSQL is the only source of truth;
the other two are projections that can be rebuilt from it.

| Store | Holds | Why this store |
|---|---|---|
| **PostgreSQL 17** (relational) | Airports, fleet, seats, flights, fares, crew, passengers, bookings, tickets, payments, users, the outbox | The rules are relationships between rows — this seat is taken, this aircraft's next sector overlaps, this fare bucket is full — and a booking must commit or roll back with its payment. Keys, CHECKs, partial unique indexes, exclusion constraints, transactions and row-level security express exactly that. |
| **pgvector** (vector, inside PostgreSQL) | Policy-chunk and feedback embeddings | The corpus is small, retrieval must join back to documents and flights, and similarity search must obey the same grants and RLS as the rest of the SQL. A separate vector service would split that join and those permissions. |
| **MongoDB 7** (document) | Flight event history (time series), live flight status, maintenance logs, audit log, notifications, feedback | Append-heavy, irregular, nested data queried by time and flight rather than joined to payments. TTL indexes expire notifications and audit rows; a change stream drives the live board. |
| **Neo4j 5** (graph) | Airports, flights, `CONNECTS_TO` edges between connectable flights, routes, crew pairings | "BLR to LHR with at most two connections, no repeated airport" is a variable-length path. Hub ranking (PageRank, betweenness) and closure impact are graph algorithms. |

Why not one database: Postgres could store maintenance notes as `jsonb` and search connections
with a recursive CTE (the project does exactly that as its fallback). The split earns its place
because the source of truth stays strict, path analytics and change streams stay simple, and
either projection can be dropped and rebuilt (`npm run graph:reconcile`, `npm run outbox:drain`).

## 8. Data dictionary

Domains (`02_domains.sql`) used across tables:

| Domain | Rule |
|---|---|
| `d_iata_code` | `^[A-Z]{3}$` |
| `d_email` | lowercase, exactly one `@` |
| `d_phone` | 7–15 digits, optional leading `+` |
| `d_fare_class` | `Economy`, `Business`, `First` |
| `d_money` | `numeric(12,2)`, non-negative, not NaN |

Per-table descriptions with keys and constraints:
operations tables in [operations.md §2](operations.md#2-relational-schema-operations),
commercial tables in [commercial.md — Data dictionary](commercial.md#data-dictionary).
Constraints worth naming:

- `flight_aircraft_no_overlap` — `EXCLUDE USING gist (aircraft_id WITH =, ops_turnaround_range(departure_time, arrival_time) WITH &&) WHERE flight_status <> 'Cancelled'`, deferrable; the range includes the 45-minute turnaround.
- `crew_assignment` exclusion on `(crew_id, tstzrange(duty_start, duty_end))`; duty ≤ 21 h.
- `ticket_active_seat_uq` — partial unique `(flight_id, seat_number) WHERE ticket_status = 'Active'`.
- Deferred constraint triggers: `aircraft.capacity` = number of `seat` rows at COMMIT.
- `flight_delay_reason`, `flight_cancel_reason`, `flight_arrives_after_departure` CHECKs; a status state-machine trigger.
- `app_user` CHECK: a PASSENGER user has a `passenger_id`, a CREW user has a `crew_id`, and no one else does.

## 9. SQL, NoSQL and vector implementation

### PostgreSQL

| Feature | Where |
|---|---|
| DDL — CREATE | every table, domain, index, view, function, trigger and policy (`db/postgres/init/`) |
| DDL — ALTER | `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and `ALTER DEFAULT PRIVILEGES` (`90`, `91`); `booking.created_by_user` FK added after `app_user` exists (`30`); `ticket.replaces_seq` (`72`) |
| DDL — DROP | `scripts/bench-indexes.ts` drops each index inside a rolled-back transaction to time queries without it; tests drop their disposable databases |
| Transactions | `fn_book` (all legs or none, flights locked in id order), `sp_pay` (payment + receipt + outbox), delay propagation with deferred constraints, `fn_outbox_claim` |
| Views | `v_flight_load`, `v_flight_manifest`, `v_crew_roster`, `v_crew_coverage`, `v_booking_summary`, `v_passenger_age`, `v_aircraft_age`; materialized `mv_route_revenue_monthly` refreshed `CONCURRENTLY` |
| Stored functions / procedures | `70_functions_ops.sql`, `71_functions_commercial.sql`, `72_disruption_joint.sql`; all writes go through `SECURITY DEFINER` routines that re-check the caller's role |
| Triggers | status machine, fare-bucket fit, baggage allowance, receipt generation, ticket totals, outbox snapshots, IANA timezone check, deferred seat capacity |
| Indexing | B-tree (composite and FK), GIN (full text, trigram), GiST (exclusion), BRIN (payments by date), partial (outbox queue, live board, active seat), HNSW (vectors) — measured in [benchmarks.md](benchmarks.md) |
| Full-text search | generated `tsvector` columns on passengers, airports and policy chunks |
| Row-level security | passengers see only their own bookings; crew see only assigned manifests; spoofing `app.role` does not bypass it |

### MongoDB

Collections, validators, indexes and pipelines: [db/mongo/README.md](../db/mongo/README.md).
Strict `$jsonSchema` validators; a time-series collection for flight events; a 90-day TTL on
notifications and a 365-day TTL on the audit log; a change stream on `flight_status` feeds the
departures board through server-sent events. Aggregations: delay Pareto (`$group` +
`$setWindowFields`), delay histogram (`$bucket`), on-time performance (`$dateTrunc`),
maintenance summary (`$facet`, `$unwind`), feedback scorecard.

### Neo4j

Model and constraints: [db/neo4j/README.md](../db/neo4j/README.md).
`(:Airport)-[:HAS_DEPARTURE]->(:Flight)-[:CONNECTS_TO {layoverMin}]->(:Flight)`, plus `ROUTE`
between airports and `FLEW_WITH` between crew. Writes are idempotent `MERGE`s from the outbox;
stale snapshots are ignored by `updatedAt`.

### Vector search

| Question | Answer |
|---|---|
| What is embedded | Policy chunks (25 authored SkyOps documents) and passenger feedback comments |
| Model | `Xenova/all-MiniLM-L6-v2`, run locally; 384 dimensions, L2-normalized |
| Storage | `vector(384)` columns `kb_chunk.embedding` and `feedback_embedding.embedding` |
| Index and metric | HNSW, `vector_cosine_ops` (`m = 16`, `ef_construction = 64`); operator `<=>` |
| Retrieval | `fn_hybrid_kb`: top 20 by vector + top 20 by full text, reciprocal rank fusion `1/(60 + rank)`, top 5 passages with title and category; keyword-only when no embedding is available |
| Metadata | document category, chunk index; feedback flight id, sentiment, date, Mongo id |

### Outbox — keeping the stores consistent

MongoDB and Neo4j cannot join a PostgreSQL transaction, so every change writes an
`outbox_event` row in the same transaction. A dispatcher claims rows with
`FOR UPDATE SKIP LOCKED`, delivers them idempotently, and retries failures with exponential
back-off. Details: [operations.md §6](operations.md#6-transactional-outbox).

## 10. Important queries

**Aircraft exclusion constraint** — two sectors of one aircraft can never overlap, turnaround
included (SQLSTATE `23P01` on violation):

```sql
-- in CREATE TABLE flight (10_ops_schema.sql)
CONSTRAINT flight_aircraft_no_overlap EXCLUDE USING gist (
  aircraft_id WITH =,
  ops_turnaround_range(departure_time, arrival_time) WITH &&
) WHERE (flight_status <> 'Cancelled') DEFERRABLE INITIALLY IMMEDIATE
```

**Crew coverage** — `JOIN`, `GROUP BY`, `HAVING` with filtered aggregates (`v_crew_coverage`):

```sql
SELECT f.flight_id, f.flight_number, f.origin, f.destination, f.departure_time, a.capacity,
       count(*) FILTER (WHERE ca.role_on_flight = 'Captain' AND ca.standby_status = 'Assigned') AS captains,
       count(*) FILTER (WHERE ca.role_on_flight = 'First Officer' AND ca.standby_status = 'Assigned') AS first_officers,
       count(*) FILTER (WHERE ca.role_on_flight IN ('Purser','Cabin Crew') AND ca.standby_status = 'Assigned') AS cabin_crew,
       ceil(a.capacity / 50.0)::integer AS cabin_required
FROM flight f JOIN aircraft a USING (aircraft_id) LEFT JOIN crew_assignment ca USING (flight_id)
WHERE f.flight_status IN ('Scheduled','Delayed','Boarding') AND f.departure_time > now()
GROUP BY f.flight_id, a.capacity
HAVING count(*) FILTER (WHERE ca.role_on_flight = 'Captain' AND ca.standby_status = 'Assigned') < 1
    OR count(*) FILTER (WHERE ca.role_on_flight = 'First Officer' AND ca.standby_status = 'Assigned') < 1
    OR count(*) FILTER (WHERE ca.role_on_flight IN ('Purser','Cabin Crew') AND ca.standby_status = 'Assigned')
       < ceil(a.capacity / 50.0);
```

**Outbox claim** (`fn_outbox_claim`) — rows stay locked until the dispatcher's transaction ends,
so several workers never take the same event:

```sql
SELECT * FROM outbox_event
WHERE processed_at IS NULL AND next_attempt_at <= now()
ORDER BY event_id LIMIT p_limit
FOR UPDATE SKIP LOCKED;
```

**Itinerary search (Cypher, abridged from `src/lib/graph/search.ts`)** — zero to two connections,
no airport revisited; PostgreSQL then re-reads every leg for live seats and price:

```cypher
MATCH (o:Airport {code: $from})-[:HAS_DEPARTURE]->(first:Flight)
WHERE first.dep >= datetime($start) AND first.dep < datetime($end)
MATCH p = (first)-[:CONNECTS_TO*0..2]->(last:Flight)
WHERE last.destination = $to
WITH nodes(p) AS legs, [x IN nodes(p) | x.origin] + [last.destination] AS stops
WHERE all(i IN range(0, size(stops) - 2) WHERE NOT stops[i] IN stops[i + 1..])
RETURN [x IN legs | x.flightId] AS flightIds
```

The same search in SQL is a recursive CTE (`opsQueries.itinerariesFallback` in
`src/server/queries/ops.ts`), used automatically if Neo4j is down; a test checks both return the
same itineraries.

**Delay Pareto (MongoDB)** — which causes account for most delay minutes:

```js
[{ $match: { 'meta.type': 'DELAY', ts: { $gte: since(30) } } },
 { $group: { _id: '$payload.reason', events: { $sum: 1 }, minutes: { $sum: '$payload.addedMinutes' } } },
 { $sort: { minutes: -1 } },
 { $setWindowFields: { sortBy: { minutes: -1 }, output: {
     cumulativeMinutes: { $sum: '$minutes', window: { documents: ['unbounded', 'current'] } } } } }]
```

Other queries to look at: `fn_book` and `fn_dynamic_fare` (`71`), `sp_update_flight_status` with
knock-on propagation and `fn_crew_legality` (`70`), `fn_crew_chain` (recursive CTE, cycle-safe),
`fn_hybrid_kb` (vector + full-text fusion), and the passenger lookup rewritten from `OR EXISTS`
to a `UNION` so the GIN index is used (≈350× faster, [benchmarks.md](benchmarks.md)).
The `/showcase` page runs named queries live, including `EXPLAIN` output and a rolled-back
double-booking attempt.

## 11. System architecture

```mermaid
flowchart LR
  B[Browser] --> MW[Middleware<br/>Auth.js roles]
  MW --> N[Next.js 15<br/>pages + route handlers]
  N -->|parameterized SQL,<br/>SECURITY DEFINER routines| PG[(PostgreSQL 17<br/>+ pgvector)]
  PG --> OB[outbox_event]
  N -->|after write| D[Outbox dispatcher<br/>+ worker / cron]
  D --> OB
  D --> MG[(MongoDB 7<br/>replica set)]
  D --> NJ[(Neo4j 5)]
  N -->|read projections,<br/>change stream| MG
  N -->|path search,<br/>analytics| NJ
```

- The browser never holds a database credential. Connection strings come from environment
  variables, read on the server (`src/lib/env.ts`); `.env` is not committed.
- The web tier connects as `skyops_app`. That role has no direct INSERT/UPDATE/DELETE on business
  tables and cannot read password hashes or salaries.
- Authorization is checked three times: middleware by path, the route handler by session role,
  and the SQL routine by the role stored in `app_user` (with RLS underneath).
- Each read of MongoDB or Neo4j fails soft: a per-store circuit breaker keeps the PostgreSQL parts
  of a screen working and marks the rest unavailable.

## 12. Application screenshots

All screenshots are from the production build against the seeded demo data
(`docs/screenshots/`).

| | |
|---|---|
| ![Landing hero](screenshots/01-landing-hero.jpg) Landing — hero | ![Takeoff](screenshots/02-landing-takeoff.jpg) Landing — takeoff |
| ![Network](screenshots/03-landing-network.jpg) Landing — live network stats from PostgreSQL | ![Check-in](screenshots/04-landing-checkin.jpg) Landing — search hand-off |
| ![Search](screenshots/05-search.jpg) Flight search with live seats and fares | ![Board](screenshots/06-departures-board.jpg) Live departures board (Mongo change stream) |
| ![Trips](screenshots/07-passenger-trips.jpg) Passenger — My Trips | ![Trip](screenshots/08-trip-detail.jpg) Booking, boarding pass, check-in |
| ![Policies](screenshots/09-policy-assistant.jpg) Policy assistant (hybrid vector search) | ![Ops](screenshots/10-ops-console.jpg) Ops console |
| ![Schedule](screenshots/11-ops-schedule.jpg) Flight schedule | ![Flight](screenshots/12-flight-console.jpg) Flight console — delay, cancel, crew |
| ![Crew coverage](screenshots/13-crew-coverage.jpg) Crew coverage and certificates | ![Network](screenshots/14-route-network.jpg) Route network (Neo4j) |
| ![Showcase](screenshots/15-db-showcase.jpg) Database showcase | ![Crew](screenshots/16-crew-roster.jpg) Crew portal — roster |
| ![Admin](screenshots/17-admin.jpg) Admin | ![Analytics](screenshots/18-admin-analytics.jpg) Analytics — SQL, Mongo and graph |
| ![Users](screenshots/19-admin-users.jpg) Users and roles | ![Outbox](screenshots/20-outbox-monitor.jpg) Outbox monitor |

Mobile (390 px): ![Mobile login](screenshots/21-mobile-login.jpg)

## 13. Testing results

Full evidence: [testing.md](testing.md). Summary of the latest run (2026-10-30):

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | clean |
| `npm test` (PostgreSQL + Mongo integration, disposable databases) | 60 passed, 2 skipped (Neo4j cases, run below) |
| `npm run test:stores` (MongoDB + Neo4j) | 5 / 5 |
| `npm run test:e2e:ops` (browser) | 11 / 11 |
| `npm run test:e2e:commercial` (browser) | full passenger journey passes |
| Fresh-volume init of `db/postgres/init/*` | all 17 scripts apply cleanly |
| Visual crawl, 5 roles × desktop and 390 px | no console errors, no failed requests, no horizontal overflow |

Highlights: 50 concurrent attempts on one seat produce exactly one booking; an aircraft turnaround
clash and a crew duty overlap are rejected by exclusion constraints; a 150-minute delay pushes the
aircraft's next sector; cancelling a flight disrupts its tickets in one transaction and they are
rebooked on the same PNR; two dispatchers never claim the same outbox event; the Neo4j and
recursive-CTE itinerary searches return identical results; RLS hides other passengers' bookings
even when `app.role` is spoofed.

## 14. Conclusion and future enhancements

SkyOps puts airline invariants — one holder per seat, no overlapping aircraft or crew duties,
legal crews, consistent payments — into the relational database itself, where the application
cannot forget them. MongoDB and Neo4j hold the data that is better shaped as documents and as a
graph, and the transactional outbox keeps them in step: one commit in PostgreSQL, then
at-least-once, idempotent delivery. pgvector adds semantic retrieval without leaving the
database's transactions or permissions.

Future enhancements:

- Expire unpaid pending bookings so they stop holding seats.
- A real payment adapter (`payment.gateway_ref` is already the idempotency key).
- Chunk long policy documents and run `feedback:index` on a schedule.
- Advance flight statuses automatically from the clock, and push live updates to passengers.
- Deploy on managed services (PostgreSQL, MongoDB Atlas, Neo4j Aura with
  `NEO4J_GDS_ENABLED=false`) using `npm run db:migrate` instead of container init.
