// Raw, parameterized SQL kept visible for the DBMS query showcase.
export const commercialQueries={
  directFlights:`SELECT f.flight_id,f.flight_number,f.origin,f.destination,f.departure_time,f.arrival_time,
    f.flight_status,ff.fare_class,fn_dynamic_fare(f.flight_id,ff.fare_class) AS price,
    fn_seats_remaining(f.flight_id,ff.fare_class) AS remaining
    FROM flight f JOIN flight_fare ff USING(flight_id) JOIN airport a ON a.airport_code=f.origin
    WHERE f.origin=$1 AND f.destination=$2 AND f.departure_time>now()+interval '1 hour'
      AND f.departure_time >= $3::date::timestamp AT TIME ZONE a.timezone
      AND f.departure_time < ($3::date+1)::timestamp AT TIME ZONE a.timezone
      AND f.flight_status IN ('Scheduled','Delayed')
    ORDER BY f.departure_time,ff.base_fare`,
  // Each booking with its journey: first origin, final destination, first departure, legs and travellers.
  trips:`SELECT s.*,j.origin,j.destination,j.departure_time,j.arrival_time,j.flight_number,j.legs,j.travellers
    FROM v_booking_summary s LEFT JOIN LATERAL (
      SELECT (array_agg(f.origin ORDER BY f.departure_time))[1] AS origin,
        (array_agg(f.destination ORDER BY f.departure_time DESC))[1] AS destination,
        min(f.departure_time) AS departure_time,max(f.arrival_time) AS arrival_time,
        (array_agg(f.flight_number ORDER BY f.departure_time))[1] AS flight_number,
        count(DISTINCT t.flight_id)::int AS legs,count(DISTINCT t.passenger_id)::int AS travellers
      FROM ticket t JOIN flight f USING(flight_id)
      WHERE t.booking_id=s.booking_id AND (t.ticket_status<>'Cancelled' OR s.booking_status='Cancelled')) j ON true
    WHERE s.passenger_id=$1 ORDER BY s.booking_date DESC LIMIT 100`,
  tickets:`SELECT t.*,f.flight_number,f.origin,f.destination,f.departure_time,f.arrival_time,
    p.first_name,p.last_name FROM ticket t JOIN flight f USING(flight_id)
    JOIN passenger p ON p.passenger_id=t.passenger_id WHERE t.booking_id=$1 ORDER BY t.ticket_seq`,
  receipts:`SELECT r.*,p.amount,p.payment_mode,p.gateway_ref FROM receipt r JOIN payment p USING(payment_id)
    WHERE p.booking_id=$1 ORDER BY r.receipt_date`,
  // Name/email full-text OR exact PNR. Written as a UNION so each branch uses its own index
  // (GIN on name_search, booking PK); a single WHERE ... OR EXISTS(...) forces a sequential scan.
  // The PNR is cast to bpchar (booking_id's type): comparing as text would bypass the primary key.
  lookup:`SELECT p.passenger_id,p.first_name,p.last_name,p.email,
    ts_rank_cd(p.name_search,websearch_to_tsquery('simple',$1)) AS rank
    FROM passenger p WHERE p.passenger_id IN (
      SELECT passenger_id FROM passenger WHERE name_search @@ websearch_to_tsquery('simple',$1)
      UNION SELECT passenger_id FROM booking WHERE length($1)=6 AND booking_id=upper($1)::bpchar)
    ORDER BY rank DESC,p.passenger_id LIMIT 30`,
  similar:`SELECT e.feedback_oid,e.flight_id,e.sentiment,e.created_at,1-(e.embedding <=> $1::vector) AS similarity
    FROM feedback_embedding e JOIN flight f USING(flight_id)
    WHERE ($2::bigint IS NULL OR e.flight_id=$2) AND e.created_at >= $3::timestamptz
      AND ($4::text IS NULL OR f.origin||'-'||f.destination=$4)
    ORDER BY e.embedding <=> $1::vector LIMIT 10`,
};
