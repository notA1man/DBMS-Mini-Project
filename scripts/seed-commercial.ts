import { Pool } from 'pg';
import { policies } from '../db/postgres/seed/policies';
import { embed } from '../src/lib/ai/embed';
process.loadEnvFile('.env');
async function main() {
  const pool=new Pool({connectionString:process.env.DATABASE_URL_OWNER});
  try {
    const check=await pool.query("SELECT to_regclass('public.kb_document') AS kb");
    if(!check.rows[0].kb) throw new Error('Run the completed database migrations first.');
    for(const [title,category,body] of policies) {
      const embedding=await embed(body);
      const c=await pool.connect();
      try {
        await c.query('BEGIN');
        // Serializes concurrent seed runs and avoids a duplicate-title race.
        await c.query("SELECT pg_advisory_xact_lock(hashtext('strata-policy-seed'))");
        let doc=(await c.query('SELECT doc_id FROM kb_document WHERE title=$1',[title])).rows[0];
        if(doc) await c.query('UPDATE kb_document SET category=$2,body=$3 WHERE doc_id=$1',[doc.doc_id,category,body]);
        else doc=(await c.query('INSERT INTO kb_document(title,category,body) VALUES($1,$2,$3) RETURNING doc_id',[title,category,body])).rows[0];
        // These short authored documents fit in one chunk; longer docs need overlapping chunks.
        await c.query('DELETE FROM kb_chunk WHERE doc_id=$1',[doc.doc_id]);
        await c.query('INSERT INTO kb_chunk(doc_id,chunk_index,content,embedding) VALUES($1,0,$2,$3::vector)',[doc.doc_id,body,JSON.stringify(embedding)]);
        await c.query('COMMIT');
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    }
    console.log(`Seeded ${policies.length} authored demo policies with local embeddings.`);
    if(process.env.SEED_ADMIN_EMAIL && process.env.SEED_ADMIN_PASSWORD) {
      if(Buffer.byteLength(process.env.SEED_ADMIN_PASSWORD)<12 || Buffer.byteLength(process.env.SEED_ADMIN_PASSWORD)>72) throw new Error('Admin password must be 12–72 bytes.');
      await pool.query(`INSERT INTO app_user(email,password_hash,role) VALUES(lower($1),crypt($2,gen_salt('bf',12)),'ADMIN')
        ON CONFLICT(email) DO NOTHING`,[process.env.SEED_ADMIN_EMAIL,process.env.SEED_ADMIN_PASSWORD]);
      console.log('Admin bootstrap checked; existing accounts were not changed.');
    }
  }finally{await pool.end();}
}
main().catch(error=>{console.error('Commercial seeding failed:',error instanceof Error?error.message:'unknown error');process.exitCode=1;});
