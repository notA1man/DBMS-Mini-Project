import { MongoClient } from 'mongodb';
import { initCommercialMongo } from '../db/mongo/commercial';
process.loadEnvFile('.env');
async function main() {
  const client=new MongoClient(process.env.MONGODB_URI!);
  try {
    await client.connect();
    await initCommercialMongo(client.db(process.env.MONGODB_DB || 'strata'));
    console.log('Commercial Mongo validators and indexes are ready.');
  } finally { await client.close(); }
}
main().catch(()=>{console.error('Mongo initialization failed. Check connectivity and privileges.');process.exitCode=1;});
