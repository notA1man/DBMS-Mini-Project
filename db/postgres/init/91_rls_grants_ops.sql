-- 91_rls_grants_ops.sql
-- Owner: Aditya
-- Grants and row-level security for operations objects. Runs after 90 (commercial), which
-- already revoked PUBLIC execute on every routine and granted read access to the public
-- flight catalogue (airport, aircraft, seat, flight, flight_fare).
--
-- The application role never writes operations tables directly: every change goes through
-- a SECURITY DEFINER routine that re-checks the caller's role from app_user.

-- Crew: salary is excluded by a column-level grant (administrators read it via fn_crew_admin).
GRANT SELECT (crew_id, crew_name, designation, license_number, hire_date, supervisor_id,
              base_airport, is_active, updated_at) ON crew TO strata_app;
GRANT SELECT ON crew_certification, crew_assignment TO strata_app;
GRANT SELECT ON v_aircraft_age, v_flight_load, v_flight_manifest, v_crew_roster, v_crew_coverage TO strata_app;

-- Staff and crew can see the crew list (names, ranks, bases); passengers cannot.
ALTER TABLE crew ENABLE ROW LEVEL SECURITY;
CREATE POLICY crew_read ON crew FOR SELECT USING (fn_has_role('ADMIN','OPS','CREW'));

-- Certificates: staff see all; a crew member sees their own.
ALTER TABLE crew_certification ENABLE ROW LEVEL SECURITY;
CREATE POLICY crew_certification_read ON crew_certification FOR SELECT
  USING (fn_has_role('ADMIN','OPS') OR crew_id = fn_current_crew_id());

-- Assignments: staff see all; crew see their own duties and who else is on those flights.
ALTER TABLE crew_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY crew_assignment_read ON crew_assignment FOR SELECT
  USING (fn_has_role('ADMIN','OPS') OR crew_id = fn_current_crew_id() OR fn_crew_can_read(flight_id));

-- The outbox and revenue materialized view are deliberately not granted: they are reached
-- only through fn_outbox_* and fn_route_revenue.

-- Deferred exclusion constraints are re-checked at COMMIT as the session role, outside any
-- SECURITY DEFINER routine, so the index expression's (pure) helper must be executable.
GRANT EXECUTE ON FUNCTION ops_turnaround_range(timestamptz, timestamptz) TO strata_app;

GRANT EXECUTE ON FUNCTION
  fn_has_role(text[]), fn_current_crew_id(),
  fn_add_aircraft(text, text, text, text, integer, jsonb),
  fn_schedule_flight(text, bigint, text, text, timestamptz, timestamptz, text, jsonb),
  fn_crew_legality(bigint, bigint, text, boolean),
  fn_flight_crew_complete(bigint),
  fn_crew_chain(bigint), fn_crew_admin(),
  fn_route_revenue(integer), fn_ops_overview(),
  fn_disrupted_tickets(),
  fn_outbox_claim(integer), fn_outbox_complete(bigint[]), fn_outbox_fail(bigint, text), fn_outbox_admin(integer),
  fn_flight_bookers(bigint), fn_seats_remaining(bigint, text),
  -- Audit entries for native MongoDB actions (maintenance logs, crew reports); actor = caller.
  fn_emit_ops_audit(text, text, text, jsonb)
TO strata_app;

GRANT EXECUTE ON PROCEDURE
  sp_generate_seat_map(bigint, jsonb), sp_set_aircraft_status(bigint, text),
  sp_upsert_airport(text, text, text, text, text, numeric, numeric),
  sp_assign_crew(bigint, bigint, text, boolean), sp_unassign_crew(bigint, bigint),
  sp_update_flight_status(bigint, text, integer, text, text, jsonb),
  sp_cancel_flight(bigint, text, jsonb),
  sp_rebook_ticket(text, smallint, bigint[], jsonb),
  sp_refresh_analytics(), sp_outbox_retry(bigint)
TO strata_app;

-- Read-only analytics role: aggregate operational data only, never passenger or crew PII.
GRANT SELECT ON airport, aircraft, flight, flight_fare, v_aircraft_age TO strata_readonly;
