// SYNTHETIC demo traffic (joint): passengers, paid bookings and tickets across the seeded schedule
// so load factors, manifests, revenue and disruption workflows have realistic volume.
//   npm run db:seed:traffic                 (DEMO_LOAD=0.45 for a busier network)
//
// Clearly synthetic: PNRs start with "T" (fn_generate_pnr only produces hex PNRs, so they never
// collide), passengers are "Demo Traveller n" @demo.skyops.test and cannot log in. Historical
// tickets need the ticket validation trigger disabled for this transaction, because the database
// (correctly) refuses to sell seats on flights that have already departed.
import { Pool } from 'pg';
try { process.loadEnvFile('.env'); } catch { /* shell env */ }

const LOAD = Number(process.env.DEMO_LOAD ?? 0.35);
const PASSENGERS = 4000;

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
  const c = await pool.connect();
  const started = Date.now();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('skyops-demo-traffic'))");
    if ((await c.query("SELECT count(*)::int AS n FROM booking WHERE booking_id LIKE 'T%'")).rows[0].n > 0) {
      console.log('Demo traffic already present - nothing to do.');
      await c.query('ROLLBACK');
      return;
    }
    await c.query(`INSERT INTO passenger(first_name, last_name, date_of_birth, email)
      SELECT 'Demo', 'Traveller ' || n, DATE '1960-01-01' + (n * 37 % 15000), 'traveller' || n || '@demo.skyops.test'
      FROM generate_series(1, $1) n ON CONFLICT (email) DO NOTHING`, [PASSENGERS]);
    await c.query(`INSERT INTO app_user(email, password_hash, role, passenger_id)
      SELECT p.email, 'demo-account-no-login', 'PASSENGER', p.passenger_id FROM passenger p
      WHERE p.email LIKE '%@demo.skyops.test' ON CONFLICT (email) DO NOTHING`);

    // Bulk load: the per-row commercial triggers (validation, booking-total sync, receipt issue) are
    // switched off for this transaction only and their effects are applied set-based below.
    await c.query('ALTER TABLE ticket DISABLE TRIGGER trg_ticket_seat_matches_aircraft');
    await c.query('ALTER TABLE ticket DISABLE TRIGGER trg_ticket_amount_sync');
    await c.query('ALTER TABLE payment DISABLE TRIGGER trg_payment_receipt');
    // One booking per ticket. Load rises towards departure; past flights are fuller.
    await c.query(`
      CREATE TEMP TABLE demo_ticket ON COMMIT DROP AS
      WITH demo AS (SELECT row_number() OVER (ORDER BY p.passenger_id) AS k, p.passenger_id, u.user_id
                    FROM passenger p JOIN app_user u USING (passenger_id) WHERE p.email LIKE '%@demo.skyops.test'),
      buckets AS (
        SELECT f.flight_id, f.aircraft_id, f.departure_time, f.flight_status, ff.fare_class, ff.base_fare,
          floor(ff.seats_allocated * least(0.98, $1 * (CASE WHEN f.departure_time < now() THEN 1.35 ELSE 1.25 - extract(epoch FROM f.departure_time - now()) / 86400 / 20 END)
                * (0.6 + 0.8 * ((f.flight_id * 7919 + length(ff.fare_class)) % 100) / 100.0)))::int AS n
        FROM flight f JOIN flight_fare ff USING (flight_id)
        WHERE f.flight_status <> 'Cancelled'),
      seats AS (
        SELECT b.*, s.seat_number, row_number() OVER (PARTITION BY b.flight_id, b.fare_class ORDER BY s.seat_number) AS rn
        FROM buckets b JOIN seat s ON s.aircraft_id = b.aircraft_id AND s.seat_class = b.fare_class)
      SELECT s.flight_id, s.aircraft_id, s.departure_time, s.flight_status, s.fare_class, s.seat_number,
        round(s.base_fare * (1 + 0.5 * s.rn / greatest(s.n, 1)) * (CASE WHEN s.rn % 7 = 0 THEN 1.3 WHEN s.rn % 3 = 0 THEN 1.15 ELSE 1 END), 2) AS fare,
        d.passenger_id, d.user_id,
        row_number() OVER (ORDER BY s.flight_id, s.fare_class, s.rn) AS seq
      FROM seats s
      JOIN demo d ON d.k = 1 + ((s.flight_id * 131 + s.rn * 17 + length(s.fare_class)) % $2)
      WHERE s.rn <= s.n`, [LOAD, PASSENGERS]);
    // The passenger pick above can repeat within a flight; keep the first ticket per (flight, passenger).
    await c.query(`DELETE FROM demo_ticket a USING demo_ticket b
      WHERE a.flight_id = b.flight_id AND a.passenger_id = b.passenger_id AND a.seq > b.seq`);

    await c.query(`INSERT INTO booking(booking_id, booking_date, passenger_id, created_by_user)
      SELECT 'T' || upper(lpad(to_hex(seq::int), 5, '0')), departure_time - make_interval(days => 1 + (seq % 30)::int), passenger_id, user_id
      FROM demo_ticket`);
    await c.query(`INSERT INTO ticket(booking_id, ticket_seq, fare_class, fare_amount, checkin_status, flight_id, passenger_id,
        aircraft_id, seat_number, boarding_pass_code)
      SELECT 'T' || upper(lpad(to_hex(seq::int), 5, '0')), 1, fare_class, fare,
        CASE WHEN flight_status IN ('Departed','Landed') THEN 'CheckedIn' ELSE 'NotCheckedIn' END,
        flight_id, passenger_id, aircraft_id,
        CASE WHEN flight_status IN ('Departed','Landed') OR departure_time < now() + interval '2 days' THEN seat_number END,
        CASE WHEN flight_status IN ('Departed','Landed') THEN md5('demo-bp-' || seq) END
      FROM demo_ticket`);
    // trg_ticket_amount_sync equivalent: total = sum of active tickets.
    await c.query(`UPDATE booking b SET total_amount = t.fare_amount FROM ticket t
      WHERE t.booking_id = b.booking_id AND b.booking_id LIKE 'T%'`);
    // Pay in full; about 4% of future bookings stay unpaid (Pending).
    await c.query(`INSERT INTO payment(amount, payment_mode, gateway_ref, booking_id, payment_date)
      SELECT b.total_amount, (ARRAY['UPI','Card','NetBanking'])[1 + (t.seq % 3)::int], 'DEMO-' || b.booking_id, b.booking_id, b.booking_date + interval '5 minutes'
      FROM booking b JOIN demo_ticket t ON b.booking_id = 'T' || upper(lpad(to_hex(t.seq::int), 5, '0'))
      WHERE t.departure_time < now() OR t.seq % 25 <> 0
      ORDER BY b.booking_date`);   // append-only in time order, as a real payments table would be
    // trg_payment_receipt equivalent: one receipt per payment, booking paid and confirmed.
    await c.query(`INSERT INTO receipt(payment_id, receipt_date)
      SELECT payment_id, payment_date FROM payment WHERE gateway_ref LIKE 'DEMO-%'`);
    await c.query(`UPDATE booking b SET amount_paid = p.amount, booking_status = 'Confirmed'
      FROM payment p WHERE p.booking_id = b.booking_id AND p.gateway_ref LIKE 'DEMO-%'`);
    await c.query('ALTER TABLE ticket ENABLE TRIGGER trg_ticket_seat_matches_aircraft');
    await c.query('ALTER TABLE ticket ENABLE TRIGGER trg_ticket_amount_sync');
    await c.query('ALTER TABLE payment ENABLE TRIGGER trg_payment_receipt');
    const n = (await c.query("SELECT count(*)::int AS n FROM ticket WHERE booking_id LIKE 'T%'")).rows[0].n;
    await c.query('COMMIT');
    await c.query('REFRESH MATERIALIZED VIEW mv_route_revenue_monthly');
    // Fresh planner statistics after a bulk load; without them later queries pick terrible plans.
    await c.query('ANALYZE');
    console.log(`Demo traffic: ${n} tickets in ${((Date.now() - started) / 1000).toFixed(1)} s (load target ${LOAD}).`);
  } catch (error) {
    await c.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { c.release(); await pool.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Demo traffic failed'); process.exitCode = 1; });
