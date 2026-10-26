// GET /api/board/stream?airport=BLR - Server-Sent Events for the live departures board.
// Pushes each change to a flight leaving this airport from a MongoDB change stream on
// flight_status (kept current by the outbox dispatcher). Without a replica set / MongoDB it
// falls back to re-sending the PostgreSQL snapshot every 15 seconds.
import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { mongoDb } from '@/lib/db/mongo';
import { opsQueries } from '@/server/queries/ops';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const parsed = z.string().regex(/^[A-Z]{3}$/).safeParse(new URL(request.url).searchParams.get('airport') ?? 'BLR');
  if (!parsed.success) return Response.json({ error: 'Invalid airport.' }, { status: 400 });
  const airport = parsed.data;
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const snapshot = async () => send('snapshot', (await pool.query(opsQueries.departures, [airport, 12])).rows);
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(': keep-alive\n\n')); }, 20000);
      let poll: ReturnType<typeof setInterval> | undefined;
      let changeStream: { close: () => Promise<void> } | undefined;
      cleanup = () => {
        closed = true; clearInterval(heartbeat); if (poll) clearInterval(poll);
        void changeStream?.close().catch(() => {});
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener('abort', cleanup);
      try { await snapshot(); } catch { send('error', { message: 'Departures are temporarily unavailable.' }); }
      try {
        const db = await mongoDb();
        const cs = db.collection('flight_status').watch(
          [{ $match: { 'fullDocument.origin': airport } }], { fullDocument: 'updateLookup' });
        changeStream = cs;
        send('mode', { live: true });
        cs.on('change', (change: { fullDocument?: Record<string, unknown> }) => {
          const d = change.fullDocument;
          if (d) send('flight', { flightId: d._id, flightNumber: d.flightNumber, origin: d.origin, destination: d.destination,
            departureTime: d.departureTime, scheduledDeparture: d.scheduledDeparture, status: d.status,
            delayMinutes: d.delayMinutes, delayReason: d.delayReason, gate: d.gate });
        });
        cs.on('error', () => { send('mode', { live: false }); changeStream = undefined; poll ??= setInterval(() => void snapshot().catch(() => {}), 15000); });
      } catch {
        send('mode', { live: false });
        poll = setInterval(() => void snapshot().catch(() => {}), 15000);
      }
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
}
