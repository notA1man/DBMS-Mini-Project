// Server-side outbox entry points. Mutating ops routes call kickOutbox() so MongoDB and Neo4j
// catch up right after the response (Next after()); the worker, the cron route and the admin
// "process now" button cover everything else.
import { after } from 'next/server';
import { pool } from '@/lib/db/postgres';
import { mongoDb } from '@/lib/db/mongo';
import { neo4jDriver } from '@/lib/db/neo4j';
import { dispatchOutbox, type Sinks } from '@/lib/outbox/dispatcher';

export const sinks = (): Sinks => ({ pg: pool, mongo: mongoDb, graph: neo4jDriver });

export async function runOutbox(limit = 200) {
  return dispatchOutbox(sinks(), limit);
}

export function kickOutbox() {
  after(async () => {
    try { await runOutbox(100); }
    catch (error) { console.error('Outbox dispatch after response failed', { name: (error as Error).name }); }
  });
}
