-- TEST ONLY: small deterministic operations data for the commercial tests, loaded AFTER the
-- real migrations (db/postgres/init/*). Reproduces the original ops_contract fixture data:
-- flights 1-4 BLR->BOM, aircraft A (3 Economy 1A-1C, 2 Business 2A-2B, 1 First 3A) and
-- aircraft B (one Economy seat 1A); flight 3 is cancelled; fares 1000/3000/6000.
DO $$
DECLARE a bigint; b bigint;
BEGIN
  a := ops_add_aircraft('VT-TSA', 'Test Six', 'Test', 'A20N', 2020,
    '{"cabins":[{"class":"Economy","fromRow":1,"toRow":1,"letters":"ABC"},
                {"class":"Business","fromRow":2,"toRow":2,"letters":"AB"},
                {"class":"First","fromRow":3,"toRow":3,"letters":"A"}]}');
  b := ops_add_aircraft('VT-TSB', 'Test One', 'Test', 'A20N', 2020,
    '{"cabins":[{"class":"Economy","fromRow":1,"toRow":1,"letters":"A"}]}');
  -- Identity values 1-4 in this order on a fresh database (the reference seed has no flights).
  INSERT INTO flight(flight_number, aircraft_id, origin, destination, departure_time, arrival_time) VALUES
    ('SK101', a, 'BLR', 'BOM', now() + interval '30 hours', now() + interval '32 hours'),
    ('SK101', a, 'BLR', 'BOM', now() + interval '72 hours', now() + interval '74 hours'),
    ('SK101', a, 'BLR', 'BOM', now() + interval '40 hours', now() + interval '42 hours'),
    ('SK101', b, 'BLR', 'BOM', now() + interval '36 hours', now() + interval '38 hours');
  UPDATE flight SET flight_status = 'Cancelled', cancel_reason = 'Test fixture cancellation' WHERE flight_id = 3;
  INSERT INTO flight_fare(flight_id, fare_class, base_fare, seats_allocated)
  SELECT f.flight_id, s.seat_class, CASE s.seat_class WHEN 'Economy' THEN 1000 WHEN 'Business' THEN 3000 ELSE 6000 END, count(*)
  FROM flight f JOIN seat s USING (aircraft_id) GROUP BY f.flight_id, s.seat_class;
END $$;
