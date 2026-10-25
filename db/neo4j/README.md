# Neo4j — route & flight-connection graph (owner: Aditya)

Mirror of PostgreSQL, fed by the transactional outbox (`outbox_event`), rebuilt any time with `npm run graph:reconcile`.

```
(:Airport {code})-[:ROUTE {distanceKm}]->(:Airport)
(:Airport)-[:HAS_DEPARTURE]->(:Flight {flightId, dep, arr, status})-[:ARRIVES_AT]->(:Airport)
(:Flight)-[:CONNECTS_TO {layoverMin}]->(:Flight)
(:Flight)-[:OPERATED_BY]->(:Aircraft)
```

`constraints.cypher` — uniqueness constraints and indexes; `queries/` — itinerary search, re-routing, network analytics.
