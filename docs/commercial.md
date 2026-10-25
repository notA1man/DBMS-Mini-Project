# Commercial, identity and semantic implementation (Aiman)

## Scope and delivery status

The implementation plan assigns Aiman commercial data/workflows, identity/RBAC,
feedback/notifications and semantic search. Aditya owns operations, graph and
the outbox dispatcher. This document is the integration contract for those areas.

The commercial PostgreSQL foundation is implemented in `02`, `20`, the
`app_user` section of `30`, `40`, the commercial sections of `50`/`60`, `71`,
`81`, and `90`. Operations placeholders are deliberately not implemented here.
Tests use a **test-only** operations contract in
`db/postgres/tests/fixtures/ops_contract.sql`; it must never be deployed.

## Problem, objectives and functional requirements

SkyOps connects airline sales and operations. A seat must not be sold twice,
even when concurrent passengers book it. Payments, receipts, check-in and
cancellation must preserve an auditable relationship to the booking.

Commercial requirements: register/login; search flights and choose seats;
book multiple passengers/legs atomically; pay in simulated installments; issue
one receipt per successful payment; list owned trips; check in during the
48-to-1-hour window; enforce baggage limits; cancel with a simulated refund;
submit feedback; read private notifications; retrieve cited policy passages.
Administrators manage staff accounts; ops staff can find passengers and similar
complaints. External payment gateways and real airline integrations are excluded.

## Shared database contract

Operations must provide these tables **before** commercial migrations:

| Table | Required columns |
|---|---|
| `aircraft` | `aircraft_id bigint PK`, `capacity` |
| `seat` | `(aircraft_id,seat_number) PK`, `seat_class d_fare_class` |
| `flight` | `flight_id bigint PK`, `aircraft_id`, `departure_time`, `arrival_time`, `flight_status` |
| `flight_fare` | `(flight_id,fare_class) PK`, `base_fare`, `seats_allocated` |
| `crew` | `crew_id bigint PK` |
| `outbox_event` | `aggregate`, `aggregate_id` (text), `event_type`, `payload jsonb`; generated event ID and processing metadata |

`outbox_event` must exist by the first commercial payment/cancellation. Both
operations and commercial routines execute within the caller's transaction.
Keep operations additions in their reserved files/sections. Do not overwrite
the implemented commercial sections of shared files.

`fn_book(booker_passenger_id, items jsonb)` returns the six-character PNR.
Each item is `{flightId, passengerId, fareClass, seatNumber?}`. The booker is
the owner; passengers on individual tickets may differ. A maximum of 24 items
is accepted. Fare classes are `Economy`, `Business`, `First`; flight statuses
used here are `Scheduled`, `Delayed`, `Cancelled`. API callers must not accept
a user-supplied price. Locks are acquired in flight-ID order; fare-bucket capacity
and seat uniqueness are checked inside the transaction. Retry the entire
transaction on `40001` or `40P01`, with a bounded backoff.

Commercial routines publish `BOOKING_CONFIRMED` and `BOOKING_CANCELLED` with
`{bookingId,userId}` and, on cancellation, `{refundAmount,reason}`. The outbox
worker should upsert one Mongo notification keyed by `event_id`; never insert
a new notification on each delivery attempt. If outbox insertion fails, the
commercial transaction fails too. No cross-database writes occur before commit.

## Pricing, payments and integrity

Price = base fare × (1 + 0.5 × active tickets / allocated seats) × departure
factor (1.30 within 2 days, 1.15 within 7 days, otherwise 1). Values round to
two decimal places and are stored on tickets. This is a project simulation,
not a real airline pricing rule. Pending bookings reserve inventory until
cancelled; automatic hold expiry remains future work.

`sp_pay(pnr, amount, mode, reference?)` accepts positive installments up to the
balance. Modes: `Card`, `UPI`, `NetBanking`. Supply a stable reference for
retry-safe payments. Reusing it with different input fails. A trigger creates
one receipt and confirms a fully paid booking. Historical payment/receipt rows
are retained after cancellation. `refund_amount` records a simulated refund;
it does not claim that a bank transfer occurred.

Cancellation refunds 90% at least 24h before the first remaining departure,
50% at least 2h before it, otherwise 0%; disrupted bookings receive 100%.
After departure cancellation is rejected. Tickets release seats and clear
boarding codes; booking total becomes the sum of remaining active tickets (0
on full cancellation). `amount_paid` stays historical, so dashboards must use
`amount_paid - refund_amount` for net simulated receipts.

