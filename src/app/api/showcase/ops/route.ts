// Operations part of the DB showcase (Aditya): each named query shows its SQL, live rows (under the
// caller's RLS) and EXPLAIN ANALYZE. The double-scheduling demo rolls back to a savepoint.
import { z } from 'zod';
import { asIdentity, apiError, checkOrigin, HttpError } from '@/server/access';
import { opsQueries } from '@/server/queries/ops';
import { ITINERARY_CYPHER } from '@/lib/graph/search';

const STAFF = ['ADMIN', 'OPS'];
type Named = { sql: string; params: unknown[]; roles: string[] | null; note: string };

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const d = z.object({ query: z.enum(['double-schedule', 'crew-chain', 'coverage', 'revenue', 'itinerary-sql', 'airport-fuzzy', 'load']),
      text: z.string().trim().max(60).default('Bengalru'), flight: z.string().regex(/^[0-9]+$/).default('1') }).parse(await request.json());

    if (d.query === 'double-schedule') return Response.json(await asIdentity(STAFF, async c => {
      const f = (await c.query(`SELECT flight_id, aircraft_id, flight_number, origin, destination, departure_time, arrival_time
        FROM flight WHERE flight_status IN ('Scheduled','Delayed') AND departure_time > now() + interval '3 hours'
        ORDER BY departure_time LIMIT 1`)).rows[0];
      if (!f) throw new HttpError(409, 'No upcoming flight to collide with.');
      const sql = `SELECT fn_schedule_flight('SK9999', $1, $2, $3, $4 + interval '20 minutes', $5 + interval '20 minutes', NULL, '{"Economy":5000,"Business":15000}');`;
      await c.query('SAVEPOINT showcase');
      try {
        await c.query(`SELECT fn_schedule_flight('SK9999',$1,$2,$3,$4::timestamptz + interval '20 minutes',$5::timestamptz + interval '20 minutes',NULL,$6::jsonb)`,
          [f.aircraft_id, f.destination, f.origin, f.departure_time, f.arrival_time, JSON.stringify({ Economy: 5000, Business: 15000, First: 30000 })]);
        throw new Error('The exclusion constraint did not fire.');
      } catch (error) {
        await c.query('ROLLBACK TO SAVEPOINT showcase');
        const e = error as { code?: string; constraint?: string; message: string };
        if (e.code !== '23P01') throw error;
        return { sql, note: `Tried to put aircraft ${f.aircraft_id} (already flying ${f.flight_number} ${f.origin}→${f.destination}) on a second sector 20 minutes later.`,
          rows: [{ attempt: 'rejected', sqlstate: e.code, constraint: e.constraint, rolledBack: true }], plan: null };
      }
    }));

    const queries: Record<string, Named> = {
      'crew-chain': { roles: ['ADMIN', 'OPS', 'CREW'], note: 'Recursive CTE over crew.supervisor_id: managers (negative depth) and reports (positive depth).',
        sql: `SELECT * FROM fn_crew_chain((SELECT crew_id FROM crew WHERE designation = 'Captain' ORDER BY crew_id LIMIT 1))`, params: [] },
      coverage: { roles: STAFF, note: 'GROUP BY + HAVING: upcoming flights missing a captain, first officer or enough cabin crew.',
        sql: 'SELECT * FROM v_crew_coverage ORDER BY departure_time LIMIT 25', params: [] },
      revenue: { roles: STAFF, note: 'Materialized view (refreshed CONCURRENTLY) behind a staff-only routine.',
        sql: 'SELECT * FROM fn_route_revenue(3) LIMIT 25', params: [] },
      'itinerary-sql': { roles: null, note: `The same itinerary search the graph answers with one traversal:\n${ITINERARY_CYPHER}`,
        sql: opsQueries.itinerariesFallback,
        params: ['BLR', 'GAU', new Date(Date.now() + 86400e3).toISOString(), new Date(Date.now() + 3 * 86400e3).toISOString(), null] },
      'airport-fuzzy': { roles: null, note: 'Full-text search plus pg_trgm similarity (GIN trigram indexes) for typo-tolerant autocomplete.',
        sql: opsQueries.airportSearch, params: [d.text] },
      load: { roles: STAFF, note: 'View v_flight_load: seats sold vs allocated per fare class (LEFT JOIN + FILTER).',
        sql: 'SELECT * FROM v_flight_load WHERE flight_id = $1', params: [d.flight] },
    };
    const q = queries[d.query];
    return Response.json(await asIdentity(q.roles, async c => {
      const result = await c.query(q.sql, q.params);
      const plan = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.sql}`, q.params);
      return { sql: q.sql, note: q.note, rows: result.rows.slice(0, 50), plan: plan.rows[0]['QUERY PLAN'] };
    }));
  } catch (error) { return apiError(error); }
}
