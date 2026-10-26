# MongoDB (db `skyops`, replica set `rs0`)

Validators and indexes are created by code, so the same setup runs against Docker and Atlas:
`npm run db:mongo:commercial` (`db/mongo/commercial.ts`) and `npm run db:mongo:ops` (`db/mongo/ops.ts`,
which also seeds maintenance history). Every collection uses `validationLevel: strict`.

| Collection | Owner | Shape and features |
|---|---|---|
| `flight_events` | Aditya | **Time series** (`ts`, meta `{flightId, flightNumber, route, type}`), 400-day expiry. Projected from outbox `FLIGHT_UPSERT` events (SCHEDULED, DELAY, RETIME, GATE_CHANGE, BOARDING, STATUS, CANCEL) plus native CREW_REPORT entries from the crew portal. Delivery is de-duplicated on `sourceEventId`. |
| `flight_status` | Aditya | One document per flight (newest snapshot wins). The live departures board watches it with a **change stream** (time-series collections cannot be watched). |
| `maintenance_logs` | Aditya | Native documents: nested `findings` (ATA chapter, severity) and `components` (part, action), AOG hours. |
| `audit_log` | Aditya | `_id = outbox:<event_id>` (idempotent), TTL 365 days. Commercial and operations audit events. |
| `feedback` | Aiman | Ratings + comment, text index; embeddings in pgvector `feedback_embedding`. |
| `notifications` | Aiman (+ ops kinds) | Per-user inbox, TTL 90 days. Ops adds FLIGHT_CANCELLED, FLIGHT_DELAYED (≥30 min) and BOOKING_REBOOKED. |

Aggregation pipelines (`db/mongo/ops.ts`): delay Pareto (`$group` + `$setWindowFields` cumulative
share), delay distribution (`$bucket`), on-time performance per route per month (`$dateTrunc`),
maintenance summary (`$facet`, `$unwind`), audit actions per role per day.
