// MongoDB consumers for operations outbox events (Aditya). All writes are idempotent:
//   flight_events   time series; a delivery check on sourceEventId (time-series collections
//                   cannot have unique indexes) - safe because only one dispatcher holds an
//                   event's row lock at a time.
//   flight_status   one document per flight, replaced only by a snapshot at least as new.
//   audit_log       _id = outbox:<event_id>, $setOnInsert.
//   notifications   _id = outbox:<event_id>:<booking>, $setOnInsert (preserves read state/TTL).
import type { AnyBulkWriteOperation, Db, Document } from 'mongodb';
import type { Pool } from 'pg';

export type OutboxEvent = { event_id: string; event_type: string; aggregate: string; aggregate_id: string;
  payload: Record<string, any>; created_at: Date | string };   // eslint-disable-line @typescript-eslint/no-explicit-any

type FlightSnapshot = { flightId: string; flightNumber: string; origin: string; destination: string; departureTime: string;
  arrivalTime: string; status: string; delayMinutes: number; delayReason: string | null; gate: string | null;
  cancelReason: string | null; updatedAt: string };

/** One FLIGHT_UPSERT can describe several operational events (e.g. a delay and a status change). */
export function flightEventsFrom(event: OutboxEvent): Document[] {
  const f = event.payload.flight as FlightSnapshot;
  const changes = (event.payload.changes ?? {}) as Record<string, unknown[]>;
  const ts = new Date(event.created_at);
  const meta = (type: string) => ({ flightId: f.flightId, flightNumber: f.flightNumber, route: `${f.origin}-${f.destination}`, type });
  const doc = (type: string, payload: Document) => ({
    ts, meta: meta(type), sourceEventId: `${event.event_id}:${type}`, actor: event.payload.actorUserId ?? null,
    payload: { ...payload, delayMinutes: f.delayMinutes } });
  const docs: Document[] = [];
  if (event.payload.created) docs.push(doc('SCHEDULED', { departureTime: new Date(f.departureTime), arrivalTime: new Date(f.arrivalTime) }));
  if (changes.delayMinutes) {
    const [from, to] = changes.delayMinutes as number[];
    if (to > from) docs.push(doc('DELAY', { fromMinutes: from, toMinutes: to, addedMinutes: to - from, reason: f.delayReason ?? 'Other' }));
    else docs.push(doc('RETIME', { fromMinutes: from, toMinutes: to }));
  }
  if (changes.gate) docs.push(doc('GATE_CHANGE', { from: changes.gate[0], to: changes.gate[1] }));
  if (changes.status) {
    const [from, to] = changes.status as string[];
    const type = to === 'Boarding' ? 'BOARDING' : to === 'Cancelled' ? 'CANCEL' : 'STATUS';
    docs.push(doc(type, { from, to, ...(to === 'Cancelled' ? { reason: f.cancelReason } : {}) }));
  }
  return docs;
}

export async function deliverFlightEvents(db: Db, events: OutboxEvent[]) {
  const docs = events.filter(e => e.event_type === 'FLIGHT_UPSERT').flatMap(flightEventsFrom);
  if (!docs.length) return;
  const collection = db.collection('flight_events');
  const seen = new Set((await collection.find({ sourceEventId: { $in: docs.map(d => d.sourceEventId) } },
    { projection: { sourceEventId: 1 } }).toArray()).map(d => d.sourceEventId));
  const fresh = docs.filter(d => !seen.has(d.sourceEventId));
  if (fresh.length) await collection.insertMany(fresh, { ordered: false });
}

export async function deliverFlightStatus(db: Db, events: OutboxEvent[]) {
  const ops: AnyBulkWriteOperation<Document>[] = events.filter(e => e.event_type === 'FLIGHT_UPSERT').map(e => {
    const f = e.payload.flight as FlightSnapshot;
    const updatedAt = new Date(f.updatedAt);
    return { replaceOne: {
      // Matches only an older (or equal) snapshot; a newer stored one makes the upsert collide on
      // _id, which is reported as a duplicate and ignored below.
      filter: { _id: f.flightId as unknown as Document['_id'], updatedAt: { $lte: updatedAt } },
      replacement: { flightNumber: f.flightNumber, origin: f.origin, destination: f.destination,
        departureTime: new Date(f.departureTime), arrivalTime: new Date(f.arrivalTime),
        scheduledDeparture: new Date(new Date(f.departureTime).getTime() - f.delayMinutes * 60000),
        status: f.status, delayMinutes: f.delayMinutes, delayReason: f.delayReason ?? null, gate: f.gate ?? null,
        updatedAt, sourceEventId: String(e.event_id) },
      upsert: true } };
  });
  if (!ops.length) return;
  try {
    await db.collection('flight_status').bulkWrite(ops, { ordered: true });
  } catch (error) {
    const e = error as { code?: number; writeErrors?: { code: number }[] };
    const errors = e.writeErrors ?? (e.code !== undefined ? [{ code: e.code }] : []);
    if (!errors.length || errors.some(w => w.code !== 11000)) throw error;
    // Only stale snapshots collided; retry the remaining operations one by one.
    for (const op of ops) {
      try { await db.collection('flight_status').bulkWrite([op]); }
      catch (inner) { if ((inner as { code?: number }).code !== 11000) throw inner; }
    }
  }
}

