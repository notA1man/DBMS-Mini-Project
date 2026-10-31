// Operations integrity tests (Aditya). Every production migration is applied, in order, to a
// disposable database - no fixtures - and behaviour is exercised through the least-privilege
// application role exactly as the web server does (SET LOCAL ROLE strata_app + app.user_id).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

process.loadEnvFile('.env');
const database = `strata_ops_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
const url = new URL(process.env.DATABASE_URL_OWNER!);
url.pathname = `/${database}`;
const owner = new Pool({ connectionString: url.toString(), max: 20 });
owner.on('error', () => {}); // idle clients are terminated when the database is dropped
let created = false;

const ids: Record<string, string> = {};
const HOUR = 3600_000;
const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

async function as<T>(userId: string, fn: (c: PoolClient) => Promise<T>) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE strata_app');
    // Deliberately claim ADMIN: authorization must come from the app_user row, not this string.
    await c.query("SELECT set_config('app.user_id',$1,true), set_config('app.role','ADMIN',true)", [userId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}
const ops = <T,>(fn: (c: PoolClient) => Promise<T>) => as(ids.ops, fn);
const one = async (c: PoolClient | Pool, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];

const FARES = JSON.stringify({ Economy: 5000, Business: 15000 });
async function schedule(number: string, aircraft: string, origin: string, destination: string, dep: number, hours: number) {
  return (await ops(c => one(c, 'SELECT fn_schedule_flight($1,$2,$3,$4,$5,$6,$7,$8::jsonb) AS id',
    [number, aircraft, origin, destination, at(dep), at(dep + hours), 'A1', FARES]))).id as string;
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO strata_app`);
  // Same order Docker and `npm run db:migrate` use; placeholders and shell scripts skipped.
  for (const file of (await readdir('db/postgres/init')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(`db/postgres/init/${file}`, 'utf8');
    if (sql.replace(/--[^\n]*/g, '').trim()) await owner.query(sql);
  }
  const user = async (key: string, email: string, role: string, extra: Record<string, string> = {}) => {
    ids[key] = (await one(owner, `INSERT INTO app_user(email,password_hash,role,passenger_id,crew_id)
      VALUES ($1,'test-only',$2,$3,$4) RETURNING user_id`, [email, role, extra.passenger ?? null, extra.crew ?? null])).user_id;
  };
  await user('admin', 'admin@test.local', 'ADMIN');
  await user('ops', 'ops@test.local', 'OPS');
  // Two A320neo (182 seats: 8 Business + 174 Economy) from the reference seed.
  const fleet = (await owner.query("SELECT aircraft_id FROM aircraft WHERE type_rating='A20N' ORDER BY aircraft_id LIMIT 3")).rows;
  [ids.ac1, ids.ac2, ids.ac3] = fleet.map(r => r.aircraft_id);
  const crew = async (key: string, name: string, designation: string, base: string, certs: [string, string][]) => {
    ids[key] = (await one(owner, `INSERT INTO crew(crew_name,designation,license_number,salary,hire_date,base_airport)
      VALUES ($1,$2,$3,100000,'2015-01-01',$4) RETURNING crew_id`, [name, designation, `LIC-${key.toUpperCase()}`, base])).crew_id;
    for (const [cert, until] of certs) await owner.query('INSERT INTO crew_certification VALUES ($1,$2,$3)', [ids[key], cert, until]);
  };
  const valid = '2099-01-01';
  await crew('cpt', 'Asha Rao', 'Captain', 'BLR', [['TYPE:A20N', valid], ['MEDICAL', valid], ['SEP', valid]]);
  await crew('cpt2', 'Kabir Das', 'Captain', 'BLR', [['TYPE:A20N', valid], ['MEDICAL', valid], ['SEP', valid]]);
  await crew('expired', 'Om Joshi', 'Captain', 'BLR', [['TYPE:A20N', '2020-01-01'], ['MEDICAL', valid], ['SEP', valid]]);
  await crew('fo', 'Tara Nair', 'First Officer', 'BLR', [['TYPE:A20N', valid], ['MEDICAL', valid], ['SEP', valid]]);
  await crew('purser', 'Zoya Khan', 'Purser', 'BLR', [['SEP', valid]]);
  for (const n of [1, 2, 3, 4]) await crew(`cc${n}`, `Cabin Crew ${n}`, 'Cabin Crew', 'BLR', [['SEP', valid]]);
  await owner.query('UPDATE crew SET supervisor_id=$1 WHERE crew_id=$2', [ids.cpt, ids.fo]);
  await user('crewUser', 'crew@test.local', 'CREW', { crew: ids.fo });
  await user('crewOther', 'crew2@test.local', 'CREW', { crew: ids.cpt2 });
  const pax = await one(owner, `INSERT INTO passenger(first_name,last_name,date_of_birth,email)
    VALUES ('Meera','Iyer','1995-05-05','meera@test.local') RETURNING passenger_id`);
  ids.passenger = pax.passenger_id;
  await user('pax', 'meera@test.local', 'PASSENGER', { passenger: ids.passenger });
}, 60000);

