// Operations seed (Aditya): crew + certificates + hierarchy, a rolling flight schedule with
// aircraft rotations, realistic history (delays with reasons, cancellations, Landed flights)
// and legal crew rosters. Repeatable: dates that already have flights are skipped, so running
// it again later only tops up the forward schedule.
//
//   npm run db:seed:ops            (uses DATABASE_URL_OWNER)
//   SEED_DAYS_BACK=21 SEED_DAYS_AHEAD=14 SEED_STAFF_PASSWORD=... npm run db:seed:ops
import { Pool, type PoolClient } from 'pg';
import { AIRPORT_BY_CODE, FEATURED_ROUTES } from '../src/lib/airports';

try { process.loadEnvFile('.env'); } catch { /* env may come from the shell */ }

const DAYS_BACK = Number(process.env.SEED_DAYS_BACK ?? 21);
const DAYS_AHEAD = Number(process.env.SEED_DAYS_AHEAD ?? 14);
const MIN = 60_000, HOUR = 60 * MIN;
const TURNAROUND = 45 * MIN;

// Deterministic pseudo-random numbers so a reseed of the same dates looks the same.
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261026);
const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];

function distanceKm(a: string, b: string) {
  const A = AIRPORT_BY_CODE[a], B = AIRPORT_BY_CODE[b];
  const r = Math.PI / 180, dLat = (B.lat - A.lat) * r, dLon = (B.lon - A.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(A.lat * r) * Math.cos(B.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const blockMinutes = (a: string, b: string) => Math.round((distanceKm(a, b) / 820 * 60 + 35) / 5) * 5;

/** UTC instant for a wall-clock time in an IANA zone (no Temporal yet). */
function zonedToUtc(date: string, minutes: number, tz: string) {
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), 0, minutes);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map(p => [p.type, p.value]));
  const asZone = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return guess - (asZone - guess);
}
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ------------------------------------------------------------------ the timetable
type Category = 'regional' | 'narrow' | 'wide';
type Planned = { number: string; origin: string; destination: string; dep: number; arr: number; category: Category; date: string };
const TRUNK = new Set(['BLR-DEL', 'BLR-BOM', 'DEL-BOM', 'MAA-DEL', 'BLR-HYD']);
const REGIONAL = new Set(['BLR-COK', 'BOM-GOI']);

function timetable(date: string): Planned[] {
  const out: Planned[] = [];
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  FEATURED_ROUTES.forEach(([a, b], r) => {
    const key = `${a}-${b}`, block = blockMinutes(a, b) * MIN;
    const category: Category = block > 6 * HOUR ? 'wide' : REGIONAL.has(key) ? 'regional' : 'narrow';
    const tzA = AIRPORT_TZ[a] ?? 'Asia/Kolkata';
    const base = 100 + r * 10;
    if (category === 'wide') {
      if (![1, 3, 5].includes(weekday)) return;                 // 3x weekly long-haul
      const dep = zonedToUtc(date, 90 + (r % 3) * 30, tzA);    // 01:30-02:30 local
      // The aircraft (and crew, after legal rest) return about a day later.
      const ret = Math.ceil((dep + block + 24 * HOUR) / (15 * MIN)) * 15 * MIN;
      out.push({ number: `SK${base}`, origin: a, destination: b, dep, arr: dep + block, category, date });
      out.push({ number: `SK${base + 1}`, origin: b, destination: a, dep: ret, arr: ret + block, category, date });
      return;
    }
    const waves = TRUNK.has(key) ? [6 * 60, 12 * 60 + 30, 19 * 60] : [8 * 60 + 15];
    waves.forEach((start, w) => {
      const dep = zonedToUtc(date, start + (r % 4) * 15, tzA);
      const ret = dep + block + 60 * MIN;                       // out-and-back rotation
      out.push({ number: `SK${base + w * 2}`, origin: a, destination: b, dep, arr: dep + block, category, date });
      out.push({ number: `SK${base + w * 2 + 1}`, origin: b, destination: a, dep: ret, arr: ret + block, category, date });
    });
  });
  return out;
}
let AIRPORT_TZ: Record<string, string> = {};

const FARE_PER_KM: Record<string, number> = { Economy: 3.1, Business: 9.5, First: 21 };
const fares = (o: string, d: string) => {
  const km = distanceKm(o, d);
  return Object.fromEntries(Object.entries(FARE_PER_KM).map(([c, k]) => [c, Math.round((1800 + km * k) / 50) * 50]));
};

