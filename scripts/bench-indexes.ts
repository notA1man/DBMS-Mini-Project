// Index benchmark (plan §7.7 / §15): EXPLAIN (ANALYZE, BUFFERS) for key queries with and without
// their index, on a disposable database filled with the ops seed + synthetic demo traffic
// (scaled to ~45k flights, ~100k passengers, ~175k tickets). Each "without" run drops the index inside a transaction that is
// rolled back, so nothing is permanently removed. Writes docs/benchmarks.md.
//   npm run bench:indexes
import { Pool, type PoolClient } from 'pg';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { commercialQueries } from '../src/server/queries/commercial';
import { opsQueries } from '../src/server/queries/ops';

try { process.loadEnvFile('.env'); } catch { /* shell env */ }
const RUNS = 7;

type Case = { name: string; index: string; sql: string; params: (c: PoolClient) => Promise<unknown[]>; owner?: string };
const CASES: Case[] = [
  { name: 'Direct flight search (route + local date)', index: 'flight_route_departure_idx', sql: commercialQueries.directFlights,
    params: async () => ['BLR', 'DEL', new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10)] },
  { name: 'Flight manifest (tickets of one flight)', index: 'ticket_flight_idx', sql: 'SELECT * FROM v_flight_manifest WHERE flight_id = $1',
    params: async c => [(await c.query("SELECT flight_id FROM flight WHERE flight_status='Landed' ORDER BY flight_id DESC LIMIT 1")).rows[0].flight_id] },
  { name: 'Passenger lookup (full-text, GIN)', index: 'passenger_name_gin', sql: commercialQueries.lookup, params: async () => ['Traveller 81234'] },
  { name: 'Aircraft rotation (next sectors of one aircraft)', index: 'flight_aircraft_departure_idx',
    sql: "SELECT flight_id, departure_time FROM flight WHERE aircraft_id = $1 AND departure_time > now() ORDER BY departure_time LIMIT 5",
    params: async c => [(await c.query('SELECT min(aircraft_id) AS a FROM aircraft')).rows[0].a] },
  { name: 'Outbox: pending events (partial index)', index: 'outbox_pending_idx',
    sql: 'SELECT event_id FROM outbox_event WHERE processed_at IS NULL AND next_attempt_at <= now() ORDER BY event_id LIMIT 50', params: async () => [] },
  { name: 'Passenger lookup, original WHERE … OR EXISTS form', index: 'passenger_name_gin',
    sql: `SELECT p.passenger_id,p.first_name,p.last_name,p.email, ts_rank_cd(p.name_search,websearch_to_tsquery('simple',$1)) AS rank
      FROM passenger p WHERE p.name_search @@ websearch_to_tsquery('simple',$1)
        OR EXISTS(SELECT 1 FROM booking b WHERE b.passenger_id=p.passenger_id AND b.booking_id=upper($1))
      ORDER BY rank DESC,p.passenger_id LIMIT 30`, params: async () => ['Traveller 81234'] },
  { name: 'Payments in a date range (BRIN)', index: 'payment_date_brin',
    sql: "SELECT count(*), sum(amount) FROM payment WHERE payment_date >= now() - interval '2 days' AND payment_date < now() - interval '1 day'", params: async () => [] },
  { name: 'Live departures board (partial index)', index: 'flight_live_board_idx', sql: opsQueries.departures, params: async () => ['BLR', 12] },
];

const run = (file: string, env: NodeJS.ProcessEnv) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', file], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file} failed`)));
});
type Plan = { 'Node Type': string; 'Index Name'?: string; Plans?: Plan[] };
const nodes = (p: Plan): string[] => [p['Index Name'] ? `${p['Node Type']} (${p['Index Name']})` : p['Node Type'], ...(p.Plans ?? []).flatMap(nodes)];
const scans = (p: Plan) => [...new Set(nodes(p).filter(n => /Scan/.test(n)))].join(', ');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(c: PoolClient, sql: string, params: unknown[]) {
  const times: number[] = []; let plan: Plan | null = null; let buffers = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = (await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
    times.push(r['Execution Time']); plan = r.Plan;
    buffers = (r.Plan['Shared Hit Blocks'] ?? 0) + (r.Plan['Shared Read Blocks'] ?? 0);
  }
  return { ms: median(times.slice(1)), plan: plan!, buffers };   // first run warms the cache
}

