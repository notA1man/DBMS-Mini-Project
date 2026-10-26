-- 80_triggers_ops.sql
-- Owner: Aditya
-- outbox triggers, flight status state machine, updated_at

-- ------------------------------------------------------------------ updated_at
CREATE FUNCTION trg_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER trg_airport_updated_at BEFORE UPDATE ON airport FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
CREATE TRIGGER trg_aircraft_updated_at BEFORE UPDATE ON aircraft FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
CREATE TRIGGER trg_flight_updated_at BEFORE UPDATE ON flight FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
CREATE TRIGGER trg_crew_updated_at BEFORE UPDATE ON crew FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();

-- ------------------------------------------------------------------ airport
-- A CHECK constraint must be immutable, and the timezone catalogue is not, so this is a trigger.
CREATE FUNCTION trg_airport_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Unknown IANA time zone "%"', NEW.timezone USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_airport_validate BEFORE INSERT OR UPDATE OF timezone ON airport
FOR EACH ROW EXECUTE FUNCTION trg_airport_validate();

-- ------------------------------------------------------------------ flight state machine
--   Scheduled -> Delayed | Boarding | Cancelled
--   Delayed   -> Scheduled (delay recovered) | Boarding | Cancelled
--   Boarding  -> Departed | Delayed | Cancelled
--   Departed  -> Landed
--   Landed, Cancelled: terminal
-- New flights start as Scheduled on an Active aircraft. Once a flight has departed its
-- aircraft, route and departure time are history and cannot be rewritten.
CREATE FUNCTION trg_flight_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE ac_status text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.flight_status <> 'Scheduled' THEN
      RAISE EXCEPTION 'New flights must start as Scheduled' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.flight_status IS DISTINCT FROM OLD.flight_status AND NOT (
         (OLD.flight_status = 'Scheduled' AND NEW.flight_status IN ('Delayed','Boarding','Cancelled'))
      OR (OLD.flight_status = 'Delayed'   AND NEW.flight_status IN ('Scheduled','Boarding','Cancelled'))
      OR (OLD.flight_status = 'Boarding'  AND NEW.flight_status IN ('Departed','Delayed','Cancelled'))
      OR (OLD.flight_status = 'Departed'  AND NEW.flight_status = 'Landed')) THEN
      RAISE EXCEPTION 'Illegal flight status change % -> %', OLD.flight_status, NEW.flight_status USING ERRCODE = '23514';
    END IF;
    IF OLD.flight_status IN ('Departed','Landed','Cancelled')
       AND (NEW.aircraft_id, NEW.origin, NEW.destination, NEW.departure_time, NEW.flight_number)
           IS DISTINCT FROM (OLD.aircraft_id, OLD.origin, OLD.destination, OLD.departure_time, OLD.flight_number) THEN
      RAISE EXCEPTION 'A % flight cannot be re-planned', lower(OLD.flight_status) USING ERRCODE = '23514';
    END IF;
    IF OLD.flight_status IN ('Landed','Cancelled') AND NEW.arrival_time IS DISTINCT FROM OLD.arrival_time THEN
      RAISE EXCEPTION 'A % flight is closed', lower(OLD.flight_status) USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.flight_status <> 'Cancelled' AND (TG_OP = 'INSERT' OR NEW.aircraft_id IS DISTINCT FROM OLD.aircraft_id) THEN
    SELECT status INTO ac_status FROM aircraft WHERE aircraft_id = NEW.aircraft_id;
    IF ac_status IS DISTINCT FROM 'Active' THEN
      RAISE EXCEPTION 'Aircraft % is % and cannot be scheduled', NEW.aircraft_id, coalesce(ac_status, 'missing')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_flight_status_transition BEFORE INSERT OR UPDATE ON flight
FOR EACH ROW EXECUTE FUNCTION trg_flight_validate();

