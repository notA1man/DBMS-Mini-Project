-- 20_commercial_schema.sql
-- Owner: Aiman
-- passenger, passenger_phone, booking, ticket, baggage, payment, receipt
-- Dependencies supplied by operations: flight, aircraft, seat, flight_fare.
CREATE TABLE passenger (
  passenger_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name text NOT NULL CHECK (length(btrim(first_name)) BETWEEN 1 AND 80),
  middle_name text,
  last_name text NOT NULL CHECK (length(btrim(last_name)) BETWEEN 1 AND 80),
  gender text CHECK (gender IN ('Male','Female','Other','Prefer not to say')),
  date_of_birth date NOT NULL CHECK (date_of_birth >= DATE '1900-01-01'),
  email d_email NOT NULL UNIQUE,
  passport_no_enc bytea,
  nationality text,
  name_search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', first_name || ' ' || coalesce(middle_name,'') || ' ' || last_name || ' ' || email)
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN passenger.passport_no_enc IS 'pgp_sym_encrypt ciphertext; key supplied by server, never stored in the database.';
CREATE TABLE passenger_phone (
  passenger_id bigint REFERENCES passenger ON DELETE CASCADE,
  phone_number d_phone,
  PRIMARY KEY (passenger_id, phone_number)
);
CREATE TABLE booking (
  booking_id char(6) PRIMARY KEY CHECK (booking_id ~ '^[A-Z0-9]{6}$'),
  booking_date timestamptz NOT NULL DEFAULT now(),
  booking_status text NOT NULL DEFAULT 'Pending' CHECK (booking_status IN ('Pending','Confirmed','Cancelled','Disrupted')),
  total_amount d_money NOT NULL DEFAULT 0,
  amount_paid d_money NOT NULL DEFAULT 0,
  passenger_id bigint NOT NULL REFERENCES passenger ON DELETE RESTRICT,
  created_by_user bigint NOT NULL,
  cancel_reason text,
  refund_amount d_money NOT NULL DEFAULT 0
);
CREATE TABLE ticket (
  booking_id char(6) REFERENCES booking ON DELETE RESTRICT,
  ticket_seq smallint CHECK (ticket_seq > 0),
  fare_class d_fare_class NOT NULL,
  fare_amount d_money NOT NULL,
  checkin_status text NOT NULL DEFAULT 'NotCheckedIn' CHECK (checkin_status IN ('NotCheckedIn','CheckedIn')),
  ticket_status text NOT NULL DEFAULT 'Active' CHECK (ticket_status IN ('Active','Cancelled','Disrupted')),
  flight_id bigint NOT NULL REFERENCES flight ON DELETE RESTRICT,
  passenger_id bigint NOT NULL REFERENCES passenger ON DELETE RESTRICT,
  aircraft_id bigint NOT NULL REFERENCES aircraft ON DELETE RESTRICT,
  seat_number text,
  boarding_pass_code text UNIQUE,
  PRIMARY KEY (booking_id, ticket_seq),
  FOREIGN KEY (aircraft_id, seat_number) REFERENCES seat(aircraft_id, seat_number),
  CHECK ((checkin_status = 'CheckedIn') = (boarding_pass_code IS NOT NULL)),
  CHECK (checkin_status <> 'CheckedIn' OR (seat_number IS NOT NULL AND ticket_status = 'Active'))
);
CREATE UNIQUE INDEX ticket_active_seat_uq ON ticket(flight_id, seat_number) WHERE ticket_status = 'Active';
CREATE UNIQUE INDEX ticket_active_passenger_uq ON ticket(flight_id, passenger_id) WHERE ticket_status = 'Active';
CREATE TABLE baggage (
  booking_id char(6), ticket_seq smallint,
  bag_seq smallint CHECK (bag_seq > 0),
  weight_kg numeric(5,2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 32),
  bag_type text NOT NULL CHECK (bag_type IN ('Cabin','Checked')),
  tag_number text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(8),'hex'),
  PRIMARY KEY (booking_id, ticket_seq, bag_seq),
  FOREIGN KEY (booking_id, ticket_seq) REFERENCES ticket ON DELETE RESTRICT
);
CREATE TABLE payment (
  payment_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_date timestamptz NOT NULL DEFAULT now(),
  amount d_money NOT NULL CHECK (amount > 0),
  payment_mode text NOT NULL CHECK (payment_mode IN ('Card','UPI','NetBanking')),
  payment_status text NOT NULL DEFAULT 'Succeeded' CHECK (payment_status IN ('Succeeded','Failed','Refunded')),
  gateway_ref text NOT NULL UNIQUE,
  booking_id char(6) NOT NULL REFERENCES booking ON DELETE RESTRICT
);
CREATE TABLE receipt (
  receipt_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_date timestamptz NOT NULL DEFAULT now(),
  receipt_number text NOT NULL UNIQUE DEFAULT ('SKY-' || encode(gen_random_bytes(10),'hex')),
  payment_id bigint NOT NULL UNIQUE REFERENCES payment ON DELETE RESTRICT
);
