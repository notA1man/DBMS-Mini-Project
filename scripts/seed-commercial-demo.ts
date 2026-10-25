import { Pool } from 'pg';
process.loadEnvFile('.env');
async function main(){
  const password=process.env.SEED_DEMO_PASSWORD;
  if(!password || Buffer.byteLength(password)<12 || Buffer.byteLength(password)>72) throw new Error('Set SEED_DEMO_PASSWORD to a 12–72 byte demo-only password.');
  const pool=new Pool({connectionString:process.env.DATABASE_URL_OWNER});
  try {
    const flight=(await pool.query(`SELECT f.flight_id FROM flight f JOIN flight_fare ff USING(flight_id)
      WHERE f.flight_status IN ('Scheduled','Delayed') AND f.departure_time>now()+interval '2 hours'
      AND ff.fare_class='Economy' AND ff.seats_allocated>=3 ORDER BY f.departure_time LIMIT 1`)).rows[0];
    if(!flight) throw new Error('Operations seed must supply a future flight with an Economy bucket of at least 3.');
    for(let n=1;n<=3;n++){
      const c=await pool.connect();
      try {
        await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('skyops-commercial-demo'))");
        const email=`passenger${n}@skyops.test`;
        let user=(await c.query('SELECT user_id,passenger_id,role FROM app_user WHERE email=$1',[email])).rows[0];
        if(!user){
          const uid=(await c.query("SELECT fn_register($1,$2,'Demo',$3,'2000-01-01') AS id",[email,password,`Passenger ${n}`])).rows[0].id;
          user=(await c.query('SELECT user_id,passenger_id,role FROM app_user WHERE user_id=$1',[uid])).rows[0];
        }
        if(user.role!=='PASSENGER') throw new Error('Demo email belongs to a non-passenger account.');
        await c.query("SELECT set_config('app.user_id',$1,true)",[user.user_id]);
        const existing=(await c.query("SELECT booking_id FROM ticket WHERE flight_id=$1 AND passenger_id=$2 AND ticket_status='Active'",[flight.flight_id,user.passenger_id])).rows[0];
        if(!existing){
          const seat=(await c.query("SELECT seat_number FROM fn_seat_map($1) WHERE seat_class='Economy' AND available LIMIT 1",[flight.flight_id])).rows[0];
          if(!seat) throw new Error('Not enough available Economy seats for demo seeding.');
          const pnr=(await c.query('SELECT fn_book($1,$2) AS pnr',[user.passenger_id,JSON.stringify([{flightId:flight.flight_id,passengerId:user.passenger_id,fareClass:'Economy',seatNumber:seat.seat_number}])])).rows[0].pnr;
          if(n!==2){
            const total=(await c.query('SELECT total_amount FROM booking WHERE booking_id=$1',[pnr])).rows[0].total_amount;
            await c.query("CALL sp_pay($1,$2,'UPI',$3)",[pnr,total,`SEED-${pnr}`]);
          }
        }
        await c.query('COMMIT');
      }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
    }
    console.log('Demo passengers/bookings/payments checked (two paid, one pending on first seed).');
  }finally{await pool.end();}
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Demo seeding failed');process.exitCode=1;});
