// Operations API (Aditya). Same conventions as /api/commercial: every handler authorizes via
// asIdentity (role re-read from app_user), validates with zod, runs SQL through the routines in
// db/postgres/init/70-72, and maps database errors with apiError. Mutations nudge the outbox
// dispatcher (kickOutbox) so MongoDB and Neo4j catch up right after the response.
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { asIdentity, apiError, checkOrigin, HttpError } from '@/server/access';
import { opsQueries } from '@/server/queries/ops';
import { kickOutbox, runOutbox } from '@/server/outbox';
import { findItineraries } from '@/server/itineraries';
import { mongoDb } from '@/lib/db/mongo';
import { neo4jDriver } from '@/lib/db/neo4j';
import { auditByRoleDay, delayDistribution, delayPareto, maintenanceSummary, onTimePerformance } from '../../../../../db/mongo/ops';
import { crewPairs, hubRanking, impactRadius, shortestRoute, unreachablePairs } from '@/lib/graph/analytics';
import type { Document } from 'mongodb';

const STAFF = ['ADMIN', 'OPS'];
const id = z.string().regex(/^[1-9][0-9]{0,17}$/);
const iata = z.string().regex(/^[A-Z]{3}$/);
const role = z.enum(['Captain', 'First Officer', 'Purser', 'Cabin Crew']);
const fareClass = z.enum(['Economy', 'Business', 'First']);
const delayReason = z.enum(['Weather', 'ATC', 'Technical', 'Crew', 'Late inbound aircraft', 'Ground handling', 'Security', 'Other']);
const layout = z.object({
  cabins: z.array(z.object({ class: fareClass, fromRow: z.number().int().min(1).max(99), toRow: z.number().int().min(1).max(99),
    letters: z.string().regex(/^[A-K]+( [A-K]+){0,3}$/) })).min(1).max(4),
  exitRows: z.array(z.number().int().min(1).max(99)).max(6).default([]),
});
type Context = { params: Promise<{ action: string }> };

/** Best-effort read against MongoDB or Neo4j: the page still renders if one store is down, and
 *  after a failure that store is skipped for a minute instead of paying its timeout every time. */
const downUntil: Record<string, number> = {};
async function optional<T>(fn: () => Promise<T>, store: 'mongo' | 'graph' = 'mongo'): Promise<{ data: T | null; error: string | null }> {
  if (Date.now() < (downUntil[store] ?? 0)) return { data: null, error: `${store === 'mongo' ? 'MongoDB' : 'Neo4j'} unreachable (retrying shortly)` };
  try { return { data: await fn(), error: null }; }
  catch (error) {
    const message = (error as Error).message;
    if (/ECONNREFUSED|ENOTFOUND|timed out|Server selection|ServiceUnavailable|Could not perform discovery|connect/i.test(message)) downUntil[store] = Date.now() + 60_000;
    return { data: null, error: message.slice(0, 200) };
  }
}
const aggregate = (pipeline: Document[], collection: string) => optional(async () =>
  (await mongoDb()).collection(collection).aggregate(pipeline).toArray());

