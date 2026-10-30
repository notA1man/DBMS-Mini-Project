import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { chromium,expect } from '@playwright/test';
import { randomUUID,randomBytes } from 'node:crypto';
import { readFile,readdir,mkdir,writeFile } from 'node:fs/promises';
import { spawn,type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { initCommercialMongo } from '../db/mongo/commercial';
import { deliverCommercialNotification } from '../src/lib/outbox/commercial';
import { embed } from '../src/lib/ai/embed';
import { policies } from '../db/postgres/seed/policies';
process.loadEnvFile('.env');

async function runScript(file:string,env:NodeJS.ProcessEnv) {
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs',file],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d.toString());child.stderr.on('data',d=>output+=d.toString());
    child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`${file} failed: ${output}`)));
  });
}

async function main() {
  const database=`skyops_commercial_e2e_${randomUUID().replaceAll('-','')}`;
  const admin=new Pool({connectionString:process.env.DATABASE_URL_OWNER});
  const ownerUrl=new URL(process.env.DATABASE_URL_OWNER!);ownerUrl.pathname=`/${database}`;
  const appUrl=new URL(process.env.DATABASE_URL!);appUrl.pathname=`/${database}`;
  const owner=new Pool({connectionString:ownerUrl.toString()});
  const mongo=new MongoClient(process.env.MONGODB_URI!);
  const mongoDb=mongo.db(database);
  let created=false,server:ChildProcess|undefined,logs='';
  const browser=await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {});
  try {
    await admin.query(`CREATE DATABASE "${database}"`);created=true;
    const migrations=(await readdir('db/postgres/init')).filter(f=>f.endsWith('.sql')).sort().map(f=>`init/${f}`);
    for(const file of [...migrations,'tests/fixtures/ops_data.sql']) {
      const sql=await readFile(`db/postgres/${file}`,'utf8');
      if(sql.replace(/--[^\n]*/g,'').trim()) await owner.query(sql);
    }
    await mongo.connect();await initCommercialMongo(mongoDb);
    const scriptEnv={...process.env,DATABASE_URL_OWNER:ownerUrl.toString(),MONGODB_DB:database,SEED_ADMIN_EMAIL:'',SEED_ADMIN_PASSWORD:'',SEED_DEMO_PASSWORD:'demo-test-password'};
    await runScript('scripts/seed-commercial.ts',scriptEnv);
    expect((await owner.query('SELECT count(*)::int AS n FROM kb_document')).rows[0].n).toBe(25);
    const vector=await embed('Maximum permitted weight for cabin luggage');
    const semantic=(await owner.query('SELECT * FROM fn_hybrid_kb($1::vector,$2,NULL)',[JSON.stringify(vector),'Maximum permitted weight for cabin luggage'])).rows;
    expect(semantic[0].category).toBe('baggage');
    console.log('PASS: 25 seeded policies and real local semantic retrieval.');
    await owner.query("INSERT INTO app_user(email,password_hash,role) VALUES('admin@skyops.test',crypt('admin-test-password',gen_salt('bf',4)),'ADMIN')");
    const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
    const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
    const base=`http://localhost:${port}`;
    server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-p',String(port)],{windowsHide:true,
      env:{...process.env,DATABASE_URL:appUrl.toString(),MONGODB_DB:database,AUTH_SECRET:randomBytes(32).toString('hex'),AUTH_TRUST_HOST:'true',EMBEDDINGS_ENABLED:'false'},stdio:['ignore','pipe','pipe']});
    server.stdout?.on('data',d=>{logs=(logs+d.toString()).slice(-10000);});server.stderr?.on('data',d=>{logs=(logs+d.toString()).slice(-10000);});
    let ready=false;
    for(let i=0;i<100;i++) {
      try {if((await fetch(base)).ok){ready=true;break;}}catch{}
      if(server.exitCode!==null) throw new Error('Application server exited.');
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    if(!ready) throw new Error('Application server did not become ready.');
    const context=await browser.newContext(),page=await context.newPage();
    page.on('pageerror',error=>{logs+=`\nBrowser: ${error.message}`;});
    await page.goto(`${base}/register`);
    await page.getByLabel('First name',{exact:true}).fill('Test');await page.getByLabel('Last name',{exact:true}).fill('Passenger');
    await page.getByLabel('Date of birth').fill('2000-01-01');await page.getByLabel('Email',{exact:true}).fill('passenger@skyops.test');
    await page.getByLabel('Password',{exact:true}).fill('passenger-test-password');await page.getByRole('button',{name:'Create account',exact:true}).click();
    await expect(page).toHaveURL(`${base}/trips`);await expect(page.getByText('No bookings yet.',{exact:false})).toBeVisible();
    console.log('PASS: browser registration and sign-in.');
    await page.goto(base);
    const demo=await context.request.post(`${base}/api/showcase`,{headers:{Origin:base},data:{query:'double-book',flight:'1',seat:'1B',text:''}});
    expect(demo.status()).toBe(200);expect((await demo.json()).rows[0].retainedBookings).toBe(0);
    const departure=(await owner.query('SELECT departure_time FROM flight WHERE flight_id=1')).rows[0].departure_time;
    const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(departure);
    await page.goto(`${base}/search`);
    await page.getByLabel('Origin airport code').fill('BLR');await page.getByLabel('Destination airport code').fill('BOM');
    await page.getByLabel('DATE',{exact:true}).fill(localDate);await page.getByRole('button',{name:'Find your flight'}).click();
    await expect(page.getByRole('link',{name:'Choose seats'}).first()).toBeVisible();
    await page.goto(`${base}/book?flights=1&fare=Economy`);
    await page.getByRole('button',{name:'1A',exact:true}).click();await page.getByRole('button',{name:'Reserve & continue to payment'}).click();
    await expect(page).toHaveURL(/\/trips\/[A-Z0-9]{6}$/);
    const pnr=page.url().split('/').at(-1)!;
    await expect(page.getByRole('heading',{name:`Booking ${pnr}`,exact:false})).toBeVisible();
    await page.getByRole('button',{name:'Record payment'}).click();
    await expect(page.getByRole('heading',{name:`Booking ${pnr}`,exact:false})).toContainText('Confirmed');
    await page.getByText('Web check-in',{exact:true}).click();await page.getByRole('button',{name:'Check in',exact:true}).click();
    await expect(page.getByText('SKYOPS BOARDING PASS',{exact:true})).toBeVisible();
    const qr=await context.request.get(`${base}/api/boarding-pass?pnr=${pnr}&seq=1`);expect(qr.status()).toBe(200);expect(qr.headers()['content-type']).toBe('image/png');
    console.log('PASS: direct search, reserve, payment, check-in and boarding QR.');
    const outbox=(await owner.query('SELECT * FROM outbox_event')).rows;
    for(const event of outbox) {await deliverCommercialNotification(mongoDb,event);await deliverCommercialNotification(mongoDb,event);}
    expect(await mongoDb.collection('notifications').countDocuments()).toBe(1);
    await page.goto(`${base}/policies`);await page.getByLabel('Your question').fill('cabin baggage');await page.getByRole('button',{name:'Find policy passages'}).click();
    await expect(page.getByText(policies[0][2],{exact:true})).toBeVisible();
    await expect(page.getByText('Keyword retrieval · semantic search is currently unavailable',{exact:true})).toBeVisible();
    const forbidden=await context.request.get(`${base}/api/commercial/users`);expect(forbidden.status()).toBe(403);
    const explain=await context.request.post(`${base}/api/showcase`,{headers:{Origin:base},data:{query:'bookings',flight:'1',seat:'1A',text:''}});
    expect(explain.status()).toBe(200);expect((await explain.json()).plan).toBeTruthy();
    const crossOrigin=await context.request.post(`${base}/api/commercial/cancel`,{headers:{Origin:'https://untrusted.example'},data:{pnr,reason:'test'}});expect(crossOrigin.status()).toBe(403);
    await page.goto(`${base}/trips/${pnr}`);
    // The flight state machine requires Scheduled -> Boarding -> Departed -> Landed.
    await owner.query("UPDATE flight SET departure_time=now()-interval '3 hours',arrival_time=now()-interval '1 hour',flight_status='Boarding' WHERE flight_id=1");
    await owner.query("UPDATE flight SET flight_status='Departed' WHERE flight_id=1");
    await owner.query("UPDATE flight SET flight_status='Landed' WHERE flight_id=1");
    await page.getByText('Leave feedback',{exact:true}).click();await page.getByLabel('Your experience').fill('The crew were very helpful throughout the flight.');
    await page.getByRole('button',{name:'Submit feedback'}).click();await expect(page.getByRole('status').filter({hasText:'Saved.'}).first()).toBeVisible();
    expect(await mongoDb.collection('feedback').countDocuments({embeddingStatus:'pending'})).toBe(1);
    await runScript('scripts/index-feedback.ts',scriptEnv);
    expect(await mongoDb.collection('feedback').countDocuments({embeddingStatus:'ready'})).toBe(1);
    expect((await owner.query('SELECT count(*)::int AS n FROM feedback_embedding')).rows[0].n).toBe(1);
    const other=await browser.newContext();
    const otherPage=await other.newPage();await otherPage.goto(`${base}/register`);
    await otherPage.getByLabel('First name',{exact:true}).fill('Other');await otherPage.getByLabel('Last name',{exact:true}).fill('Passenger');
    await otherPage.getByLabel('Date of birth').fill('2001-01-01');await otherPage.getByLabel('Email',{exact:true}).fill('other@skyops.test');await otherPage.getByLabel('Password',{exact:true}).fill('other-test-password');
    await otherPage.getByRole('button',{name:'Create account',exact:true}).click();await expect(otherPage).toHaveURL(`${base}/trips`);
    expect((await other.request.get(`${base}/api/commercial/booking?pnr=${pnr}`)).status()).toBe(404);
    expect((await other.request.get(`${base}/api/boarding-pass?pnr=${pnr}&seq=1`)).status()).toBe(404);
    const staff=await browser.newContext(),staffPage=await staff.newPage();await staffPage.goto(`${base}/login`);
    await staffPage.getByLabel('Email',{exact:true}).fill('admin@skyops.test');await staffPage.getByLabel('Password',{exact:true}).fill('admin-test-password');await staffPage.getByRole('button',{name:'Sign in',exact:true}).click();await expect(staffPage).toHaveURL(`${base}/ops`);
    const similar=await staff.request.post(`${base}/api/commercial/complaints`,{headers:{Origin:base},data:{query:'The cabin crew were helpful',route:'BLR-BOM',since:'2000-01-01'}});
    const similarData=await similar.json();
    expect(similar.status(),JSON.stringify(similarData)).toBe(200);expect(similarData.complaints).toHaveLength(1);
    await runScript('scripts/seed-commercial-demo.ts',scriptEnv);await runScript('scripts/seed-commercial-demo.ts',scriptEnv);
    expect((await owner.query("SELECT count(*)::int AS n FROM app_user WHERE email IN ('passenger1@skyops.test','passenger2@skyops.test','passenger3@skyops.test')")).rows[0].n).toBe(3);
    const passengerId=(await owner.query("SELECT user_id FROM app_user WHERE email='passenger@skyops.test'")).rows[0].user_id;
    const disable=await staff.request.post(`${base}/api/commercial/user`,{headers:{Origin:base},data:{id:passengerId,role:'PASSENGER',active:false,crewId:null}});expect(disable.status()).toBe(200);
    expect((await context.request.get(`${base}/api/commercial/identity`)).status()).toBe(401);
    const mobile=await browser.newContext({viewport:{width:390,height:844}}),mobilePage=await mobile.newPage();await mobilePage.goto(base);
    expect(await mobilePage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await mkdir('test-results',{recursive:true});await mobilePage.screenshot({path:'test-results/commercial-mobile.png',fullPage:true});
    await page.setViewportSize({width:1440,height:1000});await page.goto(base);await page.screenshot({path:'test-results/commercial-desktop.png',fullPage:true});
    await writeFile('test-results/commercial-e2e.txt',`PASS: register, login, direct search, reserve, pay, receipt, check-in, boarding QR, keyword policy retrieval, feedback, notification replay, RLS denial, role denial, CSRF denial, live account revocation, mobile overflow.\nProduction operations and graph integration were not tested.\n`);
    console.log('PASS: commercial browser journey and access-control checks. Test databases are being removed.');
  }catch(error){
    const page=browser.contexts()[0]?.pages()[0];
    if(page){await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/commercial-failure.png',fullPage:true});console.error(await page.locator('[role="status"],[role="alert"]').allTextContents());}
    console.error(logs);throw error;
  }
  finally {
    await browser.close();
    if(server && server.exitCode===null){server.kill();await new Promise<void>(resolve=>{if(server!.exitCode!==null)resolve();else server!.once('exit',()=>resolve());});}
    await owner.end();if(created)await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);await admin.end();
    if(created)await mongoDb.dropDatabase();await mongo.close();
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'E2E test failed');process.exitCode=1;});
