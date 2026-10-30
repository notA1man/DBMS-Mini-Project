import Landing, { type NetworkStats } from "@/components/landing/Landing";
import { pool } from "@/lib/db/postgres";
import { opsQueries } from "@/server/queries/ops";

// Re-read the network size every five minutes; the page itself stays static.
export const revalidate = 300;

async function networkStats(): Promise<NetworkStats> {
  try {
    return (await pool.query(opsQueries.networkStats)).rows[0] ?? null;
  } catch {
    return null;
  }
}

export default async function Home() {
  return <Landing network={await networkStats()} />;
}
