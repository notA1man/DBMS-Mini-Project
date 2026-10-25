import { Pool, type PoolClient } from "pg";
import { env } from "@/lib/env";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

export const pool =
  globalForPg.pgPool ?? new Pool({ connectionString: env.DATABASE_URL, max: 10 });

if (process.env.NODE_ENV !== "production") globalForPg.pgPool = pool;

export type TxContext = { userId?: string; role?: string };

/**
 * Runs fn inside a transaction with the RLS context set transaction-locally
 * (set_config(..., true)), so it is safe behind a transaction-mode pooler.
 */
export async function withTx<T>(
  ctx: TxContext,
  fn: (client: PoolClient) => Promise<T>,
  isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await client.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)",
      [ctx.userId ?? "", ctx.role ?? ""],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
