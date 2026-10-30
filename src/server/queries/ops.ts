// Raw, parameterized operations SQL (Aditya), kept in one place so the DB showcase can display
// exactly what runs. Mutations go through SECURITY DEFINER routines; these are the reads.
export const opsQueries = {
  // Origin-airport calendar day -> UTC window (flights near local midnight land on the right day).
  dayWindow: `SELECT ($2::date::timestamp AT TIME ZONE timezone) AS start,
    (($2::date + 1)::timestamp AT TIME ZONE timezone) AS "end" FROM airport WHERE airport_code = $1`,

  // Itinerary search without Neo4j: a recursive CTE that joins flight to itself once per hop,
  // carrying the visited airports to avoid loops. Same rules as the graph's CONNECTS_TO edges.
  itinerariesFallback: `WITH RECURSIVE paths AS (
      SELECT ARRAY[f.flight_id] AS ids, ARRAY[f.origin::text, f.destination::text] AS stops,
             f.departure_time AS first_dep, f.arrival_time AS last_arr, f.destination::text AS at
      FROM flight f
      WHERE f.origin = $1 AND f.departure_time >= $3 AND f.departure_time < $4
        AND f.flight_status IN ('Scheduled','Delayed') AND f.departure_time > now() + interval '1 hour'
      UNION ALL
      SELECT p.ids || g.flight_id, p.stops || g.destination::text, p.first_dep, g.arrival_time, g.destination::text
      FROM paths p
      JOIN flight g ON g.origin = p.at
      WHERE cardinality(p.ids) < 3 AND p.at <> $2
        AND g.departure_time BETWEEN p.last_arr + interval '45 minutes' AND p.last_arr + interval '6 hours'
        AND g.flight_status IN ('Scheduled','Delayed')
        AND NOT g.destination::text = ANY (p.stops)
    )
    SELECT ids::text[] AS "flightIds", (extract(epoch FROM last_arr - first_dep) / 60)::integer AS "totalMinutes"
    FROM paths WHERE at = $2 AND ($5::timestamptz IS NULL OR last_arr <= $5)
    ORDER BY cardinality(ids), "totalMinutes" LIMIT 40`,

  // Confirms graph candidates against the source of truth: still bookable, seats left, live price.
  legDetails: `SELECT f.flight_id::text AS "flightId", f.flight_number AS "flightNumber", f.origin, f.destination,
      f.departure_time AS "departureTime", f.arrival_time AS "arrivalTime", f.flight_status AS status,
      fn_seats_remaining(f.flight_id, $2) AS remaining, fn_dynamic_fare(f.flight_id, $2) AS price
    FROM flight f JOIN flight_fare ff ON ff.flight_id = f.flight_id AND ff.fare_class = $2
    WHERE f.flight_id = ANY ($1::bigint[]) AND f.flight_status IN ('Scheduled','Delayed')
      AND f.departure_time > now() + interval '1 hour'`,

  departures: `SELECT f.flight_id::text AS "flightId", f.flight_number AS "flightNumber", f.origin, f.destination,
      a.city AS "destinationCity", f.departure_time AS "departureTime", f.arrival_time AS "arrivalTime",
      f.departure_time - make_interval(mins => f.delay_minutes) AS "scheduledDeparture",
      f.flight_status AS status, f.delay_minutes AS "delayMinutes", f.delay_reason AS "delayReason", f.gate
    FROM flight f JOIN airport a ON a.airport_code = f.destination
    WHERE f.origin = $1 AND f.departure_time > now() - interval '45 minutes'
      AND f.departure_time < now() + make_interval(hours => $2)
    ORDER BY f.departure_time LIMIT 60`,

  schedule: `SELECT f.flight_id::text AS "flightId", f.flight_number AS "flightNumber", f.origin, f.destination,
      f.departure_time AS "departureTime", f.arrival_time AS "arrivalTime", f.flight_status AS status,
      f.delay_minutes AS "delayMinutes", f.gate, a.registration, a.type_rating AS "typeRating",
      (SELECT count(*) FROM crew_assignment ca WHERE ca.flight_id = f.flight_id AND ca.standby_status = 'Assigned')::int AS crew,
      fn_flight_crew_complete(f.flight_id) AS "crewComplete",
      (SELECT sum(fn_seats_remaining(f.flight_id, ff.fare_class)) FROM flight_fare ff WHERE ff.flight_id = f.flight_id)::int AS "seatsLeft"
    FROM flight f JOIN aircraft a USING (aircraft_id)
    WHERE f.departure_time >= $1 AND f.departure_time < $2
      AND ($3::text IS NULL OR f.origin = $3 OR f.destination = $3)
      AND ($4::text IS NULL OR f.flight_status = $4)
    ORDER BY f.departure_time LIMIT 300`,

  flight: `SELECT f.*, f.departure_time - make_interval(mins => f.delay_minutes) AS scheduled_departure,
      a.registration, a.model, a.type_rating, a.capacity, fn_flight_crew_complete(f.flight_id) AS crew_complete
    FROM flight f JOIN aircraft a USING (aircraft_id) WHERE f.flight_id = $1`,
  flightCrew: `SELECT ca.crew_id::text AS "crewId", c.crew_name AS name, c.designation, ca.role_on_flight AS role,
      ca.standby_status AS standby, ca.duty_start AS "dutyStart", ca.duty_end AS "dutyEnd"
    FROM crew_assignment ca JOIN crew c USING (crew_id) WHERE ca.flight_id = $1
    ORDER BY array_position(ARRAY['Captain','First Officer','Purser','Cabin Crew'], ca.role_on_flight), c.crew_name`,
  flightLoad: `SELECT fare_class AS "fareClass", seats_allocated AS allocated, seats_sold AS sold, load_factor AS "loadFactor"
    FROM v_flight_load WHERE flight_id = $1 ORDER BY array_position(ARRAY['First','Business','Economy'], fare_class::text)`,
  manifest: `SELECT booking_id AS "bookingId", ticket_seq AS seq, first_name AS "firstName", last_name AS "lastName",
      fare_class AS "fareClass", seat_number AS seat, checkin_status AS checkin, ticket_status AS status, bags,
      bag_weight_kg AS "bagKg"
    FROM v_flight_manifest WHERE flight_id = $1 ORDER BY seat_number NULLS LAST, last_name`,

  // Crew who could fill a role: right rank and type rating, and at the origin when the flight
  // leaves. Only that short list is run through the full rule set (fn_crew_legality).
  crewCandidates: `SELECT x."crewId", x.name, x.designation, x.base, x.location,
      bool_and(l.passed) AS legal,
      jsonb_agg(jsonb_build_object('rule', l.rule, 'detail', l.detail)) FILTER (WHERE NOT l.passed) AS failures
    FROM (
      SELECT c.crew_id, c.crew_id::text AS "crewId", c.crew_name AS name, c.designation, c.base_airport AS base,
             f.flight_id, loc.location
      FROM flight f JOIN aircraft a USING (aircraft_id) CROSS JOIN crew c
      CROSS JOIN LATERAL (SELECT coalesce((SELECT pf.destination FROM crew_assignment ca JOIN flight pf USING (flight_id)
          WHERE ca.crew_id = c.crew_id AND ca.duty_end <= f.departure_time - interval '30 minutes'
          ORDER BY ca.duty_end DESC LIMIT 1), c.base_airport) AS location) loc
      WHERE f.flight_id = $1 AND c.is_active AND loc.location = f.origin
        AND NOT EXISTS (SELECT 1 FROM crew_assignment ca WHERE ca.crew_id = c.crew_id AND ca.flight_id = f.flight_id)
        AND c.designation = ANY (CASE $2 WHEN 'Captain' THEN ARRAY['Captain'] WHEN 'First Officer' THEN ARRAY['First Officer','Captain']
                                         WHEN 'Purser' THEN ARRAY['Purser'] ELSE ARRAY['Cabin Crew','Purser'] END)
        AND ($2 IN ('Purser','Cabin Crew') OR EXISTS (SELECT 1 FROM crew_certification cc
              WHERE cc.crew_id = c.crew_id AND cc.certification = 'TYPE:' || a.type_rating))
      OFFSET 0
    ) x
    CROSS JOIN LATERAL fn_crew_legality(x.crew_id, x.flight_id, $2) l
    GROUP BY x."crewId", x.name, x.designation, x.base, x.location
    ORDER BY legal DESC, x.name LIMIT $3`,

  coverage: `SELECT flight_id::text AS "flightId", flight_number AS "flightNumber", origin, destination,
      departure_time AS "departureTime", captains, first_officers AS "firstOfficers", cabin_crew AS "cabinCrew",
      cabin_required AS "cabinRequired"
    FROM v_crew_coverage WHERE departure_time < now() + make_interval(hours => $1) ORDER BY departure_time`,

  roster: `SELECT flight_id::text AS "flightId", flight_number AS "flightNumber", origin, destination,
      departure_time AS "departureTime", arrival_time AS "arrivalTime", flight_status AS status,
      role_on_flight AS role, standby_status AS standby, duty_start AS "dutyStart", duty_end AS "dutyEnd"
    FROM v_crew_roster WHERE crew_id = $1 ORDER BY duty_start LIMIT 60`,
  crewProfile: `SELECT c.crew_id::text AS "crewId", c.crew_name AS name, c.designation, c.base_airport AS base,
      c.license_number AS license, c.hire_date AS "hireDate",
      (SELECT jsonb_agg(jsonb_build_object('certification', certification, 'validUntil', valid_until) ORDER BY certification)
         FROM crew_certification WHERE crew_id = c.crew_id) AS certifications
    FROM crew c WHERE c.crew_id = $1`,

  fleet: `SELECT a.aircraft_id::text AS "aircraftId", a.registration, a.model, a.manufacturer, a.type_rating AS "typeRating",
      a.capacity, a.status, v.age_years AS "ageYears",
      (SELECT jsonb_object_agg(seat_class, n) FROM (SELECT seat_class, count(*) AS n FROM seat s
         WHERE s.aircraft_id = a.aircraft_id GROUP BY seat_class) x) AS cabins,
      (SELECT count(*) FROM flight f WHERE f.aircraft_id = a.aircraft_id AND f.flight_status IN ('Scheduled','Delayed','Boarding','Departed'))::int AS "openFlights"
    FROM aircraft a JOIN v_aircraft_age v USING (aircraft_id) ORDER BY a.type_rating, a.registration`,
  seatMap: `SELECT seat_number AS seat, seat_class AS "class", seat_position AS position, is_exit_row AS exit
    FROM seat WHERE aircraft_id = $1
    ORDER BY substring(seat_number FROM '^[0-9]+')::int, right(seat_number, 1)`,
  airports: `SELECT airport_code AS code, airport_name AS name, city, country, timezone, latitude AS lat, longitude AS lon,
      (SELECT count(*) FROM flight f WHERE f.origin = a.airport_code AND f.departure_time > now())::int AS "upcomingDepartures"
    FROM airport a ORDER BY airport_code`,
  // Autocomplete: full-text match first, trigram similarity catches typos ("Bengalru").
  airportSearch: `SELECT airport_code AS code, airport_name AS name, city,
      greatest(similarity(city, $1), similarity(airport_name, $1)) AS score
    FROM airport
    WHERE name_search @@ plainto_tsquery('simple', $1) OR city % $1 OR airport_name % $1 OR airport_code = upper($1)
    ORDER BY (airport_code = upper($1)) DESC, score DESC LIMIT 8`,

  // Landing page network size: distinct routes, served airports, average flights per UTC day.
  networkStats: `SELECT count(DISTINCT (origin, destination))::int AS routes,
      (SELECT count(*) FROM airport)::int AS airports,
      round(count(*)::numeric / greatest(1, count(DISTINCT (departure_time AT TIME ZONE 'UTC')::date)))::int AS "dailyFlights"
    FROM flight WHERE flight_status <> 'Cancelled'`,

  // Analytics (SQL side)
  loadByRoute: `SELECT origin || '-' || destination AS route, count(DISTINCT flight_id)::int AS flights,
      sum(seats_sold)::int AS sold, sum(seats_allocated)::int AS seats,
      round(sum(seats_sold)::numeric / nullif(sum(seats_allocated), 0), 3) AS "loadFactor"
    FROM v_flight_load WHERE departure_time BETWEEN now() - interval '30 days' AND now() + interval '14 days'
    GROUP BY 1 HAVING sum(seats_allocated) > 0 ORDER BY "loadFactor" DESC NULLS LAST LIMIT 15`,
  otpSql: `SELECT origin || '-' || destination AS route, count(*)::int AS flights,
      round(avg((delay_minutes <= 15)::int), 3) AS "onTimeRate", round(avg(delay_minutes), 1) AS "avgDelay"
    FROM flight WHERE flight_status = 'Landed' AND arrival_time > now() - interval '30 days'
    GROUP BY 1 HAVING count(*) >= 5 ORDER BY "onTimeRate" LIMIT 10`,
  fleetUtilisation: `SELECT a.registration, a.type_rating AS "typeRating",
      round(sum(f.duration_minutes) FILTER (WHERE f.flight_status IN ('Departed','Landed')) / 60.0 / 14, 1) AS "blockHoursPerDay"
    FROM aircraft a LEFT JOIN flight f ON f.aircraft_id = a.aircraft_id AND f.departure_time > now() - interval '14 days'
      AND f.departure_time <= now()
    GROUP BY a.aircraft_id ORDER BY "blockHoursPerDay" DESC NULLS LAST`,
};
