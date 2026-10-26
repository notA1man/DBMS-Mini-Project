// Outbox worker: delivers PostgreSQL outbox events to MongoDB and Neo4j.
//   npm run worker          keep running (polls every 2 s)
//   npm run outbox:drain    deliver everything pending, then exit
import { clients } from './clients';
import { dispatchOutbox, drainOutbox } from '../src/lib/outbox/dispatcher';

async function main() {
  const c = clients();
  const sinks = { pg: c.pg, mongo: c.mongo, graph: c.graph };
  try {
    if (process.argv.includes('--drain')) {
      const started = Date.now();
      const total = await drainOutbox(sinks, { log: r => { if (r.claimed) process.stdout.write(`\r  delivered ${r.delivered}/${r.claimed} this pass`); } });
      process.stdout.write('\n');
      console.log(`Outbox drained in ${((Date.now() - started) / 1000).toFixed(1)} s: ${total.delivered} delivered, ${total.failed} failed.`);
      for (const [consumer, message] of Object.entries(total.errors)) console.warn(`  ${consumer} -> ${message}`);
      if (total.failed) process.exitCode = 1;
      return;
    }
    console.log('Outbox worker running (Ctrl+C to stop)');
    let stop = false;
    process.on('SIGINT', () => { stop = true; });
    while (!stop) {
      try {
        const r = await dispatchOutbox(sinks, 200);
        if (r.claimed) console.log(`${new Date().toISOString()} delivered ${r.delivered}, failed ${r.failed}`
          + (Object.keys(r.errors).length ? ` (${Object.values(r.errors).join('; ')})` : ''));
        if (r.claimed === 200 && r.delivered) continue;   // more waiting: go again immediately
      } catch (error) { console.error('Dispatch pass failed:', (error as Error).message); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally { await c.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Outbox worker failed'); process.exitCode = 1; });
