-- TEST ONLY: minimum operations interface, never part of production migrations.
CREATE TABLE aircraft (aircraft_id bigint PRIMARY KEY, capacity integer NOT NULL);
CREATE TABLE seat (
  aircraft_id bigint REFERENCES aircraft, seat_number text, seat_class d_fare_class NOT NULL,
  PRIMARY KEY (aircraft_id,seat_number)
);
CREATE TABLE flight (
  flight_id bigint PRIMARY KEY, aircraft_id bigint REFERENCES aircraft,
  departure_time timestamptz NOT NULL, arrival_time timestamptz NOT NULL,
  flight_status text NOT NULL
);
CREATE TABLE flight_fare (
  flight_id bigint REFERENCES flight, fare_class d_fare_class, base_fare d_money,
  seats_allocated integer, PRIMARY KEY(flight_id,fare_class)
);
CREATE TABLE crew (crew_id bigint PRIMARY KEY);
CREATE TABLE outbox_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate text,aggregate_id text,event_type text,payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,last_error text
);
INSERT INTO aircraft VALUES(1,6),(2,1);
INSERT INTO seat VALUES(1,'1A','Economy'),(1,'1B','Economy'),(1,'1C','Economy'),
  (1,'2A','Business'),(1,'2B','Business'),(1,'3A','First'),(2,'1A','Economy');
INSERT INTO flight VALUES
  (1,1,now()+interval '30 hours',now()+interval '32 hours','Scheduled'),
  (2,1,now()+interval '72 hours',now()+interval '74 hours','Scheduled'),
  (3,1,now()+interval '40 hours',now()+interval '42 hours','Cancelled'),
  (4,2,now()+interval '36 hours',now()+interval '38 hours','Scheduled');
INSERT INTO flight_fare SELECT flight_id,'Economy',1000,3 FROM flight;
INSERT INTO flight_fare SELECT flight_id,'Business',3000,2 FROM flight;
INSERT INTO flight_fare SELECT flight_id,'First',6000,1 FROM flight;
UPDATE flight_fare SET seats_allocated=1 WHERE flight_id=4;
