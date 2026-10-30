// MongoDB + Neo4j integration tests (Aditya). They need the Docker services (npm run db:up) and
// skip themselves when a store is unreachable, so `npm test` still works with PostgreSQL alone.
// Neo4j Community has a single database, so the graph tests replace its contents: they only run
// via `npm run test:stores` (vitest --mode stores), which rebuilds the real graph afterwards.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool } from 'pg';
import { MongoClient, type Db } from 'mongodb';
import neo4j, { type Driver } from 'neo4j-driver';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { initOpsMongo, delayPareto } from '../../../db/mongo/ops';
import { deliverAudit, deliverFlightEvents, deliverFlightStatus, type OutboxEvent } from '@/lib/outbox/ops';
import { reconcileGraph } from '@/lib/graph/reconcile';
import { graphItineraries } from '@/lib/graph/search';
import { applyGraphEvents } from '@/lib/graph/sync';
import { opsQueries } from '@/server/queries/ops';

process.loadEnvFile('.env');
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);

async function reachable(fn: () => Promise<unknown>) { try { await fn(); return true; } catch { return false; } }
const mongoClient = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:1', { serverSelectionTimeoutMS: 3000 });
const driver: Driver = neo4j.driver(process.env.NEO4J_URI ?? 'bolt://127.0.0.1:1',
  neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD ?? 'x'),
  { disableLosslessIntegers: true, connectionTimeout: 3000, maxTransactionRetryTime: 2000 });
const hasMongo = await reachable(() => mongoClient.connect());
const mode = (import.meta as unknown as { env?: { MODE?: string } }).env?.MODE;   // vitest --mode stores
const hasNeo4j = mode === 'stores' && await reachable(() => driver.getServerInfo());

afterAll(async () => { await mongoClient.close().catch(() => {}); await driver.close(); });

const flightEvent = (id: string, updatedAt: string, status: string, changes: Record<string, unknown>): OutboxEvent => ({
  event_id: id, event_type: 'FLIGHT_UPSERT', aggregate: 'flight', aggregate_id: '9', created_at: updatedAt,
  payload: { flight: { flightId: '9', flightNumber: 'SK109', origin: 'BLR', destination: 'GOI', departureTime: '2026-11-02T03:00:00Z',
    arrivalTime: '2026-11-02T04:15:00Z', status, delayMinutes: status === 'Delayed' ? 30 : 0, delayReason: status === 'Delayed' ? 'ATC' : null,
    gate: 'A3', cancelReason: null, updatedAt }, changes } });

describe.skipIf(!hasMongo)('MongoDB operations collections', () => {
  let db: Db;
  beforeAll(async () => { db = mongoClient.db(`skyops_ops_test_${suffix}`); await initOpsMongo(db); });
  afterAll(async () => { await db?.dropDatabase(); });

  test('strict validators reject malformed documents', async () => {
    await expect(db.collection('maintenance_logs').insertOne({ aircraftId: '1', registration: 'VT-SKA', checkType: 'Z' })).rejects.toThrow();
    await expect(db.collection('audit_log').insertOne({ _id: 'bad' as never, ts: new Date() })).rejects.toThrow();
  });

  test('flight events and audit entries are delivered exactly once despite redelivery', async () => {
    const e = flightEvent('1001', '2026-10-30T10:00:00Z', 'Delayed', { delayMinutes: [0, 30], status: ['Scheduled', 'Delayed'] });
    await deliverFlightEvents(db, [e]); await deliverFlightEvents(db, [e]);
    expect(await db.collection('flight_events').countDocuments({ 'meta.flightId': '9' })).toBe(2);
    const audit: OutboxEvent = { event_id: '1002', event_type: 'AUDIT_LOG', aggregate: 'operations', aggregate_id: '9', created_at: new Date(),
      payload: { ts: new Date().toISOString(), userId: '1', role: 'OPS', action: 'TEST', entity: 'flight', entityId: '9' } };
    await deliverAudit(db, [audit]); await deliverAudit(db, [audit]);
    expect(await db.collection('audit_log').countDocuments()).toBe(1);
    const pareto = await db.collection('flight_events').aggregate(delayPareto(3650)).toArray();
    expect(pareto[0]).toMatchObject({ reason: 'ATC', minutes: 30, cumulativeShare: 1 });
  });

  test('flight status keeps the newest snapshot even when an older one arrives later', async () => {
    const newer = flightEvent('2001', '2026-10-30T12:00:00Z', 'Boarding', { status: ['Delayed', 'Boarding'] });
    const older = flightEvent('2000', '2026-10-30T11:00:00Z', 'Delayed', { status: ['Scheduled', 'Delayed'] });
    await deliverFlightStatus(db, [newer]);
    await deliverFlightStatus(db, [older]);
    expect((await db.collection('flight_status').findOne({ _id: '9' as never }))?.status).toBe('Boarding');
  });
});

