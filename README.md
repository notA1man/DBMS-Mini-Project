# SkyOps — Airline Operations & Ticketing Platform

DBMS Level 3 mini project. Disruption-aware airline platform built on **PostgreSQL** (relational core, pgvector), **Neo4j** (route & connection graph) and **MongoDB** (operational events, maintenance, feedback, audit), with a **Next.js** web app.

**Team:** Aiman A Nawab (PES1UG24CS038) · Aditya

## Current implementation

Both halves are implemented and integrated:

- **Commercial (Aiman)** — identity/RBAC, search, booking, payments, check-in and boarding passes,
  baggage, feedback and notifications, local policy retrieval, query showcase.
  See [commercial.md](docs/commercial.md).
- **Operations (Aditya)** — airports, fleet and seat maps, scheduling with no-overlap exclusion
  constraints, crew legality and rostering, delay knock-on propagation, cancellation and joint
  rebooking, the transactional outbox feeding MongoDB and Neo4j, connecting-flight search, live
  departures board, ops/crew/admin screens and the landing page.
  See [operations.md](docs/operations.md), the [ER diagram](docs/diagrams/er.svg) and the
  [index benchmark](docs/benchmarks.md).

Test results: [testing.md](docs/testing.md).

## Stack
| Layer | Tech |
|---|---|
| Web / API | Next.js 15 (App Router, Route Handlers), TypeScript, Tailwind |
| Relational | PostgreSQL 17 + pgvector, btree_gist, pg_trgm, pgcrypto |
| Graph | Neo4j 5 (APOC, GDS) |
| Document | MongoDB 7 (replica set: transactions, change streams, time-series) |
| Embeddings | `Xenova/all-MiniLM-L6-v2` (local, free) |

## Prerequisites
- Node.js 22+
- Docker Desktop

## Getting started
```bash
git clone <repo-url> && cd DBMS-Mini-Project
cp .env.example .env        # then change the passwords
npm install
npm run db:up               # Postgres, Mongo, Neo4j (first start runs db/postgres/init/*)
npm run db:seed:ops         # crew, flights, rosters (set SEED_STAFF_PASSWORD for staff logins)
npm run db:mongo:commercial && npm run db:mongo:ops
npm run db:seed:commercial  # policies + local embeddings
npm run outbox:drain        # project everything into MongoDB and Neo4j
npm run dev                 # http://localhost:3000  (run `npm run worker` alongside)
```
**Existing volumes from before the operations schema landed:** run `npm run db:reset` once
(it wipes the volumes) — the init scripts only run on an empty volume.
Health check of all three databases: http://localhost:3000/api/health
Neo4j Browser: http://localhost:7474

Optional local LLM for the policy assistant:
```bash
docker compose --profile ai up -d
docker compose exec ollama ollama pull llama3.2:3b
```

| Script | What it does |
|---|---|
| `npm run db:up` / `db:down` | start / stop the databases |
| `npm run db:reset` | **wipes** volumes and re-runs all init scripts |
| `npm run typecheck`, `npm run lint`, `npm test` | checks |
| `npm run db:migrate` | checksum-tracked SQL migrations for a database not created by Compose init |
| `npm run db:mongo:commercial` | feedback/notification validators and indexes |
| `npm run db:seed:commercial` | 25 demo policies with local embeddings; optional admin bootstrap |
| `npm run db:seed:demo` | optional demo passengers/bookings/payments (`SEED_DEMO_PASSWORD` required) |
| `npm run feedback:index` | retryable Mongo feedback → pgvector indexing |
| `npm run test:e2e:commercial` | production-build browser journey in disposable databases |
| `npm run db:seed:ops` | crew, 5 weeks of flights, legality-checked rosters, optional staff logins |
| `npm run db:mongo:ops` | ops collections (time series, validators, TTL) + maintenance history |
| `npm run db:seed:traffic` | optional synthetic bookings for realistic loads (`DEMO_LOAD`) |
| `npm run outbox:drain` / `npm run worker` | deliver outbox events once / continuously |
| `npm run graph:reconcile` | rebuild the Neo4j graph from PostgreSQL |
| `npm run test:stores` | MongoDB + Neo4j integration tests (replaces graph contents, then rebuilds) |
| `npm run test:e2e:ops` | ops/crew/admin browser journey in a disposable database |
| `npm run bench:indexes` | EXPLAIN ANALYZE with vs without each key index → `docs/benchmarks.md` |

Before browser tests, run `npx playwright install chromium` and `npm run build`.
Tests require the Compose PostgreSQL/Mongo services and `.env` connection strings;
they do not use or clear production tables. The browser test also downloads/caches
the local embedding model on its first run. Set a random `AUTH_SECRET` before
running the development app; tests provide a temporary secret automatically.

## Repository layout
```
db/postgres/init/   ordered SQL run on first container start (00 ext … 95 seed)
db/postgres/tests/  test fixtures (tests are Vitest: src/server/tests)
db/mongo/           collection validators, indexes, aggregation pipelines
db/neo4j/           graph model and constraints (code in src/lib/graph)
scripts/            seeding, outbox worker, graph reconcile
src/app/            Next.js routes (UI + /api)
src/lib/db/         PostgreSQL / MongoDB / Neo4j clients
src/server/queries/ named, parameterized SQL
docs/               report, ER diagram, schema, testing results
```

## Conventions
- Branches: `feat/<name>-<topic>`, merged via PR reviewed by the other member.
- Commits: `feat(db): …`, `feat(ui): …`, `fix(api): …`, `docs: …`.
- Never commit `.env`; all credentials come from environment variables.