// ------------------------------------------------------------------ crew
const FIRST = ['Aarav','Vihaan','Ishaan','Arjun','Kabir','Rohan','Aditi','Ananya','Diya','Meera','Saanvi','Kavya',
  'Nikhil','Pranav','Rahul','Sneha','Priya','Tara','Zoya','Farhan','Imran','Neha','Pooja','Rhea','Siddharth','Varun',
  'Karan','Lakshmi','Deepa','Joseph','Maria','Harpreet','Gurpreet','Tenzin','Anil','Sunita','Ritu','Yash','Om','Asha'];
const LAST = ['Sharma','Iyer','Reddy','Nair','Menon','Kapoor','Singh','Khan','Das','Bose','Mehta','Patel','Rao',
  'Pillai','Chatterjee','Gupta','Joshi','Kulkarni','Fernandes','DSouza','Bhat','Hegde','Verma','Mishra','Sethi'];
type CrewSpec = { designation: string; types: string[]; count: number };
const CREW: CrewSpec[] = [
  { designation: 'Captain', types: ['A20N'], count: 70 }, { designation: 'First Officer', types: ['A20N'], count: 70 },
  { designation: 'Captain', types: ['AT76'], count: 6 }, { designation: 'First Officer', types: ['AT76'], count: 6 },
  { designation: 'Captain', types: ['B789', 'A359'], count: 22 }, { designation: 'First Officer', types: ['B789', 'A359'], count: 22 },
  { designation: 'Purser', types: [], count: 110 }, { designation: 'Cabin Crew', types: [], count: 320 },
];
const SALARY: Record<string, [number, number]> = {
  Captain: [420000, 650000], 'First Officer': [210000, 320000], Purser: [110000, 160000], 'Cabin Crew': [65000, 105000],
};

async function seedCrew(c: PoolClient, demand: Map<string, number>) {
  if ((await c.query('SELECT count(*)::int AS n FROM crew')).rows[0].n > 0) return false;
  const hubs = [...demand.entries()].sort((x, y) => y[1] - x[1]);
  const totalDemand = hubs.reduce((s, [, n]) => s + n, 0);
  const today = Date.now();
  let serial = 0;
  for (const spec of CREW) {
    for (let i = 0; i < spec.count; i++) {
      serial++;
      // Bases follow where rotations start, so crews begin where they are needed.
      let roll = rand() * totalDemand, base = hubs[0][0];
      for (const [hub, n] of hubs) { if ((roll -= n) <= 0) { base = hub; break; } }
      const pilot = spec.types.length > 0;
      const [lo, hi] = SALARY[spec.designation];
      const name = `${FIRST[serial % FIRST.length]} ${LAST[(serial * 7) % LAST.length]}`;
      const license = `${pilot ? 'ATPL' : 'CC'}-IN-${String(serial).padStart(4, '0')}`;
      const { rows } = await c.query(
        `INSERT INTO crew(crew_name, designation, license_number, salary, hire_date, base_airport)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING crew_id`,
        [name, spec.designation, license, Math.round((lo + rand() * (hi - lo)) / 100) * 100,
         isoDate(today - (400 + rand() * 5000) * 86400000), base]);
      const id = rows[0].crew_id;
      // Most certificates are comfortably valid; a few expire inside the schedule window so the
      // legality checks have something real to refuse.
      const validUntil = (lateRisk: number) => isoDate(today + (rand() < lateRisk ? 2 + rand() * 10 : 60 + rand() * 600) * 86400000);
      const certs: [string, string][] = [['SEP', validUntil(0.02)], ['CRM', validUntil(0)]];
      if (pilot) {
        certs.push(['MEDICAL', validUntil(0.02)]);
        for (const t of spec.types) certs.push([`TYPE:${t}`, validUntil(0.03)]);
      }
      for (const [cert, until] of certs) {
        await c.query('INSERT INTO crew_certification VALUES ($1,$2,$3)', [id, cert, until]);
      }
    }
  }
  // Reporting lines per base: chief pilot -> captains -> first officers; chief purser -> pursers -> cabin crew.
  await c.query(`
    WITH ranked AS (
      SELECT crew_id, designation, base_airport,
             row_number() OVER (PARTITION BY base_airport, designation ORDER BY hire_date, crew_id) AS rn,
             count(*) OVER (PARTITION BY base_airport, designation) AS n
      FROM crew),
    chiefs AS (SELECT base_airport, designation, crew_id FROM ranked WHERE rn = 1)
    UPDATE crew c SET supervisor_id = CASE
      WHEN r.designation IN ('Captain','Purser') AND r.rn > 1 THEN
        (SELECT crew_id FROM chiefs ch WHERE ch.base_airport = r.base_airport AND ch.designation = r.designation)
      WHEN r.designation = 'First Officer' THEN
        (SELECT x.crew_id FROM ranked x WHERE x.base_airport = r.base_airport AND x.designation = 'Captain'
          ORDER BY x.rn OFFSET ((r.rn - 1) % greatest((SELECT count(*) FROM ranked y WHERE y.base_airport = r.base_airport AND y.designation = 'Captain'), 1)) LIMIT 1)
      WHEN r.designation = 'Cabin Crew' THEN
        (SELECT x.crew_id FROM ranked x WHERE x.base_airport = r.base_airport AND x.designation = 'Purser'
          ORDER BY x.rn OFFSET ((r.rn - 1) % greatest((SELECT count(*) FROM ranked y WHERE y.base_airport = r.base_airport AND y.designation = 'Purser'), 1)) LIMIT 1)
      END
    FROM ranked r WHERE r.crew_id = c.crew_id`);
  return true;
}

