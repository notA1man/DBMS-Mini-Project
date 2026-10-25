-- 71_functions_commercial.sql
-- Owner: Aiman
-- fn_generate_pnr, fn_dynamic_fare, fn_book, sp_pay, sp_cancel_booking, sp_check_in, fn_seat_map
-- Every SECURITY DEFINER entry point authenticates the transaction context.
-- Only the trusted server may hold skyops_app credentials and set app.user_id.
CREATE FUNCTION fn_current_user_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::bigint
$$;

CREATE FUNCTION fn_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app_user WHERE user_id=fn_current_user_id()
    AND is_active AND role IN ('ADMIN','OPS'))
$$;

CREATE FUNCTION fn_owns_passenger(p_passenger bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM app_user WHERE user_id=fn_current_user_id()
    AND is_active AND passenger_id=p_passenger)
$$;

CREATE FUNCTION fn_crew_can_read(p_flight bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM app_user u JOIN crew_assignment ca ON ca.crew_id=u.crew_id
    WHERE u.user_id=fn_current_user_id() AND u.is_active AND u.role='CREW' AND ca.flight_id=p_flight)
$$;

CREATE FUNCTION fn_assert_booking_access(p_pnr text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM booking b WHERE b.booking_id=p_pnr
    AND (fn_is_staff() OR fn_owns_passenger(b.passenger_id))) THEN
    RAISE EXCEPTION 'Booking unavailable' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION fn_generate_pnr() RETURNS text
LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE candidate text;
BEGIN
  FOR i IN 1..100 LOOP
    candidate := upper(substr(encode(gen_random_bytes(6),'hex'),1,6));
    IF NOT EXISTS (SELECT 1 FROM booking WHERE booking_id=candidate) THEN RETURN candidate; END IF;
  END LOOP;
  RAISE EXCEPTION 'Unable to generate PNR; retry transaction' USING ERRCODE='40001';
END $$;

CREATE FUNCTION fn_dynamic_fare(p_flight bigint, p_class text) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE base numeric; capacity integer; sold integer; dep timestamptz;
BEGIN
  SELECT ff.base_fare, ff.seats_allocated, f.departure_time INTO base, capacity, dep
  FROM flight_fare ff JOIN flight f USING(flight_id)
  WHERE ff.flight_id=p_flight AND ff.fare_class=p_class AND f.flight_status IN ('Scheduled','Delayed');
  IF NOT FOUND OR capacity <= 0 OR dep <= now() THEN RAISE EXCEPTION 'Fare unavailable'; END IF;
  SELECT count(*) INTO sold FROM ticket WHERE flight_id=p_flight AND fare_class=p_class AND ticket_status='Active';
  RETURN round(base * (1 + 0.5*sold/capacity) * CASE
    WHEN dep < now()+interval '2 days' THEN 1.30
    WHEN dep < now()+interval '7 days' THEN 1.15 ELSE 1 END, 2);
END $$;

