// MongoDB operations collections (Aditya): validators, indexes and analytics pipelines.
// Relational ids are decimal strings (bigint-safe), matching the commercial collections.
import type { Db, Document } from 'mongodb';

const id = { bsonType: 'string', pattern: '^[0-9]+$' };
const iata = { bsonType: 'string', pattern: '^[A-Z]{3}$' };
export const FLIGHT_EVENT_TYPES = ['SCHEDULED', 'STATUS', 'DELAY', 'GATE_CHANGE', 'BOARDING', 'CANCEL', 'RETIME', 'CREW_REPORT'] as const;
export const DELAY_REASONS = ['Weather', 'ATC', 'Technical', 'Crew', 'Late inbound aircraft', 'Ground handling', 'Security', 'Other'];

export const opsValidators: Record<string, Document> = {
  // Time series: one document per operational event; meta is the bucketing key.
  flight_events: { $jsonSchema: { bsonType: 'object', required: ['ts', 'meta', 'sourceEventId', 'payload'],
    properties: {
      ts: { bsonType: 'date' },
      meta: { bsonType: 'object', required: ['flightId', 'flightNumber', 'route', 'type'],
        properties: { flightId: id, flightNumber: { bsonType: 'string', pattern: '^SK[0-9]{2,4}$' },
          route: { bsonType: 'string', pattern: '^[A-Z]{3}-[A-Z]{3}$' }, type: { enum: [...FLIGHT_EVENT_TYPES] } } },
      // outbox:<event_id>:<TYPE> for projected events, native:<uuid>:<TYPE> for crew reports
      sourceEventId: { bsonType: 'string', pattern: '^([0-9]+|native:[0-9a-f-]{36}):[A-Z_]+$' },
      actor: { bsonType: ['string', 'null'] },
      payload: { bsonType: 'object' } } } },
  // Current state per flight (one document each) - the live departures board watches this
  // collection with a change stream (time-series collections cannot be watched).
  flight_status: { $jsonSchema: { bsonType: 'object',
    required: ['_id', 'flightNumber', 'origin', 'destination', 'departureTime', 'arrivalTime', 'status', 'delayMinutes', 'updatedAt'],
    properties: { _id: id, flightNumber: { bsonType: 'string' }, origin: iata, destination: iata,
      departureTime: { bsonType: 'date' }, arrivalTime: { bsonType: 'date' }, scheduledDeparture: { bsonType: 'date' },
      status: { enum: ['Scheduled', 'Delayed', 'Boarding', 'Departed', 'Landed', 'Cancelled'] },
      delayMinutes: { bsonType: ['int', 'long', 'double'], minimum: 0, maximum: 1440 },
      delayReason: { enum: [...DELAY_REASONS, null] }, gate: { bsonType: ['string', 'null'] },
      updatedAt: { bsonType: 'date' }, sourceEventId: { bsonType: 'string' } } } },
  maintenance_logs: { $jsonSchema: { bsonType: 'object',
    required: ['aircraftId', 'registration', 'checkType', 'openedAt', 'technician', 'findings', 'components', 'aogHours'],
    properties: {
      aircraftId: id, registration: { bsonType: 'string', pattern: '^[A-Z0-9]{1,2}-[A-Z0-9]{3,5}$' },
      checkType: { enum: ['A', 'B', 'C', 'D', 'DEFECT'] },
      openedAt: { bsonType: 'date' }, closedAt: { bsonType: ['date', 'null'] },
      technician: { bsonType: 'string', minLength: 2, maxLength: 120 },
      findings: { bsonType: 'array', maxItems: 50, items: { bsonType: 'object', required: ['ata', 'description', 'severity'],
        properties: { ata: { bsonType: 'string', pattern: '^[0-9]{2}(-[0-9]{2})?$' },   // ATA iSpec 2200 chapter
          description: { bsonType: 'string', minLength: 3, maxLength: 1000 }, severity: { enum: ['minor', 'major', 'critical'] } } } },
      components: { bsonType: 'array', maxItems: 100, items: { bsonType: 'object', required: ['partNo', 'action'],
        properties: { partNo: { bsonType: 'string', maxLength: 40 }, action: { enum: ['inspected', 'repaired', 'replaced'] },
          serial: { bsonType: 'string', maxLength: 40 } } } },
      aogHours: { bsonType: ['int', 'long', 'double'], minimum: 0 },   // aircraft-on-ground time
      createdBy: { bsonType: ['string', 'null'] } } } },
  audit_log: { $jsonSchema: { bsonType: 'object', required: ['_id', 'ts', 'userId', 'role', 'action', 'entity', 'entityId'],
    properties: { _id: { bsonType: 'string', pattern: '^outbox:[0-9]+$' }, ts: { bsonType: 'date' }, userId: id,
      role: { enum: ['ADMIN', 'OPS', 'CREW', 'PASSENGER'] }, action: { bsonType: 'string', pattern: '^[A-Z_]{2,40}$' },
      entity: { bsonType: 'string' }, entityId: { bsonType: 'string' }, detail: { bsonType: ['object', 'null'] } } } },
};

/** Creates or updates a collection with its validator. Returns false when the server refused a
 *  validator (older MongoDB releases reject validators on time-series collections). */
async function ensureCollection(db: Db, name: string, options: Document): Promise<boolean> {
  const validator = opsValidators[name];
  const exists = await db.listCollections({ name }).hasNext();
  try {
    if (exists) await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    else await db.createCollection(name, { ...options, validator, validationLevel: 'strict', validationAction: 'error' });
    return true;
  } catch (error) {
    if (!options.timeseries) throw error;
    if (!exists) await db.createCollection(name, options);
    console.warn(`MongoDB refused a validator on time-series collection ${name}; the dispatcher validates its shape instead.`);
    return false;
  }
}

