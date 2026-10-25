-- 02_domains.sql
-- Owner: Aiman
-- Shared domains: d_iata_code, d_email, d_phone, d_fare_class, d_money
CREATE DOMAIN d_iata_code AS text CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN d_email AS text CHECK (
  length(VALUE) <= 254 AND VALUE = lower(VALUE)
  AND VALUE ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
);
CREATE DOMAIN d_phone AS text CHECK (VALUE ~ '^\+?[0-9]{7,15}$');
CREATE DOMAIN d_fare_class AS text CHECK (VALUE IN ('Economy', 'Business', 'First'));
CREATE DOMAIN d_money AS numeric(12,2) CHECK (VALUE >= 0 AND VALUE <> 'NaN'::numeric);
