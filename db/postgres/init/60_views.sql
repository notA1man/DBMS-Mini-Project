-- 60_views.sql
-- Owner: Both
-- v_passenger_age, v_aircraft_age (Lab 04), v_flight_load, v_flight_manifest,
-- v_booking_summary, v_crew_roster, v_crew_coverage, mv_route_revenue_monthly
CREATE VIEW v_passenger_age WITH (security_invoker = true) AS
SELECT passenger_id, first_name, middle_name, last_name,
       extract(year FROM age(current_date, date_of_birth))::integer AS age
FROM passenger;
CREATE VIEW v_booking_summary WITH (security_invoker = true) AS
SELECT b.*, (b.total_amount - least(b.amount_paid, b.total_amount))::numeric(12,2) AS amount_due,
       (SELECT count(*) FROM ticket t WHERE t.booking_id=b.booking_id AND t.ticket_status='Active') AS active_tickets
FROM booking b;
-- Operations-owned views are added by Aditya below.

-- ---------------------------------------------------------------- operations (Aditya)
-- security_invoker: callers see what RLS allows them to see.
CREATE VIEW v_aircraft_age WITH (security_invoker = true) AS
SELECT aircraft_id, registration, model, type_rating, status, year_of_manufacture,
       extract(year FROM current_date)::integer - year_of_manufacture AS age_years
FROM aircraft;

-- Seats sold vs allocated, per flight and fare class.
CREATE VIEW v_flight_load WITH (security_invoker = true) AS
SELECT f.flight_id, f.flight_number, f.origin, f.destination, f.departure_time, f.flight_status,
       ff.fare_class, ff.seats_allocated,
       count(t.ticket_seq) FILTER (WHERE t.ticket_status = 'Active') AS seats_sold,
       round(count(t.ticket_seq) FILTER (WHERE t.ticket_status = 'Active')::numeric
             / nullif(ff.seats_allocated, 0), 3) AS load_factor
FROM flight f
JOIN flight_fare ff USING (flight_id)
LEFT JOIN ticket t ON t.flight_id = f.flight_id AND t.fare_class = ff.fare_class
GROUP BY f.flight_id, ff.fare_class, ff.seats_allocated;

-- Passengers, seats, check-in and bags per flight. Ticket/passenger RLS limits crew to
-- flights they are assigned to; passengers only ever see their own rows.
CREATE VIEW v_flight_manifest WITH (security_invoker = true) AS
SELECT t.flight_id, f.flight_number, f.departure_time, t.booking_id, t.ticket_seq,
       p.passenger_id, p.first_name, p.last_name, t.fare_class, t.seat_number,
       t.checkin_status, t.ticket_status,
       (SELECT count(*) FROM baggage b WHERE b.booking_id = t.booking_id AND b.ticket_seq = t.ticket_seq) AS bags,
       (SELECT coalesce(sum(b.weight_kg), 0) FROM baggage b
         WHERE b.booking_id = t.booking_id AND b.ticket_seq = t.ticket_seq) AS bag_weight_kg
FROM ticket t
JOIN flight f USING (flight_id)
JOIN passenger p ON p.passenger_id = t.passenger_id;

-- Upcoming duties per crew member.
CREATE VIEW v_crew_roster WITH (security_invoker = true) AS
SELECT ca.crew_id, c.crew_name, c.designation, ca.flight_id, f.flight_number, f.origin, f.destination,
       f.departure_time, f.arrival_time, f.flight_status, ca.role_on_flight, ca.standby_status,
       ca.duty_start, ca.duty_end
FROM crew_assignment ca
JOIN crew c USING (crew_id)
JOIN flight f USING (flight_id)
WHERE ca.duty_end >= now() - interval '1 day';

-- Flights that cannot legally depart yet: missing captain, first officer or enough cabin
-- crew (one per 50 seats). GROUP BY + HAVING over the roster.
CREATE VIEW v_crew_coverage WITH (security_invoker = true) AS
SELECT f.flight_id, f.flight_number, f.origin, f.destination, f.departure_time, a.capacity,
       count(*) FILTER (WHERE ca.role_on_flight = 'Captain' AND ca.standby_status = 'Assigned') AS captains,
       count(*) FILTER (WHERE ca.role_on_flight = 'First Officer' AND ca.standby_status = 'Assigned') AS first_officers,
       count(*) FILTER (WHERE ca.role_on_flight IN ('Purser','Cabin Crew') AND ca.standby_status = 'Assigned') AS cabin_crew,
       ceil(a.capacity / 50.0)::integer AS cabin_required
FROM flight f
JOIN aircraft a USING (aircraft_id)
LEFT JOIN crew_assignment ca USING (flight_id)
WHERE f.flight_status IN ('Scheduled','Delayed','Boarding') AND f.departure_time > now()
GROUP BY f.flight_id, a.capacity
HAVING count(*) FILTER (WHERE ca.role_on_flight = 'Captain' AND ca.standby_status = 'Assigned') < 1
    OR count(*) FILTER (WHERE ca.role_on_flight = 'First Officer' AND ca.standby_status = 'Assigned') < 1
    OR count(*) FILTER (WHERE ca.role_on_flight IN ('Purser','Cabin Crew') AND ca.standby_status = 'Assigned')
       < ceil(a.capacity / 50.0);

-- Monthly revenue per route. Materialized (expensive join over every ticket); refreshed
-- CONCURRENTLY by sp_refresh_analytics(), which needs the unique index below.
-- Not granted to the app role: staff read it through fn_route_revenue().
CREATE MATERIALIZED VIEW mv_route_revenue_monthly AS
SELECT date_trunc('month', f.departure_time AT TIME ZONE 'Asia/Kolkata')::date AS month,
       f.origin, f.destination,
       count(*) FILTER (WHERE t.ticket_status = 'Active') AS tickets_sold,
       count(*) FILTER (WHERE t.ticket_status IN ('Cancelled','Disrupted')) AS tickets_lost,
       coalesce(sum(t.fare_amount) FILTER (WHERE t.ticket_status = 'Active'), 0)::numeric(14,2) AS revenue,
       round(avg(t.fare_amount) FILTER (WHERE t.ticket_status = 'Active'), 2) AS avg_fare
FROM ticket t
JOIN flight f USING (flight_id)
GROUP BY 1, 2, 3
WITH DATA;
CREATE UNIQUE INDEX mv_route_revenue_monthly_uq ON mv_route_revenue_monthly(month, origin, destination);
