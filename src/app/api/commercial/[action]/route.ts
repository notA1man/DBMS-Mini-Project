import { z } from 'zod';
import { pool } from '@/lib/db/postgres';
import { mongoDb } from '@/lib/db/mongo';
import { embed } from '@/lib/ai/embed';
import { asIdentity, apiError, checkOrigin, HttpError, retryTransaction } from '@/server/access';
import { commercialQueries } from '@/server/queries/commercial';
import { feedbackScorecard } from '../../../../../db/mongo/commercial';

const id=z.string().regex(/^[1-9][0-9]*$/);
const pnrSchema=z.string().regex(/^[A-Z0-9]{6}$/);
const fare=z.enum(['Economy','Business','First']);
const roles=['PASSENGER','ADMIN','OPS'];
const bookSchema=z.object({items:z.array(z.object({flightId:id,fareClass:fare,seatNumber:z.string().max(8).nullable(),
  travelerIndex:z.number().int().min(0).max(5)})).min(1).max(24),
  travelers:z.array(z.object({firstName:z.string().trim().min(1).max(80),lastName:z.string().trim().min(1).max(80),
    email:z.email().max(254),dateOfBirth:z.iso.date()})).max(5).default([])});
type Context={params:Promise<{action:string}>};

export async function GET(request:Request,context:Context) {
  try {
    const {action}=await context.params;
    const q=new URL(request.url).searchParams;
    if(action==='seat-map') return Response.json({seats:(await pool.query('SELECT * FROM fn_seat_map($1)',[id.parse(q.get('flight'))])).rows});
    if(action==='trips') return Response.json(await asIdentity(roles,async(c,u)=>({trips:(await c.query(commercialQueries.trips,[u.passenger_id])).rows})));
    if(action==='booking') return Response.json(await asIdentity(roles,async c=>{
      const pnr=pnrSchema.parse(q.get('pnr'));
      const booking=(await c.query('SELECT * FROM v_booking_summary WHERE booking_id=$1',[pnr])).rows[0];
      if(!booking) throw new HttpError(404,'Booking not found.');
      const tickets=(await c.query(commercialQueries.tickets,[pnr])).rows;
      const receipts=(await c.query(commercialQueries.receipts,[pnr])).rows;
      const baggage=(await c.query('SELECT * FROM baggage WHERE booking_id=$1 ORDER BY ticket_seq,bag_seq',[pnr])).rows;
      return {booking,tickets,receipts,baggage};
    }));
    if(action==='identity') return Response.json(await asIdentity(null,async(_c,u)=>({user:u})));
    if(action==='users') return Response.json(await asIdentity(['ADMIN'],async c=>({users:(await c.query('SELECT * FROM fn_admin_users()')).rows})));
    if(action==='lookup') return Response.json(await asIdentity(['OPS','ADMIN'],async c=>({passengers:(await c.query(commercialQueries.lookup,[z.string().trim().min(2).max(100).parse(q.get('q'))])).rows})));
    if(action==='notifications') {
      const user=await asIdentity(null,async(_c,u)=>u);
      const db=await mongoDb();
      return Response.json({notifications:await db.collection('notifications').find({userId:user.user_id}).sort({createdAt:-1}).limit(50).toArray()});
    }
    if(action==='feedback-analytics') {
      await asIdentity(['OPS','ADMIN'],async()=>null);
      return Response.json({analytics:await (await mongoDb()).collection('feedback').aggregate(feedbackScorecard).toArray()});
    }
    throw new HttpError(404,'Unknown action.');
  } catch(error) { return apiError(error); }
}