-- ------------------------------------------------------------------ fare buckets
CREATE FUNCTION trg_flight_fare_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE seats integer;
BEGIN
  SELECT count(*) INTO seats FROM seat s JOIN flight f ON f.aircraft_id = s.aircraft_id
  WHERE f.flight_id = NEW.flight_id AND s.seat_class = NEW.fare_class;
  IF NEW.seats_allocated > seats THEN
    RAISE EXCEPTION 'Cannot allocate % % seats: the aircraft has %', NEW.seats_allocated, NEW.fare_class, seats
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_flight_fare_validate BEFORE INSERT OR UPDATE ON flight_fare
FOR EACH ROW EXECUTE FUNCTION trg_flight_fare_validate();

-- ------------------------------------------------------------------ crew assignment
-- Hard rules that must hold even for direct writes; the full legality report (rest, position,
-- certificates) runs in sp_assign_crew where the UI can explain each failure.
CREATE FUNCTION trg_crew_assignment_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE desig text; active boolean;
BEGIN
  SELECT designation, is_active INTO desig, active FROM crew WHERE crew_id = NEW.crew_id;
  IF NOT active THEN RAISE EXCEPTION 'Inactive crew cannot be assigned' USING ERRCODE = '23514'; END IF;
  IF NOT (NEW.role_on_flight = desig
          OR (NEW.role_on_flight = 'First Officer' AND desig = 'Captain')
          OR (NEW.role_on_flight = 'Cabin Crew' AND desig = 'Purser')) THEN
    RAISE EXCEPTION '% may not fly as %', desig, NEW.role_on_flight USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM flight WHERE flight_id = NEW.flight_id AND flight_status = 'Cancelled') THEN
    RAISE EXCEPTION 'Cannot crew a cancelled flight' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_crew_assignment_validate BEFORE INSERT OR UPDATE OF crew_id, role_on_flight ON crew_assignment
FOR EACH ROW EXECUTE FUNCTION trg_crew_assignment_validate();

-- ------------------------------------------------------------------ aircraft capacity
-- aircraft.capacity must equal its number of seats. Checked at COMMIT (deferred constraint
-- trigger) so a seat map can be deleted and rebuilt inside one transaction.
CREATE FUNCTION trg_aircraft_capacity_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE id bigint; cap integer; seats integer;
BEGIN
  id := CASE WHEN TG_TABLE_NAME = 'aircraft' THEN NEW.aircraft_id
             WHEN TG_OP = 'DELETE' THEN OLD.aircraft_id ELSE NEW.aircraft_id END;
  SELECT capacity INTO cap FROM aircraft WHERE aircraft_id = id;
  IF NOT FOUND THEN RETURN NULL; END IF;   -- aircraft deleted in the same transaction
  SELECT count(*) INTO seats FROM seat WHERE aircraft_id = id;
  IF cap <> seats THEN
    RAISE EXCEPTION 'Aircraft % capacity % does not match its % seats', id, cap, seats USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_seat_capacity AFTER INSERT OR UPDATE OR DELETE ON seat
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_aircraft_capacity_check();
CREATE CONSTRAINT TRIGGER trg_aircraft_capacity AFTER INSERT OR UPDATE OF capacity ON aircraft
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_aircraft_capacity_check();

