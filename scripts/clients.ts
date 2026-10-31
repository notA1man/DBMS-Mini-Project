// Database clients for CLI scripts. Created here (not via src/lib/env) because scripts load
// .env at runtime, after module imports have already executed.
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import neo4j from 'neo4j-driver';

try { process.loadEnvFile('.env'); } catch { /* variables may come from the shell */ }

export function clients({ owner = false } = {}) {
  const pg = new Pool({ connectionString: owner ? process.env.DATABASE_URL_OWNER : process.env.DATABASE_URL });
  const mongoClient = process.env.MONGODB_URI ? new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 }) : null;
  const graph = process.env.NEO4J_URI && process.env.NEO4J_PASSWORD
    ? neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USER ?? 'neo4j', process.env.NEO4J_PASSWORD),
        { disableLosslessIntegers: true, connectionTimeout: 5000, maxTransactionRetryTime: 3000 })
    : null;
  const mongo = mongoClient ? async () => { await mongoClient.connect(); return mongoClient.db(process.env.MONGODB_DB ?? 'strata'); } : null;
  const close = async () => { await pg.end(); await mongoClient?.close(); await graph?.close(); };
  return { pg, mongo, graph, close };
}