afterAll(async () => {
  await owner.end();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
});

describe('schema integrity', () => {
  test('seat maps match aircraft capacity, checked at COMMIT', async () => {
    const r = await one(owner, `SELECT count(*)::int AS bad FROM aircraft a
      WHERE capacity <> (SELECT count(*) FROM seat s WHERE s.aircraft_id = a.aircraft_id)`);
    expect(r.bad).toBe(0);
    await expect(owner.query('UPDATE aircraft SET capacity = capacity + 1 WHERE aircraft_id = $1', [ids.ac1]))
      .rejects.toMatchObject({ code: '23514' });
  });

  test('seat-map generator assigns window / middle / aisle seats and exit rows', async () => {
    const rows = (await owner.query(`SELECT seat_number, seat_position, is_exit_row FROM seat
      WHERE aircraft_id=$1 AND seat_number IN ('12A','12B','12C','12D','3A')`, [ids.ac1])).rows;
    const by = Object.fromEntries(rows.map(r => [r.seat_number, r]));
    expect(by['12A']).toMatchObject({ seat_position: 'Window', is_exit_row: true });
    expect(by['12B'].seat_position).toBe('Middle');
    expect(by['12C'].seat_position).toBe('Aisle');
    expect(by['12D'].seat_position).toBe('Aisle');
    expect(by['3A'].is_exit_row).toBe(false);
  });

  test('airport time zones are validated against the IANA catalogue', async () => {
    await expect(owner.query(`INSERT INTO airport(airport_code,airport_name,city,country,timezone,latitude,longitude)
      VALUES ('ZZZ','Nowhere Intl','Nowhere','IN','Mars/Olympus',0,0)`)).rejects.toMatchObject({ code: '23514' });
  });
});

