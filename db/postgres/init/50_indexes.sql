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
