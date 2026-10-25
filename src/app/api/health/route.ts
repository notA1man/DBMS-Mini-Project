import { NextResponse } from "next/server";
import { pool } from "@/lib/db/postgres";
import { mongoDb } from "@/lib/db/mongo";
import { neo4jDriver } from "@/lib/db/neo4j";

export const dynamic = "force-dynamic";

async function check(fn: () => Promise<unknown>) {
  const start = Date.now();
  try {
    const detail = await fn();
    return { ok: true, ms: Date.now() - start, detail };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: (err as Error).message };
  }
}

// GET /api/health -> connectivity of all three databases
export async function GET() {
  const [postgres, mongo, neo4j] = await Promise.all([
    check(async () => {
      const { rows } = await pool.query(
        "SELECT version() AS version, (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS pgvector",
      );
      return rows[0];
    }),
    check(async () => (await mongoDb()).command({ ping: 1 })),
    check(async () => (await neo4jDriver.getServerInfo()).agent),
  ]);
  const ok = postgres.ok && mongo.ok && neo4j.ok;
  return NextResponse.json({ ok, postgres, mongo, neo4j }, { status: ok ? 200 : 503 });
}