describe('aircraft scheduling (exclusion constraint)', () => {
  test('an aircraft cannot fly overlapping sectors or skip its 45-minute turnaround', async () => {
    ids.f1 = await schedule('SK901', ids.ac1, 'BLR', 'DEL', 48, 2.75);
    // Overlaps SK901 outright.
    await expect(schedule('SK902', ids.ac1, 'DEL', 'BLR', 49, 2.75)).rejects.toMatchObject({ code: '23P01' });
    // Departs 30 minutes after SK901 lands: inside the turnaround.
    await expect(schedule('SK902', ids.ac1, 'DEL', 'BLR', 48 + 2.75 + 0.5, 2.75)).rejects.toMatchObject({ code: '23P01' });
    // 60 minutes later is legal.
    ids.f2 = await schedule('SK902', ids.ac1, 'DEL', 'BLR', 48 + 2.75 + 1, 2.75);
    expect(ids.f2).toBeTruthy();
  });

  test('fare buckets sell exactly the cabins the aircraft has', async () => {
    const rows = (await owner.query('SELECT fare_class, seats_allocated FROM flight_fare WHERE flight_id=$1 ORDER BY 1', [ids.f1])).rows;
    expect(rows).toEqual([{ fare_class: 'Business', seats_allocated: 8 }, { fare_class: 'Economy', seats_allocated: 174 }]);
    await expect(ops(c => c.query('SELECT fn_schedule_flight($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)',
      ['SK903', ids.ac2, 'BLR', 'MAA', at(30), at(31), JSON.stringify({ Economy: 4000 })]))).rejects.toThrow(/Missing base fare for Business/);
  });

  test('only operations staff can schedule; the app role cannot write tables directly', async () => {
    await expect(as(ids.pax, c => c.query('SELECT fn_schedule_flight($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)',
      ['SK904', ids.ac2, 'BLR', 'MAA', at(30), at(31), FARES]))).rejects.toMatchObject({ code: '42501' });
    await expect(as(ids.ops, c => c.query("UPDATE flight SET gate='Z9'"))).rejects.toMatchObject({ code: '42501' });
    await expect(as(ids.ops, c => c.query('DELETE FROM crew_assignment'))).rejects.toMatchObject({ code: '42501' });
  });

  test('flight status follows the state machine', async () => {
    await expect(owner.query("UPDATE flight SET flight_status='Landed' WHERE flight_id=$1", [ids.f2]))
      .rejects.toThrow(/Illegal flight status change Scheduled -> Landed/);
    await expect(owner.query(`INSERT INTO flight(flight_number,aircraft_id,origin,destination,departure_time,arrival_time,flight_status)
      VALUES ('SK999',$1,'BLR','GOI',now()+interval '9 days',now()+interval '9 days 1 hour','Landed')`, [ids.ac3]))
      .rejects.toThrow(/start as Scheduled/);
  });
});

describe('crew legality', () => {
  const assign = (crew: string, flight: string, role: string) =>
    ops(c => c.query('CALL sp_assign_crew($1,$2,$3)', [crew, flight, role]));

  test('legality report explains each rule', async () => {
    const rules = (await ops(c => c.query('SELECT * FROM fn_crew_legality($1,$2,$3)', [ids.expired, ids.f1, 'Captain']))).rows;
    expect(rules.find(r => r.rule === 'TYPE_RATING')).toMatchObject({ passed: false });
    expect(rules.find(r => r.rule === 'TYPE_RATING').detail).toMatch(/expired on 2020-01-01/);
    expect(rules.filter(r => !r.passed)).toHaveLength(1);
  });

  test('illegal assignments are refused with the failing rule', async () => {
    await expect(assign(ids.expired, ids.f1, 'Captain')).rejects.toThrow(/TYPE_RATING/);
    await expect(assign(ids.fo, ids.f1, 'Captain')).rejects.toThrow(/ROLE/);
    await expect(assign(ids.purser, ids.f1, 'First Officer')).rejects.toThrow(/ROLE/);
  });

  test('a full legal crew can be assigned and completes the flight', async () => {
    for (const [crew, role] of [[ids.cpt, 'Captain'], [ids.fo, 'First Officer'], [ids.purser, 'Purser'],
      [ids.cc1, 'Cabin Crew'], [ids.cc2, 'Cabin Crew'], [ids.cc3, 'Cabin Crew']]) await assign(crew, ids.f1, role);
    expect((await ops(c => one(c, 'SELECT fn_flight_crew_complete($1) AS ok', [ids.f1]))).ok).toBe(true);
    await expect(assign(ids.cpt2, ids.f1, 'Captain')).rejects.toThrow(/ROLE_SLOT/);
  });

  test('crew must be where the flight departs, and cannot overlap duties', async () => {
    // cc4 is based in BLR; SK902 departs DEL.
    await expect(assign(ids.cc4, ids.f2, 'Cabin Crew')).rejects.toThrow(/POSITION/);
    // The captain flies SK901 BLR->DEL, so DEL->BLR an hour later is a legal continuation.
    await assign(ids.cpt, ids.f2, 'Captain');
    // A third sector the same day would push the duty period past 13 hours.
    ids.f3 = await schedule('SK905', ids.ac1, 'BLR', 'DEL', 48 + 7.5, 2.75);
    ids.f4 = await schedule('SK906', ids.ac1, 'DEL', 'BLR', 48 + 11.25, 2.75);
    await assign(ids.cpt, ids.f3, 'Captain');
    await expect(assign(ids.cpt, ids.f4, 'Captain')).rejects.toThrow(/DUTY_PERIOD/);
    // The database itself refuses overlapping duties even for privileged direct writes.
    await expect(owner.query(`INSERT INTO crew_assignment(crew_id,flight_id,role_on_flight,duty_start,duty_end)
      VALUES ($1,$2,'Cabin Crew',$3,$4)`, [ids.cc1, ids.f3, at(48.5), at(52)])).rejects.toMatchObject({ code: '23P01' });
  });

  test('boarding is blocked until the crew is complete', async () => {
    await expect(ops(c => c.query("CALL sp_update_flight_status($1,'Boarding')", [ids.f2]))).rejects.toThrow(/crew is incomplete/);
  });
});

