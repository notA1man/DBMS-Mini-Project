// Transactional-outbox dispatcher (Aditya). One pass:
//   BEGIN; claim up to N pending events (FOR UPDATE SKIP LOCKED, oldest first)
//   deliver them, grouped by consumer (Neo4j graph, Mongo projections, notifications)
//   mark delivered events processed; failed ones get attempts+1 and exponential backoff
//   COMMIT
// External writes happen before COMMIT, so a crash can redeliver an event - every consumer is
// idempotent. Rows stay locked for the whole pass, so concurrent dispatchers (worker, cron,
// after() hooks) never deliver the same event at the same time.
import type { Pool } from 'pg';
import type { Db } from 'mongodb';
import type { Driver } from 'neo4j-driver';
import { applyGraphEvents, GRAPH_EVENT_TYPES } from '@/lib/graph/sync';
import { deliverCommercialNotification, type CommercialEvent } from './commercial';
import { deliverAudit, deliverFlightEvents, deliverFlightStatus, deliverOpsNotifications, type OutboxEvent } from './ops';

export type Sinks = { pg: Pool; mongo: (() => Promise<Db>) | null; graph: Driver | null };
type Consumer = { name: string; accepts: (e: OutboxEvent) => boolean; deliver: (events: OutboxEvent[]) => Promise<void> };

function consumers(s: Sinks): Consumer[] {
  const needMongo = async () => { if (!s.mongo) throw new Error('MongoDB is not configured'); return s.mongo(); };
  return [
    { name: 'neo4j', accepts: e => GRAPH_EVENT_TYPES.has(e.event_type),
      deliver: async ev => { if (!s.graph) throw new Error('Neo4j is not configured'); await applyGraphEvents(s.graph, ev); } },
    { name: 'flight_events', accepts: e => e.event_type === 'FLIGHT_UPSERT',
      deliver: async ev => deliverFlightEvents(await needMongo(), ev) },
    { name: 'flight_status', accepts: e => e.event_type === 'FLIGHT_UPSERT',
      deliver: async ev => deliverFlightStatus(await needMongo(), ev) },
    { name: 'audit_log', accepts: e => e.event_type === 'AUDIT_LOG',
      deliver: async ev => deliverAudit(await needMongo(), ev) },
    { name: 'ops_notifications', accepts: e => ['FLIGHT_CANCELLED', 'BOOKING_REBOOKED'].includes(e.event_type)
        || (e.event_type === 'FLIGHT_UPSERT' && Boolean(e.payload.changes?.delayMinutes)),
      deliver: async ev => deliverOpsNotifications(await needMongo(), s.pg, ev) },
    { name: 'commercial_notifications', accepts: e => ['BOOKING_CONFIRMED', 'BOOKING_CANCELLED'].includes(e.event_type),
      deliver: async ev => { const db = await needMongo(); for (const e of ev) await deliverCommercialNotification(db, e as unknown as CommercialEvent); } },
  ];
}

export type DispatchResult = { claimed: number; delivered: number; failed: number; errors: Record<string, string> };

export async function dispatchOutbox(sinks: Sinks, limit = 200): Promise<DispatchResult> {
  const client = await sinks.pg.connect();
  const errors: Record<string, string> = {};
  try {
    await client.query('BEGIN');
    const events: OutboxEvent[] = (await client.query('SELECT * FROM fn_outbox_claim($1)', [limit])).rows
      .map(r => ({ ...r, event_id: String(r.event_id) }));
    const failedIds = new Map<string, string>();
    for (const consumer of consumers(sinks)) {
      const batch = events.filter(consumer.accepts);
      if (!batch.length) continue;
      try { await consumer.deliver(batch); }
      catch (error) {
        const message = `${consumer.name}: ${(error as Error).message}`.slice(0, 480);
        errors[consumer.name] = message;
        for (const e of batch) if (!failedIds.has(e.event_id)) failedIds.set(e.event_id, message);
      }
    }
    // Events no consumer wants (e.g. aircraft-only changes when the graph is disabled) still complete.
    const delivered = events.filter(e => !failedIds.has(e.event_id)).map(e => e.event_id);
    if (delivered.length) await client.query('SELECT fn_outbox_complete($1::bigint[])', [delivered]);
    for (const [id, message] of failedIds) await client.query('SELECT fn_outbox_fail($1,$2)', [id, message]);
    await client.query('COMMIT');
    return { claimed: events.length, delivered: delivered.length, failed: failedIds.size, errors };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Runs passes until nothing is left (or a pass delivers nothing, i.e. only failing events remain). */
export async function drainOutbox(sinks: Sinks, { limit = 500, maxPasses = 1000, log = (() => {}) as (r: DispatchResult) => void } = {}) {
  const total: DispatchResult = { claimed: 0, delivered: 0, failed: 0, errors: {} };
  for (let i = 0; i < maxPasses; i++) {
    const r = await dispatchOutbox(sinks, limit);
    log(r);
    total.claimed += r.claimed; total.delivered += r.delivered; total.failed += r.failed;
    Object.assign(total.errors, r.errors);
    if (r.claimed === 0 || r.delivered === 0) break;
  }
  return total;
}