// ------------------------------------------------------------------ main
type Aircraft = { id: string; type: string; capacity: number; location: string | null; availableAt: number };
type Crew = { id: string; designation: string; base: string; location: string; lastEnd: number; chainStart: number;
  certs: Map<string, number> };
const DELAY_REASONS: [string, number][] = [['Weather', 24], ['ATC', 20], ['Ground handling', 16], ['Technical', 14],
  ['Crew', 7], ['Security', 4], ['Other', 3]];
function delayReason() {
  let roll = rand() * DELAY_REASONS.reduce((s, [, w]) => s + w, 0);
  for (const [reason, w] of DELAY_REASONS) if ((roll -= w) <= 0) return reason;
  return 'Other';
}
function sampleDelay() {
  const x = rand();
  if (x < 0.68) return 0;
  if (x < 0.85) return 5 + Math.floor(rand() * 15);
  if (x < 0.96) return 20 + Math.floor(rand() * 70);
  return 90 + Math.floor(rand() * 150);
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
  const c = await pool.connect();
  const now = Date.now();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('strata-seed-ops'))");
    AIRPORT_TZ = Object.fromEntries((await c.query('SELECT airport_code, timezone FROM airport')).rows
      .map(r => [r.airport_code, r.timezone]));
    if (Object.keys(AIRPORT_TZ).length === 0) throw new Error('Run migrations first: airports are missing (95_seed_reference.sql).');
    const firstEvent = Number((await c.query('SELECT coalesce(max(event_id),0) AS n FROM outbox_event')).rows[0].n);

    // Which dates still need flights?
    const dates: string[] = [];
    for (let d = -DAYS_BACK; d <= DAYS_AHEAD; d++) dates.push(isoDate(now + d * 86400000));
    // Outbound flight numbers are even and always leave an Indian hub, so their IST date is the
    // timetable date (long-haul returns depart the next day and must not mark that day as done).
    const seeded = new Set((await c.query(
      `SELECT DISTINCT (departure_time AT TIME ZONE 'Asia/Kolkata')::date::text AS d FROM flight
       WHERE right(flight_number, 1) IN ('0','2','4','6','8')`)).rows.map(r => r.d));
    const plan = dates.filter(d => !seeded.has(d)).flatMap(timetable).sort((x, y) => x.dep - y.dep);

    // Crew bases follow outbound demand.
    const demand = new Map<string, number>();
    for (const d of dates.slice(-7)) for (const f of timetable(d)) {
      if (Number(f.number.slice(-1)) % 2 === 0) demand.set(f.origin, (demand.get(f.origin) ?? 0) + 1);
    }
    const newCrew = await seedCrew(c, demand);

    // Current fleet and crew positions (rebuilt from the database when topping up).
    const fleet: Aircraft[] = (await c.query(`
      SELECT a.aircraft_id AS id, a.type_rating AS type, a.capacity,
             (SELECT f.destination FROM flight f WHERE f.aircraft_id = a.aircraft_id AND f.flight_status <> 'Cancelled' ORDER BY f.departure_time DESC LIMIT 1) AS location,
             (SELECT extract(epoch FROM max(f.arrival_time)) * 1000 FROM flight f WHERE f.aircraft_id = a.aircraft_id AND f.flight_status <> 'Cancelled') AS available
      FROM aircraft a WHERE a.status = 'Active' ORDER BY a.aircraft_id`)).rows
      .map(r => ({ id: r.id, type: r.type, capacity: r.capacity, location: r.location, availableAt: Number(r.available ?? 0) + TURNAROUND }));
    const crew: Crew[] = (await c.query(`
      SELECT c.crew_id AS id, c.designation, c.base_airport AS base,
             coalesce((SELECT f.destination FROM crew_assignment ca JOIN flight f USING (flight_id) WHERE ca.crew_id = c.crew_id ORDER BY ca.duty_end DESC LIMIT 1), c.base_airport) AS location,
             (SELECT extract(epoch FROM max(duty_end)) * 1000 FROM crew_assignment WHERE crew_id = c.crew_id) AS last_end,
             (SELECT jsonb_object_agg(certification, valid_until) FROM crew_certification WHERE crew_id = c.crew_id) AS certs
      FROM crew c WHERE c.is_active ORDER BY c.crew_id`)).rows
      .map(r => ({ id: r.id, designation: r.designation, base: r.base, location: r.location,
        lastEnd: Number(r.last_end ?? 0), chainStart: Number(r.last_end ?? 0),
        certs: new Map(Object.entries(r.certs ?? {}).map(([k, v]) => [k, Date.parse(`${v}T23:59:59Z`)])) }));

    const typesFor: Record<Category, string[]> = { wide: ['B789', 'A359'], narrow: ['A20N'], regional: ['AT76', 'A20N'] };
    let scheduled = 0, skipped = 0, cancelled = 0, delayed = 0, assigned = 0, gaps = 0;
    const rejected: string[] = [];

    for (const p of plan) {
      // ---- aircraft: one already at the origin, else an unused one positioned there.
      const ok = (a: Aircraft) => typesFor[p.category].includes(a.type);
      // Widebodies idle for 8 h+ at another Indian hub may be repositioned (an unrecorded ferry
      // flight, as airlines do), otherwise they strand at the wrong hub and history fills with
      // multi-hour "late inbound aircraft" delays.
      const domestic = (code: string | null) => code !== null && (AIRPORT_BY_CODE[code]?.country ?? '') === 'IN';
      const eligible = fleet.filter(a => ok(a) && (a.location === p.origin || a.location === null
        || (p.category === 'wide' && domestic(a.location) && domestic(p.origin) && a.availableAt + 8 * HOUR <= p.dep)));
      const past = p.arr < now - 30 * MIN;
      const candidates = eligible
        .map(a => ({ a, ready: a.location === null ? 0 : a.availableAt, here: a.location === p.origin }))
        .filter(x => past || x.ready <= p.dep)
        .sort((x, y) => Number(y.here && x.ready <= p.dep ? 0 : 1) - Number(x.here && y.ready <= p.dep ? 0 : 1)
          || (x.a.location === null ? 1 : 0) - (y.a.location === null ? 1 : 0)
          || typesFor[p.category].indexOf(x.a.type) - typesFor[p.category].indexOf(y.a.type) || x.ready - y.ready);
      const chosen = candidates[0];
      if (!chosen) { skipped++; continue; }
      const ac = chosen.a;

      // ---- history: delays (own + knock-on) and cancellations.
      let delay = 0, reason: string | null = null;
      const isPast = p.dep < now;
      if (isPast) {
        delay = sampleDelay();
        if (delay > 0) reason = delayReason();
        const knock = Math.ceil(Math.max(0, (chosen.ready - (p.dep + delay * MIN)) / MIN));
        if (knock > 0) { delay += knock; reason = 'Late inbound aircraft'; }
      } else if (chosen.ready > p.dep) {
        continue; // never plan a future sector the aircraft cannot make
      }
      const dep = p.dep + delay * MIN, arr = p.arr + delay * MIN;
      const cancel = isPast && rand() < 0.015;

      const fl = await c.query(
        `INSERT INTO flight(flight_number, aircraft_id, origin, destination, departure_time, arrival_time, gate, delay_minutes, delay_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (flight_number, departure_time) DO NOTHING RETURNING flight_id`,
        [p.number, ac.id, p.origin, p.destination, new Date(dep), new Date(arr),
         `${pick(['A', 'B', 'C', ''])}${1 + Math.floor(rand() * 40)}`, delay, reason]);
      if (!fl.rows[0]) continue;
      const flightId = fl.rows[0].flight_id;
      const f = fares(p.origin, p.destination);
      await c.query(`INSERT INTO flight_fare(flight_id, fare_class, base_fare, seats_allocated)
        SELECT $1, seat_class, ($3::jsonb ->> seat_class)::numeric, count(*) FROM seat WHERE aircraft_id = $2 GROUP BY seat_class`,
        [flightId, ac.id, JSON.stringify(f)]);
      scheduled++;

      if (cancel) {
        await c.query("UPDATE flight SET flight_status = 'Cancelled', cancel_reason = $2 WHERE flight_id = $1",
          [flightId, pick(['Technical fault on inbound aircraft', 'Severe weather at destination', 'ATC restrictions'])]);
        cancelled++;
        continue;   // the aircraft stays where it was
      }
      ac.location = p.destination;
      ac.availableAt = arr + TURNAROUND;
      if (delay > 0) delayed++;

      // ---- crew: Captain, First Officer, Purser, then cabin crew (1 per 50 seats in total).
      const dutyStart = dep - 30 * MIN, dutyEnd = arr + 15 * MIN;
      const maxPeriod = (arr - dep > 8 * HOUR ? 20 : 13) * HOUR;
      const cabinNeeded = Math.ceil(ac.capacity / 50);
      const roles: string[] = ['Captain', 'First Officer', 'Purser', ...Array(Math.max(cabinNeeded - 1, 0)).fill('Cabin Crew')];
      const onBoard = new Set<string>();
      for (const role of roles) {
        const can = (m: Crew) => {
          if (onBoard.has(m.id) || m.location !== p.origin || m.lastEnd > dutyStart) return false;
          const fits = role === 'Captain' ? m.designation === 'Captain'
            : role === 'First Officer' ? m.designation === 'First Officer'
            : role === 'Purser' ? m.designation === 'Purser' : m.designation === 'Cabin Crew';
          if (!fits) return false;
          const valid = (cert: string) => (m.certs.get(cert) ?? 0) >= dep;
          if (!valid('SEP')) return false;
          if (role === 'Captain' || role === 'First Officer') {
            if (!valid('MEDICAL') || !valid(`TYPE:${ac.type}`)) return false;
          }
          const sameChain = dutyStart - m.lastEnd < 10 * HOUR;
          return !sameChain || dutyEnd - m.chainStart <= maxPeriod;
        };
        // Prefer a crew member continuing their duty period (keeps crews together), then whoever
        // has been idle longest.
        const choice = crew.filter(can).sort((x, y) =>
          Number(dutyStart - y.lastEnd < 10 * HOUR) - Number(dutyStart - x.lastEnd < 10 * HOUR) || x.lastEnd - y.lastEnd)[0];
        if (!choice) { gaps++; continue; }
        // Future duties go through the full database legality check; a disagreement with the
        // planner above just leaves the seat open instead of aborting the whole seed.
        await c.query('SAVEPOINT duty');
        try {
          await c.query('SELECT ops_assign_crew($1,$2,$3,false,$4)', [choice.id, flightId, role, dep > now]);
          await c.query('RELEASE SAVEPOINT duty');
        } catch (error) {
          await c.query('ROLLBACK TO SAVEPOINT duty');
          rejected.push(`${p.number} ${role}: ${(error as Error).message}`);
          gaps++;
          continue;
        }
        if (dutyStart - choice.lastEnd >= 10 * HOUR) choice.chainStart = dutyStart;
        choice.lastEnd = dutyEnd;
        choice.location = p.destination;
        onBoard.add(choice.id);
        assigned++;
      }

      // ---- statuses follow the clock (each step is a legal state-machine transition).
      const steps: string[] = [];
      if (delay > 0) steps.push('Delayed');
      if (dep - 40 * MIN <= now) steps.push('Boarding');
      if (dep <= now) steps.push('Departed');
      if (arr <= now) steps.push('Landed');
      for (const s of steps) await c.query('UPDATE flight SET flight_status = $2 WHERE flight_id = $1', [flightId, s]);
    }

    // Seeded outbox events get the time they would have happened, so the Mongo time series
    // and audit views show a believable history instead of "everything happened just now".
    await c.query(`
      UPDATE outbox_event o SET created_at = least(now(), t.ts), next_attempt_at = least(now(), t.ts)
      FROM (
        SELECT event_id,
          CASE
            WHEN (payload ->> 'created')::boolean THEN (payload #>> '{flight,departureTime}')::timestamptz - interval '21 days'
            WHEN payload #>> '{changes,status,1}' = 'Landed' THEN (payload #>> '{flight,arrivalTime}')::timestamptz
            WHEN payload #>> '{changes,status,1}' = 'Departed' THEN (payload #>> '{flight,departureTime}')::timestamptz
            WHEN payload #>> '{changes,status,1}' = 'Boarding' THEN (payload #>> '{flight,departureTime}')::timestamptz - interval '40 minutes'
            WHEN payload #>> '{changes,status,1}' = 'Delayed' THEN (payload #>> '{flight,departureTime}')::timestamptz
                 - make_interval(mins => (payload #>> '{flight,delayMinutes}')::integer) - interval '90 minutes'
            WHEN payload #>> '{changes,status,1}' = 'Cancelled' THEN (payload #>> '{flight,departureTime}')::timestamptz - interval '3 hours'
          END AS ts
        FROM outbox_event WHERE event_id > $1 AND event_type = 'FLIGHT_UPSERT'
      ) t
      WHERE o.event_id = t.event_id AND t.ts IS NOT NULL`, [firstEvent]);
    await c.query(`UPDATE outbox_event SET created_at = least(created_at, now() - interval '22 days')
      WHERE event_id > $1 AND event_type = 'FLIGHT_FARE_UPSERT'`, [firstEvent]);

    // Optional demo staff logins (never a default password).
    const staffPassword = process.env.SEED_STAFF_PASSWORD;
    if (staffPassword) {
      if (Buffer.byteLength(staffPassword) < 12 || Buffer.byteLength(staffPassword) > 72) throw new Error('SEED_STAFF_PASSWORD must be 12-72 bytes.');
      const crewUser = async (email: string, designation: string) => {
        const id = (await c.query(`SELECT ca.crew_id FROM crew_assignment ca JOIN crew c USING (crew_id)
          WHERE c.designation = $1 AND ca.duty_start > now() AND NOT EXISTS (SELECT 1 FROM app_user u WHERE u.crew_id = c.crew_id)
          GROUP BY ca.crew_id ORDER BY min(ca.duty_start) LIMIT 1`, [designation])).rows[0]?.crew_id;
        if (id) await c.query(`INSERT INTO app_user(email, password_hash, role, crew_id)
          VALUES ($1, crypt($2, gen_salt('bf', 12)), 'CREW', $3) ON CONFLICT (email) DO NOTHING`, [email, staffPassword, id]);
      };
      await c.query(`INSERT INTO app_user(email, password_hash, role) VALUES ('ops@strata.test', crypt($1, gen_salt('bf', 12)), 'OPS')
        ON CONFLICT (email) DO NOTHING`, [staffPassword]);
      await crewUser('captain@strata.test', 'Captain');
      await crewUser('purser@strata.test', 'Purser');
    }

    await c.query('COMMIT');
    await c.query('REFRESH MATERIALIZED VIEW mv_route_revenue_monthly');
    // Fresh planner statistics after a bulk load; without them later queries pick terrible plans.
    await c.query('ANALYZE');
    const totals = (await c.query(`SELECT (SELECT count(*) FROM flight) AS flights, (SELECT count(*) FROM crew) AS crew,
      (SELECT count(*) FROM crew_assignment) AS duties, (SELECT count(*) FROM outbox_event WHERE processed_at IS NULL) AS pending`)).rows[0];
    if (rejected.length) console.warn(`Database refused ${rejected.length} planned duties, e.g. ${rejected.slice(0, 3).join(' | ')}`);
    console.log(`Ops seed: ${newCrew ? 'created crew; ' : ''}${scheduled} flights scheduled (${delayed} delayed, ${cancelled} cancelled, ${skipped} not coverable), `
      + `${assigned} crew duties (${gaps} unfilled seats). Totals: ${totals.flights} flights, ${totals.crew} crew, ${totals.duties} duties, `
      + `${totals.pending} outbox events pending - run npm run outbox:drain to sync MongoDB/Neo4j.`);
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    c.release();
    await pool.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Ops seed failed'); process.exitCode = 1; });
