# MongoDB (db `skyops`, replica set `rs0`)

Collection setup lives in `scripts/init-mongo.ts` (so the same code runs against Docker and Atlas).

| Collection | Owner | Notes |
|---|---|---|
| `flight_events` | Aditya | time-series (`ts`, meta `{flightId, flightNumber, route, type}`), change stream for live board |
| `maintenance_logs` | Aditya | nested findings/components, `$jsonSchema` validator |
| `audit_log` | Aditya | TTL 365 d |
| `feedback` | Aiman | ratings + comment, text index; embeddings go to pgvector `feedback_embedding` |
| `notifications` | Aiman | per-user inbox, TTL 90 d |

`validators/` holds one `$jsonSchema` JSON file per collection.
