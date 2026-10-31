import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { embed } from '../src/lib/ai/embed';
process.loadEnvFile('.env');
async function main() {
  const pool=new Pool({connectionString:process.env.DATABASE_URL_OWNER});
  const mongo=new MongoClient(process.env.MONGODB_URI!);
  try {
    await mongo.connect();
    const collection=mongo.db(process.env.MONGODB_DB || 'strata').collection('feedback');
    const cursor=collection.find({embeddingStatus:'pending'}).sort({createdAt:1}).limit(100);
    let count=0;
    for await(const feedback of cursor) {
      const vector=await embed(feedback.comment);
      await pool.query(`INSERT INTO feedback_embedding(feedback_oid,flight_id,sentiment,created_at,embedding)
        VALUES($1,$2,$3,$4,$5::vector) ON CONFLICT(feedback_oid) DO UPDATE SET
          embedding=excluded.embedding,sentiment=excluded.sentiment`,
        [feedback._id.toHexString(),feedback.flightId,feedback.sentiment,feedback.createdAt,JSON.stringify(vector)]);
      // Only mark ready after PG has committed. Retrying after a crash repeats the upsert.
      await collection.updateOne({_id:feedback._id},{$set:{embeddingStatus:'ready'}});
      count++;
    }
    console.log(`Indexed ${count} pending feedback comments.`);
  }finally{await pool.end();await mongo.close();}
}
main().catch(()=>{console.error('Feedback indexing failed; pending documents remain retryable.');process.exitCode=1;});
