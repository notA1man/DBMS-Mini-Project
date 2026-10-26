-- 70_functions_ops.sql
-- Owner: Aditya
-- sp_generate_seat_map, sp_schedule_flight, sp_assign_crew, fn_flight_crew_complete,
-- sp_update_flight_status, sp_cancel_flight, fn_crew_chain, sp_refresh_analytics
--
-- Conventions
--   ops_*  internal routines (no EXECUTE grant): used by seeding and by the public wrappers.
--   fn_* / sp_*  public entry points: SECURITY DEFINER, fixed search_path, and every one
--                re-checks the caller's role from app_user (never from the app.role string).
--   Functions that the commercial file defines later (fn_current_user_id) are resolved at
--   call time, which plpgsql allows.

-- ------------------------------------------------------------------ authorization
CREATE FUNCTION fn_has_role(VARIADIC p_roles text[]) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM app_user WHERE user_id = fn_current_user_id()
                   AND is_active AND role = ANY (p_roles));
END $$;

CREATE FUNCTION fn_assert_role(VARIADIC p_roles text[]) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT fn_has_role(VARIADIC p_roles) THEN
    RAISE EXCEPTION 'This action requires one of: %', array_to_string(p_roles, ', ') USING ERRCODE = '42501';
  END IF;
END $$;

CREATE FUNCTION fn_current_crew_id() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN (SELECT crew_id FROM app_user WHERE user_id = fn_current_user_id() AND is_active AND role = 'CREW');
END $$;

