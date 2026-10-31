import { Pool } from 'pg';
import { readFile,readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
process.loadEnvFile('.env');
async function main() {
  const pool=new Pool({connectionString:process.env.DATABASE_URL_OWNER});
  const c=await pool.connect();
  try {
    const ops=await readFile('db/postgres/init/10_ops_schema.sql','utf8');
    const platform=await readFile('db/postgres/init/30_platform_schema.sql','utf8');
    if(!/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?airport\b/i.test(ops) || !/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?outbox_event\b/i.test(platform)) {
      throw new Error('Operations dependency is incomplete: Aditya must implement 10_ops_schema.sql and outbox_event in 30_platform_schema.sql before production migration. No migrations were applied.');
    }
    const roles=await c.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('strata_app','strata_readonly')");
    if(roles.rows[0].n!==2) throw new Error('Initialize database roles using 01_roles.sh first.');
    await c.query("SELECT pg_advisory_lock(hashtext('strata-migrate'))");
    await c.query('CREATE TABLE IF NOT EXISTS strata_migration (name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    const files=(await readdir('db/postgres/init')).filter(f=>f.endsWith('.sql')).sort();
    for(const name of files) {
      const sql=await readFile(`db/postgres/init/${name}`,'utf8');
      if(!sql.replace(/--[^\n]*/g,'').trim()) continue; // Never record placeholders as completed migrations.
      const checksum=createHash('sha256').update(sql.replaceAll('\r\n','\n')).digest('hex');
      const existing=(await c.query('SELECT checksum FROM strata_migration WHERE name=$1',[name])).rows[0];
      if(existing) {if(existing.checksum!==checksum) throw new Error(`Applied migration changed: ${name}. Add an incremental migration instead.`);continue;}
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO strata_migration(name,checksum) VALUES($1,$2)',[name,checksum]);
        await c.query('COMMIT');console.log(`Applied ${name}`);
      }catch(error){await c.query('ROLLBACK');throw error;}
    }
  }finally{await c.query("SELECT pg_advisory_unlock(hashtext('strata-migrate'))");c.release();await pool.end();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Migration failed');process.exitCode=1;});
