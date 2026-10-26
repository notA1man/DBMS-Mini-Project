-- 50_indexes.sql
-- Owner: Both (ops section: Aditya, commercial section: Aiman)
-- FK indexes, composite search index, partial, GIN/trigram, BRIN
-- Commercial indexes (Aiman). Operations indexes can be added separately.
CREATE INDEX passenger_name_gin ON passenger USING gin(name_search);
CREATE INDEX booking_passenger_idx ON booking(passenger_id, booking_date DESC);
CREATE INDEX booking_created_by_idx ON booking(created_by_user);
CREATE INDEX ticket_flight_idx ON ticket(flight_id);
CREATE INDEX ticket_passenger_idx ON ticket(passenger_id);
CREATE INDEX ticket_aircraft_seat_idx ON ticket(aircraft_id, seat_number);
CREATE INDEX payment_booking_idx ON payment(booking_id);
CREATE INDEX payment_date_brin ON payment USING brin(payment_date);
CREATE INDEX kb_document_fts_gin ON kb_document USING gin(fts);
CREATE INDEX feedback_embedding_flight_idx ON feedback_embedding(flight_id, created_at);

-- Operations indexes (Aditya). PostgreSQL does not index foreign keys automatically.
-- Flight search: equality on origin/destination, then a range on departure_time.
CREATE INDEX flight_route_departure_idx ON flight(origin, destination, departure_time);
CREATE INDEX flight_destination_idx ON flight(destination);
-- Aircraft rotation lookups (knock-on delays, turnaround checks) and FK.
CREATE INDEX flight_aircraft_departure_idx ON flight(aircraft_id, departure_time);
-- Live departures board: only flights that can still change.
CREATE INDEX flight_live_board_idx ON flight(departure_time)
  WHERE flight_status NOT IN ('Landed','Cancelled');
CREATE INDEX crew_assignment_flight_idx ON crew_assignment(flight_id);
CREATE INDEX crew_supervisor_idx ON crew(supervisor_id);
CREATE INDEX crew_base_idx ON crew(base_airport);
-- Airport autocomplete: full-text first, trigram similarity for typos ("Bengalru").
CREATE INDEX airport_name_search_gin ON airport USING gin(name_search);
CREATE INDEX airport_name_trgm ON airport USING gin(airport_name gin_trgm_ops);
CREATE INDEX airport_city_trgm ON airport USING gin(city gin_trgm_ops);
-- Outbox: the dispatcher only ever scans pending rows.
CREATE INDEX outbox_pending_idx ON outbox_event(next_attempt_at, event_id) WHERE processed_at IS NULL;