Check-in requires a confirmed booking, active flight/ticket and a seat matching
the aircraft and fare class. Cabin baggage totals at most 7kg; checked baggage
totals 20/30/40kg for Economy/Business/First, with a 32kg per-bag ceiling.

## Identity and security

The server connects as `skyops_app`, never as the migration owner. `withTx`
sets transaction-local `app.user_id`; authorization helpers derive role and
active status from `app_user`, **not** the caller-supplied `app.role` string.
Credentials for this role must remain on the server: clients with arbitrary SQL
access could forge transaction context. RLS is defense in depth for trusted
server requests, not an authentication protocol for untrusted database clients.

The app has no direct commercial INSERT/UPDATE/DELETE privileges and cannot
SELECT password hashes. Narrow SECURITY DEFINER routines use a fixed search
path; PUBLIC cannot create objects in `public` or execute application routines.
Views use `security_invoker` so RLS applies. `fn_register` creates passenger and
user atomically, normalizes email, and uses pgcrypto bcrypt at cost 12. Passwords
must be 12–72 bytes (bcrypt's input limit). `fn_authenticate` returns identity
only, persists failed attempts and locks for 15 minutes after five failures.
Session/API authorization must recheck active status against the database.

`passport_no_enc` is reserved for pgcrypto ciphertext. The current registration
flow does not collect passports. Never store a plaintext passport or encryption
key in this column. Database-owner credentials are only for migrations/tests.

## Data dictionary

| Relation | Key and purpose |
|---|---|
| passenger | identity PK; normalized unique email, name/DOB, optional encrypted passport, generated name FTS |
| passenger_phone | passenger + validated phone composite PK |
| booking | PNR PK; booker/user FK, status, active ticket total, historical paid, simulated refund |
| ticket | booking + sequence PK; flight/passenger/aircraft FKs, class/price, nullable seat, check-in/code |
| baggage | booking + ticket + bag sequence PK; weight/type and unique generated tag |
| payment | identity PK; booking FK, amount/mode/status, unique idempotency reference |
| receipt | identity PK; unique payment FK, receipt number/date |
| app_user | identity PK; unique email, bcrypt hash, role/link checks, lockout and active state |
| kb_document | identity PK; title/category/body and English FTS |
| kb_chunk | identity PK; document FK + unique chunk index, content/FTS, 384-dimensional vector |
| feedback_embedding | Mongo ObjectId text PK; flight FK, sentiment/date and vector |

Money uses non-negative `numeric(12,2)` with NaN rejected. Email is lowercase,
IATA is three uppercase letters, phones have 7–15 digits and optional `+`.
Ticket indexes enforce one active passenger and one active seat per flight.
FKs are indexed directly or through the leading columns of composite keys.

## Vector design and query showcase

Embeddings use `Xenova/all-MiniLM-L6-v2`, 384 dimensions, normalized. HNSW uses
cosine distance, m=16 and ef_construction=64. `fn_hybrid_kb(vector,query,category)`
combines the best 20 vector and 20 English FTS chunk hits using reciprocal rank
fusion `1/(60+rank)`, returning up to five passages with document attribution.
A null vector gives explicit text-only fallback; it must not be called semantic
retrieval in the UI. Policy content must be authored as SkyOps demo policy,
not represented as an actual carrier's rules.

Showcase queries: `SELECT * FROM fn_seat_map($1)`; owned
`SELECT * FROM v_booking_summary ORDER BY booking_date DESC`; passenger FTS
`name_search @@ websearch_to_tsquery('simple',$1)`; and
`SELECT * FROM fn_hybrid_kb($1::vector,$2,$3)`.

## Verification and remaining integration

`npm test -- src/server/tests/commercial.test.ts` creates a uniquely named
disposable PostgreSQL database using `DATABASE_URL_OWNER`, loads the exact
commercial SQL with the operations fixture, tests through `SET LOCAL ROLE
skyops_app`, then drops only that database. It does not reset Docker volumes.
The role must already exist (Compose initialization creates it).

Operations migrations, seed flights, graph itinerary API, flight-cancellation
integration and notification dispatch require Aditya's implementation. A
fixture test passing is not evidence of those production integrations working.
Cloud deployment, production migrations, visual review, benchmark evidence and
joint disruption E2E remain separate acceptance checks.
