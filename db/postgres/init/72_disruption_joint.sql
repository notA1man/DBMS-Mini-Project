-- 72_disruption_joint.sql
-- Owner: Both (joint disruption -> re-booking workflow)
-- Ops cancels a flight (sp_cancel_flight marks tickets/bookings Disrupted); the graph finds
-- alternative itineraries; ops accepts one and sp_rebook_ticket re-books the passenger on the
-- SAME booking in one transaction. The passenger keeps their PNR and pays nothing extra:
-- the first replacement leg carries the original fare, later legs are priced at 0, so the
-- commercial total (sum of active tickets) returns to what was paid.

-- Links a replacement ticket to the disrupted ticket it replaces (same booking).
ALTER TABLE ticket ADD COLUMN replaces_seq smallint;
ALTER TABLE ticket ADD CONSTRAINT ticket_replaces_fk
  FOREIGN KEY (booking_id, replaces_seq) REFERENCES ticket (booking_id, ticket_seq) ON DELETE RESTRICT;
ALTER TABLE ticket ADD CONSTRAINT ticket_replaces_not_self CHECK (replaces_seq IS NULL OR replaces_seq <> ticket_seq);
CREATE INDEX ticket_replaces_idx ON ticket(booking_id, replaces_seq) WHERE replaces_seq IS NOT NULL;