-- Contract: [{flightId: bigint, passengerId: bigint, fareClass: string, seatNumber?: string}].
-- All items succeed or none do. Sorted flight locks avoid opposite-order itinerary deadlocks.
CREATE FUNCTION fn_book(p_passenger bigint, p_items jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pnr text; item jsonb; f flight%ROWTYPE; seq smallint := 0;
  capacity integer; sold integer; price numeric; actor bigint := fn_current_user_id();
BEGIN
  IF NOT (fn_is_staff() OR fn_owns_passenger(p_passenger)) THEN
    RAISE EXCEPTION 'Passenger unavailable' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Items must be an array'; END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'Provide 1 to 24 ticket items'; END IF;
  PERFORM 1 FROM flight WHERE flight_id IN
    (SELECT (x->>'flightId')::bigint FROM jsonb_array_elements(p_items) x)
    ORDER BY flight_id FOR UPDATE;
  -- The unique primary key remains the final guard against concurrent PNR collisions.
  LOOP
    pnr := fn_generate_pnr();
    BEGIN
      INSERT INTO booking(booking_id,passenger_id,created_by_user) VALUES(pnr,p_passenger,actor);
      EXIT;
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    seq := seq+1;
    SELECT * INTO f FROM flight WHERE flight_id=(item->>'flightId')::bigint;
    IF NOT FOUND OR f.flight_status NOT IN ('Scheduled','Delayed') OR f.departure_time<=now()+interval '1 hour' THEN
      RAISE EXCEPTION 'Flight unavailable for booking';
    END IF;
    SELECT seats_allocated INTO capacity FROM flight_fare
      WHERE flight_id=f.flight_id AND fare_class=item->>'fareClass';
    SELECT count(*) INTO sold FROM ticket WHERE flight_id=f.flight_id
      AND fare_class=item->>'fareClass' AND ticket_status='Active';
    IF capacity IS NULL OR sold>=capacity THEN RAISE EXCEPTION 'Fare bucket sold out'; END IF;
    price := fn_dynamic_fare(f.flight_id,item->>'fareClass');
    INSERT INTO ticket(booking_id,ticket_seq,fare_class,fare_amount,flight_id,passenger_id,aircraft_id,seat_number)
    VALUES(pnr,seq,item->>'fareClass',price,f.flight_id,(item->>'passengerId')::bigint,f.aircraft_id,nullif(item->>'seatNumber',''));
  END LOOP;
  PERFORM fn_emit_audit('BOOK',pnr);
  RETURN pnr;
END $$;

CREATE PROCEDURE sp_pay(p_pnr text, p_amount numeric, p_mode text, p_reference text DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b booking%ROWTYPE; prior payment%ROWTYPE; ref text;
BEGIN
  PERFORM fn_assert_booking_access(p_pnr);
  SELECT * INTO b FROM booking WHERE booking_id=p_pnr FOR UPDATE;
  ref := coalesce(p_reference, 'SIM-' || encode(gen_random_bytes(16),'hex'));
  SELECT * INTO prior FROM payment WHERE gateway_ref=ref;
  IF FOUND THEN
    IF prior.booking_id=p_pnr AND prior.amount=p_amount AND prior.payment_mode=p_mode THEN RETURN; END IF;
    RAISE EXCEPTION 'Payment reference already used';
  END IF;
  IF b.booking_status <> 'Pending' OR p_amount IS NULL OR p_amount<=0 OR p_amount<>round(p_amount,2) OR p_amount>b.total_amount-b.amount_paid THEN
    RAISE EXCEPTION 'Invalid payment amount or booking status';
  END IF;
  INSERT INTO payment(amount,payment_mode,gateway_ref,booking_id) VALUES(p_amount,p_mode,ref,p_pnr);
  PERFORM fn_emit_audit('PAY',p_pnr);
END $$;

CREATE PROCEDURE sp_check_in(p_pnr text, p_seq smallint, p_seat text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t ticket%ROWTYPE;
BEGIN
  PERFORM fn_assert_booking_access(p_pnr);
  PERFORM 1 FROM booking WHERE booking_id=p_pnr AND booking_status='Confirmed' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only confirmed bookings may check in'; END IF;
  SELECT * INTO t FROM ticket WHERE booking_id=p_pnr AND ticket_seq=p_seq FOR UPDATE;
  IF NOT FOUND OR t.ticket_status<>'Active' THEN RAISE EXCEPTION 'Ticket unavailable'; END IF;
  IF t.checkin_status='CheckedIn' THEN
    IF t.seat_number=p_seat THEN RETURN; END IF;
    RAISE EXCEPTION 'Ticket already checked in';
  END IF;
  UPDATE ticket SET seat_number=p_seat, checkin_status='CheckedIn',
    boarding_pass_code=encode(gen_random_bytes(16),'hex') WHERE booking_id=p_pnr AND ticket_seq=p_seq;
  PERFORM fn_emit_audit('CHECK_IN',p_pnr);
END $$;

CREATE PROCEDURE sp_add_baggage(p_pnr text, p_seq smallint, p_weight numeric, p_type text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE next_seq smallint;
BEGIN
  PERFORM fn_assert_booking_access(p_pnr);
  PERFORM 1 FROM ticket WHERE booking_id=p_pnr AND ticket_seq=p_seq AND ticket_status='Active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ticket unavailable'; END IF;
  SELECT coalesce(max(bag_seq),0)+1 INTO next_seq FROM baggage WHERE booking_id=p_pnr AND ticket_seq=p_seq;
  INSERT INTO baggage VALUES(p_pnr,p_seq,next_seq,p_weight,p_type,DEFAULT);
  PERFORM fn_emit_audit('ADD_BAGGAGE',p_pnr);
END $$;

CREATE PROCEDURE sp_cancel_booking(p_pnr text, p_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE b booking%ROWTYPE; first_dep timestamptz; refund numeric;
BEGIN
  PERFORM fn_assert_booking_access(p_pnr);
  SELECT * INTO b FROM booking WHERE booking_id=p_pnr FOR UPDATE;
  IF b.booking_status='Cancelled' THEN RETURN; END IF;
  IF p_reason IS NULL OR length(btrim(p_reason))=0 THEN RAISE EXCEPTION 'Cancellation reason required'; END IF;
  SELECT min(f.departure_time) INTO first_dep FROM ticket t JOIN flight f USING(flight_id)
    WHERE t.booking_id=p_pnr AND t.ticket_status IN ('Active','Disrupted');
  IF first_dep<=now() THEN RAISE EXCEPTION 'Cannot cancel after departure'; END IF;
  refund := round(b.amount_paid * CASE WHEN b.booking_status='Disrupted' THEN 1
    WHEN first_dep>=now()+interval '24 hours' THEN 0.90
    WHEN first_dep>=now()+interval '2 hours' THEN 0.50 ELSE 0 END,2);
  UPDATE ticket SET ticket_status='Cancelled',checkin_status='NotCheckedIn',boarding_pass_code=NULL
    WHERE booking_id=p_pnr AND ticket_status IN ('Active','Disrupted');
  UPDATE booking SET booking_status='Cancelled',cancel_reason=p_reason,refund_amount=refund WHERE booking_id=p_pnr;
  INSERT INTO outbox_event(aggregate,aggregate_id,event_type,payload)
  VALUES('booking',p_pnr,'BOOKING_CANCELLED',jsonb_build_object(
    'bookingId',p_pnr,'userId',b.created_by_user,'refundAmount',refund,'reason',p_reason));
  PERFORM fn_emit_audit('CANCEL',p_pnr);
END $$;

CREATE FUNCTION fn_seat_map(p_flight bigint)
RETURNS TABLE(seat_number text, seat_class text, available boolean, price numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.seat_number, s.seat_class::text,
    NOT EXISTS (SELECT 1 FROM ticket t WHERE t.flight_id=f.flight_id
      AND t.seat_number=s.seat_number AND t.ticket_status='Active'),
    fn_dynamic_fare(f.flight_id,s.seat_class)
  FROM flight f JOIN seat s USING(aircraft_id)
  WHERE f.flight_id=p_flight AND f.flight_status IN ('Scheduled','Delayed') AND f.departure_time>now()
  ORDER BY s.seat_number
$$;

-- Authentication returns no hash. Failure counters commit because invalid credentials
-- return an empty result rather than raising an exception/rolling back the counter.
CREATE FUNCTION fn_authenticate(p_email text, p_password text)
RETURNS TABLE(user_id bigint, email text, role text, passenger_id bigint, crew_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u app_user%ROWTYPE;
BEGIN
  IF octet_length(p_password) NOT BETWEEN 12 AND 72 THEN RETURN; END IF;
  SELECT * INTO u FROM app_user a WHERE a.email=lower(btrim(p_email)) FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM crypt(p_password, '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW');
    RETURN;
  END IF;
  IF NOT u.is_active OR u.locked_until>now() THEN RETURN; END IF;
  IF crypt(p_password,u.password_hash) IS DISTINCT FROM u.password_hash THEN
    UPDATE app_user a SET failed_logins=CASE WHEN u.locked_until<=now() THEN 1 ELSE u.failed_logins+1 END,
      locked_until=CASE WHEN u.locked_until<=now() THEN NULL
        WHEN u.failed_logins+1>=5 THEN now()+interval '15 minutes' ELSE NULL END
      WHERE a.user_id=u.user_id;
    RETURN;
  END IF;
  UPDATE app_user a SET failed_logins=0,locked_until=NULL WHERE a.user_id=u.user_id;
  RETURN QUERY SELECT u.user_id,u.email::text,u.role,u.passenger_id,u.crew_id;
END $$;

CREATE FUNCTION fn_request_budget(p_key text,p_limit integer,p_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE used integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 100 OR p_seconds NOT BETWEEN 10 AND 3600 THEN RAISE EXCEPTION 'Invalid request budget'; END IF;
  DELETE FROM auth_rate_limit WHERE bucket_start<now()-interval '1 hour';
  INSERT INTO auth_rate_limit AS r(key,bucket_start,attempts) VALUES(p_key,now(),1)
    ON CONFLICT(key) DO UPDATE SET
      bucket_start=CASE WHEN r.bucket_start<=now()-make_interval(secs=>p_seconds) THEN now() ELSE r.bucket_start END,
      attempts=CASE WHEN r.bucket_start<=now()-make_interval(secs=>p_seconds) THEN 1 ELSE least(r.attempts+1,p_limit+1) END
    RETURNING attempts INTO used;
  RETURN used<=p_limit;
END $$;

CREATE FUNCTION fn_register(p_email text, p_password text, p_first text, p_last text, p_dob date)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pid bigint; uid bigint;
BEGIN
  IF octet_length(p_password) NOT BETWEEN 12 AND 72 OR p_password IS NULL THEN
    RAISE EXCEPTION 'Password must be 12 to 72 bytes';
  END IF;
  IF p_dob>current_date THEN RAISE EXCEPTION 'Date of birth cannot be in the future'; END IF;
  INSERT INTO passenger(first_name,last_name,date_of_birth,email)
    VALUES(btrim(p_first),btrim(p_last),p_dob,lower(btrim(p_email))) RETURNING passenger_id INTO pid;
  INSERT INTO app_user(email,password_hash,role,passenger_id)
    VALUES(lower(btrim(p_email)),crypt(p_password,gen_salt('bf',12)),'PASSENGER',pid) RETURNING user_id INTO uid;
  PERFORM fn_emit_audit('REGISTER',uid::text,uid);
  RETURN uid;
END $$;

CREATE FUNCTION fn_add_traveler(p_email text,p_first text,p_last text,p_dob date) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE pid bigint;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE user_id=fn_current_user_id() AND is_active AND role='PASSENGER') THEN
    RAISE EXCEPTION 'Passenger account required' USING ERRCODE='42501';
  END IF;
  IF p_dob>current_date THEN RAISE EXCEPTION 'Date of birth cannot be in the future'; END IF;
  -- Reuse a companion previously booked by this account only when identity
  -- details match; never reuse another account's record by email alone.
  SELECT p.passenger_id INTO pid FROM passenger p WHERE p.email=lower(btrim(p_email))
    AND p.first_name=btrim(p_first) AND p.last_name=btrim(p_last) AND p.date_of_birth=p_dob
    AND EXISTS(SELECT 1 FROM ticket t JOIN booking b USING(booking_id)
      WHERE t.passenger_id=p.passenger_id AND fn_owns_passenger(b.passenger_id));
  IF FOUND THEN RETURN pid; END IF;
  INSERT INTO passenger(first_name,last_name,date_of_birth,email)
    VALUES(btrim(p_first),btrim(p_last),p_dob,lower(btrim(p_email))) RETURNING passenger_id INTO pid;
  RETURN pid;
END $$;

CREATE PROCEDURE sp_admin_create_user(p_email text,p_password text,p_role text,p_crew bigint DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE user_id=fn_current_user_id() AND is_active AND role='ADMIN') THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
  END IF;
  IF p_role NOT IN ('ADMIN','OPS','CREW') OR p_password IS NULL OR octet_length(p_password) NOT BETWEEN 12 AND 72 THEN
    RAISE EXCEPTION 'Invalid staff role or password';
  END IF;
  INSERT INTO app_user(email,password_hash,role,crew_id)
    VALUES(lower(btrim(p_email)),crypt(p_password,gen_salt('bf',12)),p_role,p_crew);
  PERFORM fn_emit_audit('CREATE_STAFF',lower(btrim(p_email)));
END $$;

CREATE FUNCTION fn_session_user()
RETURNS TABLE(user_id bigint, email text, role text, passenger_id bigint, crew_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.user_id,a.email::text,a.role,a.passenger_id,a.crew_id FROM app_user a
  WHERE a.user_id=fn_current_user_id() AND a.is_active
$$;

CREATE PROCEDURE sp_store_passport(p_passenger bigint,p_number text,p_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (fn_is_staff() OR fn_owns_passenger(p_passenger)) THEN
    RAISE EXCEPTION 'Passenger unavailable' USING ERRCODE='42501';
  END IF;
  IF p_key IS NULL OR octet_length(p_key)<32 THEN RAISE EXCEPTION 'Encryption key is not configured'; END IF;
  IF p_number IS NULL OR p_number !~ '^[A-Z0-9]{6,20}$' THEN RAISE EXCEPTION 'Invalid passport format'; END IF;
  UPDATE passenger SET passport_no_enc=pgp_sym_encrypt(p_number,p_key,'cipher-algo=aes256') WHERE passenger_id=p_passenger;
  PERFORM fn_emit_audit('UPDATE_PASSPORT',p_passenger::text);
END $$;

CREATE FUNCTION fn_admin_users()
RETURNS TABLE(user_id bigint,email text,role text,is_active boolean,passenger_id bigint,crew_id bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_user a WHERE a.user_id=fn_current_user_id() AND a.is_active AND a.role='ADMIN') THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT a.user_id,a.email::text,a.role,a.is_active,a.passenger_id,a.crew_id FROM app_user a ORDER BY a.user_id;
END $$;

CREATE PROCEDURE sp_admin_user(p_id bigint,p_role text,p_active boolean,p_crew bigint DEFAULT NULL)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE user_id=fn_current_user_id() AND is_active AND role='ADMIN') THEN
    RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';
  END IF;
  IF p_id=fn_current_user_id() THEN RAISE EXCEPTION 'Cannot modify your own administrator account'; END IF;
  -- A linked passenger remains a passenger; staff accounts are provisioned separately.
  UPDATE app_user SET role=p_role,is_active=p_active,crew_id=p_crew WHERE user_id=p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'User unavailable'; END IF;
  PERFORM fn_emit_audit('UPDATE_USER',p_id::text);
END $$;

-- Aditya's dispatcher projects AUDIT_LOG into audit_log. Credentials and submitted
-- passenger fields never enter the payload. Audit insertion shares the mutation transaction.
CREATE FUNCTION fn_emit_audit(p_action text,p_entity_id text,p_actor bigint DEFAULT fn_current_user_id()) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor_role text;
BEGIN
  SELECT role INTO actor_role FROM app_user WHERE user_id=p_actor AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Audit actor unavailable' USING ERRCODE='42501'; END IF;
  INSERT INTO outbox_event(aggregate,aggregate_id,event_type,payload)
    VALUES('commercial',p_entity_id,'AUDIT_LOG',jsonb_build_object('ts',now(),'userId',p_actor::text,
      'role',actor_role,'action',p_action,'entity','commercial','entityId',p_entity_id));
END $$;

CREATE FUNCTION fn_hybrid_kb(p_embedding vector(384),p_query text,p_category text DEFAULT NULL)
RETURNS TABLE(doc_id bigint,title text,category text,content text,score numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH vector_hits AS (
    SELECT c.chunk_id, row_number() OVER(ORDER BY c.embedding <=> p_embedding,c.chunk_id) AS rank
    FROM kb_chunk c JOIN kb_document d USING(doc_id)
    WHERE p_embedding IS NOT NULL AND (p_category IS NULL OR d.category=p_category)
    ORDER BY c.embedding <=> p_embedding,c.chunk_id LIMIT 20
  ), text_hits AS (
    SELECT c.chunk_id,row_number() OVER(ORDER BY ts_rank_cd(c.fts,websearch_to_tsquery('english',p_query)) DESC,c.chunk_id) AS rank
    FROM kb_chunk c JOIN kb_document d USING(doc_id)
    WHERE c.fts @@ websearch_to_tsquery('english',p_query) AND (p_category IS NULL OR d.category=p_category)
    ORDER BY ts_rank_cd(c.fts,websearch_to_tsquery('english',p_query)) DESC,c.chunk_id LIMIT 20
  ), fused AS (
    SELECT chunk_id,sum(s) AS score FROM (
      SELECT chunk_id,1.0/(60+rank) AS s FROM vector_hits
      UNION ALL SELECT chunk_id,1.0/(60+rank) FROM text_hits
    ) r GROUP BY chunk_id
  ) SELECT d.doc_id,d.title,d.category,c.content,f.score
    FROM fused f JOIN kb_chunk c USING(chunk_id) JOIN kb_document d USING(doc_id)
    ORDER BY f.score DESC,c.chunk_id LIMIT 5
$$;
