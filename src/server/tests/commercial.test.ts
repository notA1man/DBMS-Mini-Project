import { afterAll, beforeAll, expect, test } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { commercialQueries } from '../queries/commercial';

process.loadEnvFile('.env');
const database = `strata_commercial_test_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
const url = new URL(process.env.DATABASE_URL_OWNER!);
url.pathname = `/${database}`;
const owner = new Pool({ connectionString: url.toString(), max: 55 });
owner.on('error', () => {}); // idle clients are terminated when the test database is dropped
let created = false;
let booking: string;

async function asUser<T>(id: number, fn: (c: PoolClient) => Promise<T>) {
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE strata_app');
    // Deliberately lie about role: authorization must use the account row.
    await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.role','ADMIN',true)", [String(id)]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally { c.release(); }
}
const book = (c: PoolClient, flightId=1, seatNumber: string | null='1A', passengerId=1, fareClass='Economy') =>
  c.query('SELECT fn_book($1,$2::jsonb) AS pnr', [passengerId, JSON.stringify([{flightId, passengerId, fareClass, seatNumber}])]);

beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  // Real migrations in production order (placeholders skipped), then deterministic test data.
  const migrations = (await readdir('db/postgres/init')).filter(f => f.endsWith('.sql')).sort().map(f => `init/${f}`);
  for (const file of [...migrations, 'tests/fixtures/ops_data.sql']) {
    const sql = await readFile(`db/postgres/${file}`, 'utf8');
    if (sql.replace(/--[^\n]*/g, '').trim()) await owner.query(sql);
  }
  await owner.query(`INSERT INTO passenger(first_name,last_name,date_of_birth,email)
    SELECT 'Passenger',n::text,'2000-01-01','test'||n||'@example.com' FROM generate_series(1,60) n`);
  await owner.query(`INSERT INTO app_user(email,password_hash,role,passenger_id)
    SELECT email,'test-only','PASSENGER',passenger_id FROM passenger`);
}, 30000);

afterAll(async () => {
  await owner.end();
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
});

test('50 parallel requests for one seat yield exactly one sale', async () => {
  const results = await Promise.allSettled(Array.from({length:50},(_,i) => asUser(i+1,c=>book(c,4,'1A',i+1))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const counts=await owner.query("SELECT count(*)::int AS n FROM ticket WHERE flight_id=4");
  expect(counts.rows[0].n).toBe(1);
  const orphan=await owner.query('SELECT count(*)::int AS n FROM booking b WHERE NOT EXISTS(SELECT 1 FROM ticket t WHERE t.booking_id=b.booking_id)');
  expect(orphan.rows[0].n).toBe(0);
},30000);

test('booking prices tickets and synchronizes total', async () => {
  booking=(await asUser(1,c=>book(c))).rows[0].pnr;
  const {rows}=await asUser(1,c=>c.query('SELECT * FROM v_booking_summary WHERE booking_id=$1',[booking]));
  expect(Number(rows[0].total_amount)).toBe(1300);
  expect(rows[0].active_tickets).toBe('1');
});

test('RLS hides another passenger booking, tickets, receipts and passenger data', async () => {
  for (const table of ['booking','ticket','payment']) {
    const result=await asUser(2,c=>c.query(`SELECT * FROM ${table} WHERE booking_id=$1`,[booking]));
    expect(result.rows).toHaveLength(0);
  }
  expect((await asUser(2,c=>c.query('SELECT * FROM passenger WHERE passenger_id=1'))).rows).toHaveLength(0);
  await expect(asUser(2,c=>c.query('CALL sp_pay($1,100,\'UPI\')',[booking]))).rejects.toMatchObject({code:'42501'});
});

test('app cannot write totals, payments, user roles or read hashes', async () => {
  for (const sql of ["UPDATE booking SET total_amount=0",'DELETE FROM ticket',
    "UPDATE app_user SET role='ADMIN'",'SELECT password_hash FROM app_user']) {
    await expect(asUser(1,c=>c.query(sql))).rejects.toMatchObject({code:'42501'});
  }
});

test('booking fails atomically for a bad second leg', async () => {
  await expect(asUser(1,c=>c.query('SELECT fn_book(1,$1)',[JSON.stringify([
    {flightId:2,passengerId:1,fareClass:'Economy',seatNumber:'1B'},
    {flightId:3,passengerId:1,fareClass:'Economy',seatNumber:'1A'},
  ])]))).rejects.toThrow('Flight unavailable');
  expect((await owner.query('SELECT * FROM ticket WHERE flight_id=2')).rows).toHaveLength(0);
});

test('cannot claim another booker or select a seat in another fare class', async () => {
  await expect(asUser(2,c=>book(c,1,'1B',1))).rejects.toMatchObject({code:'42501'});
  await expect(asUser(2,c=>book(c,1,'2A',2))).rejects.toThrow('fare class');
});

test('unpaid booking cannot check in', async () => {
  await expect(asUser(1,c=>c.query('CALL sp_check_in($1,1::smallint,\'1A\')',[booking]))).rejects.toThrow('confirmed');
});

test('partial then final payment creates one receipt each; retry is idempotent', async () => {
  await asUser(1,c=>c.query("CALL sp_pay($1,150,'UPI','test-partial')",[booking]));
  await asUser(1,c=>c.query("CALL sp_pay($1,150,'UPI','test-partial')",[booking]));
  expect((await owner.query('SELECT booking_status FROM booking WHERE booking_id=$1',[booking])).rows[0].booking_status).toBe('Pending');
  await expect(asUser(1,c=>c.query("CALL sp_pay($1,1151,'Card')",[booking]))).rejects.toThrow('Invalid payment');
  await asUser(1,c=>c.query("CALL sp_pay($1,1150,'Card','test-final')",[booking]));
  await asUser(1,c=>c.query("CALL sp_pay($1,1150,'Card','test-final')",[booking]));
  const {rows}=await asUser(1,c=>c.query('SELECT * FROM booking WHERE booking_id=$1',[booking]));
  expect(rows[0].booking_status).toBe('Confirmed');
  expect(Number(rows[0].amount_paid)).toBe(1300);
  expect((await asUser(1,c=>c.query('SELECT * FROM receipt'))).rows).toHaveLength(2);
  expect((await asUser(2,c=>c.query('SELECT * FROM receipt'))).rows).toHaveLength(0);
});

test('check-in issues boarding code and accepts same-seat retry', async () => {
  await asUser(1,c=>c.query("CALL sp_check_in($1,1::smallint,'1A')",[booking]));
  await asUser(1,c=>c.query("CALL sp_check_in($1,1::smallint,'1A')",[booking]));
  expect((await owner.query('SELECT boarding_pass_code FROM ticket WHERE booking_id=$1',[booking])).rows[0].boarding_pass_code).toHaveLength(32);
});

test('baggage allowance applies to aggregate weight', async () => {
  await asUser(1,c=>c.query("CALL sp_add_baggage($1,1::smallint,12,'Checked')",[booking]));
  await asUser(1,c=>c.query("CALL sp_add_baggage($1,1::smallint,8,'Checked')",[booking]));
  await expect(asUser(1,c=>c.query("CALL sp_add_baggage($1,1::smallint,1,'Checked')",[booking]))).rejects.toThrow('allowance exceeded');
  await expect(asUser(1,c=>c.query("CALL sp_add_baggage($1,1::smallint,8,'Cabin')",[booking]))).rejects.toThrow('allowance exceeded');
});

test('paid booking outside 48h window cannot check in', async () => {
  const pnr=(await asUser(2,c=>book(c,2,'1B',2))).rows[0].pnr;
  await asUser(2,c=>c.query("CALL sp_pay($1,1150,'UPI')",[pnr]));
  await expect(asUser(2,c=>c.query("CALL sp_check_in($1,1::smallint,'1B')",[pnr]))).rejects.toThrow('48 to 1 hours');
});

test('cancel releases seat, clears check-in and computes simulated refund', async () => {
  await asUser(1,c=>c.query("CALL sp_cancel_booking($1,'Plans changed')",[booking]));
  await asUser(1,c=>c.query("CALL sp_cancel_booking($1,'Plans changed')",[booking]));
  const {rows}=await owner.query('SELECT * FROM booking WHERE booking_id=$1',[booking]);
  expect(rows[0].booking_status).toBe('Cancelled');
  expect(Number(rows[0].refund_amount)).toBe(1170);
  expect(Number(rows[0].total_amount)).toBe(0);
  const map=await asUser(1,c=>c.query('SELECT * FROM fn_seat_map(1) WHERE seat_number=\'1A\''));
  expect(map.rows[0].available).toBe(true);
  await asUser(3,c=>book(c,1,'1A',3));
});

test('fare bucket capacity holds even without seat reservations', async () => {
  const results=await Promise.allSettled([4,5,6,7,8].map(id=>asUser(id,c=>book(c,1,null,id))));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
});

test('registration is atomic and authentication locks out after five bad attempts', async () => {
  const password='a-long-test-password';
  const registered=await asUser(1,c=>c.query("SELECT fn_register('New@Example.com',$1,'New','User','2001-01-01') AS id",[password]));
  const id=registered.rows[0].id;
  const login=()=>asUser(1,c=>c.query("SELECT * FROM fn_authenticate('new@example.com',$1)",[password]));
  expect((await login()).rows[0].user_id).toBe(id);
  await expect(asUser(1,c=>c.query("SELECT fn_register('New@Example.com',$1,'New','User','2001-01-01')",[password]))).rejects.toMatchObject({code:'23505'});
  for(let i=0;i<5;i++) {
    expect((await asUser(1,c=>c.query("SELECT * FROM fn_authenticate('new@example.com','incorrect-password')"))).rows).toHaveLength(0);
  }
  expect((await login()).rows).toHaveLength(0);
  await owner.query("UPDATE app_user SET locked_until=now()-interval '1 minute' WHERE user_id=$1",[id]);
  expect((await login()).rows).toHaveLength(1);
  expect((await owner.query('SELECT failed_logins FROM app_user WHERE user_id=$1',[id])).rows[0].failed_logins).toBe(0);
},15000);

test('disabled users lose database access even with an existing context', async () => {
  await owner.query('UPDATE app_user SET is_active=false WHERE user_id=3');
  expect((await asUser(3,c=>c.query('SELECT * FROM booking'))).rows).toHaveLength(0);
  await expect(asUser(3,c=>book(c,2,'1C',3))).rejects.toMatchObject({code:'42501'});
  await owner.query('UPDATE app_user SET is_active=true WHERE user_id=3');
});

test('confirmation and cancellation publish transactional outbox notifications', async () => {
  const {rows}=await owner.query("SELECT event_type,payload FROM outbox_event WHERE aggregate_id=$1 AND event_type IN ('BOOKING_CONFIRMED','BOOKING_CANCELLED') ORDER BY event_id",[booking]);
  expect(rows.map(r=>r.event_type)).toEqual(['BOOKING_CONFIRMED','BOOKING_CANCELLED']);
  expect(rows[1].payload.refundAmount).toBe(1170);
});

test('hybrid retrieval supports vectors, text-only fallback and category filtering', async () => {
  const embedding=JSON.stringify([1,...Array(383).fill(0)]);
  const doc=await owner.query("INSERT INTO kb_document(title,category,body) VALUES('Bag policy','baggage','Cabin baggage allowance is seven kilograms') RETURNING doc_id");
  await owner.query("INSERT INTO kb_chunk(doc_id,chunk_index,content,embedding) VALUES($1,0,'Cabin baggage allowance is seven kilograms',$2::vector)",[doc.rows[0].doc_id,embedding]);
  expect((await asUser(1,c=>c.query("SELECT * FROM fn_hybrid_kb($1::vector,'baggage','baggage')",[embedding]))).rows).toHaveLength(1);
  expect((await asUser(1,c=>c.query("SELECT * FROM fn_hybrid_kb(NULL,'baggage','baggage')"))).rows).toHaveLength(1);
  expect((await asUser(1,c=>c.query("SELECT * FROM fn_hybrid_kb(NULL,'baggage','pets')"))).rows).toHaveLength(0);
});

test('additional travelers and booking are atomic; booker can read companion details',async()=>{
  await expect(asUser(1,async c=>{
    await c.query("SELECT fn_add_traveler('rollback@example.com','Guest','One','2000-01-01')");
    await c.query("SELECT fn_add_traveler('test1@example.com','Guest','Two','2000-01-01')");
  })).rejects.toMatchObject({code:'23505'});
  expect((await owner.query("SELECT * FROM passenger WHERE email='rollback@example.com'")).rows).toHaveLength(0);
  await asUser(1,async c=>{
    const guest=(await c.query("SELECT fn_add_traveler('guest@example.com','Guest','Traveler','2000-01-01') AS id")).rows[0].id;
    await c.query('SELECT fn_book(1,$1::jsonb)',[JSON.stringify([{flightId:2,passengerId:guest,fareClass:'Business',seatNumber:'2A'}])]);
    expect((await c.query('SELECT * FROM passenger WHERE passenger_id=$1',[guest])).rows).toHaveLength(1);
    expect((await c.query("SELECT fn_add_traveler('guest@example.com','Guest','Traveler','2000-01-01') AS id")).rows[0].id).toBe(guest);
  });
});

test('crew can read only assigned manifests and cannot read financial rows',async()=>{
  await owner.query(`INSERT INTO crew(crew_name,designation,license_number,salary,hire_date,base_airport)
    VALUES ('Test Crew One','Purser','TEST-CREW-1',1,'2020-01-01','BLR'),('Test Crew Two','Purser','TEST-CREW-2',1,'2020-01-01','BLR')`);
  await owner.query(`INSERT INTO crew_assignment(crew_id,flight_id,role_on_flight,duty_start,duty_end)
    SELECT 1, flight_id, 'Purser', departure_time - interval '30 minutes', arrival_time + interval '15 minutes' FROM flight WHERE flight_id=2`);
  const ids=(await owner.query(`INSERT INTO app_user(email,password_hash,role,crew_id)
    VALUES('crew1@example.com','test-only','CREW',1),('crew2@example.com','test-only','CREW',2) RETURNING user_id`)).rows;
  const assigned=Number(ids[0].user_id),unassigned=Number(ids[1].user_id);
  const tickets=await asUser(assigned,c=>c.query('SELECT * FROM ticket'));
  expect(tickets.rows.length).toBeGreaterThan(0);
  expect(tickets.rows.every(t=>t.flight_id==='2')).toBe(true);
  expect((await asUser(assigned,c=>c.query('SELECT * FROM passenger'))).rows.length).toBeGreaterThan(0);
  expect((await asUser(unassigned,c=>c.query('SELECT * FROM passenger'))).rows).toHaveLength(0);
  for(const table of ['booking','payment','receipt']) expect((await asUser(assigned,c=>c.query(`SELECT * FROM ${table}`))).rows).toHaveLength(0);
});

test('failed outbox write rolls payment, receipt and confirmation back together',async()=>{
  const pnr=(await owner.query("SELECT booking_id FROM ticket WHERE fare_class='Business' AND flight_id=2")).rows[0].booking_id;
  const amount=(await owner.query('SELECT total_amount FROM booking WHERE booking_id=$1',[pnr])).rows[0].total_amount;
  await owner.query("ALTER TABLE outbox_event ADD CONSTRAINT test_reject_confirmation CHECK(event_type<>'BOOKING_CONFIRMED') NOT VALID");
  try {
    await expect(asUser(1,c=>c.query("CALL sp_pay($1,$2,'UPI')",[pnr,amount]))).rejects.toMatchObject({code:'23514'});
    expect((await owner.query('SELECT * FROM payment WHERE booking_id=$1',[pnr])).rows).toHaveLength(0);
    expect((await owner.query('SELECT amount_paid FROM booking WHERE booking_id=$1',[pnr])).rows[0].amount_paid).toBe('0.00');
  }finally{await owner.query('ALTER TABLE outbox_event DROP CONSTRAINT test_reject_confirmation');}
});

test('only administrators can create staff and change account roles',async()=>{
  await expect(asUser(1,c=>c.query('SELECT * FROM fn_admin_users()'))).rejects.toMatchObject({code:'42501'});
  const adminId=Number((await owner.query("INSERT INTO app_user(email,password_hash,role) VALUES('admin@example.com','test-only','ADMIN') RETURNING user_id")).rows[0].user_id);
  await asUser(adminId,c=>c.query("CALL sp_admin_create_user('ops@example.com','temporary-password','OPS')"));
  const ops=Number((await owner.query("SELECT user_id FROM app_user WHERE email='ops@example.com'")).rows[0].user_id);
  await asUser(adminId,c=>c.query("CALL sp_admin_user($1,'OPS',false,NULL)",[ops]));
  expect((await asUser(ops,c=>c.query('SELECT * FROM fn_session_user()'))).rows).toHaveLength(0);
  await expect(asUser(adminId,c=>c.query("CALL sp_admin_user($1,'OPS',true,NULL)",[adminId]))).rejects.toThrow('own administrator');
});

test('direct search uses the origin airport calendar date across UTC midnight',async()=>{
  await owner.query("UPDATE flight SET departure_time='2030-01-02 00:30:00+05:30',arrival_time='2030-01-02 02:30:00+05:30' WHERE flight_id=2");
  const today=await asUser(1,c=>c.query(commercialQueries.directFlights,['BLR','BOM','2030-01-02']));
  const yesterday=await asUser(1,c=>c.query(commercialQueries.directFlights,['BLR','BOM','2030-01-01']));
  expect(today.rows.some(f=>f.flight_id==='2')).toBe(true);
  expect(yesterday.rows.some(f=>f.flight_id==='2')).toBe(false);
});

test('request budgets persist and reset after the window expires',async()=>{
  const key='a'.repeat(64);
  for(let n=0;n<3;n++) expect((await asUser(1,c=>c.query('SELECT fn_request_budget($1,3,60) AS allowed',[key]))).rows[0].allowed).toBe(true);
  expect((await asUser(1,c=>c.query('SELECT fn_request_budget($1,3,60) AS allowed',[key]))).rows[0].allowed).toBe(false);
  await owner.query("UPDATE auth_rate_limit SET bucket_start=now()-interval '2 minutes' WHERE key=$1",[key]);
  expect((await asUser(1,c=>c.query('SELECT fn_request_budget($1,3,60) AS allowed',[key]))).rows[0].allowed).toBe(true);
});

test('commercial audit entries carry the database actor but no credentials',async()=>{
  const rows=(await owner.query("SELECT payload FROM outbox_event WHERE event_type='AUDIT_LOG' AND aggregate_id=$1",[booking])).rows;
  expect(rows.some(r=>r.payload.action==='PAY' && r.payload.userId==='1')).toBe(true);
  expect(rows.every(r=>!('password' in r.payload) && !('password_hash' in r.payload))).toBe(true);
});

test('passport storage encrypts with pgcrypto and enforces ownership',async()=>{
  const key='test-encryption-key-with-at-least-32-bytes';
  await asUser(1,c=>c.query("CALL sp_store_passport(1,'A1234567',$1)",[key]));
  const record=(await owner.query('SELECT passport_no_enc,pgp_sym_decrypt(passport_no_enc,$1) AS plaintext FROM passenger WHERE passenger_id=1',[key])).rows[0];
  expect(record.plaintext).toBe('A1234567');expect(record.passport_no_enc.toString('utf8')).not.toContain('A1234567');
  await expect(asUser(2,c=>c.query("CALL sp_store_passport(1,'A1234567',$1)",[key]))).rejects.toMatchObject({code:'42501'});
  await expect(asUser(1,c=>c.query("CALL sp_store_passport(1,'A1234567','short')"))).rejects.toThrow('Encryption key');
});

test('staff can execute filtered vector similarity under the application role',async()=>{
  const vector=JSON.stringify([1,...Array(383).fill(0)]);
  await owner.query("INSERT INTO feedback_embedding(feedback_oid,flight_id,sentiment,embedding) VALUES('000000000000000000000001',2,'neutral',$1::vector)",[vector]);
  const uid=Number((await owner.query("SELECT user_id FROM app_user WHERE email='admin@example.com'")).rows[0].user_id);
  expect((await asUser(uid,c=>c.query(commercialQueries.similar,[vector,null,'2000-01-01','BLR-BOM']))).rows).toHaveLength(1);
});
