// Operations end-to-end test (Aditya): schedule -> assign crew -> delay with knock-on -> cancel ->
// re-route through the graph (or SQL fallback) -> re-book, plus crew portal RLS and role denial.
// Uses a disposable PostgreSQL database (and a disposable MongoDB database when MongoDB is
// reachable) and a production Next server, like test-commercial-e2e.ts. Existing data is untouched.
//   npm run build && npm run test:e2e:ops
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { chromium, expect, type Page } from '@playwright/test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { initOpsMongo } from '../db/mongo/ops';
import { initCommercialMongo } from '../db/mongo/commercial';
process.loadEnvFile('.env');

const PASSWORD = 'e2e-staff-password';
const results: string[] = [];
const pass = (message: string) => { results.push(`PASS: ${message}`); console.log(`PASS: ${message}`); };

function runScript(file: string, env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', file], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${file} failed: ${output}`)));
  });
}
async function freePort() {
  const s = createServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return port;
}

async function main() {
  const database = `skyops_ops_e2e_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new Pool({ connectionString: process.env.DATABASE_URL_OWNER });
  const ownerUrl = new URL(process.env.DATABASE_URL_OWNER!); ownerUrl.pathname = `/${database}`;
  const appUrl = new URL(process.env.DATABASE_URL!); appUrl.pathname = `/${database}`;
  const owner = new Pool({ connectionString: ownerUrl.toString() }); owner.on('error', () => {});
  const mongo = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:1', { serverSelectionTimeoutMS: 3000 });
  const hasMongo = await mongo.connect().then(() => true, () => false);
  let created = false, server: ChildProcess | undefined, logs = '';
  // PLAYWRIGHT_CHROMIUM lets you reuse an already-installed Chromium instead of `npx playwright install`.
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    await owner.query(`GRANT CONNECT ON DATABASE "${database}" TO skyops_app`);
    for (const file of (await readdir('db/postgres/init')).filter(f => f.endsWith('.sql')).sort()) {
      const sql = await readFile(`db/postgres/init/${file}`, 'utf8');
      if (sql.replace(/--[^\n]*/g, '').trim()) await owner.query(sql);
    }
    const env = { ...process.env, DATABASE_URL_OWNER: ownerUrl.toString(), SEED_DAYS_BACK: '3', SEED_DAYS_AHEAD: '4', SEED_STAFF_PASSWORD: PASSWORD, DEMO_LOAD: '0.15', MONGODB_DB: database };
    await runScript('scripts/seed-ops.ts', env);
    await runScript('scripts/seed-demo-traffic.ts', env);
    await owner.query(`INSERT INTO app_user(email, password_hash, role) VALUES ('admin@skyops.test', crypt($1, gen_salt('bf', 4)), 'ADMIN')`, [PASSWORD]);
    if (hasMongo) { const db = mongo.db(database); await initCommercialMongo(db); await initOpsMongo(db); }
    pass(`disposable database seeded (${(await owner.query('SELECT count(*) FROM flight')).rows[0].count} flights)${hasMongo ? ' + MongoDB collections' : ' (MongoDB not reachable: fallback paths exercised)'}`);

    const port = await freePort(), base = `http://localhost:${port}`;
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_URL: appUrl.toString(), MONGODB_DB: database, AUTH_SECRET: randomBytes(32).toString('hex'), AUTH_TRUST_HOST: 'true', EMBEDDINGS_ENABLED: 'false' } });
    server.stdout?.on('data', d => { logs = (logs + d).slice(-10000); }); server.stderr?.on('data', d => { logs = (logs + d).slice(-10000); });
    for (let i = 0; ; i++) {
      try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
      if (i > 100 || server.exitCode !== null) throw new Error('Application server did not start.');
      await new Promise(r => setTimeout(r, 200));
    }

    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => d.accept());
    const login = async (p: Page, email: string) => {
      await ctx.clearCookies(); await p.goto(`${base}/login`);
      await p.fill('input[name=email]', email); await p.fill('input[name=password]', PASSWORD);
      await p.click('button:has-text("Sign in")'); await p.waitForURL(u => !u.pathname.startsWith('/login'));
    };

    // ---- ops: dashboard
    await login(page, 'ops@skyops.test');
    expect(new URL(page.url()).pathname).toBe('/ops');
    await expect(page.locator('.kpi').first()).toBeVisible();
    pass('ops staff land on the ops console with live KPIs');

    // ---- schedule a flight, then a clash on the same aircraft is refused by the exclusion constraint
    const ac = (await owner.query("SELECT aircraft_id, registration FROM aircraft WHERE type_rating='A20N' ORDER BY aircraft_id DESC LIMIT 1")).rows[0];
    const day = new Date(Date.now() + 6 * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10);
    const scheduleForm = async (number: string, dep: string, arr: string) => {
      await page.goto(`${base}/ops/schedule`);
      const form = page.locator('form', { hasText: 'Schedule flight' });
      await form.locator('input[name=flightNumber]').fill(number);
      await form.locator('select[name=aircraftId]').selectOption(String(ac.aircraft_id));
      await form.locator('input[name=origin]').fill('BLR'); await form.locator('input[name=destination]').fill('GOI');
      await form.locator('input[name=departure]').fill(`${day}T${dep}`); await form.locator('input[name=arrival]').fill(`${day}T${arr}`);
      await form.locator('input[name=Economy]').fill('4200'); await form.locator('input[name=Business]').fill('12500');
      await form.locator('button').click();
      return form.locator('[role=status]');
    };
    await expect(await scheduleForm('SK9001', '10:00', '11:20')).toContainText('Scheduled flight');
    await expect(await scheduleForm('SK9002', '11:40', '13:00')).toContainText('conflicts with an existing assignment');
    pass('scheduling works and a turnaround clash is rejected by flight_aircraft_no_overlap (23P01)');

    // ---- crew legality: a legal assignment goes through, illegal candidates explain why
    const flightId = (await owner.query("SELECT flight_id FROM flight WHERE flight_number='SK9001'")).rows[0].flight_id;
    await owner.query(`UPDATE crew SET base_airport='BLR' WHERE crew_id IN (SELECT crew_id FROM crew c
      WHERE designation='Purser' AND NOT EXISTS (SELECT 1 FROM crew_assignment ca WHERE ca.crew_id=c.crew_id) ORDER BY crew_id LIMIT 1)`);
    await page.goto(`${base}/ops/flights/${flightId}`);
    await page.selectOption('select:near(:text("Assign crew"))', 'Purser');
    const legal = page.locator('article', { hasText: 'All rules pass' }).first();
    await expect(legal).toBeVisible();
    await legal.locator('button:has-text("Assign")').click();
    await expect(page.locator('[role=status]', { hasText: 'assigned as Purser' })).toBeVisible();
    pass('crew picker shows rule-by-rule legality and assigns a legal purser');

    // ---- delay with knock-on
    const tight = (await owner.query(`SELECT f.flight_id, g.flight_number AS next FROM flight f JOIN flight g ON g.aircraft_id=f.aircraft_id
      AND g.departure_time > f.arrival_time AND g.departure_time < f.arrival_time + interval '100 minutes' AND g.flight_status='Scheduled'
      WHERE f.flight_status='Scheduled' AND f.departure_time > now() + interval '3 hours' ORDER BY f.departure_time LIMIT 1`)).rows[0];
    await page.goto(`${base}/ops/flights/${tight.flight_id}`);
    await page.fill('input[name=delay]', '150'); await page.selectOption('select[name=reason]', 'ATC');
    await page.click('button:has-text("Update")');
    await expect(page.locator('p.card[role=status]')).toContainText(`Knock-on: ${tight.next}`);
    pass(`a 150-minute delay propagates to the aircraft's next sector (${tight.next})`);

    // ---- cancel a booked flight -> disrupted -> re-route -> re-book
    const booked = (await owner.query(`SELECT f.flight_id, f.origin, f.destination FROM flight f JOIN ticket t USING (flight_id)
      WHERE t.ticket_status='Active' AND f.flight_status='Scheduled' AND f.departure_time BETWEEN now() + interval '4 hours' AND now() + interval '30 hours'
        AND f.origin='BLR' AND f.destination IN ('DEL','BOM','HYD')
      GROUP BY f.flight_id ORDER BY count(*) LIMIT 1`)).rows[0];
    await page.goto(`${base}/ops/flights/${booked.flight_id}`);
    await page.fill('input[name=reason]', 'Bird strike on inbound aircraft');
    await page.click('button:has-text("Cancel flight")');
    await expect(page.locator('p.card[role=status]')).toContainText('disrupted');
    pass('cancelling a booked flight disrupts its tickets and bookings in one transaction');
    await page.goto(`${base}/ops/disruptions`);
    const card = page.locator('article', { hasText: `${booked.origin} → ${booked.destination}` }).first();
    await card.locator('button:has-text("Find alternatives")').click();
    await expect(card.getByText('Source:')).toBeVisible({ timeout: 20000 });
    const before = (await owner.query("SELECT count(*)::int AS n FROM ticket WHERE replaces_seq IS NOT NULL")).rows[0].n;
    await card.locator('button:has-text("Re-book")').first().click();
    await expect.poll(async () => (await owner.query("SELECT count(*)::int AS n FROM ticket WHERE replaces_seq IS NOT NULL")).rows[0].n).toBe(before + 1);
    const rebooked = (await owner.query(`SELECT b.booking_status, b.total_amount = b.amount_paid AS unchanged FROM ticket t JOIN booking b USING (booking_id)
      WHERE t.replaces_seq IS NOT NULL ORDER BY t.booking_id LIMIT 1`)).rows[0];
    expect(rebooked).toEqual({ booking_status: 'Confirmed', unchanged: true });
    pass('a disrupted passenger is re-booked on the same PNR at no extra cost (booking back to Confirmed)');

    // ---- showcase: exclusion constraint demo rolls back
    await page.goto(`${base}/showcase`);
    const showcase = page.locator('form', { has: page.locator('option[value=double-schedule]') });
    await showcase.locator('button').click();
    await expect(page.locator('td', { hasText: 'flight_aircraft_no_overlap' })).toBeVisible();
    pass('DB showcase demonstrates the exclusion constraint with a savepoint rollback');

    // ---- public board + connecting search (graph or SQL fallback)
    await page.goto(`${base}/board`);
    await expect(page.locator('.board tbody tr').first()).toBeVisible();
    const r = await (await fetch(`${base}/api/search/itineraries?from=BLR&to=GAU&date=${new Date(Date.now() + 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10)}`)).json();
    expect(Array.isArray(r.itineraries)).toBe(true);
    pass(`public departures board renders; itinerary API answers via ${r.source} (${r.itineraries.length} options)`);

    // ---- crew portal and role separation
    await login(page, 'captain@skyops.test');
    expect(new URL(page.url()).pathname).toBe('/crew');
    await page.locator('table a').first().click();
    await expect(page.getByText('row-level security')).toBeVisible();
    await page.goto(`${base}/ops`);
    expect(new URL(page.url()).pathname).toBe('/crew');
    const denied = await page.evaluate(async () => (await fetch('/api/ops/overview')).status);
    expect(denied).toBe(403);
    pass('crew see their roster and assigned manifests only; ops pages and APIs are denied (middleware + API)');

    await login(page, 'admin@skyops.test');
    for (const path of ['/admin/analytics', '/admin/fleet', '/admin/outbox']) {
      await page.goto(base + path); await expect(page.locator('h1')).toBeVisible();
    }
    pass('admin analytics, fleet and outbox screens render');

    expect(errors, 'browser errors').toEqual([]);
    await mkdir('test-results', { recursive: true });
    await writeFile('test-results/ops-e2e.txt', results.join('\n') + '\n');
    console.log(`\n${results.length} checks passed.`);
  } catch (error) {
    console.error(logs.slice(-3000));
    throw error;
  } finally {
    server?.kill();
    await browser.close();
    if (hasMongo) await mongo.db(database).dropDatabase().catch(() => {});
    await mongo.close().catch(() => {});
    await owner.end();
    if (created) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
