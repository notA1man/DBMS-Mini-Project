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
