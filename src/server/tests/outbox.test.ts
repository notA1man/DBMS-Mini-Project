// Outbox dispatcher tests (Aditya): routing, completion and failure handling against a real
// PostgreSQL outbox, with in-memory MongoDB / Neo4j stand-ins (the real stores are covered by
// stores.test.ts when they are reachable).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Driver } from 'neo4j-driver';
import { dispatchOutbox, drainOutbox } from '@/lib/outbox/dispatcher';
import { flightEventsFrom, type OutboxEvent } from '@/lib/outbox/ops';

process.loadEnvFile('.env');
const database = `skyops_outbox_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
const url = new URL(process.env.DATABASE_URL_OWNER!); url.pathname = `/${database}`;
const owner = new Pool({ connectionString: url.toString() });
const appUrl = new URL(process.env.DATABASE_URL!); appUrl.pathname = `/${database}`;
const app = new Pool({ connectionString: appUrl.toString() });   // the dispatcher runs as the app role
owner.on('error', () => {}); app.on('error', () => {});
let created = false;

/** Records every write; can be told to fail. */
function fakeMongo() {
  const writes: Record<string, unknown[]> = {};
  let fail = false;
  const collection = (name: string) => ({
    find: () => ({ toArray: async () => [] }),
    insertMany: async (docs: unknown[]) => { if (fail) throw new Error('mongo down'); (writes[name] ??= []).push(...docs); },
    bulkWrite: async (ops: unknown[]) => { if (fail) throw new Error('mongo down'); (writes[name] ??= []).push(...ops); },
    updateOne: async (...args: unknown[]) => { (writes[name] ??= []).push(args); },
  });
  return { db: { collection } as unknown as Db, writes, setFail: (v: boolean) => { fail = v; } };
}
function fakeGraph() {
  const queries: { cypher: string; params: Record<string, unknown> }[] = [];
  const driver = { executeQuery: async (cypher: string, params: Record<string, unknown> = {}) => { queries.push({ cypher, params }); return { records: [] }; } };
  return { driver: driver as unknown as Driver, queries };
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`); created = true;
  await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO skyops_app`);
  for (const file of (await readdir('db/postgres/init')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(`db/postgres/init/${file}`, 'utf8');
    if (sql.replace(/--[^\n]*/g, '').trim()) await owner.query(sql);
  }
}, 60000);
afterAll(async () => {
  await app.end(); await owner.end();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
});

describe('flight event projection', () => {
  const base: OutboxEvent = { event_id: '42', event_type: 'FLIGHT_UPSERT', aggregate: 'flight', aggregate_id: '7', created_at: '2026-10-26T06:00:00Z',
    payload: { flight: { flightId: '7', flightNumber: 'SK101', origin: 'BLR', destination: 'DEL', departureTime: '2026-10-26T08:00:00Z',
      arrivalTime: '2026-10-26T10:45:00Z', status: 'Delayed', delayMinutes: 40, delayReason: 'Weather', gate: 'B4', cancelReason: null, updatedAt: '2026-10-26T06:00:00Z' },
      changes: { delayMinutes: [0, 40], status: ['Scheduled', 'Delayed'], gate: ['A1', 'B4'] }, actorUserId: '3' } };

  test('one snapshot becomes typed time-series events with stable idempotency keys', () => {
    const docs = flightEventsFrom(base);
    expect(docs.map(d => d.meta.type)).toEqual(['DELAY', 'GATE_CHANGE', 'STATUS']);
    expect(docs[0]).toMatchObject({ sourceEventId: '42:DELAY', meta: { route: 'BLR-DEL', flightNumber: 'SK101' },
      payload: { fromMinutes: 0, toMinutes: 40, addedMinutes: 40, reason: 'Weather' }, actor: '3' });
    expect(flightEventsFrom(base).map(d => d.sourceEventId)).toEqual(docs.map(d => d.sourceEventId));
  });

  test('boarding and cancellation get their own event types; a reduced delay is a retime', () => {
    const boarding = flightEventsFrom({ ...base, payload: { ...base.payload, changes: { status: ['Delayed', 'Boarding'] } } });
    expect(boarding.map(d => d.meta.type)).toEqual(['BOARDING']);
    const retime = flightEventsFrom({ ...base, payload: { ...base.payload, changes: { delayMinutes: [40, 10] } } });
    expect(retime[0]).toMatchObject({ meta: { type: 'RETIME' }, payload: { fromMinutes: 40, toMinutes: 10 } });
  });

  test('moving to Delayed with a delay recorded at creation still yields one DELAY', () => {
    const late = flightEventsFrom({ ...base, payload: { ...base.payload, changes: { status: ['Scheduled', 'Delayed'] } } });
    expect(late.map(d => d.meta.type)).toEqual(['DELAY', 'STATUS']);
    expect(late[0]).toMatchObject({ payload: { fromMinutes: 0, addedMinutes: 40, reason: 'Weather' } });
  });
});

describe('dispatcher', () => {
  test('routes each event type to its consumers and marks delivered events processed', async () => {
    const mongo = fakeMongo(), graph = fakeGraph();
    // The reference seed already queued AIRPORT_UPSERT + AIRCRAFT_UPSERT events.
    const r = await dispatchOutbox({ pg: app, mongo: async () => mongo.db, graph: graph.driver }, 500);
    expect(r.claimed).toBeGreaterThan(50);
    expect(r.failed).toBe(0);
    expect(graph.queries.some(q => q.cypher.includes('MERGE (a:Airport'))).toBe(true);
    expect(graph.queries.some(q => q.cypher.includes('MERGE (x:Aircraft'))).toBe(true);
    const pending = (await owner.query('SELECT count(*)::int AS n FROM outbox_event WHERE processed_at IS NULL')).rows[0].n;
    expect(pending).toBe(0);
  });

  test('a failing consumer only fails its own events, which back off and are retried later', async () => {
    const mongo = fakeMongo(), graph = fakeGraph();
    await owner.query(`INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload) VALUES
      ('operations','1','AUDIT_LOG','{"ts":"2026-10-26T06:00:00Z","userId":"1","role":"OPS","action":"TEST","entity":"flight","entityId":"1"}'),
      ('airport','ZZZ','AIRPORT_UPSERT','{"code":"BLR","name":"x","city":"y","country":"IN","timezone":"Asia/Kolkata","lat":1,"lon":1,"updatedAt":"2026-10-26T06:00:00Z"}')`);
    mongo.setFail(true);
    const r = await dispatchOutbox({ pg: app, mongo: async () => mongo.db, graph: graph.driver }, 50);
    expect(r).toMatchObject({ claimed: 2, delivered: 1, failed: 1 });
    expect(r.errors.audit_log).toMatch(/mongo down/);
    const failed = (await owner.query("SELECT attempts, last_error, next_attempt_at > now() AS later FROM outbox_event WHERE event_type='AUDIT_LOG'")).rows[0];
    expect(failed).toMatchObject({ attempts: 1, later: true });
    // Not due yet: the next pass leaves it alone.
    expect((await dispatchOutbox({ pg: app, mongo: async () => mongo.db, graph: graph.driver }, 50)).claimed).toBe(0);
    await owner.query("UPDATE outbox_event SET next_attempt_at = now() WHERE event_type='AUDIT_LOG'");
    mongo.setFail(false);
    const total = await drainOutbox({ pg: app, mongo: async () => mongo.db, graph: graph.driver });
    expect(total).toMatchObject({ delivered: 1, failed: 0 });
    expect(mongo.writes.audit_log).toHaveLength(1);
  });

  test('without Neo4j configured, graph events stay pending instead of being lost', async () => {
    await owner.query(`INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
      VALUES ('aircraft','1','AIRCRAFT_UPSERT','{"aircraftId":"1","updatedAt":"2026-10-26T06:00:00Z"}')`);
    const r = await dispatchOutbox({ pg: app, mongo: null, graph: null }, 10);
    expect(r).toMatchObject({ claimed: 1, delivered: 0, failed: 1 });
    expect(r.errors.neo4j).toMatch(/not configured/);
  });
});