export async function POST(request:Request,context:Context) {
  try {
    checkOrigin(request);
    const {action}=await context.params;
    const input=await request.json();
    if(action==='book') {
      const d=bookSchema.parse(input);
      return Response.json(await retryTransaction(()=>asIdentity(['PASSENGER'],async(c,u)=>{
        const passengers=[u.passenger_id!];
        for(const t of d.travelers) {
          const r=await c.query('SELECT fn_add_traveler($1,$2,$3,$4) AS id',[t.email,t.firstName,t.lastName,t.dateOfBirth]);
          passengers.push(r.rows[0].id);
        }
        const items=d.items.map(item=>{
          if(!passengers[item.travelerIndex]) throw new HttpError(400,'Missing traveler details.');
          return {...item,passengerId:passengers[item.travelerIndex]};
        });
        const {rows}=await c.query('SELECT fn_book($1,$2::jsonb) AS pnr',[u.passenger_id,JSON.stringify(items)]);
        return {pnr:rows[0].pnr};
      })),{status:201});
    }
    if(action==='pay') {
      const d=z.object({pnr:pnrSchema,amount:z.number().positive().max(9999999999),mode:z.enum(['Card','UPI','NetBanking']),reference:z.string().min(8).max(100)}).parse(input);
      await retryTransaction(()=>asIdentity(roles,async c=>{await c.query('CALL sp_pay($1,$2,$3,$4)',[d.pnr,d.amount,d.mode,d.reference]);}));
    } else if(action==='check-in') {
      const d=z.object({pnr:pnrSchema,seq:z.number().int().positive().max(24),seat:z.string().min(1).max(8)}).parse(input);
      await retryTransaction(()=>asIdentity(roles,async c=>{await c.query('CALL sp_check_in($1,$2::smallint,$3)',[d.pnr,d.seq,d.seat]);}));
    } else if(action==='baggage') {
      const d=z.object({pnr:pnrSchema,seq:z.number().int().positive().max(24),weight:z.number().positive().max(32),type:z.enum(['Cabin','Checked'])}).parse(input);
      await retryTransaction(()=>asIdentity(roles,async c=>{await c.query('CALL sp_add_baggage($1,$2::smallint,$3,$4)',[d.pnr,d.seq,d.weight,d.type]);}));
    } else if(action==='cancel') {
      const d=z.object({pnr:pnrSchema,reason:z.string().trim().min(1).max(1000)}).parse(input);
      await retryTransaction(()=>asIdentity(roles,async c=>{await c.query('CALL sp_cancel_booking($1,$2)',[d.pnr,d.reason]);}));
    } else if(action==='user') {
      const d=z.object({id,role:z.enum(['ADMIN','OPS','CREW','PASSENGER']),active:z.boolean(),crewId:id.nullable().default(null)}).parse(input);
      await asIdentity(['ADMIN'],async c=>{await c.query('CALL sp_admin_user($1,$2,$3,$4)',[d.id,d.role,d.active,d.crewId]);});
    } else if(action==='staff') {
      const d=z.object({email:z.email(),password:z.string().min(12).refine(v=>Buffer.byteLength(v)<=72),role:z.enum(['ADMIN','OPS','CREW']),crewId:id.nullable().default(null)}).parse(input);
      await asIdentity(['ADMIN'],async c=>{await c.query('CALL sp_admin_create_user($1,$2,$3,$4)',[d.email,d.password,d.role,d.crewId]);});
    } else if(action==='notification-read') {
      const d=z.object({id:z.string().max(100)}).parse(input);
      const user=await asIdentity(null,async(_c,u)=>u);
      await (await mongoDb()).collection<{_id:string}>('notifications').updateOne({_id:d.id,userId:user.user_id},{$set:{read:true}});
    } else if(action==='feedback') {
      const rating=z.number().int().min(1).max(5);
      const d=z.object({pnr:pnrSchema,seq:z.number().int().positive().max(24),comment:z.string().trim().min(10).max(3000),
        ratings:z.object({punctuality:rating,crew:rating,seat:rating,food:rating,overall:rating}),tags:z.array(z.string().trim().min(1).max(40)).max(10).default([])}).parse(input);
      const details=await asIdentity(['PASSENGER'],async(c,u)=>{
        const {rows}=await c.query(`SELECT t.flight_id,t.passenger_id,f.origin,f.destination FROM ticket t JOIN flight f USING(flight_id)
          WHERE t.booking_id=$1 AND t.ticket_seq=$2 AND t.passenger_id=$3 AND t.ticket_status='Active'
          AND f.flight_status='Landed' AND f.arrival_time<=now()`,[d.pnr,d.seq,u.passenger_id]);
        if(!rows[0]) throw new HttpError(400,'Feedback is available after your flight has landed.');
        return rows[0];
      });
      await (await mongoDb()).collection('feedback').insertOne({bookingId:d.pnr,flightId:details.flight_id,passengerId:details.passenger_id,
        route:`${details.origin}-${details.destination}`,ratings:d.ratings,comment:d.comment,tags:[...new Set(d.tags)],
        sentiment:d.ratings.overall>=4?'positive':d.ratings.overall<=2?'negative':'neutral',createdAt:new Date(),embeddingStatus:'pending'});
    } else if(action==='complaints') {
      const d=z.object({query:z.string().min(3).max(1000),flightId:id.nullable().default(null),route:z.string().regex(/^[A-Z]{3}-[A-Z]{3}$/).nullable().default(null),since:z.iso.date().default('2000-01-01')}).parse(input);
      await asIdentity(['ADMIN','OPS'],async()=>null);
      const vector=await embed(d.query);
      const results=await asIdentity(['ADMIN','OPS'],async c=>(await c.query(commercialQueries.similar,[JSON.stringify(vector),d.flightId,d.since,d.route])).rows);
      const db=await mongoDb();
      const {ObjectId}=await import('mongodb');
      const documents=await db.collection('feedback').find({_id:{$in:results.map(r=>new ObjectId(r.feedback_oid))}}).toArray();
      return Response.json({complaints:results.map(r=>({...r,feedback:documents.find(doc=>doc._id.toHexString()===r.feedback_oid)}))});
    } else throw new HttpError(404,'Unknown action.');
    return Response.json({ok:true});
  } catch(error) {
    if((error as {code:number}).code===11000) return Response.json({error:'Feedback has already been submitted for this flight.'},{status:409});
    return apiError(error);
  }
}
