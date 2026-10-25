import { z } from 'zod';
import { asIdentity,apiError,checkOrigin,HttpError } from '@/server/access';
export async function POST(request:Request) {
  try {
    checkOrigin(request);
    const d=z.object({query:z.enum(['seats','bookings','lookup','double-book']),flight:z.string().regex(/^[0-9]+$/).default('1'),text:z.string().max(100).default(''),seat:z.string().max(8).default('1A')}).parse(await request.json());
    return Response.json(await asIdentity(d.query==='lookup'?['ADMIN','OPS']:null,async(c,u)=>{
      if(d.query==='double-book') {
        if(u.role!=='PASSENGER') throw new HttpError(403,'A passenger account is required for this demonstration.');
        const seat=(await c.query('SELECT * FROM fn_seat_map($1) WHERE seat_number=$2 AND available',[d.flight,d.seat])).rows[0];
        if(!seat) throw new HttpError(409,'Choose a currently available seat.');
        const items=JSON.stringify([{flightId:d.flight,passengerId:u.passenger_id,fareClass:seat.seat_class,seatNumber:d.seat}]);
        await c.query('SAVEPOINT showcase');
        let firstSucceeded=false;
        try {
          await c.query('SELECT fn_book($1,$2::jsonb)',[u.passenger_id,items]);firstSucceeded=true;
          await c.query('SELECT fn_book($1,$2::jsonb)',[u.passenger_id,items]);
          throw new Error('Double-booking constraint did not reject the second call.');
        }catch(error){
          await c.query('ROLLBACK TO SAVEPOINT showcase');
          if(!firstSucceeded || (error as {code:string}).code!=='23505') throw error;
          return {sql:'SELECT fn_book($1,$2::jsonb); -- attempted twice, then ROLLBACK TO SAVEPOINT',
            rows:[{firstAttempt:'accepted',secondAttempt:'rejected',sqlstate:'23505',constraint:(error as {constraint:string}).constraint,retainedBookings:0}],plan:null};
        }
      }
      const queries={
        seats:{sql:'SELECT * FROM fn_seat_map($1)',params:[d.flight]},
        bookings:{sql:'SELECT * FROM v_booking_summary ORDER BY booking_date DESC LIMIT 20',params:[]},
        lookup:{sql:"SELECT passenger_id,first_name,last_name,email FROM passenger WHERE name_search @@ websearch_to_tsquery('simple',$1) LIMIT 20",params:[d.text]},
      };
      const query=queries[d.query];
      const result=await c.query(query.sql,query.params);
      const plan=await c.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`,query.params);
      return {sql:query.sql,rows:result.rows,plan:plan.rows[0]['QUERY PLAN']};
    }));
  }catch(error){return apiError(error);}
}
