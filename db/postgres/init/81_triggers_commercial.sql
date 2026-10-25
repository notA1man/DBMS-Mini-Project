-- 81_triggers_commercial.sql
-- Owner: Aiman
-- booking total sync, payment -> receipt, seat/aircraft match, baggage allowance, check-in window
CREATE FUNCTION trg_ticket_validate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE f flight%ROWTYPE; cls text; b booking%ROWTYPE;
BEGIN
  SELECT * INTO f FROM flight WHERE flight_id=NEW.flight_id FOR UPDATE;
  IF NEW.aircraft_id IS DISTINCT FROM f.aircraft_id THEN RAISE EXCEPTION 'Seat aircraft does not match flight'; END IF;
  IF NEW.ticket_status='Active' THEN
    IF f.flight_status NOT IN ('Scheduled','Delayed') OR f.departure_time<=now() THEN RAISE EXCEPTION 'Flight unavailable'; END IF;
    IF NEW.seat_number IS NOT NULL THEN
      SELECT seat_class INTO cls FROM seat WHERE aircraft_id=NEW.aircraft_id AND seat_number=NEW.seat_number;
      IF cls IS DISTINCT FROM NEW.fare_class THEN RAISE EXCEPTION 'Seat does not match fare class'; END IF;
    END IF;
  END IF;
  IF NEW.checkin_status='CheckedIn' AND (TG_OP='INSERT' OR OLD.checkin_status IS DISTINCT FROM NEW.checkin_status) THEN
    SELECT * INTO b FROM booking WHERE booking_id=NEW.booking_id;
    IF b.booking_status<>'Confirmed' OR f.flight_status NOT IN ('Scheduled','Delayed')
      OR now()<f.departure_time-interval '48 hours' OR now()>f.departure_time-interval '1 hour' THEN
      RAISE EXCEPTION 'Check-in requires payment and opens 48 to 1 hours before departure';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_ticket_seat_matches_aircraft BEFORE INSERT OR UPDATE ON ticket
FOR EACH ROW EXECUTE FUNCTION trg_ticket_validate();

CREATE FUNCTION trg_ticket_total() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    UPDATE booking SET total_amount=(SELECT coalesce(sum(fare_amount),0) FROM ticket
      WHERE booking_id=OLD.booking_id AND ticket_status='Active') WHERE booking_id=OLD.booking_id;
  END IF;
  IF TG_OP<>'DELETE' THEN
    UPDATE booking SET total_amount=(SELECT coalesce(sum(fare_amount),0) FROM ticket
      WHERE booking_id=NEW.booking_id AND ticket_status='Active') WHERE booking_id=NEW.booking_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_ticket_amount_sync AFTER INSERT OR UPDATE OR DELETE ON ticket
FOR EACH ROW EXECUTE FUNCTION trg_ticket_total();

CREATE FUNCTION trg_issue_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE b booking%ROWTYPE;
BEGIN
  SELECT * INTO b FROM booking WHERE booking_id=NEW.booking_id FOR UPDATE;
  IF NEW.payment_status='Succeeded' THEN
    IF b.booking_status<>'Pending' OR NEW.amount>b.total_amount-b.amount_paid THEN RAISE EXCEPTION 'Payment exceeds balance or booking is closed'; END IF;
    INSERT INTO receipt(payment_id) VALUES(NEW.payment_id);
    UPDATE booking SET amount_paid=amount_paid+NEW.amount,
      booking_status=CASE WHEN amount_paid+NEW.amount=total_amount THEN 'Confirmed' ELSE 'Pending' END
      WHERE booking_id=NEW.booking_id;
    IF b.amount_paid+NEW.amount=b.total_amount THEN
      INSERT INTO outbox_event(aggregate,aggregate_id,event_type,payload)
      VALUES('booking',NEW.booking_id,'BOOKING_CONFIRMED',jsonb_build_object(
        'bookingId',NEW.booking_id,'userId',b.created_by_user));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_payment_receipt AFTER INSERT ON payment FOR EACH ROW EXECUTE FUNCTION trg_issue_receipt();

CREATE FUNCTION trg_validate_baggage() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE cls text; total numeric; allowance numeric; status text;
BEGIN
  SELECT fare_class,ticket_status INTO cls,status FROM ticket WHERE booking_id=NEW.booking_id AND ticket_seq=NEW.ticket_seq FOR UPDATE;
  IF status IS DISTINCT FROM 'Active' THEN RAISE EXCEPTION 'Baggage requires active ticket'; END IF;
  allowance := CASE WHEN NEW.bag_type='Cabin' THEN 7 WHEN cls='Economy' THEN 20 WHEN cls='Business' THEN 30 ELSE 40 END;
  SELECT coalesce(sum(weight_kg),0) INTO total FROM baggage
    WHERE booking_id=NEW.booking_id AND ticket_seq=NEW.ticket_seq AND bag_type=NEW.bag_type
    AND (TG_OP='INSERT' OR (booking_id,ticket_seq,bag_seq)<>(OLD.booking_id,OLD.ticket_seq,OLD.bag_seq));
  IF total+NEW.weight_kg>allowance THEN RAISE EXCEPTION 'Baggage allowance exceeded (% kg)',allowance; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_baggage_allowance BEFORE INSERT OR UPDATE ON baggage FOR EACH ROW EXECUTE FUNCTION trg_validate_baggage();