-- ------------------------------------------------------------------ outbox
-- Snapshot events: each carries the full current row, so consumers can apply them out of
-- order safely (Neo4j/Mongo keep the newest updatedAt). 'changes' lists what moved, which
-- becomes a typed entry in the Mongo flight_events time series.
CREATE FUNCTION trg_flight_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE changes jsonb := '{}'; row_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
    VALUES ('flight', OLD.flight_id::text, 'FLIGHT_DELETED', jsonb_build_object('flightId', OLD.flight_id::text));
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.flight_status IS DISTINCT FROM OLD.flight_status THEN
      changes := changes || jsonb_build_object('status', jsonb_build_array(OLD.flight_status, NEW.flight_status));
    END IF;
    IF NEW.delay_minutes IS DISTINCT FROM OLD.delay_minutes THEN
      changes := changes || jsonb_build_object('delayMinutes', jsonb_build_array(OLD.delay_minutes, NEW.delay_minutes),
                                               'delayReason', NEW.delay_reason);
    END IF;
    IF NEW.gate IS DISTINCT FROM OLD.gate THEN
      changes := changes || jsonb_build_object('gate', jsonb_build_array(OLD.gate, NEW.gate));
    END IF;
    IF NEW.departure_time IS DISTINCT FROM OLD.departure_time OR NEW.arrival_time IS DISTINCT FROM OLD.arrival_time THEN
      changes := changes || jsonb_build_object('times', jsonb_build_array(OLD.departure_time, NEW.departure_time));
    END IF;
    IF NEW.aircraft_id IS DISTINCT FROM OLD.aircraft_id THEN
      changes := changes || jsonb_build_object('aircraftId', jsonb_build_array(OLD.aircraft_id::text, NEW.aircraft_id::text));
    END IF;
    IF changes = '{}' THEN RETURN NULL; END IF;   -- nothing a consumer cares about
  END IF;
  row_data := jsonb_build_object(
    'flightId', NEW.flight_id::text, 'flightNumber', NEW.flight_number, 'origin', NEW.origin,
    'destination', NEW.destination, 'departureTime', NEW.departure_time, 'arrivalTime', NEW.arrival_time,
    'status', NEW.flight_status, 'delayMinutes', NEW.delay_minutes, 'delayReason', NEW.delay_reason, 'gate', NEW.gate,
    'aircraftId', NEW.aircraft_id::text, 'durationMinutes', NEW.duration_minutes,
    'cancelReason', NEW.cancel_reason, 'updatedAt', NEW.updated_at);
  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('flight', NEW.flight_id::text, 'FLIGHT_UPSERT', jsonb_build_object(
    'flight', row_data, 'changes', changes, 'created', TG_OP = 'INSERT',
    'actorUserId', fn_current_user_id()::text));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_flight_outbox AFTER INSERT OR UPDATE OR DELETE ON flight
FOR EACH ROW EXECUTE FUNCTION trg_flight_outbox();

CREATE FUNCTION trg_airport_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('airport', NEW.airport_code, 'AIRPORT_UPSERT', jsonb_build_object(
    'code', NEW.airport_code, 'name', NEW.airport_name, 'city', NEW.city, 'country', NEW.country,
    'timezone', NEW.timezone, 'lat', NEW.latitude, 'lon', NEW.longitude, 'updatedAt', NEW.updated_at));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_airport_outbox AFTER INSERT OR UPDATE ON airport
FOR EACH ROW EXECUTE FUNCTION trg_airport_outbox();

CREATE FUNCTION trg_aircraft_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('aircraft', NEW.aircraft_id::text, 'AIRCRAFT_UPSERT', jsonb_build_object(
    'aircraftId', NEW.aircraft_id::text, 'registration', NEW.registration, 'model', NEW.model,
    'typeRating', NEW.type_rating, 'capacity', NEW.capacity, 'status', NEW.status, 'updatedAt', NEW.updated_at));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_aircraft_outbox AFTER INSERT OR UPDATE OF registration, model, type_rating, capacity, status ON aircraft
FOR EACH ROW EXECUTE FUNCTION trg_aircraft_outbox();

-- Fare buckets are inserted after their flight, so they publish their own small event
-- (the graph keeps a per-flight minimum fare for itinerary ranking).
CREATE FUNCTION trg_flight_fare_outbox() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('flight', NEW.flight_id::text, 'FLIGHT_FARE_UPSERT', jsonb_build_object(
    'flightId', NEW.flight_id::text, 'fareClass', NEW.fare_class, 'baseFare', NEW.base_fare,
    'seatsAllocated', NEW.seats_allocated));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_flight_fare_outbox AFTER INSERT OR UPDATE ON flight_fare
FOR EACH ROW EXECUTE FUNCTION trg_flight_fare_outbox();