export async function initOpsMongo(db: Db) {
  await ensureCollection(db, 'flight_events', {
    timeseries: { timeField: 'ts', metaField: 'meta', granularity: 'minutes' },
    expireAfterSeconds: 400 * 24 * 60 * 60,
  });
  await ensureCollection(db, 'flight_status', {});
  await ensureCollection(db, 'maintenance_logs', {});
  await ensureCollection(db, 'audit_log', {});

  await db.collection('flight_events').createIndexes([
    { key: { 'meta.flightId': 1, ts: -1 } },
    { key: { 'meta.type': 1, ts: -1 } },
    { key: { 'meta.route': 1, ts: -1 } },
    { key: { sourceEventId: 1 } },                      // idempotent delivery check
  ]);
  await db.collection('flight_status').createIndexes([
    { key: { origin: 1, departureTime: 1 } }, { key: { destination: 1, arrivalTime: 1 } },
  ]);
  await db.collection('maintenance_logs').createIndexes([
    { key: { aircraftId: 1, openedAt: -1 } }, { key: { checkType: 1, openedAt: -1 } },
    { key: { closedAt: 1, aircraftId: 1 } },
  ]);
  await db.collection('audit_log').createIndexes([
    { key: { userId: 1, ts: -1 } }, { key: { role: 1, ts: -1 } }, { key: { entity: 1, entityId: 1, ts: -1 } },
    { key: { ts: 1 }, expireAfterSeconds: 365 * 24 * 60 * 60 },
  ]);
}

// ------------------------------------------------------------------ aggregation pipelines
const since = (days: number) => new Date(Date.now() - days * 86400000);

/** Delay Pareto: which causes account for most delay minutes (cumulative share via $setWindowFields). */
export const delayPareto = (days = 30): Document[] => [
  { $match: { 'meta.type': 'DELAY', ts: { $gte: since(days) } } },
  { $group: { _id: '$payload.reason', events: { $sum: 1 }, minutes: { $sum: '$payload.addedMinutes' } } },
  { $sort: { minutes: -1 } },
  { $setWindowFields: { sortBy: { minutes: -1 }, output: {
    cumulativeMinutes: { $sum: '$minutes', window: { documents: ['unbounded', 'current'] } },
    totalMinutes: { $sum: '$minutes', window: { documents: ['unbounded', 'unbounded'] } } } } },
  { $project: { _id: 0, reason: { $ifNull: ['$_id', 'Unspecified'] }, events: 1, minutes: 1,
    cumulativeShare: { $round: [{ $divide: ['$cumulativeMinutes', { $max: ['$totalMinutes', 1] }] }, 3] } } },
];

/** How long delays are: histogram with $bucket. */
export const delayDistribution = (days = 30): Document[] => [
  { $match: { 'meta.type': 'DELAY', ts: { $gte: since(days) } } },
  { $bucket: { groupBy: '$payload.toMinutes', boundaries: [0, 15, 30, 60, 120, 240, 1441], default: 'other',
    output: { flights: { $sum: 1 } } } },
];

/** On-time performance per route per month (arrival within 15 minutes of schedule). */
export const onTimePerformance = (days = 90): Document[] => [
  { $match: { 'meta.type': 'STATUS', 'payload.to': 'Landed', ts: { $gte: since(days) } } },
  { $group: { _id: { route: '$meta.route', month: { $dateTrunc: { date: '$ts', unit: 'month' } } },
    flights: { $sum: 1 }, onTime: { $sum: { $cond: [{ $lte: ['$payload.delayMinutes', 15] }, 1, 0] } },
    avgDelay: { $avg: '$payload.delayMinutes' } } },
  { $project: { _id: 0, route: '$_id.route', month: '$_id.month', flights: 1,
    onTimeRate: { $round: [{ $divide: ['$onTime', '$flights'] }, 3] }, avgDelay: { $round: ['$avgDelay', 1] } } },
  { $sort: { month: -1, onTimeRate: 1 } },
];

/** Maintenance: aircraft-on-ground hours per aircraft and the most replaced parts. */
export const maintenanceSummary: Document[] = [{ $facet: {
  aogByAircraft: [
    { $group: { _id: '$registration', aogHours: { $sum: '$aogHours' }, workOrders: { $sum: 1 },
      open: { $sum: { $cond: [{ $eq: ['$closedAt', null] }, 1, 0] } } } },
    { $sort: { aogHours: -1 } }],
  replacedParts: [
    { $unwind: '$components' }, { $match: { 'components.action': 'replaced' } },
    { $group: { _id: '$components.partNo', replacements: { $sum: 1 } } }, { $sort: { replacements: -1 } }, { $limit: 10 }],
  findingsByAta: [
    { $unwind: '$findings' },
    { $group: { _id: { $substrBytes: ['$findings.ata', 0, 2] }, count: { $sum: 1 },
      critical: { $sum: { $cond: [{ $eq: ['$findings.severity', 'critical'] }, 1, 0] } } } },
    { $sort: { count: -1 } }, { $limit: 10 }],
} }];

/** Audit: actions per role per day. */
export const auditByRoleDay = (days = 14): Document[] => [
  { $match: { ts: { $gte: since(days) } } },
  { $group: { _id: { day: { $dateTrunc: { date: '$ts', unit: 'day' } }, role: '$role' }, actions: { $sum: 1 } } },
  { $sort: { '_id.day': 1, '_id.role': 1 } },
  { $project: { _id: 0, day: '$_id.day', role: '$_id.role', actions: 1 } },
];