describe('row-level security', () => {
  test('crew see their own duties and colleagues on those flights; passengers see no crew', async () => {
    const mine = (await as(ids.crewUser, c => c.query('SELECT DISTINCT flight_id FROM crew_assignment'))).rows;
    expect(mine.map(r => r.flight_id)).toEqual([ids.f1]);
    const colleagues = (await as(ids.crewUser, c => c.query('SELECT count(*)::int AS n FROM crew_assignment WHERE flight_id=$1', [ids.f1]))).rows[0];
    expect(colleagues.n).toBe(6);
    expect((await as(ids.pax, c => c.query('SELECT * FROM crew_assignment'))).rows).toHaveLength(0);
    expect((await as(ids.pax, c => c.query('SELECT crew_id, crew_name FROM crew'))).rows).toHaveLength(0);
  });

  test('salaries are not readable by the application role, only via the admin routine', async () => {
    await expect(as(ids.ops, c => c.query('SELECT salary FROM crew'))).rejects.toMatchObject({ code: '42501' });
    await expect(as(ids.ops, c => c.query('SELECT * FROM fn_crew_admin()'))).rejects.toMatchObject({ code: '42501' });
    const rows = (await as(ids.admin, c => c.query('SELECT salary FROM fn_crew_admin()'))).rows;
    expect(rows.length).toBeGreaterThan(0);
  });

  test('recursive crew chain walks the hierarchy and survives a cycle', async () => {
    const chain = (await as(ids.crewUser, c => c.query('SELECT crew_name, depth FROM fn_crew_chain($1)', [ids.fo]))).rows;
    expect(chain).toEqual([{ crew_name: 'Asha Rao', depth: -1 }, { crew_name: 'Tara Nair', depth: 0 }]);
    await owner.query('UPDATE crew SET supervisor_id=$1 WHERE crew_id=$2', [ids.fo, ids.cpt]);   // cycle
    const cyclic = (await as(ids.ops, c => c.query('SELECT * FROM fn_crew_chain($1)', [ids.fo]))).rows;
    expect(cyclic.length).toBeLessThan(10);
    await owner.query('UPDATE crew SET supervisor_id=NULL WHERE crew_id=$1', [ids.cpt]);
  });
});

