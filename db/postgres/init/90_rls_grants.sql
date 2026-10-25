-- 90_rls_grants.sql
-- Owner: Aiman
-- GRANTs to skyops_app / skyops_readonly, RLS policies on commercial tables
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL PROCEDURES IN SCHEMA public FROM PUBLIC;
-- No direct commercial writes: totals, prices, payments and ownership are controlled by routines.
GRANT SELECT ON passenger, passenger_phone, booking, ticket, baggage, payment, receipt,
  v_booking_summary, v_passenger_age, kb_document, kb_chunk TO skyops_app;
GRANT EXECUTE ON FUNCTION fn_current_user_id(), fn_is_staff(), fn_owns_passenger(bigint),
  fn_dynamic_fare(bigint,text), fn_seat_map(bigint), fn_book(bigint,jsonb) TO skyops_app;
GRANT EXECUTE ON PROCEDURE sp_pay(text,numeric,text,text), sp_check_in(text,smallint,text),
  sp_cancel_booking(text,text), sp_add_baggage(text,smallint,numeric,text) TO skyops_app;

ALTER TABLE passenger ENABLE ROW LEVEL SECURITY;
CREATE POLICY passenger_read ON passenger FOR SELECT USING (fn_is_staff() OR fn_owns_passenger(passenger_id)
  OR EXISTS (SELECT 1 FROM ticket t JOIN booking b USING(booking_id)
    WHERE t.passenger_id=passenger.passenger_id AND fn_owns_passenger(b.passenger_id)));
ALTER TABLE passenger_phone ENABLE ROW LEVEL SECURITY;
CREATE POLICY passenger_phone_read ON passenger_phone FOR SELECT USING(fn_is_staff() OR fn_owns_passenger(passenger_id));
ALTER TABLE booking ENABLE ROW LEVEL SECURITY;
CREATE POLICY booking_read ON booking FOR SELECT USING(fn_is_staff() OR fn_owns_passenger(passenger_id));
ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_read ON ticket FOR SELECT USING(fn_is_staff() OR EXISTS
  (SELECT 1 FROM booking b WHERE b.booking_id=ticket.booking_id));
ALTER TABLE baggage ENABLE ROW LEVEL SECURITY;
CREATE POLICY baggage_read ON baggage FOR SELECT USING(fn_is_staff() OR EXISTS
  (SELECT 1 FROM booking b WHERE b.booking_id=baggage.booking_id));
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY payment_read ON payment FOR SELECT USING(fn_is_staff() OR EXISTS
  (SELECT 1 FROM booking b WHERE b.booking_id=payment.booking_id));
ALTER TABLE receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY receipt_read ON receipt FOR SELECT USING(fn_is_staff() OR EXISTS
  (SELECT 1 FROM payment p WHERE p.payment_id=receipt.payment_id));
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_read ON app_user FOR SELECT USING(fn_is_staff() OR user_id=fn_current_user_id());
-- Authentication must use a narrow, separately defined routine; password hashes are never SELECT-granted.
ALTER TABLE feedback_embedding ENABLE ROW LEVEL SECURITY;
CREATE POLICY feedback_embedding_staff ON feedback_embedding FOR SELECT USING(fn_is_staff());
GRANT SELECT ON feedback_embedding TO skyops_app;
GRANT EXECUTE ON FUNCTION fn_authenticate(text,text),fn_register(text,text,text,text,date),
  fn_session_user(),fn_admin_users(),fn_hybrid_kb(vector,text,text) TO skyops_app;
GRANT EXECUTE ON PROCEDURE sp_admin_user(bigint,text,boolean,bigint) TO skyops_app;
-- No blanket readonly grant: it would expose passenger PII. Admin reports use the application role.