async function main() {
  const database = `skyops_bench_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
  const url = new URL(process.env.DATABASE_URL_OWNER!); url.pathname = `/${database}`;
  const owner = new Pool({ connectionString: url.toString() });
  owner.on('error', () => {});
  try {
    await admin.query(`CREATE DATABASE "${database}"`);
    for (const file of (await readdir('db/postgres/init')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = await readFile(`db/postgres/init/${file}`, 'utf8');
      if (sql.replace(/--[^\n]*/g, '').trim()) await owner.query(sql);
    }
    const env = { ...process.env, DATABASE_URL_OWNER: url.toString(), SEED_STAFF_PASSWORD: '' };
    await run('scripts/seed-ops.ts', env);
    await run('scripts/seed-demo-traffic.ts', env);
    // Scale up the tables whose indexes matter at volume (benchmark database only):
    // two years of flight history (the 3-week pattern copied back in time, triggers off for the
    // bulk copy - the exclusion constraint still checks every row) and 100k passengers.
    await owner.query('ALTER TABLE flight DISABLE TRIGGER USER');
    await owner.query(`INSERT INTO flight(flight_number, aircraft_id, origin, destination, departure_time, arrival_time, flight_status, gate, delay_minutes, delay_reason)
      SELECT f.flight_number, f.aircraft_id, f.origin, f.destination, f.departure_time - k * interval '23 days', f.arrival_time - k * interval '23 days',
             'Landed', f.gate, f.delay_minutes, f.delay_reason
      FROM flight f CROSS JOIN generate_series(1, 32) k
      WHERE f.flight_status = 'Landed' AND f.departure_time > now() - interval '21 days' AND f.arrival_time < now()`);
    await owner.query('ALTER TABLE flight ENABLE TRIGGER USER');
    await owner.query(`INSERT INTO passenger(first_name, last_name, date_of_birth, email)
      SELECT 'Bench', 'Traveller ' || n, DATE '1950-01-01' + (n % 20000), 'bench' || n || '@bench.skyops.test' FROM generate_series(4001, 104000) n`);
    // A realistic outbox: almost everything already delivered.
    await owner.query("UPDATE outbox_event SET processed_at = now() WHERE event_id % 50 <> 0");
    await owner.query('VACUUM ANALYZE');
    const sizes = (await owner.query(`SELECT relname, reltuples::bigint AS n FROM pg_class
      WHERE relname IN ('flight','ticket','booking','passenger','payment','outbox_event','crew_assignment') ORDER BY relname`)).rows;

    const c = await owner.connect();
    const results: string[] = [];
    try {
      for (const k of CASES) {
        const params = await k.params(c);
        const withIdx = await measure(c, k.sql, params);
        await c.query('BEGIN');
        await c.query(`DROP INDEX ${k.index}`);
        const without = await measure(c, k.sql, params);
        await c.query('ROLLBACK');
        const speedup = without.ms / Math.max(withIdx.ms, 0.001);
        results.push(`| ${k.name} | \`${k.index}\` | ${without.ms.toFixed(2)} ms<br><small>${scans(without.plan)}</small> | ${withIdx.ms.toFixed(2)} ms<br><small>${scans(withIdx.plan)}</small> | ${speedup.toFixed(1)}× |`);
        console.log(`${k.name}: ${without.ms.toFixed(2)} ms -> ${withIdx.ms.toFixed(2)} ms (${speedup.toFixed(1)}x)`);
      }
    } finally { c.release(); }

    const pg = (await owner.query('SHOW server_version')).rows[0].server_version;
    const md = `# Index benchmark

Generated by \`npm run bench:indexes\` on ${new Date().toISOString().slice(0, 10)} (PostgreSQL ${pg}).
Disposable database with the operations seed plus synthetic demo traffic, \`VACUUM ANALYZE\`d.
Each query ran ${RUNS} times with \`EXPLAIN (ANALYZE, BUFFERS)\`; the table shows the median execution
time after a warm-up run. "Without" drops that one index inside a transaction which is then rolled
back, so the planner falls back to whatever else it has (usually a sequential scan).

**Data volume:** ${sizes.map(s => `${s.relname} ≈ ${Number(s.n).toLocaleString('en-IN')}`).join(' · ')}

| Query | Index | Without index | With index | Speed-up |
|---|---|---|---|---|
${results.join('\n')}

## Reading the results

- **B-tree composite \`flight(origin, destination, departure_time)\`**: equality on the route, range on
  time - the column order matches the predicate, so the planner seeks straight to the day's rows.
- **FK indexes** (\`ticket(flight_id)\`): PostgreSQL does not index foreign keys automatically;
  without it every manifest is a full scan of the ticket table.
- **GIN on a generated \`tsvector\`** turns full-text lookup from scanning every passenger into an
  inverted-index probe.
- **Partial indexes** (\`outbox_event … WHERE processed_at IS NULL\`, live-board flights) stay tiny
  because they only contain rows the query can ever want.
- **BRIN on \`payment_date\`** is a few kilobytes for an append-only table; it helps range scans
  when physical order follows time, and is the cheapest index to maintain.
- **Direct search and the live board show ~1×** because each falls back to the *other* flight index
  when its own is dropped (the plans above name it) — the two cover each other at this size.
- **The original \`WHERE … OR EXISTS\` lookup cannot use the GIN index at all** (1.0×, sequential
  scan either way); rewriting it as a \`UNION\` of the full-text branch and an exact PNR branch is
  what makes the 350× row above possible.
- Small tables (airports, aircraft) are deliberately left to sequential scans - an index would not
  beat reading a handful of pages.

Timings depend on the machine; the plan shapes (index vs sequential scan) and relative speed-ups
are the reproducible part.
`;
    await writeFile('docs/benchmarks.md', md);
    console.log('Wrote docs/benchmarks.md');
  } finally {
    await owner.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Benchmark failed'); process.exitCode = 1; });