describe.skipIf(!hasNeo4j)('Neo4j graph', () => {
  const database = `skyops_graph_test_${suffix}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
  const url = new URL(process.env.DATABASE_URL_OWNER!); url.pathname = `/${database}`;
  const owner = new Pool({ connectionString: url.toString() });
  owner.on('error', () => {});
  let day = '';

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE "${database}"`);
    for (const file of (await readdir('db/postgres/init')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = await readFile(`db/postgres/init/${file}`, 'utf8');
      if (sql.replace(/--[^\n]*/g, '').trim()) await owner.query(sql);
    }
    // A small, known network two days out (IST): BLR-DEL-SXR, BLR-BOM-DEL, BLR-GAU direct, DEL-GAU.
    day = new Date(Date.now() + 2 * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10);
    const ac = (await owner.query("SELECT aircraft_id FROM aircraft WHERE type_rating='A20N' ORDER BY aircraft_id LIMIT 6")).rows.map(r => r.aircraft_id);
    const fl = (n: string, a: number, o: string, d: string, dep: string, arr: string) => owner.query(
      "SELECT ops_schedule_flight($1,$2,$3,$4,($5::date + $6::time) AT TIME ZONE 'Asia/Kolkata',($5::date + $7::time) AT TIME ZONE 'Asia/Kolkata',NULL,$8::jsonb)",
      [n, ac[a], o, d, day, dep, arr, JSON.stringify({ Economy: 4000, Business: 12000 })]);
    await fl('SK801', 0, 'BLR', 'DEL', '07:00', '09:45');
    await fl('SK802', 1, 'DEL', 'SXR', '11:00', '12:30');
    await fl('SK803', 2, 'BLR', 'BOM', '05:00', '06:45');
    await fl('SK804', 3, 'BOM', 'DEL', '08:00', '10:10');   // 75 min layover in BOM, 50 in DEL
    await fl('SK805', 4, 'DEL', 'GAU', '13:00', '15:30');
    await fl('SK806', 5, 'BLR', 'GAU', '08:00', '10:55');
    await fl('SK807', 1, 'SXR', 'DEL', '13:30', '15:00');   // loops back: must never extend BLR-DEL-SXR
    await reconcileGraph(owner, driver, { daysBack: 1, daysAhead: 5 });
  }, 120000);
  afterAll(async () => {
    await driver.executeQuery('MATCH (n) DETACH DELETE n');
    await owner.end(); await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`); await admin.end();
  });

  const window = async (from: string) => {
    const w = (await owner.query(opsQueries.dayWindow, [from, day])).rows[0];
    return { start: w.start.toISOString(), end: w.end.toISOString() };
  };
  const numbers = async (ids: string[][]) => {
    const all = (await owner.query('SELECT flight_id::text AS id, flight_number FROM flight')).rows;
    const by = new Map(all.map(r => [r.id, r.flight_number]));
    return ids.map(p => p.map(id => by.get(String(id))).join('>')).sort();
  };

  test('graph traversal and the recursive-CTE fallback return exactly the same itineraries', async () => {
    for (const [from, to] of [['BLR', 'SXR'], ['BLR', 'GAU'], ['BLR', 'DEL'], ['BOM', 'SXR']]) {
      const w = await window(from);
      const graph = await graphItineraries(driver, { from, to, ...w });
      const sql = (await owner.query(opsQueries.itinerariesFallback, [from, to, w.start, w.end, null])).rows;
      expect(await numbers(graph.map(g => g.flightIds)), `${from}-${to}`).toEqual(await numbers(sql.map(s => s.flightIds)));
    }
    const w = await window('BLR');
    expect(await numbers((await graphItineraries(driver, { from: 'BLR', to: 'SXR', ...w })).map(g => g.flightIds)))
      .toEqual(['SK801>SK802', 'SK803>SK804>SK802']);
  });

  test('cancelling a flight removes its connections on the next sync', async () => {
    const id = (await owner.query("SELECT flight_id FROM flight WHERE flight_number='SK802'")).rows[0].flight_id;
    await owner.query("UPDATE flight SET flight_status='Cancelled', cancel_reason='test' WHERE flight_id=$1", [id]);
    const event = (await owner.query("SELECT event_id::text, event_type, payload FROM outbox_event WHERE aggregate='flight' AND aggregate_id=$1 AND event_type='FLIGHT_UPSERT' ORDER BY outbox_event.event_id DESC LIMIT 1", [String(id)])).rows[0];
    await applyGraphEvents(driver, [event]);
    const w = await window('BLR');
    expect(await graphItineraries(driver, { from: 'BLR', to: 'SXR', ...w })).toEqual([]);
  });
});