-- Disrupted tickets that still need a new itinerary. must_arrive_by is set when the same
-- passenger has a later active leg in the booking (the connection must still be made).
CREATE FUNCTION fn_disrupted_tickets()
RETURNS TABLE(booking_id text, ticket_seq smallint, passenger_id bigint, first_name text, last_name text,
              fare_class text, flight_id bigint, flight_number text, origin text, destination text,
              departure_time timestamptz, cancel_reason text, must_arrive_by timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  RETURN QUERY
  SELECT t.booking_id::text, t.ticket_seq, t.passenger_id, p.first_name, p.last_name, t.fare_class::text,
         f.flight_id, f.flight_number, f.origin::text, f.destination::text, f.departure_time, f.cancel_reason,
         (SELECT min(nf.departure_time) - interval '45 minutes'
          FROM ticket nt JOIN flight nf ON nf.flight_id = nt.flight_id
          WHERE nt.booking_id = t.booking_id AND nt.passenger_id = t.passenger_id
            AND nt.ticket_status = 'Active' AND nf.departure_time > f.departure_time)
  FROM ticket t
  JOIN flight f ON f.flight_id = t.flight_id
  JOIN passenger p ON p.passenger_id = t.passenger_id
  WHERE t.ticket_status = 'Disrupted'
    AND NOT EXISTS (SELECT 1 FROM ticket r WHERE r.booking_id = t.booking_id AND r.replaces_seq = t.ticket_seq)
    AND EXISTS (SELECT 1 FROM booking b WHERE b.booking_id = t.booking_id AND b.booking_status = 'Disrupted')
  ORDER BY f.departure_time, t.booking_id, t.ticket_seq;
END $$;

-- Re-book one disrupted ticket onto p_flights (1-3 legs, in travel order).
CREATE PROCEDURE sp_rebook_ticket(p_pnr text, p_seq smallint, p_flights bigint[], INOUT p_result jsonb DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t ticket%ROWTYPE; orig flight%ROWTYPE; leg flight%ROWTYPE; prev flight%ROWTYPE;
  b booking%ROWTYPE; deadline timestamptz; next_seq smallint; i integer;
  capacity integer; sold integer; new_seqs smallint[] := '{}';
BEGIN
  PERFORM fn_assert_role('ADMIN','OPS');
  IF p_flights IS NULL OR cardinality(p_flights) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'Provide 1 to 3 replacement legs';
  END IF;
  SELECT * INTO b FROM booking WHERE booking_id = p_pnr FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking % not found', p_pnr; END IF;
  SELECT * INTO t FROM ticket WHERE booking_id = p_pnr AND ticket_seq = p_seq FOR UPDATE;
  IF NOT FOUND OR t.ticket_status <> 'Disrupted' THEN RAISE EXCEPTION 'Ticket is not disrupted'; END IF;
  IF EXISTS (SELECT 1 FROM ticket WHERE booking_id = p_pnr AND replaces_seq = p_seq) THEN
    RAISE EXCEPTION 'Ticket has already been re-booked';
  END IF;
  SELECT * INTO orig FROM flight WHERE flight_id = t.flight_id;
  SELECT min(nf.departure_time) - interval '45 minutes' INTO deadline
  FROM ticket nt JOIN flight nf ON nf.flight_id = nt.flight_id
  WHERE nt.booking_id = p_pnr AND nt.passenger_id = t.passenger_id AND nt.ticket_status = 'Active'
    AND nf.departure_time > orig.departure_time;

  -- Lock replacement flights in id order (same discipline as fn_book: no lock-order deadlocks).
  PERFORM 1 FROM flight WHERE flight_id = ANY (p_flights) ORDER BY flight_id FOR UPDATE;

  FOR i IN 1 .. cardinality(p_flights) LOOP
    SELECT * INTO leg FROM flight WHERE flight_id = p_flights[i];
    IF NOT FOUND OR leg.flight_status NOT IN ('Scheduled','Delayed') OR leg.departure_time <= now() + interval '1 hour' THEN
      RAISE EXCEPTION 'Replacement flight % is not available', p_flights[i];
    END IF;
    IF i = 1 AND leg.origin <> orig.origin THEN
      RAISE EXCEPTION 'First replacement leg must depart %', orig.origin;
    END IF;
    IF i > 1 AND (leg.origin <> prev.destination OR leg.departure_time < prev.arrival_time + interval '45 minutes') THEN
      RAISE EXCEPTION 'Legs must connect at the same airport with at least 45 minutes';
    END IF;
    SELECT seats_allocated INTO capacity FROM flight_fare WHERE flight_id = leg.flight_id AND fare_class = t.fare_class;
    SELECT count(*) INTO sold FROM ticket WHERE flight_id = leg.flight_id AND fare_class = t.fare_class AND ticket_status = 'Active';
    IF capacity IS NULL OR sold >= capacity THEN
      RAISE EXCEPTION 'No % seats left on flight %', t.fare_class, leg.flight_number;
    END IF;
    prev := leg;
  END LOOP;
  IF prev.destination <> orig.destination THEN RAISE EXCEPTION 'Itinerary must end at %', orig.destination; END IF;
  IF deadline IS NOT NULL AND prev.arrival_time > deadline THEN
    RAISE EXCEPTION 'Itinerary arrives too late for the passenger''s onward flight';
  END IF;

  SELECT coalesce(max(ticket_seq), 0) INTO next_seq FROM ticket WHERE booking_id = p_pnr;
  FOR i IN 1 .. cardinality(p_flights) LOOP
    SELECT * INTO leg FROM flight WHERE flight_id = p_flights[i];
    next_seq := next_seq + 1;
    INSERT INTO ticket(booking_id, ticket_seq, fare_class, fare_amount, flight_id, passenger_id, aircraft_id, replaces_seq)
    VALUES (p_pnr, next_seq, t.fare_class, CASE WHEN i = 1 THEN t.fare_amount ELSE 0 END,
            leg.flight_id, t.passenger_id, leg.aircraft_id, p_seq);
    new_seqs := new_seqs || next_seq;
  END LOOP;

  -- Once nothing in the booking is left unresolved, it returns to its payment state.
  IF NOT EXISTS (SELECT 1 FROM ticket x WHERE x.booking_id = p_pnr AND x.ticket_status = 'Disrupted'
                 AND NOT EXISTS (SELECT 1 FROM ticket r WHERE r.booking_id = x.booking_id AND r.replaces_seq = x.ticket_seq)) THEN
    UPDATE booking SET booking_status = CASE WHEN amount_paid >= total_amount THEN 'Confirmed' ELSE 'Pending' END
    WHERE booking_id = p_pnr;
  END IF;

  INSERT INTO outbox_event(aggregate, aggregate_id, event_type, payload)
  VALUES ('booking', p_pnr, 'BOOKING_REBOOKED', jsonb_build_object(
    'bookingId', p_pnr, 'userId', b.created_by_user::text, 'replacedSeq', p_seq,
    'flights', (SELECT jsonb_agg(f2.flight_number ORDER BY array_position(p_flights, f2.flight_id))
                FROM flight f2 WHERE f2.flight_id = ANY (p_flights))));

  p_result := jsonb_build_object('bookingId', p_pnr, 'replacedSeq', p_seq, 'newSeqs', to_jsonb(new_seqs),
    'bookingStatus', (SELECT booking_status FROM booking WHERE booking_id = p_pnr));
  PERFORM fn_emit_ops_audit('REBOOK_TICKET', 'booking', p_pnr, p_result);
END $$;
