// Rebuilds Neo4j from PostgreSQL (source of truth).  npm run graph:reconcile
import { clients } from './clients';
import { reconcileGraph } from '../src/lib/graph/reconcile';

async function main() {
  const c = clients({ owner: true });   // reads crew rosters for the flew-with network
  try {
    if (!c.graph) throw new Error('Set NEO4J_URI and NEO4J_PASSWORD in .env');
    const started = Date.now();
    const result = await reconcileGraph(c.pg, c.graph);
    console.log(`Graph rebuilt in ${((Date.now() - started) / 1000).toFixed(1)} s:`, JSON.stringify(result));
  } finally { await c.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Reconcile failed'); process.exitCode = 1; });
