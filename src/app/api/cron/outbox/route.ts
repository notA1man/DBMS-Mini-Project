// Scheduled outbox delivery (Vercel Cron or any scheduler): GET with Authorization: Bearer $CRON_SECRET.
import { timingSafeEqual } from 'node:crypto';
import { runOutbox } from '@/server/outbox';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!secret || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try { return Response.json(await runOutbox(500)); }
  catch { return Response.json({ error: 'Outbox dispatch failed' }, { status: 503 }); }
}