export async function deliverAudit(db: Db, events: OutboxEvent[]) {
  const ops = events.filter(e => e.event_type === 'AUDIT_LOG').map(e => {
    const p = e.payload;
    return { updateOne: { filter: { _id: `outbox:${e.event_id}` }, upsert: true, update: { $setOnInsert: {
      ts: new Date(p.ts), userId: String(p.userId), role: p.role, action: p.action, entity: p.entity,
      entityId: String(p.entityId), detail: p.detail ?? null } } } };
  });
  if (ops.length) await db.collection<{ _id: string }>('audit_log').bulkWrite(ops as AnyBulkWriteOperation<{ _id: string }>[], { ordered: false });
}

const NOTIFY_DELAY_MINUTES = 30;
type Notice = { _id: string; userId: string; kind: string; title: string; body: string; link: string; read: boolean; createdAt: Date };

/** Passenger notifications for operational disruption (cancellation, significant delay, re-booking). */
export async function deliverOpsNotifications(db: Db, pg: Pool, events: OutboxEvent[]) {
  const notices: Notice[] = [];
  for (const e of events) {
    const createdAt = new Date(e.created_at);
    if (e.event_type === 'FLIGHT_CANCELLED') {
      for (const b of (e.payload.bookings ?? []) as { bookingId: string; userId: string }[]) {
        notices.push({ _id: `outbox:${e.event_id}:${b.bookingId}`, userId: String(b.userId), kind: 'FLIGHT_CANCELLED',
          title: `Flight ${e.payload.flightNumber} cancelled`,
          body: `${e.payload.flightNumber} ${e.payload.origin}→${e.payload.destination} was cancelled (${e.payload.reason}). `
            + `Our operations team will re-book you; you can also cancel booking ${b.bookingId} for a full simulated refund.`,
          link: `/trips/${b.bookingId}`, read: false, createdAt });
      }
    } else if (e.event_type === 'FLIGHT_UPSERT' && e.payload.changes?.delayMinutes) {
      const [from, to] = e.payload.changes.delayMinutes as number[];
      if (to - from < NOTIFY_DELAY_MINUTES || e.payload.flight.departureTime < new Date().toISOString()) continue;
      const f = e.payload.flight as FlightSnapshot;
      const bookers = (await pg.query('SELECT booking_id, user_id FROM fn_flight_bookers($1)', [f.flightId])).rows;
      for (const b of bookers) {
        notices.push({ _id: `outbox:${e.event_id}:${b.booking_id}`, userId: String(b.user_id), kind: 'FLIGHT_DELAYED',
          title: `Flight ${f.flightNumber} delayed by ${to} min`,
          body: `${f.flightNumber} ${f.origin}→${f.destination} now departs ${new Date(f.departureTime).toLocaleString('en-IN',
            { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })} IST (${f.delayReason ?? 'operational reasons'}).`,
          link: `/trips/${b.booking_id}`, read: false, createdAt });
      }
    } else if (e.event_type === 'BOOKING_REBOOKED') {
      notices.push({ _id: `outbox:${e.event_id}`, userId: String(e.payload.userId), kind: 'BOOKING_REBOOKED',
        title: `Booking ${e.payload.bookingId} re-booked`,
        body: `You have been moved to ${(e.payload.flights as string[]).join(' + ')} at no extra cost. Check in again from My Trips.`,
        link: `/trips/${e.payload.bookingId}`, read: false, createdAt });
    }
  }
  if (!notices.length) return;
  await db.collection<Notice>('notifications').bulkWrite(notices.map(({ _id, ...doc }) => ({
    updateOne: { filter: { _id }, update: { $setOnInsert: doc }, upsert: true } })), { ordered: false });
}

/** Native Mongo write for a maintenance work order (validated by the collection's $jsonSchema). */
export type MaintenanceLog = { aircraftId: string; registration: string; checkType: 'A' | 'B' | 'C' | 'D' | 'DEFECT';
  openedAt: Date; closedAt: Date | null; technician: string; aogHours: number; createdBy: string | null;
  findings: { ata: string; description: string; severity: 'minor' | 'major' | 'critical' }[];
  components: { partNo: string; action: 'inspected' | 'repaired' | 'replaced'; serial?: string }[] };
