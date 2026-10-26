-- 10_ops_schema.sql
-- Owner: Aditya
-- airport, aircraft, seat, flight, crew, crew_certification, crew_assignment, flight_fare
-- Exclusion constraints: aircraft turnaround overlap, crew duty overlap
--
-- Integrity lives here, not in the app: domains, CHECKs, FKs with RESTRICT, and two
-- GiST exclusion constraints (btree_gist) that make double-scheduling an aircraft or
-- a crew member impossible. Both exclusions are DEFERRABLE so a single transaction can
-- shift a whole aircraft rotation (knock-on delays) and be checked once at COMMIT.

-- Occupancy of an aircraft for one sector, including the 45-minute turnaround.
-- timestamptz + interval is only STABLE in general (adding days depends on DST rules), so an
-- index expression cannot use it directly. Adding a fixed number of minutes is time-zone
-- independent, which makes this wrapper genuinely immutable.
CREATE FUNCTION ops_turnaround_range(p_departure timestamptz, p_arrival timestamptz) RETURNS tstzrange
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT tstzrange(p_departure, p_arrival + interval '45 minutes')
$$;

CREATE TABLE airport (
  airport_code d_iata_code PRIMARY KEY,
  airport_name text NOT NULL UNIQUE CHECK (length(btrim(airport_name)) BETWEEN 2 AND 120),
  city         text NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 80),
  country      char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),          -- ISO 3166-1 alpha-2
  timezone     text NOT NULL,                                          -- IANA name, validated by trigger
  latitude     numeric(9,6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude    numeric(9,6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  name_search  tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', airport_code || ' ' || airport_name || ' ' || city || ' ' || country)
  ) STORED,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE airport IS 'IATA airports. Deleting an airport is RESTRICTed while flights or crew reference it.';

CREATE TABLE aircraft (
  aircraft_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration        text NOT NULL UNIQUE CHECK (registration ~ '^[A-Z0-9]{1,2}-[A-Z0-9]{3,5}$'),
  model               text NOT NULL CHECK (length(btrim(model)) BETWEEN 2 AND 60),
  manufacturer        text NOT NULL CHECK (length(btrim(manufacturer)) BETWEEN 2 AND 60),
  type_rating         text NOT NULL CHECK (type_rating ~ '^[A-Z0-9]{3,6}$'),  -- e.g. A320, B789, AT76
  capacity            integer NOT NULL CHECK (capacity BETWEEN 1 AND 853),    -- = number of seat rows, checked at COMMIT
  year_of_manufacture integer NOT NULL CHECK (year_of_manufacture BETWEEN 1960 AND 2100),
  status              text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Maintenance','Retired')),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Weak entity: a seat only exists within its aircraft.
CREATE TABLE seat (
  aircraft_id   bigint NOT NULL REFERENCES aircraft ON DELETE CASCADE,
  seat_number   text NOT NULL CHECK (seat_number ~ '^[1-9][0-9]?[A-K]$'),
  seat_class    d_fare_class NOT NULL,
  seat_position text NOT NULL CHECK (seat_position IN ('Window','Middle','Aisle')),
  is_exit_row   boolean NOT NULL DEFAULT false,
  PRIMARY KEY (aircraft_id, seat_number)
);

CREATE TABLE flight (
  flight_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flight_number    text NOT NULL CHECK (flight_number ~ '^SK[0-9]{2,4}$'),
  departure_time   timestamptz NOT NULL,      -- current estimate (schedule + delay_minutes)
  arrival_time     timestamptz NOT NULL,
  flight_status    text NOT NULL DEFAULT 'Scheduled'
                   CHECK (flight_status IN ('Scheduled','Delayed','Boarding','Departed','Landed','Cancelled')),
  duration_minutes integer GENERATED ALWAYS AS
                   ((extract(epoch FROM (arrival_time - departure_time)) / 60)::integer) STORED,
  aircraft_id      bigint NOT NULL REFERENCES aircraft ON DELETE RESTRICT,
  origin           d_iata_code NOT NULL REFERENCES airport ON DELETE RESTRICT,
  destination      d_iata_code NOT NULL REFERENCES airport ON DELETE RESTRICT,
  gate             text CHECK (gate ~ '^[A-Z]?[0-9]{1,3}[A-Z]?$'),
  delay_minutes    integer NOT NULL DEFAULT 0 CHECK (delay_minutes BETWEEN 0 AND 1440),
  delay_reason     text CHECK (delay_reason IN ('Weather','ATC','Technical','Crew','Late inbound aircraft',
                                                'Ground handling','Security','Other')),
  cancel_reason    text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT flight_distinct_airports CHECK (origin <> destination),
  CONSTRAINT flight_arrives_after_departure CHECK (arrival_time > departure_time),
  CONSTRAINT flight_max_duration CHECK (arrival_time - departure_time <= interval '20 hours'),
  CONSTRAINT flight_cancel_reason CHECK ((flight_status = 'Cancelled') = (cancel_reason IS NOT NULL)),
  CONSTRAINT flight_delay_reason CHECK (delay_minutes = 0 OR delay_reason IS NOT NULL),
  CONSTRAINT flight_number_departure_uq UNIQUE (flight_number, departure_time),
  -- An aircraft cannot fly two sectors at once and needs a 45-minute turnaround.
  CONSTRAINT flight_aircraft_no_overlap EXCLUDE USING gist (
    aircraft_id WITH =,
    ops_turnaround_range(departure_time, arrival_time) WITH &&
  ) WHERE (flight_status <> 'Cancelled') DEFERRABLE INITIALLY IMMEDIATE
);
COMMENT ON COLUMN flight.delay_minutes IS 'Cumulative delay; the original schedule is departure_time - delay_minutes.';

CREATE TABLE crew (
  crew_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  crew_name      text NOT NULL CHECK (length(btrim(crew_name)) BETWEEN 2 AND 120),
  designation    text NOT NULL CHECK (designation IN ('Captain','First Officer','Purser','Cabin Crew')),
  license_number text NOT NULL UNIQUE CHECK (license_number ~ '^[A-Z0-9-]{6,20}$'),
  salary         d_money NOT NULL,
  hire_date      date NOT NULL CHECK (hire_date >= DATE '1970-01-01'),
  supervisor_id  bigint REFERENCES crew ON DELETE SET NULL,
  base_airport   d_iata_code NOT NULL REFERENCES airport ON DELETE RESTRICT,
  is_active      boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT crew_not_own_supervisor CHECK (supervisor_id <> crew_id)
);
COMMENT ON COLUMN crew.salary IS 'Not granted to the application role; exposed only to administrators via fn_crew_admin().';

-- Multivalued attribute: TYPE:<rating> for pilots, SEP (safety & emergency) for everyone.
CREATE TABLE crew_certification (
  crew_id       bigint NOT NULL REFERENCES crew ON DELETE CASCADE,
  certification text NOT NULL CHECK (certification ~ '^(TYPE:[A-Z0-9]{3,6}|SEP|MEDICAL|CRM)$'),
  valid_until   date NOT NULL,
  PRIMARY KEY (crew_id, certification)
);

CREATE TABLE crew_assignment (
  crew_id        bigint NOT NULL REFERENCES crew ON DELETE RESTRICT,
  flight_id      bigint NOT NULL REFERENCES flight ON DELETE RESTRICT,
  role_on_flight text NOT NULL CHECK (role_on_flight IN ('Captain','First Officer','Purser','Cabin Crew')),
  duty_start     timestamptz NOT NULL,   -- report time: departure - 60 min
  duty_end       timestamptz NOT NULL,   -- release time: arrival + 30 min
  standby_status text NOT NULL DEFAULT 'Assigned' CHECK (standby_status IN ('Assigned','Standby')),
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (crew_id, flight_id),
  CONSTRAINT crew_duty_positive CHECK (duty_end > duty_start),
  CONSTRAINT crew_duty_max CHECK (duty_end - duty_start <= interval '21 hours'),
  -- A crew member cannot be on two duties at the same time.
  CONSTRAINT crew_no_overlapping_duty EXCLUDE USING gist (
    crew_id WITH =,
    tstzrange(duty_start, duty_end) WITH &&
  ) DEFERRABLE INITIALLY IMMEDIATE
);

-- Fare buckets: how many seats of each class are for sale on a flight.
CREATE TABLE flight_fare (
  flight_id       bigint NOT NULL REFERENCES flight ON DELETE CASCADE,
  fare_class      d_fare_class NOT NULL,
  base_fare       d_money NOT NULL CHECK (base_fare > 0),
  seats_allocated integer NOT NULL CHECK (seats_allocated >= 0),
  PRIMARY KEY (flight_id, fare_class)
);