export async function GET(request: Request, context: Context) {
  try {
    const { action } = await context.params;
    const q = new URL(request.url).searchParams;
    const param = (name: string) => q.get(name) ?? undefined;

    switch (action) {
      case 'overview': return Response.json(await asIdentity(STAFF, async c => ({
        overview: (await c.query('SELECT fn_ops_overview() AS o')).rows[0].o,
        coverage: (await c.query(opsQueries.coverage, [48])).rows,
        departures: (await c.query(opsQueries.schedule, [new Date(Date.now() - 2 * 3600e3), new Date(Date.now() + 12 * 3600e3), null, null])).rows,
      })));

      case 'schedule': {
        const d = z.object({ from: z.iso.date(), days: z.coerce.number().int().min(1).max(14).default(1),
          airport: iata.optional(), status: z.enum(['Scheduled', 'Delayed', 'Boarding', 'Departed', 'Landed', 'Cancelled']).optional() })
          .parse({ from: param('from'), days: param('days'), airport: param('airport'), status: param('status') });
        const start = new Date(`${d.from}T00:00:00+05:30`), end = new Date(start.getTime() + d.days * 86400e3);
        return Response.json(await asIdentity(STAFF, async c => ({
          flights: (await c.query(opsQueries.schedule, [start, end, d.airport ?? null, d.status ?? null])).rows,
          fleet: (await c.query("SELECT aircraft_id::text AS \"aircraftId\", registration, type_rating AS \"typeRating\" FROM aircraft WHERE status='Active' ORDER BY registration")).rows,
        })));
      }

      case 'flight': {
        const flightId = id.parse(param('id'));
        const data = await asIdentity(STAFF, async c => {
          const flight = (await c.query(opsQueries.flight, [flightId])).rows[0];
          if (!flight) throw new HttpError(404, 'Flight not found.');
          return { flight, crew: (await c.query(opsQueries.flightCrew, [flightId])).rows,
            load: (await c.query(opsQueries.flightLoad, [flightId])).rows,
            manifest: (await c.query(opsQueries.manifest, [flightId])).rows };
        });
        const events = await optional(async () => (await mongoDb()).collection('flight_events')
          .find({ 'meta.flightId': flightId }).sort({ ts: -1 }).limit(40).toArray());
        return Response.json({ ...data, events: events.data ?? [], eventsError: events.error });
      }

      case 'candidates': {
        const d = z.object({ flight: id, role }).parse({ flight: param('flight'), role: param('role') });
        return Response.json(await asIdentity(STAFF, async c => ({ candidates: (await c.query(opsQueries.crewCandidates, [d.flight, d.role, 25])).rows })));
      }

      case 'legality': {
        const d = z.object({ crew: id, flight: id, role }).parse({ crew: param('crew'), flight: param('flight'), role: param('role') });
        return Response.json(await asIdentity(STAFF, async c => ({ rules: (await c.query('SELECT * FROM fn_crew_legality($1,$2,$3)', [d.crew, d.flight, d.role])).rows })));
      }

      case 'crew': return Response.json(await asIdentity(STAFF, async c => ({
        coverage: (await c.query(opsQueries.coverage, [72])).rows,
        expiring: (await c.query(`SELECT c.crew_id::text AS "crewId", c.crew_name AS name, c.designation, c.base_airport AS base,
            cc.certification, cc.valid_until AS "validUntil"
          FROM crew_certification cc JOIN crew c USING (crew_id)
          WHERE cc.valid_until < current_date + 30 ORDER BY cc.valid_until LIMIT 40`)).rows,
        strength: (await c.query(`SELECT base_airport AS base, designation, count(*)::int AS n FROM crew WHERE is_active
          GROUP BY 1, 2 ORDER BY 1, array_position(ARRAY['Captain','First Officer','Purser','Cabin Crew'], designation)`)).rows,
      })));

      case 'disruptions': return Response.json(await asIdentity(STAFF, async c => ({
        tickets: (await c.query('SELECT * FROM fn_disrupted_tickets()')).rows,
        cancelled: (await c.query(`SELECT flight_id::text AS "flightId", flight_number AS "flightNumber", origin, destination,
            departure_time AS "departureTime", cancel_reason AS reason, updated_at AS "cancelledAt"
          FROM flight WHERE flight_status='Cancelled' AND departure_time > now() - interval '2 days' ORDER BY departure_time`)).rows,
      })));

      case 'reroute': {
        const d = z.object({ pnr: z.string().regex(/^[A-Z0-9]{6}$/), seq: z.coerce.number().int().min(1).max(99) })
          .parse({ pnr: param('pnr'), seq: param('seq') });
        return Response.json(await asIdentity(STAFF, async c => {
          const t = (await c.query('SELECT * FROM fn_disrupted_tickets() WHERE booking_id=$1 AND ticket_seq=$2', [d.pnr, d.seq])).rows[0];
          if (!t) throw new HttpError(404, 'No unresolved disruption for this ticket.');
          // From the original departure (or now + 1 h) through the next 36 hours.
          const start = new Date(Math.max(new Date(t.departure_time).getTime() - 2 * 3600e3, Date.now() + 3600e3));
          const end = new Date(start.getTime() + 36 * 3600e3);
          const result = await findItineraries(c, neo4jDriver, { from: t.origin, to: t.destination, start: start.toISOString(),
            end: end.toISOString(), arriveBy: t.must_arrive_by ? new Date(t.must_arrive_by).toISOString() : null }, { fareClass: t.fare_class, limit: 8 });
          return { ticket: t, ...result };
        }));
      }

      case 'fleet': return Response.json(await asIdentity(STAFF, async c => ({ fleet: (await c.query(opsQueries.fleet)).rows })));
      case 'seat-map': return Response.json(await asIdentity(STAFF, async c => ({ seats: (await c.query(opsQueries.seatMap, [id.parse(param('aircraft'))])).rows })));
      case 'airports': return Response.json(await asIdentity(STAFF, async c => ({ airports: (await c.query(opsQueries.airports)).rows })));
      case 'crew-admin': return Response.json(await asIdentity(['ADMIN'], async c => ({ crew: (await c.query('SELECT * FROM fn_crew_admin()')).rows })));

      // Split by store so a slow or stopped database never blanks the others' charts.
      case 'analytics': {
        const part = z.enum(['sql', 'mongo', 'graph']).parse(param('part') ?? 'sql');
        if (part === 'sql') return Response.json(await asIdentity(STAFF, async c => ({
          revenue: (await c.query('SELECT * FROM fn_route_revenue(3) LIMIT 30')).rows,
          load: (await c.query(opsQueries.loadByRoute)).rows,
          otp: (await c.query(opsQueries.otpSql)).rows,
          utilisation: (await c.query(opsQueries.fleetUtilisation)).rows,
        })));
        await asIdentity(STAFF, async () => null);
        if (part === 'mongo') {
          const [pareto, distribution, otp, maintenance] = await Promise.all([
            aggregate(delayPareto(30), 'flight_events'), aggregate(delayDistribution(30), 'flight_events'),
            aggregate(onTimePerformance(90), 'flight_events'), aggregate(maintenanceSummary, 'maintenance_logs')]);
          return Response.json({ pareto, distribution, otp, maintenance });
        }
        const hubs = await optional(() => hubRanking(neo4jDriver), 'graph');
        const [unreachable, pairs] = await Promise.all([optional(() => unreachablePairs(neo4jDriver), 'graph'), optional(() => crewPairs(neo4jDriver), 'graph')]);
        return Response.json({ hubs, unreachable, pairs });
      }

      case 'impact': {
        const d = z.object({ airport: iata, hours: z.coerce.number().int().min(1).max(72).default(24) })
          .parse({ airport: param('airport'), hours: param('hours') });
        await asIdentity(STAFF, async () => null);
        const graph = await optional(() => impactRadius(neo4jDriver, d.airport, d.hours), 'graph');
        const passengers = graph.data?.flightIds.length ? await asIdentity(STAFF, async c => (await c.query(
          "SELECT count(*)::int AS n FROM ticket WHERE ticket_status='Active' AND flight_id = ANY($1::bigint[])", [graph.data!.flightIds])).rows[0].n) : 0;
        return Response.json({ ...graph, passengers });
      }

      case 'shortest': {
        const d = z.object({ from: iata, to: iata }).parse({ from: param('from'), to: param('to') });
        await asIdentity(STAFF, async () => null);
        return Response.json(await optional(() => shortestRoute(neo4jDriver, d.from, d.to), 'graph'));
      }

      case 'audit': {
        await asIdentity(['ADMIN'], async () => null);
        const filter: Document = {};
        if (param('role')) filter.role = z.enum(['ADMIN', 'OPS', 'CREW', 'PASSENGER']).parse(param('role'));
        if (param('entity')) filter.entity = z.string().max(30).parse(param('entity'));
        const [entries, byDay] = await Promise.all([
          optional(async () => (await mongoDb()).collection('audit_log').find(filter).sort({ ts: -1 }).limit(100).toArray()),
          aggregate(auditByRoleDay(14), 'audit_log'),
        ]);
        return Response.json({ entries, byDay });
      }

      case 'outbox': return Response.json(await asIdentity(['ADMIN'], async c => ({
        events: (await c.query('SELECT * FROM fn_outbox_admin(150)')).rows,
        overview: (await c.query('SELECT fn_ops_overview() AS o')).rows[0].o,
      })));

      case 'maintenance': {
        await asIdentity(STAFF, async () => null);
        const filter: Document = param('aircraft') ? { aircraftId: id.parse(param('aircraft')) } : {};
        const [logs, summary] = await Promise.all([
          optional(async () => (await mongoDb()).collection('maintenance_logs').find(filter).sort({ openedAt: -1 }).limit(60).toArray()),
          aggregate(maintenanceSummary, 'maintenance_logs'),
        ]);
        return Response.json({ logs, summary });
      }

      // ---------------------------------------------------------------- crew portal
      case 'crew-me': return Response.json(await asIdentity(['CREW'], async (c, u) => {
        if (!u.crew_id) throw new HttpError(403, 'This account is not linked to a crew record.');
        return { profile: (await c.query(opsQueries.crewProfile, [u.crew_id])).rows[0],
          roster: (await c.query(opsQueries.roster, [u.crew_id])).rows,
          chain: (await c.query('SELECT crew_id::text AS "crewId", crew_name AS name, designation, depth FROM fn_crew_chain($1)', [u.crew_id])).rows };
      }));
      case 'crew-flight': {
        const flightId = id.parse(param('id'));
        return Response.json(await asIdentity(['CREW', 'ADMIN', 'OPS'], async c => {
          // RLS: crew see manifests and colleagues only for flights they are rostered on.
          const crew = (await c.query(opsQueries.flightCrew, [flightId])).rows;
          if (!crew.length) throw new HttpError(403, 'You are not rostered on this flight.');
          return { flight: (await c.query(`SELECT flight_id::text AS "flightId", flight_number AS "flightNumber", origin, destination,
              departure_time AS "departureTime", arrival_time AS "arrivalTime", flight_status AS status, gate, delay_minutes AS "delayMinutes"
              FROM flight WHERE flight_id=$1`, [flightId])).rows[0],
            crew, manifest: (await c.query(opsQueries.manifest, [flightId])).rows };
        }));
      }
      default: throw new HttpError(404, 'Unknown action.');
    }
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const { action } = await context.params;
    const input = await request.json();
    let result: unknown = { ok: true };

    switch (action) {
      case 'schedule': {
        const d = z.object({ flightNumber: z.string().regex(/^SK[0-9]{2,4}$/), aircraftId: id, origin: iata, destination: iata,
          departure: z.iso.datetime({ offset: true }), arrival: z.iso.datetime({ offset: true }),
          gate: z.string().regex(/^[A-Z]?[0-9]{1,3}[A-Z]?$/).nullable().default(null),
          fares: z.partialRecord(fareClass, z.number().positive().max(1_000_000)) }).parse(input);
        result = await asIdentity(STAFF, async c => ({ flightId: (await c.query(
          'SELECT fn_schedule_flight($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS id',
          [d.flightNumber, d.aircraftId, d.origin, d.destination, d.departure, d.arrival, d.gate, JSON.stringify(d.fares)])).rows[0].id }));
        break;
      }
      case 'status': {
        const d = z.object({ flightId: id, status: z.enum(['Scheduled', 'Delayed', 'Boarding', 'Departed', 'Landed']).nullable().default(null),
          delayMinutes: z.number().int().min(0).max(1440).nullable().default(null),
          gate: z.string().regex(/^[A-Z]?[0-9]{1,3}[A-Z]?$/).nullable().default(null), delayReason: delayReason.nullable().default(null) }).parse(input);
        result = await asIdentity(STAFF, async c => (await c.query('CALL sp_update_flight_status($1,$2,$3,$4,$5,NULL)',
          [d.flightId, d.status, d.delayMinutes, d.gate, d.delayReason])).rows[0].p_result);
        break;
      }
      case 'cancel': {
        const d = z.object({ flightId: id, reason: z.string().trim().min(3).max(300) }).parse(input);
        result = await asIdentity(STAFF, async c => (await c.query('CALL sp_cancel_flight($1,$2,NULL)', [d.flightId, d.reason])).rows[0].p_result);
        break;
      }
      case 'assign': {
        const d = z.object({ crewId: id, flightId: id, role, standby: z.boolean().default(false) }).parse(input);
        await asIdentity(STAFF, async c => { await c.query('CALL sp_assign_crew($1,$2,$3,$4)', [d.crewId, d.flightId, d.role, d.standby]); });
        break;
      }
      case 'unassign': {
        const d = z.object({ crewId: id, flightId: id }).parse(input);
        await asIdentity(STAFF, async c => { await c.query('CALL sp_unassign_crew($1,$2)', [d.crewId, d.flightId]); });
        break;
      }
      case 'rebook': {
        const d = z.object({ pnr: z.string().regex(/^[A-Z0-9]{6}$/), seq: z.number().int().min(1).max(99), flightIds: z.array(id).min(1).max(3) }).parse(input);
        result = await asIdentity(STAFF, async c => (await c.query('CALL sp_rebook_ticket($1,$2::smallint,$3::bigint[],NULL)',
          [d.pnr, d.seq, d.flightIds])).rows[0].p_result);
        break;
      }
      case 'aircraft': {
        const d = z.object({ registration: z.string().regex(/^[A-Z0-9]{1,2}-[A-Z0-9]{3,5}$/), model: z.string().trim().min(2).max(60),
          manufacturer: z.string().trim().min(2).max(60), typeRating: z.string().regex(/^[A-Z0-9]{3,6}$/),
          year: z.number().int().min(1960).max(2100), layout }).parse(input);
        result = await asIdentity(['ADMIN'], async c => ({ aircraftId: (await c.query('SELECT fn_add_aircraft($1,$2,$3,$4,$5,$6::jsonb) AS id',
          [d.registration, d.model, d.manufacturer, d.typeRating, d.year, JSON.stringify(d.layout)])).rows[0].id }));
        break;
      }
      case 'seat-map': {
        const d = z.object({ aircraftId: id, layout }).parse(input);
        await asIdentity(['ADMIN'], async c => { await c.query('CALL sp_generate_seat_map($1,$2::jsonb)', [d.aircraftId, JSON.stringify(d.layout)]); });
        break;
      }
      case 'aircraft-status': {
        const d = z.object({ aircraftId: id, status: z.enum(['Active', 'Maintenance', 'Retired']) }).parse(input);
        await asIdentity(STAFF, async c => { await c.query('CALL sp_set_aircraft_status($1,$2)', [d.aircraftId, d.status]); });
        break;
      }
      case 'airport': {
        const d = z.object({ code: iata, name: z.string().trim().min(2).max(120), city: z.string().trim().min(1).max(80),
          country: z.string().regex(/^[A-Z]{2}$/), timezone: z.string().min(3).max(60),
          lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).parse(input);
        await asIdentity(['ADMIN'], async c => { await c.query('CALL sp_upsert_airport($1,$2,$3,$4,$5,$6,$7)',
          [d.code, d.name, d.city, d.country, d.timezone, d.lat, d.lon]); });
        break;
      }
      case 'refresh-analytics':
        await asIdentity(STAFF, async c => { await c.query('CALL sp_refresh_analytics()'); });
        break;
      case 'outbox-run':
        await asIdentity(['ADMIN'], async () => null);
        return Response.json(await runOutbox(500));
      case 'outbox-retry': {
        const d = z.object({ eventId: id }).parse(input);
        await asIdentity(['ADMIN'], async c => { await c.query('CALL sp_outbox_retry($1)', [d.eventId]); });
        break;
      }
      case 'maintenance': {
        // Native MongoDB document (validated by $jsonSchema); the audit entry goes through the
        // PostgreSQL outbox so it lands in audit_log like every other change. The two writes are
        // not atomic - the audit is written first, so a failed insert at worst leaves an audit
        // entry for an attempted work order, never an unaudited one.
        const d = z.object({ aircraftId: id, checkType: z.enum(['A', 'B', 'C', 'D', 'DEFECT']), technician: z.string().trim().min(2).max(120),
          aogHours: z.number().min(0).max(2000), closed: z.boolean().default(false),
          findings: z.array(z.object({ ata: z.string().regex(/^[0-9]{2}(-[0-9]{2})?$/), description: z.string().trim().min(3).max(1000),
            severity: z.enum(['minor', 'major', 'critical']) })).min(1).max(20),
          components: z.array(z.object({ partNo: z.string().trim().min(1).max(40), action: z.enum(['inspected', 'repaired', 'replaced']),
            serial: z.string().max(40).optional() })).max(40).default([]) }).parse(input);
        const { registration, userId } = await asIdentity(STAFF, async (c, u) => {
          const a = (await c.query('SELECT registration FROM aircraft WHERE aircraft_id=$1', [d.aircraftId])).rows[0];
          if (!a) throw new HttpError(404, 'Aircraft not found.');
          await c.query("SELECT fn_emit_ops_audit('LOG_MAINTENANCE','aircraft',$1,$2::jsonb)",
            [d.aircraftId, JSON.stringify({ checkType: d.checkType, findings: d.findings.length })]);
          return { registration: a.registration as string, userId: u.user_id };
        });
        const now = new Date();
        const inserted = await (await mongoDb()).collection('maintenance_logs').insertOne({ aircraftId: d.aircraftId, registration,
          checkType: d.checkType, openedAt: now, closedAt: d.closed ? now : null, technician: d.technician, aogHours: d.aogHours,
          findings: d.findings, components: d.components, createdBy: String(userId) });
        result = { id: inserted.insertedId.toHexString() };
        break;
      }
      case 'crew-report': {
        // Crew portal: "report a flight event" (native time-series entry + outbox audit).
        const d = z.object({ flightId: id, kind: z.enum(['Boarding complete', 'Doors closed', 'Medical incident', 'Technical snag',
          'Disruptive passenger', 'Catering issue']), note: z.string().trim().max(500).default('') }).parse(input);
        const info = await asIdentity(['CREW'], async (c, u) => {
          const f = (await c.query(`SELECT f.flight_id::text AS id, f.flight_number, f.origin, f.destination FROM flight f
            WHERE f.flight_id=$1 AND EXISTS (SELECT 1 FROM crew_assignment ca WHERE ca.flight_id=f.flight_id AND ca.crew_id=$2)`,
            [d.flightId, u.crew_id])).rows[0];
          if (!f) throw new HttpError(403, 'You are not rostered on this flight.');
          await c.query("SELECT fn_emit_ops_audit('CREW_REPORT','flight',$1,$2::jsonb)", [d.flightId, JSON.stringify({ kind: d.kind })]);
          return { ...f, userId: u.user_id };
        });
        await (await mongoDb()).collection('flight_events').insertOne({ ts: new Date(),
          meta: { flightId: info.id, flightNumber: info.flight_number, route: `${info.origin}-${info.destination}`, type: 'CREW_REPORT' },
          sourceEventId: `native:${randomUUID()}:CREW_REPORT`, actor: String(info.userId), payload: { kind: d.kind, note: d.note } });
        break;
      }
      default: throw new HttpError(404, 'Unknown action.');
    }
    kickOutbox();
    return Response.json(result);
  } catch (error) { return apiError(error); }
}
