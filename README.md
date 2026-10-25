# SkyOps — Airline Operations & Ticketing Platform

DBMS Level 3 mini project. Disruption-aware airline platform built on **PostgreSQL** (relational core, pgvector), **Neo4j** (route & connection graph) and **MongoDB** (operational events, maintenance, feedback, audit), with a **Next.js** web app.

**Team:** Aiman A Nawab (PES1UG24CS038) · Aditya

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
npm run dev                 # http://localhost:3000
```
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

## Repository layout
```
db/postgres/init/   ordered SQL run on first container start (00 ext … 95 seed)
db/postgres/tests/  pgTAP tests
db/mongo/           collection validators and notes
db/neo4j/           graph constraints and Cypher queries
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
