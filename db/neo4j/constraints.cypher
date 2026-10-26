// Applied automatically by src/lib/graph/sync.ts (ensureGraphSchema) on reconcile; kept here for
// reference and for running by hand in Neo4j Browser.
CREATE CONSTRAINT airport_code IF NOT EXISTS FOR (a:Airport) REQUIRE a.code IS UNIQUE;
CREATE CONSTRAINT flight_id IF NOT EXISTS FOR (f:Flight) REQUIRE f.flightId IS UNIQUE;
CREATE CONSTRAINT aircraft_id IF NOT EXISTS FOR (x:Aircraft) REQUIRE x.id IS UNIQUE;
CREATE CONSTRAINT crew_id IF NOT EXISTS FOR (c:Crew) REQUIRE c.crewId IS UNIQUE;
CREATE INDEX flight_dep IF NOT EXISTS FOR (f:Flight) ON (f.dep);
CREATE INDEX flight_route_dep IF NOT EXISTS FOR (f:Flight) ON (f.origin, f.dep);