-- Operations audit trail. Same payload shape as the commercial fn_emit_audit, with the
-- entity named; the dispatcher upserts it into Mongo audit_log keyed by event_id.
CREATE FUNCTION fn_emit_ops_audit(p_action text, p_entity text, p_entity_id text, p_detail jsonb DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor bigint := fn_current_user_id(); actor_role text;
BEGIN
  SELECT role INTO actor_role FROM app_user WHERE user_id = actor AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Audit actor unavailable' USING ERRCODE = '42501'; END IF;
  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('operations', p_entity_id, 'AUDIT_LOG', jsonb_build_object(
    'ts', now(), 'userId', actor::text, 'role', actor_role, 'action', p_action,
    'entity', p_entity, 'entityId', p_entity_id, 'detail', p_detail));
END $$;

-- ------------------------------------------------------------------ fleet & seat maps
-- Layout spec (JSON):
--   {"cabins":[{"class":"Business","fromRow":1,"toRow":3,"letters":"AC DF"},
--              {"class":"Economy","fromRow":4,"toRow":30,"letters":"ABC DEF"}],
--    "exitRows":[12,13]}
-- Spaces in "letters" are aisles: outer letters are windows, letters next to an aisle are
-- aisle seats, the rest are middle seats.
CREATE FUNCTION ops_generate_seat_map(p_aircraft bigint, p_layout jsonb) RETURNS integer
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  cabin jsonb; grp text[]; g text; ch text; pos text;
  r integer; gi integer; i integer; n integer := 0; last_row integer := 0;
  from_row integer; to_row integer; exit_rows integer[];
BEGIN
  IF jsonb_typeof(p_layout -> 'cabins') IS DISTINCT FROM 'array' OR jsonb_array_length(p_layout -> 'cabins') = 0 THEN
    RAISE EXCEPTION 'Seat layout needs at least one cabin';
  END IF;
  SELECT coalesce(array_agg(x::integer), '{}') INTO exit_rows
  FROM jsonb_array_elements_text(coalesce(p_layout -> 'exitRows', '[]'::jsonb)) x;

  PERFORM 1 FROM aircraft WHERE aircraft_id = p_aircraft FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aircraft % not found', p_aircraft; END IF;
  -- Ticket rows reference seats; regenerating a seat map that has been sold fails on that FK.
  DELETE FROM seat WHERE aircraft_id = p_aircraft;

  FOR cabin IN SELECT value FROM jsonb_array_elements(p_layout -> 'cabins') LOOP
    from_row := (cabin ->> 'fromRow')::integer;
    to_row   := (cabin ->> 'toRow')::integer;
    IF cabin ->> 'class' IS NULL OR cabin ->> 'class' NOT IN ('Economy','Business','First') THEN
      RAISE EXCEPTION 'Unknown cabin class %', cabin ->> 'class';
    END IF;
    IF from_row IS NULL OR to_row IS NULL OR from_row <= last_row OR to_row < from_row OR to_row > 99 THEN
      RAISE EXCEPTION 'Cabin rows must be ascending, non-overlapping and at most 99';
    END IF;
    IF coalesce(cabin ->> 'letters', '') !~ '^[A-K]+( [A-K]+){0,3}$' THEN
      RAISE EXCEPTION 'Seat letters must be groups of A-K separated by single spaces (aisles)';
    END IF;
    IF (SELECT count(*) FROM regexp_split_to_table(replace(cabin ->> 'letters', ' ', ''), '') l)
       <> (SELECT count(DISTINCT l) FROM regexp_split_to_table(replace(cabin ->> 'letters', ' ', ''), '') l) THEN
      RAISE EXCEPTION 'Seat letters must not repeat within a cabin';
    END IF;
    grp := string_to_array(cabin ->> 'letters', ' ');
    FOR r IN from_row .. to_row LOOP
      FOR gi IN 1 .. array_length(grp, 1) LOOP
        g := grp[gi];
        FOR i IN 1 .. length(g) LOOP
          ch := substr(g, i, 1);
          pos := CASE
            WHEN (gi = 1 AND i = 1) OR (gi = array_length(grp, 1) AND i = length(g)) THEN 'Window'
            WHEN i = 1 OR i = length(g) THEN 'Aisle'
            ELSE 'Middle' END;
          INSERT INTO seat(aircraft_id, seat_number, seat_class, seat_position, is_exit_row)
          VALUES (p_aircraft, r || ch, cabin ->> 'class', pos, r = ANY (exit_rows));
          n := n + 1;
        END LOOP;
      END LOOP;
    END LOOP;
    last_row := to_row;
  END LOOP;
  -- capacity = COUNT(seat) is verified by a deferred constraint trigger at COMMIT.
  UPDATE aircraft SET capacity = n WHERE aircraft_id = p_aircraft;
  RETURN n;
END $$;

CREATE FUNCTION ops_add_aircraft(p_registration text, p_model text, p_manufacturer text,
  p_type_rating text, p_year integer, p_layout jsonb) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE id bigint;
BEGIN
  -- Placeholder capacity; the seat map sets the real value in the same transaction.
  INSERT INTO aircraft(registration, model, manufacturer, type_rating, capacity, year_of_manufacture)
  VALUES (upper(btrim(p_registration)), btrim(p_model), btrim(p_manufacturer), upper(p_type_rating), 1, p_year)
  RETURNING aircraft_id INTO id;
  PERFORM ops_generate_seat_map(id, p_layout);
  RETURN id;
END $$;

CREATE FUNCTION fn_add_aircraft(p_registration text, p_model text, p_manufacturer text,
  p_type_rating text, p_year integer, p_layout jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE id bigint;
BEGIN
  PERFORM fn_assert_role('ADMIN');
  id := ops_add_aircraft(p_registration, p_model, p_manufacturer, p_type_rating, p_year, p_layout);
  PERFORM fn_emit_ops_audit('ADD_AIRCRAFT', 'aircraft', id::text, jsonb_build_object('registration', upper(btrim(p_registration))));
  RETURN id;
END $$;

CREATE PROCEDURE sp_generate_seat_map(p_aircraft bigint, p_layout jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE seats integer;
BEGIN
  PERFORM fn_assert_role('ADMIN');
  IF EXISTS (SELECT 1 FROM flight WHERE aircraft_id = p_aircraft AND flight_status NOT IN ('Landed','Cancelled')) THEN
    RAISE EXCEPTION 'Reassign or complete this aircraft''s open flights before changing its seat map';
  END IF;
  seats := ops_generate_seat_map(p_aircraft, p_layout);
  PERFORM fn_emit_ops_audit('GENERATE_SEAT_MAP', 'aircraft', p_aircraft::text, jsonb_build_object('seats', seats));
END $$;

CREATE PROCEDURE sp_set_aircraft_status(p_aircraft bigint, p_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE open_flights integer;
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  PERFORM 1 FROM aircraft WHERE aircraft_id = p_aircraft FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Aircraft % not found', p_aircraft; END IF;
  IF p_status <> 'Active' THEN
    SELECT count(*) INTO open_flights FROM flight
    WHERE aircraft_id = p_aircraft AND flight_status IN ('Scheduled','Delayed','Boarding','Departed');
    IF open_flights > 0 THEN
      RAISE EXCEPTION 'Aircraft still has % open flight(s); cancel or complete them first', open_flights;
    END IF;
  END IF;
  UPDATE aircraft SET status = p_status WHERE aircraft_id = p_aircraft;
  PERFORM fn_emit_ops_audit('SET_AIRCRAFT_STATUS', 'aircraft', p_aircraft::text, jsonb_build_object('status', p_status));
END $$;

CREATE PROCEDURE sp_upsert_airport(p_code text, p_name text, p_city text, p_country text,
  p_timezone text, p_lat numeric, p_lon numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN');
  INSERT INTO airport(airport_code, airport_name, city, country, timezone, latitude, longitude)
  VALUES (upper(p_code), btrim(p_name), btrim(p_city), upper(p_country), p_timezone, p_lat, p_lon)
  ON CONFLICT (airport_code) DO UPDATE SET airport_name = EXCLUDED.airport_name, city = EXCLUDED.city,
    country = EXCLUDED.country, timezone = EXCLUDED.timezone, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;
  PERFORM fn_emit_ops_audit('UPSERT_AIRPORT', 'airport', upper(p_code));
END $$;

-- ------------------------------------------------------------------ scheduling
-- p_fares: {"Economy": 4500, "Business": 14000, "First": 38000} - one entry for every cabin
-- class the aircraft has, none for classes it lacks. Each bucket sells the whole cabin.
CREATE FUNCTION ops_schedule_flight(p_number text, p_aircraft bigint, p_origin text, p_destination text,
  p_departure timestamptz, p_arrival timestamptz, p_gate text, p_fares jsonb) RETURNS bigint
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE id bigint; cls text; seats integer;
BEGIN
  IF jsonb_typeof(p_fares) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Fares must be an object keyed by class'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_fares) k WHERE k NOT IN ('Economy','Business','First')) THEN
    RAISE EXCEPTION 'Unknown fare class in fares';
  END IF;
  INSERT INTO flight(flight_number, aircraft_id, origin, destination, departure_time, arrival_time, gate)
  VALUES (upper(p_number), p_aircraft, upper(p_origin), upper(p_destination), p_departure, p_arrival, nullif(upper(p_gate), ''))
  RETURNING flight_id INTO id;
  FOR cls, seats IN SELECT seat_class, count(*) FROM seat WHERE aircraft_id = p_aircraft GROUP BY seat_class LOOP
    IF NOT p_fares ? cls OR (p_fares ->> cls)::numeric IS NULL THEN
      RAISE EXCEPTION 'Missing base fare for % cabin', cls;
    END IF;
    INSERT INTO flight_fare(flight_id, fare_class, base_fare, seats_allocated)
    VALUES (id, cls, (p_fares ->> cls)::numeric, seats);
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_fares) k
             WHERE NOT EXISTS (SELECT 1 FROM seat s WHERE s.aircraft_id = p_aircraft AND s.seat_class = k)) THEN
    RAISE EXCEPTION 'Aircraft has no seats for one of the fare classes supplied';
  END IF;
  RETURN id;
END $$;

-- Public scheduling. Overlapping an aircraft's existing rotation fails with SQLSTATE 23P01
-- (exclusion constraint flight_aircraft_no_overlap); the API maps that to a 409.
CREATE FUNCTION fn_schedule_flight(p_number text, p_aircraft bigint, p_origin text, p_destination text,
  p_departure timestamptz, p_arrival timestamptz, p_gate text, p_fares jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE id bigint;
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  IF p_departure <= now() + interval '1 hour' THEN
    RAISE EXCEPTION 'New flights must depart at least one hour from now';
  END IF;
  id := ops_schedule_flight(p_number, p_aircraft, p_origin, p_destination, p_departure, p_arrival, p_gate, p_fares);
  PERFORM fn_emit_ops_audit('SCHEDULE_FLIGHT', 'flight', id::text, jsonb_build_object('flightNumber', upper(p_number)));
  RETURN id;
END $$;

-- ------------------------------------------------------------------ crew legality
-- Duty window for one sector: report 30 min before departure, release 15 min after arrival.
-- With a 45-minute aircraft turnaround, consecutive sectors on one aircraft never overlap.
CREATE FUNCTION ops_duty_window(p_flight bigint, OUT duty_start timestamptz, OUT duty_end timestamptz)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT departure_time - interval '30 minutes', arrival_time + interval '15 minutes'
  FROM flight WHERE flight_id = p_flight
$$;

-- Every rule with pass/fail and a human-readable detail, so the ops UI can explain WHY an
-- assignment is illegal. Rules (simplified flight-time limitations):
--   ACTIVE        crew record active
--   ROLE          designation may fly the requested role (captain may act as first officer)
--   TYPE_RATING   pilots hold a valid TYPE:<aircraft type> certificate on the departure date
--   MEDICAL       pilots hold a valid MEDICAL certificate
--   SAFETY        everyone holds valid SEP (safety & emergency procedures)
--   FLIGHT_OPEN   flight is Scheduled/Delayed and in the future
--   NOT_ASSIGNED  not already on this flight
--   ROLE_SLOT     captain / first-officer seat not already taken (standby exempt)
--   NO_OVERLAP    no other duty overlaps this sector
--   POSITION      crew is at the origin: previous sector landed there, or home base if none
--   POSITION_NEXT the next assigned sector departs from this sector's destination
--   DUTY_PERIOD   sectors less than 10 h apart form one duty period, which may span <= 13 h
--                 (20 h when the sector is longer than 8 h: augmented long-haul crew), i.e.
--                 at least 10 h rest between duty periods
CREATE FUNCTION ops_crew_legality(p_crew bigint, p_flight bigint, p_role text, p_standby boolean DEFAULT false)
RETURNS TABLE(rule text, passed boolean, detail text)
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  c crew%ROWTYPE; f flight%ROWTYPE; a aircraft%ROWTYPE; ok boolean;
  w_start timestamptz; w_end timestamptz; max_period interval;
  prev_dest text; next_origin text; chain_start timestamptz; chain_end timestamptz;
  d record; pilot boolean := p_role IN ('Captain','First Officer'); cert_until date;
BEGIN
  SELECT * INTO c FROM crew WHERE crew_id = p_crew;
  SELECT * INTO f FROM flight WHERE flight_id = p_flight;
  IF c.crew_id IS NULL OR f.flight_id IS NULL THEN
    RETURN QUERY SELECT 'EXISTS', false, 'Crew member or flight not found'; RETURN;
  END IF;
  SELECT * INTO a FROM aircraft WHERE aircraft_id = f.aircraft_id;
  SELECT ow.duty_start, ow.duty_end INTO w_start, w_end FROM ops_duty_window(p_flight) ow;

  RETURN QUERY SELECT 'ACTIVE', c.is_active,
    CASE WHEN c.is_active THEN 'Crew record active' ELSE 'Crew record is inactive' END;

  ok := CASE p_role WHEN 'Captain' THEN c.designation = 'Captain'
                    WHEN 'First Officer' THEN c.designation IN ('Captain','First Officer')
                    WHEN 'Purser' THEN c.designation = 'Purser'
                    WHEN 'Cabin Crew' THEN c.designation IN ('Purser','Cabin Crew') ELSE false END;
  RETURN QUERY SELECT 'ROLE', ok,
    CASE WHEN ok THEN format('%s may fly as %s', c.designation, p_role)
         ELSE format('A %s may not fly as %s', c.designation, p_role) END;

  IF pilot THEN
    SELECT max(valid_until) INTO cert_until FROM crew_certification
    WHERE crew_id = p_crew AND certification = 'TYPE:' || a.type_rating;
    ok := cert_until >= f.departure_time::date;
    RETURN QUERY SELECT 'TYPE_RATING', coalesce(ok, false),
      CASE WHEN cert_until IS NULL THEN format('Not rated on the %s', a.type_rating)
           WHEN ok THEN format('TYPE:%s valid until %s', a.type_rating, cert_until)
           ELSE format('TYPE:%s rating expired on %s', a.type_rating, cert_until) END;
    SELECT max(valid_until) INTO cert_until FROM crew_certification WHERE crew_id = p_crew AND certification = 'MEDICAL';
    ok := cert_until >= f.departure_time::date;
    RETURN QUERY SELECT 'MEDICAL', coalesce(ok, false),
      CASE WHEN ok THEN format('Medical valid until %s', cert_until)
           ELSE format('Medical certificate missing or expired (%s)', coalesce(cert_until::text, 'none')) END;
  END IF;
  SELECT max(valid_until) INTO cert_until FROM crew_certification WHERE crew_id = p_crew AND certification = 'SEP';
  ok := cert_until >= f.departure_time::date;
  RETURN QUERY SELECT 'SAFETY', coalesce(ok, false),
    CASE WHEN ok THEN format('Safety & emergency training valid until %s', cert_until)
         ELSE format('Safety & emergency training missing or expired (%s)', coalesce(cert_until::text, 'none')) END;

  ok := f.flight_status IN ('Scheduled','Delayed') AND f.departure_time > now();
  RETURN QUERY SELECT 'FLIGHT_OPEN', ok,
    CASE WHEN ok THEN format('Flight is %s', f.flight_status)
         ELSE format('Flight is %s and can no longer be crewed', lower(f.flight_status)) END;

  ok := NOT EXISTS (SELECT 1 FROM crew_assignment WHERE crew_id = p_crew AND flight_id = p_flight);
  RETURN QUERY SELECT 'NOT_ASSIGNED', ok, CASE WHEN ok THEN 'Not yet on this flight' ELSE 'Already assigned to this flight' END;

  IF pilot AND NOT p_standby THEN
    ok := NOT EXISTS (SELECT 1 FROM crew_assignment WHERE flight_id = p_flight
                      AND role_on_flight = p_role AND standby_status = 'Assigned');
    RETURN QUERY SELECT 'ROLE_SLOT', ok,
      CASE WHEN ok THEN format('%s seat is open', p_role) ELSE format('The %s seat is already filled', p_role) END;
  END IF;

  ok := NOT EXISTS (SELECT 1 FROM crew_assignment ca WHERE ca.crew_id = p_crew AND ca.flight_id <> p_flight
                    AND tstzrange(ca.duty_start, ca.duty_end) && tstzrange(w_start, w_end));
  RETURN QUERY SELECT 'NO_OVERLAP', ok, CASE WHEN ok THEN 'No overlapping duty' ELSE 'Overlaps another duty' END;

  SELECT pf.destination INTO prev_dest FROM crew_assignment ca JOIN flight pf USING (flight_id)
  WHERE ca.crew_id = p_crew AND ca.duty_end <= w_start ORDER BY ca.duty_end DESC LIMIT 1;
  ok := coalesce(prev_dest, c.base_airport) = f.origin;
  RETURN QUERY SELECT 'POSITION', ok,
    CASE WHEN ok THEN format('At %s for departure', f.origin)
         ELSE format('Will be at %s, but the flight departs %s', coalesce(prev_dest, c.base_airport), f.origin) END;

  SELECT nf.origin INTO next_origin FROM crew_assignment ca JOIN flight nf USING (flight_id)
  WHERE ca.crew_id = p_crew AND ca.duty_start >= w_end ORDER BY ca.duty_start LIMIT 1;
  ok := next_origin IS NULL OR next_origin = f.destination;
  RETURN QUERY SELECT 'POSITION_NEXT', ok,
    CASE WHEN next_origin IS NULL THEN 'No later duty to connect to'
         WHEN ok THEN format('Next duty departs %s, where this flight lands', next_origin)
         ELSE format('Next duty departs %s, but this flight lands at %s', next_origin, f.destination) END;

  -- Grow the duty period outward from this sector while neighbouring duties are < 10 h away.
  chain_start := w_start; chain_end := w_end;
  FOR d IN SELECT ca.duty_start, ca.duty_end FROM crew_assignment ca
           WHERE ca.crew_id = p_crew AND ca.flight_id <> p_flight AND ca.duty_end <= w_start
           ORDER BY ca.duty_end DESC LOOP
    EXIT WHEN chain_start - d.duty_end >= interval '10 hours';
    chain_start := d.duty_start;
  END LOOP;
  FOR d IN SELECT ca.duty_start, ca.duty_end FROM crew_assignment ca
           WHERE ca.crew_id = p_crew AND ca.flight_id <> p_flight AND ca.duty_start >= w_end
           ORDER BY ca.duty_start LOOP
    EXIT WHEN d.duty_start - chain_end >= interval '10 hours';
    chain_end := d.duty_end;
  END LOOP;
  -- Long-haul sectors (block > 8 h) assume an augmented crew and allow a 20 h period.
  max_period := CASE WHEN f.arrival_time - f.departure_time > interval '8 hours'
                     THEN interval '20 hours' ELSE interval '13 hours' END;
  ok := chain_end - chain_start <= max_period;
  RETURN QUERY SELECT 'DUTY_PERIOD', ok,
    format('Duty period %s %s the %s h limit (10 h rest required between periods)',
           to_char(chain_end - chain_start, 'HH24"h"MI"m"'), CASE WHEN ok THEN 'is within' ELSE 'exceeds' END,
           extract(hour FROM max_period));
END $$;

CREATE FUNCTION fn_crew_legality(p_crew bigint, p_flight bigint, p_role text, p_standby boolean DEFAULT false)
RETURNS TABLE(rule text, passed boolean, detail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  RETURN QUERY SELECT * FROM ops_crew_legality(p_crew, p_flight, p_role, p_standby);
END $$;

-- Internal assignment. p_enforce=false is only for seeding historical rosters (past flights
-- cannot pass FLIGHT_OPEN); the exclusion constraint still applies either way.
CREATE FUNCTION ops_assign_crew(p_crew bigint, p_flight bigint, p_role text,
  p_standby boolean DEFAULT false, p_enforce boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE failed record; w record;
BEGIN
  -- Serialize concurrent assignments of the same crew member and freeze the flight times.
  PERFORM 1 FROM crew WHERE crew_id = p_crew FOR UPDATE;
  PERFORM 1 FROM flight WHERE flight_id = p_flight FOR SHARE;
  IF p_enforce THEN
    SELECT * INTO failed FROM ops_crew_legality(p_crew, p_flight, p_role, p_standby) l WHERE NOT l.passed LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Crew assignment illegal (%): %', failed.rule, failed.detail; END IF;
  END IF;
  SELECT * INTO w FROM ops_duty_window(p_flight);
  INSERT INTO crew_assignment(crew_id, flight_id, role_on_flight, duty_start, duty_end, standby_status)
  VALUES (p_crew, p_flight, p_role, w.duty_start, w.duty_end, CASE WHEN p_standby THEN 'Standby' ELSE 'Assigned' END);
END $$;

CREATE PROCEDURE sp_assign_crew(p_crew bigint, p_flight bigint, p_role text, p_standby boolean DEFAULT false)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  PERFORM ops_assign_crew(p_crew, p_flight, p_role, p_standby, true);
  PERFORM fn_emit_ops_audit('ASSIGN_CREW', 'flight', p_flight::text,
    jsonb_build_object('crewId', p_crew::text, 'role', p_role, 'standby', p_standby));
END $$;

CREATE PROCEDURE sp_unassign_crew(p_crew bigint, p_flight bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  DELETE FROM crew_assignment ca USING flight f
  WHERE ca.flight_id = f.flight_id AND ca.crew_id = p_crew AND ca.flight_id = p_flight
    AND f.flight_status IN ('Scheduled','Delayed');
  IF NOT FOUND THEN RAISE EXCEPTION 'No removable assignment (flight may already be boarding or closed)'; END IF;
  PERFORM fn_emit_ops_audit('UNASSIGN_CREW', 'flight', p_flight::text, jsonb_build_object('crewId', p_crew::text));
END $$;

-- Captain + first officer + one cabin crew per 50 seats (standby crew do not count).
CREATE FUNCTION fn_flight_crew_complete(p_flight bigint) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cap integer; cpt integer; fo integer; cabin integer;
BEGIN
  SELECT a.capacity INTO cap FROM flight f JOIN aircraft a USING (aircraft_id) WHERE f.flight_id = p_flight;
  SELECT count(*) FILTER (WHERE role_on_flight = 'Captain'),
         count(*) FILTER (WHERE role_on_flight = 'First Officer'),
         count(*) FILTER (WHERE role_on_flight IN ('Purser','Cabin Crew'))
    INTO cpt, fo, cabin
  FROM crew_assignment WHERE flight_id = p_flight AND standby_status = 'Assigned';
  RETURN cap IS NOT NULL AND cpt >= 1 AND fo >= 1 AND cabin >= ceil(cap / 50.0);
END $$;

-- ------------------------------------------------------------------ status & disruption
-- Knock-on delay propagation. Call after p_flight's own times have been moved (from
-- p_old_departure). Every later sector of the same aircraft that no longer has its 45-minute
-- turnaround is pushed back and marked Delayed. Crew duties move with their flights; a crew
-- member whose moved duty now collides with a LATER duty on another aircraft is released
-- from that later flight (it then appears in v_crew_coverage for re-crewing).
-- The caller defers the exclusion constraints so the rotation is checked once, at COMMIT.
CREATE FUNCTION ops_propagate_delay(p_flight bigint, p_old_departure timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  f flight%ROWTYPE; nxt flight%ROWTYPE; prev_arrival timestamptz; extra_min integer;
  knock jsonb := '[]'; released jsonb := '[]'; moved bigint[] := ARRAY[p_flight]; rel record;
BEGIN
  SELECT * INTO f FROM flight WHERE flight_id = p_flight;
  prev_arrival := f.arrival_time;
  FOR nxt IN SELECT * FROM flight
             WHERE aircraft_id = f.aircraft_id AND flight_id <> p_flight AND departure_time > p_old_departure
               AND flight_status IN ('Scheduled','Delayed')
             ORDER BY departure_time FOR UPDATE LOOP
    EXIT WHEN nxt.departure_time >= prev_arrival + interval '45 minutes';
    extra_min := ceil(extract(epoch FROM (prev_arrival + interval '45 minutes' - nxt.departure_time)) / 60)::integer;
    UPDATE flight SET departure_time = departure_time + make_interval(mins => extra_min),
                      arrival_time = arrival_time + make_interval(mins => extra_min),
                      delay_minutes = least(delay_minutes + extra_min, 1440),
                      delay_reason = coalesce(delay_reason, 'Late inbound aircraft'),
                      flight_status = 'Delayed'
    WHERE flight_id = nxt.flight_id RETURNING arrival_time INTO prev_arrival;
    knock := knock || jsonb_build_object('flightId', nxt.flight_id::text, 'flightNumber', nxt.flight_number,
                                         'addedMinutes', extra_min);
    moved := moved || nxt.flight_id;
  END LOOP;

  UPDATE crew_assignment ca SET duty_start = w.duty_start, duty_end = w.duty_end
  FROM flight fl, LATERAL ops_duty_window(fl.flight_id) w
  WHERE ca.flight_id = fl.flight_id AND fl.flight_id = ANY (moved);

  FOR rel IN
    DELETE FROM crew_assignment later
    USING crew_assignment cur
    WHERE cur.flight_id = ANY (moved) AND later.crew_id = cur.crew_id AND NOT later.flight_id = ANY (moved)
      AND later.duty_start >= cur.duty_start
      AND tstzrange(later.duty_start, later.duty_end) && tstzrange(cur.duty_start, cur.duty_end)
    RETURNING later.crew_id, later.flight_id
  LOOP
    released := released || jsonb_build_object('crewId', rel.crew_id::text, 'flightId', rel.flight_id::text);
  END LOOP;
  RETURN jsonb_build_object('knockOn', knock, 'releasedCrew', released);
END $$;

-- p_status NULL keeps/derives the status (Scheduled <-> Delayed follows the delay).
-- p_delay_minutes is the new TOTAL delay versus the original schedule.
-- Returns {flightId, status, knockOn:[...], releasedCrew:[...]} through the INOUT parameter.
CREATE PROCEDURE sp_update_flight_status(p_flight bigint, p_status text DEFAULT NULL,
  p_delay_minutes integer DEFAULT NULL, p_gate text DEFAULT NULL, p_delay_reason text DEFAULT NULL,
  INOUT p_result jsonb DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  f flight%ROWTYPE; new_status text; new_delay integer; shift interval := interval '0';
  cascade jsonb := jsonb_build_object('knockOn', '[]'::jsonb, 'releasedCrew', '[]'::jsonb);
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  SELECT * INTO f FROM flight WHERE flight_id = p_flight FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Flight % not found', p_flight; END IF;
  IF p_status = 'Cancelled' THEN RAISE EXCEPTION 'Use sp_cancel_flight to cancel (it handles passengers and crew)'; END IF;

  new_delay := coalesce(p_delay_minutes, f.delay_minutes);
  IF new_delay <> f.delay_minutes THEN
    IF f.flight_status NOT IN ('Scheduled','Delayed','Boarding') THEN
      RAISE EXCEPTION 'Delay can only change before departure';
    END IF;
    IF new_delay NOT BETWEEN 0 AND 1440 THEN RAISE EXCEPTION 'Delay must be 0 to 1440 minutes'; END IF;
    IF new_delay > f.delay_minutes AND p_delay_reason IS NULL THEN
      RAISE EXCEPTION 'Give a delay reason (Weather, ATC, Technical, Crew, ...)';
    END IF;
    shift := make_interval(mins => new_delay - f.delay_minutes);
  END IF;

  new_status := coalesce(p_status, CASE
    WHEN f.flight_status IN ('Scheduled','Delayed') AND new_delay > 0 THEN 'Delayed'
    WHEN f.flight_status = 'Delayed' AND new_delay = 0 THEN 'Scheduled'
    ELSE f.flight_status END);
  IF new_status IN ('Boarding','Departed') AND f.flight_status NOT IN ('Boarding','Departed')
     AND NOT fn_flight_crew_complete(p_flight) THEN
    RAISE EXCEPTION 'Flight cannot board: crew is incomplete (see crew coverage)';
  END IF;

  SET CONSTRAINTS flight_aircraft_no_overlap, crew_no_overlapping_duty DEFERRED;
  -- One UPDATE = one outbox event. The legal state machine is trg_flight_status_transition.
  UPDATE flight SET departure_time = departure_time + shift, arrival_time = arrival_time + shift,
                    delay_minutes = new_delay, flight_status = new_status,
                    delay_reason = CASE WHEN new_delay = 0 THEN NULL ELSE coalesce(p_delay_reason, delay_reason) END,
                    gate = coalesce(nullif(upper(p_gate), ''), gate)
  WHERE flight_id = p_flight;
  IF shift <> interval '0' THEN
    cascade := ops_propagate_delay(p_flight, f.departure_time);
  END IF;

  p_result := cascade || jsonb_build_object('flightId', p_flight::text, 'status', new_status, 'delayMinutes', new_delay);
  PERFORM fn_emit_ops_audit('UPDATE_FLIGHT_STATUS', 'flight', p_flight::text, p_result);
END $$;

-- Cancels a flight in one transaction: flight -> Cancelled, active tickets -> Disrupted
-- (check-in and boarding code cleared, as the commercial ticket CHECK requires), their
-- bookings -> Disrupted, crew released, and a FLIGHT_CANCELLED outbox event listing the
-- affected bookings so the dispatcher can notify each booker.
CREATE PROCEDURE sp_cancel_flight(p_flight bigint, p_reason text, INOUT p_result jsonb DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f flight%ROWTYPE; pnrs text[]; tickets integer; bookings jsonb; crew_ids jsonb;
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;
  SELECT * INTO f FROM flight WHERE flight_id = p_flight FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Flight % not found', p_flight; END IF;
  IF f.flight_status NOT IN ('Scheduled','Delayed','Boarding') THEN
    RAISE EXCEPTION 'Only flights that have not departed can be cancelled (status %)', f.flight_status;
  END IF;

  UPDATE flight SET flight_status = 'Cancelled', cancel_reason = btrim(p_reason) WHERE flight_id = p_flight;

  WITH t AS (
    UPDATE ticket SET ticket_status = 'Disrupted', checkin_status = 'NotCheckedIn', boarding_pass_code = NULL
    WHERE flight_id = p_flight AND ticket_status = 'Active'
    RETURNING booking_id
  ) SELECT count(*), coalesce(array_agg(DISTINCT booking_id), '{}') INTO tickets, pnrs FROM t;

  WITH b AS (
    UPDATE booking SET booking_status = 'Disrupted'
    WHERE booking_id = ANY (pnrs) AND booking_status IN ('Pending','Confirmed')
    RETURNING booking_id, created_by_user
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('bookingId', booking_id, 'userId', created_by_user::text)), '[]')
    INTO bookings FROM b;

  WITH released AS (DELETE FROM crew_assignment WHERE flight_id = p_flight RETURNING crew_id)
  SELECT coalesce(jsonb_agg(crew_id::text), '[]') INTO crew_ids FROM released;

  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('flight', p_flight::text, 'FLIGHT_CANCELLED', jsonb_build_object(
    'flightId', p_flight::text, 'flightNumber', f.flight_number, 'origin', f.origin, 'destination', f.destination,
    'departureTime', f.departure_time, 'reason', btrim(p_reason), 'bookings', bookings, 'releasedCrew', crew_ids));

  p_result := jsonb_build_object('flightId', p_flight::text, 'disruptedTickets', tickets,
    'disruptedBookings', jsonb_array_length(bookings), 'releasedCrew', jsonb_array_length(crew_ids));
  PERFORM fn_emit_ops_audit('CANCEL_FLIGHT', 'flight', p_flight::text, p_result || jsonb_build_object('reason', btrim(p_reason)));
END $$;

-- ------------------------------------------------------------------ crew hierarchy
-- Recursive CTE over the supervisor self-reference: the management chain above (negative
-- depth) and everyone reporting below (positive depth). Cycle-safe via the path array.
CREATE FUNCTION fn_crew_chain(p_crew bigint)
RETURNS TABLE(crew_id bigint, crew_name text, designation text, supervisor_id bigint, depth integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS','CREW');
  RETURN QUERY
  WITH RECURSIVE up AS (
    SELECT c.crew_id, c.crew_name, c.designation, c.supervisor_id, 0 AS depth, ARRAY[c.crew_id] AS path
    FROM crew c WHERE c.crew_id = p_crew
    UNION ALL
    SELECT s.crew_id, s.crew_name, s.designation, s.supervisor_id, up.depth - 1, up.path || s.crew_id
    FROM crew s JOIN up ON s.crew_id = up.supervisor_id
    WHERE NOT s.crew_id = ANY (up.path)
  ), down AS (
    SELECT c.crew_id, c.crew_name, c.designation, c.supervisor_id, 0 AS depth, ARRAY[c.crew_id] AS path
    FROM crew c WHERE c.crew_id = p_crew
    UNION ALL
    SELECT r.crew_id, r.crew_name, r.designation, r.supervisor_id, down.depth + 1, down.path || r.crew_id
    FROM crew r JOIN down ON r.supervisor_id = down.crew_id
    WHERE NOT r.crew_id = ANY (down.path)
  )
  SELECT u.crew_id, u.crew_name, u.designation, u.supervisor_id, u.depth FROM up u
  UNION
  SELECT d.crew_id, d.crew_name, d.designation, d.supervisor_id, d.depth FROM down d
  ORDER BY depth, crew_name;
END $$;

-- Administrators only: the one place salaries are visible.
CREATE FUNCTION fn_crew_admin()
RETURNS TABLE(crew_id bigint, crew_name text, designation text, license_number text, salary numeric,
              hire_date date, supervisor_id bigint, base_airport text, is_active boolean, certifications jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN');
  RETURN QUERY
  SELECT c.crew_id, c.crew_name, c.designation, c.license_number, c.salary::numeric, c.hire_date,
         c.supervisor_id, c.base_airport::text, c.is_active,
         coalesce((SELECT jsonb_agg(jsonb_build_object('certification', cc.certification, 'validUntil', cc.valid_until)
                                    ORDER BY cc.certification)
                   FROM crew_certification cc WHERE cc.crew_id = c.crew_id), '[]')
  FROM crew c ORDER BY c.crew_id;
END $$;

-- ------------------------------------------------------------------ analytics
CREATE PROCEDURE sp_refresh_analytics()
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_route_revenue_monthly;
END $$;

CREATE FUNCTION fn_route_revenue(p_months integer DEFAULT 12)
RETURNS TABLE(month date, origin text, destination text, tickets_sold bigint, tickets_lost bigint,
              revenue numeric, avg_fare numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  RETURN QUERY SELECT m.month, m.origin::text, m.destination::text, m.tickets_sold, m.tickets_lost, m.revenue, m.avg_fare
  FROM mv_route_revenue_monthly m
  WHERE m.month >= (date_trunc('month', current_date) - make_interval(months => p_months))::date
  ORDER BY m.month DESC, m.revenue DESC;
END $$;

-- One-call dashboard numbers for the ops console.
CREATE FUNCTION fn_ops_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE result jsonb;
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  SELECT jsonb_build_object(
    'next24h', (SELECT jsonb_object_agg(flight_status, n) FROM (
        SELECT flight_status, count(*) AS n FROM flight
        WHERE departure_time BETWEEN now() - interval '2 hours' AND now() + interval '24 hours'
        GROUP BY flight_status) s),
    'onTimeRate7d', (SELECT round(avg((delay_minutes <= 15)::integer), 3) FROM flight
        WHERE flight_status = 'Landed' AND arrival_time > now() - interval '7 days'),
    'unresolvedDisruptions', (SELECT count(*) FROM ticket t WHERE t.ticket_status = 'Disrupted'
        AND NOT EXISTS (SELECT 1 FROM ticket r WHERE r.booking_id = t.booking_id AND r.replaces_seq = t.ticket_seq)),
    'crewGaps', (SELECT count(*) FROM v_crew_coverage WHERE departure_time < now() + interval '48 hours'),
    'outboxPending', (SELECT count(*) FROM outbox_event WHERE processed_at IS NULL),
    'outboxFailing', (SELECT count(*) FROM outbox_event WHERE processed_at IS NULL AND attempts > 0)
  ) INTO result;
  RETURN result;
END $$;

-- ------------------------------------------------------------------ outbox dispatcher API
-- The dispatcher runs as the application role without a user (worker / cron), so these
-- three routines do not check app.user_id. Only trusted server code holds the credentials.
-- Rows stay locked (FOR UPDATE SKIP LOCKED) until the caller's transaction ends, so two
-- dispatchers never deliver the same event concurrently.
CREATE FUNCTION fn_outbox_claim(p_limit integer DEFAULT 50) RETURNS SETOF outbox_event
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Claim 1 to 500 events'; END IF;
  RETURN QUERY SELECT * FROM outbox_event
  WHERE processed_at IS NULL AND next_attempt_at <= now()
  ORDER BY event_id LIMIT p_limit
  FOR UPDATE SKIP LOCKED;
END $$;

CREATE FUNCTION fn_outbox_complete(p_ids bigint[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE outbox_event SET processed_at = now(), last_error = NULL
  WHERE event_id = ANY (p_ids) AND processed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Exponential backoff: 2^attempts seconds, capped at one hour.
CREATE FUNCTION fn_outbox_fail(p_id bigint, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE outbox_event SET attempts = attempts + 1, last_error = left(coalesce(p_error, 'unknown error'), 500),
    next_attempt_at = now() + make_interval(secs => least(power(2, attempts + 1), 3600))
  WHERE event_id = p_id AND processed_at IS NULL;
END $$;

CREATE FUNCTION fn_outbox_admin(p_limit integer DEFAULT 100)
RETURNS TABLE(event_id bigint, aggregate text, aggregate_id text, event_type text, payload jsonb,
              created_at timestamptz, processed_at timestamptz, attempts integer, last_error text, next_attempt_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN');
  RETURN QUERY SELECT o.event_id, o.aggregate, o.aggregate_id, o.event_type, o.payload, o.created_at,
    o.processed_at, o.attempts, o.last_error, o.next_attempt_at
  FROM outbox_event o ORDER BY (o.processed_at IS NULL) DESC, o.event_id DESC LIMIT least(p_limit, 500);
END $$;

CREATE PROCEDURE sp_outbox_retry(p_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM fn_assert_role('ADMIN');
  UPDATE outbox_event SET next_attempt_at = now() WHERE event_id = p_id AND processed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event % is not pending', p_id; END IF;
END $$;

-- Bookers of active tickets on a flight, for delay notifications. Used by the dispatcher, which
-- has no user context (RLS would otherwise hide every booking); returns ids only.
CREATE FUNCTION fn_flight_bookers(p_flight bigint) RETURNS TABLE(booking_id text, user_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY SELECT DISTINCT b.booking_id::text, b.created_by_user
  FROM ticket t JOIN booking b ON b.booking_id = t.booking_id
  WHERE t.flight_id = p_flight AND t.ticket_status = 'Active';
END $$;

-- Seats still for sale in a fare bucket. SECURITY DEFINER because ticket rows are protected by
-- RLS: an anonymous search would otherwise count zero sold seats and show every flight as
-- empty. Returns only the number, never ticket data.
CREATE FUNCTION fn_seats_remaining(p_flight bigint, p_class text) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN (SELECT ff.seats_allocated - (SELECT count(*) FROM ticket t WHERE t.flight_id = p_flight
                                        AND t.fare_class = p_class AND t.ticket_status = 'Active')
          FROM flight_fare ff WHERE ff.flight_id = p_flight AND ff.fare_class = p_class);
END $$;