describe('delays and disruption', () => {
  test('a delay pushes the aircraft rotation (knock-on) and moves crew duties', async () => {
    // Cabin crew 1 works SK901 into DEL, then SK910 on ANOTHER aircraft 60 minutes later.
    ids.f10 = await schedule('SK910', ids.ac2, 'DEL', 'MAA', 48 + 2.75 + 1, 2.5);
    await ops(c => c.query("CALL sp_assign_crew($1,$2,'Cabin Crew')", [ids.cc1, ids.f10]));
    // SK902 leaves 60 min after SK901 lands; a 90-minute delay leaves it 15 minutes short, and the
    // shortfall ripples through the rest of the aircraft's tight rotation (SK905, SK906).
    const result = (await ops(c => one(c, "CALL sp_update_flight_status($1,NULL,90,NULL,'Weather',NULL)", [ids.f1]))).p_result;
    expect(result.status).toBe('Delayed');
    expect(result.knockOn).toEqual([
      { flightId: ids.f2, flightNumber: 'SK902', addedMinutes: 75 },
      { flightId: ids.f3, flightNumber: 'SK905', addedMinutes: 60 },
      { flightId: ids.f4, flightNumber: 'SK906', addedMinutes: 45 },
    ]);
    const f2 = await one(owner, 'SELECT flight_status, delay_minutes, delay_reason FROM flight WHERE flight_id=$1', [ids.f2]);
    expect(f2).toEqual({ flight_status: 'Delayed', delay_minutes: 75, delay_reason: 'Late inbound aircraft' });
    // Crew duties travel with their flights...
    const duty = await one(owner, `SELECT bool_and(ca.duty_start = f.departure_time - interval '30 minutes') AS moved
      FROM crew_assignment ca JOIN flight f USING (flight_id) WHERE ca.crew_id=$1`, [ids.cpt]);
    expect(duty.moved).toBe(true);
    // ...and a duty on another aircraft that now collides is released for re-crewing.
    expect(result.releasedCrew).toEqual([{ crewId: ids.cc1, flightId: ids.f10 }]);
    expect((await one(owner, 'SELECT count(*)::int AS n FROM crew_assignment WHERE flight_id=$1', [ids.f10])).n).toBe(0);
    await expect(ops(c => c.query('CALL sp_update_flight_status($1,NULL,120)', [ids.f1]))).rejects.toThrow(/delay reason/);
  });

  test('cancelling a flight disrupts tickets and bookings, frees crew and notifies via the outbox', async () => {
    ids.pnr = (await as(ids.pax, c => one(c, 'SELECT fn_book($1,$2::jsonb) AS pnr', [ids.passenger,
      JSON.stringify([{ flightId: ids.f1, passengerId: ids.passenger, fareClass: 'Economy', seatNumber: '14C' }])]))).pnr;
    const total = (await one(owner, 'SELECT total_amount FROM booking WHERE booking_id=$1', [ids.pnr])).total_amount;
    await as(ids.pax, c => c.query("CALL sp_pay($1,$2,'UPI','TEST-PAY-1')", [ids.pnr, total]));
    const result = (await ops(c => one(c, "CALL sp_cancel_flight($1,'Bird strike on inbound aircraft',NULL)", [ids.f1]))).p_result;
    expect(result).toMatchObject({ disruptedTickets: 1, disruptedBookings: 1, releasedCrew: 6 });
    expect(await one(owner, 'SELECT ticket_status, seat_number FROM ticket WHERE booking_id=$1', [ids.pnr]))
      .toEqual({ ticket_status: 'Disrupted', seat_number: '14C' });
    expect((await one(owner, 'SELECT booking_status FROM booking WHERE booking_id=$1', [ids.pnr])).booking_status).toBe('Disrupted');
    const event = await one(owner, "SELECT payload FROM outbox_event WHERE event_type='FLIGHT_CANCELLED' ORDER BY event_id DESC LIMIT 1");
    expect(event.payload.bookings).toEqual([{ bookingId: ids.pnr, userId: ids.pax }]);
    // A cancelled sector no longer blocks the aircraft.
    ids.f1b = await schedule('SK907', ids.ac1, 'BLR', 'DEL', 48 + 0.5, 2.75);
    expect(ids.f1b).toBeTruthy();
  });

  test('ops re-books the disrupted passenger on the same PNR at no extra cost', async () => {
    const pending = (await ops(c => c.query('SELECT * FROM fn_disrupted_tickets()'))).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ booking_id: ids.pnr, origin: 'BLR', destination: 'DEL' });
    // Wrong destination and non-connecting legs are refused.
    await expect(ops(c => c.query('CALL sp_rebook_ticket($1,1::smallint,$2::bigint[],NULL)', [ids.pnr, [ids.f2]])))
      .rejects.toThrow(/must depart BLR/);
    const result = (await ops(c => one(c, 'CALL sp_rebook_ticket($1,1::smallint,$2::bigint[],NULL)', [ids.pnr, [ids.f1b]]))).p_result;
    expect(result).toMatchObject({ bookingStatus: 'Confirmed', newSeqs: [2] });
    const booking = await one(owner, 'SELECT total_amount, amount_paid FROM booking WHERE booking_id=$1', [ids.pnr]);
    expect(booking.total_amount).toBe(booking.amount_paid);
    expect(await one(owner, 'SELECT ticket_status, replaces_seq, seat_number FROM ticket WHERE booking_id=$1 AND ticket_seq=2', [ids.pnr]))
      .toEqual({ ticket_status: 'Active', replaces_seq: 1, seat_number: null });
    expect((await ops(c => c.query('SELECT * FROM fn_disrupted_tickets()'))).rows).toHaveLength(0);
    await expect(ops(c => c.query('CALL sp_rebook_ticket($1,1::smallint,$2::bigint[],NULL)', [ids.pnr, [ids.f1b]])))
      .rejects.toThrow(/not disrupted|already been re-booked/);
  });
});

