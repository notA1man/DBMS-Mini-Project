# Neo4j — route & flight-connection graph (owner: Aditya)

A projection of PostgreSQL (the source of truth), kept current by the transactional outbox and
rebuildable at any time with `npm run graph:reconcile`. Code: `src/lib/graph/`.

```
(:Airport {code,name,city,country,timezone,lat,lon,location})
(:Aircraft {id,registration,model,typeRating,capacity,status})
(:Flight {flightId,number,origin,destination,dep,arr,status,delayMinutes,durationMin,minFare})
(:Airport)-[:HAS_DEPARTURE]->(:Flight)-[:ARRIVES_AT]->(:Airport)
(:Flight)-[:OPERATED_BY]->(:Aircraft)
(:Flight)-[:CONNECTS_TO {layoverMin}]->(:Flight)        same airport, 45-360 min, neither cancelled, no U-turn
(:Airport)-[:ROUTE {distanceKm,flightsPerWeek,avgDurationMin}]->(:Airport)
(:Crew {crewId,name,designation,base})-[:FLEW_WITH {flights}]-(:Crew)     rebuilt by reconcile (90 days)
```

| File | What it does |
|---|---|
| `src/lib/graph/sync.ts` | Applies outbox events with `UNWIND … MERGE` (idempotent); a node only accepts a snapshot at least as new as its `updatedAt`, so out-of-order delivery is safe. `CONNECTS_TO` is recomputed around every changed flight; `ROUTE` around every changed airport pair. |
| `src/lib/graph/reconcile.ts` | Wipes and rebuilds the graph from PostgreSQL by replaying the same snapshot events. |
| `src/lib/graph/search.ts` | Itinerary search: `MATCH p=(first)-[:CONNECTS_TO*0..2]->(last)` with a distinct-airports check. The API falls back to an equivalent recursive CTE when Neo4j is unreachable; `src/server/tests/stores.test.ts` asserts both return identical itineraries. |
| `src/lib/graph/analytics.ts` | Hub ranking (GDS PageRank + betweenness; weighted-degree fallback on AuraDB Free), shortest route by distance, unreachable pairs, airport-closure impact radius, crew pairs. |

`constraints.cypher` lists the uniqueness constraints and indexes (also created automatically).
Set `NEO4J_GDS_ENABLED=false` on AuraDB Free.
