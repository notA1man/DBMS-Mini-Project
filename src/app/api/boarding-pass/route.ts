import QRCode from 'qrcode';
import { z } from 'zod';
import { asIdentity,apiError,HttpError } from '@/server/access';
export async function GET(request:Request) {
  try {
    const q=z.object({pnr:z.string().regex(/^[A-Z0-9]{6}$/),seq:z.coerce.number().int().positive().max(24)}).parse(Object.fromEntries(new URL(request.url).searchParams));
    const code=await asIdentity(['PASSENGER','ADMIN','OPS'],async c=>{
      const {rows}=await c.query("SELECT boarding_pass_code FROM ticket WHERE booking_id=$1 AND ticket_seq=$2 AND ticket_status='Active' AND checkin_status='CheckedIn'",[q.pnr,q.seq]);
      if(!rows[0]) throw new HttpError(404,'Boarding pass unavailable.');
      return rows[0].boarding_pass_code;
    });
    const png=await QRCode.toBuffer(`SKYOPS:${code}`,{width:300,margin:2});
    return new Response(new Uint8Array(png),{headers:{'Content-Type':'image/png','Cache-Control':'private, no-store'}});
  } catch(error) {return apiError(error);}
}