describe('outbox', () => {
  test('two dispatchers never claim the same event (FOR UPDATE SKIP LOCKED)', async () => {
    const a = await owner.connect(), b = await owner.connect();
    try {
      for (const c of [a, b]) { await c.query('BEGIN'); await c.query('SET LOCAL ROLE strata_app'); }
      const first = (await a.query('SELECT event_id FROM fn_outbox_claim(25)')).rows.map(r => r.event_id);
      const second = (await b.query('SELECT event_id FROM fn_outbox_claim(25)')).rows.map(r => r.event_id);
      expect(first.length).toBe(25);
      expect(second.filter(id => first.includes(id))).toEqual([]);
      await a.query('SELECT fn_outbox_complete($1::bigint[])', [first]);
      await b.query('SELECT fn_outbox_fail($1, $2)', [second[0], 'neo4j unavailable']);
      await a.query('COMMIT'); await b.query('ROLLBACK');
    } finally { a.release(); b.release(); }
    const done = await one(owner, 'SELECT count(*)::int AS n FROM outbox_event WHERE processed_at IS NOT NULL');
    expect(done.n).toBe(25);
  });

  test('failures back off exponentially and completion is idempotent', async () => {
    const id = (await one(owner, 'SELECT event_id FROM outbox_event WHERE processed_at IS NULL ORDER BY event_id LIMIT 1')).event_id;
    await as(ids.ops, c => c.query("SELECT fn_outbox_fail($1,'boom')", [id]));
    await as(ids.ops, c => c.query("SELECT fn_outbox_fail($1,'boom again')", [id]));
    const row = await one(owner, "SELECT attempts, last_error, next_attempt_at > now() + interval '3 seconds' AS later FROM outbox_event WHERE event_id=$1", [id]);
    expect(row).toEqual({ attempts: 2, last_error: 'boom again', later: true });
    expect((await as(ids.ops, c => one(c, 'SELECT fn_outbox_complete($1::bigint[]) AS n', [[id]]))).n).toBe(1);
    expect((await as(ids.ops, c => one(c, 'SELECT fn_outbox_complete($1::bigint[]) AS n', [[id]]))).n).toBe(0);
  });

  test('state changes and audit entries are written in the same transaction', async () => {
    const before = (await one(owner, "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='AUDIT_LOG'")).n;
    await expect(ops(async c => {
      await c.query("CALL sp_update_flight_status($1,NULL,NULL,'B12')", [ids.f2]);
      throw new Error('roll back');
    })).rejects.toThrow('roll back');
    expect((await one(owner, "SELECT count(*)::int AS n FROM outbox_event WHERE event_type='AUDIT_LOG'")).n).toBe(before);
    expect((await one(owner, 'SELECT gate FROM flight WHERE flight_id=$1', [ids.f2])).gate).toBe('A1');
  });
});

describe('analytics', () => {
  test('revenue materialized view refreshes concurrently through the ops routine', async () => {
    await ops(c => c.query('CALL sp_refresh_analytics()'));
    const rows = (await ops(c => c.query('SELECT * FROM fn_route_revenue(12)'))).rows;
    expect(rows.find(r => r.origin === 'BLR' && r.destination === 'DEL')).toBeTruthy();
    await expect(as(ids.pax, c => c.query('SELECT * FROM fn_route_revenue(12)'))).rejects.toMatchObject({ code: '42501' });
  });
});
