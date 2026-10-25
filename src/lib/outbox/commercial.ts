import type { Db } from 'mongodb';

export type CommercialEvent={event_id:string;event_type:string;created_at:Date|string;
  payload:{userId:string|number;bookingId:string;refundAmount?:number;reason?:string}};

/** Aditya's dispatcher calls this handler and marks processed only after it resolves. */
export async function deliverCommercialNotification(db:Db,event:CommercialEvent):Promise<boolean> {
  if(!['BOOKING_CONFIRMED','BOOKING_CANCELLED'].includes(event.event_type)) return false;
  const {bookingId,userId,refundAmount}=event.payload;
  if(!/^[A-Z0-9]{6}$/.test(bookingId) || !/^[0-9]+$/.test(String(userId))) throw new Error('Invalid commercial notification payload');
  const confirmed=event.event_type==='BOOKING_CONFIRMED';
  // A stable event key prevents duplicate notifications across retries/crashes.
  // $setOnInsert also preserves an existing read flag and original TTL date.
  await db.collection<{_id:string}>('notifications').updateOne({_id:`outbox:${event.event_id}`},{$setOnInsert:{
    userId:String(userId),kind:event.event_type,title:confirmed?'Booking confirmed':'Booking cancelled',
    body:confirmed?`Your booking ${bookingId} is confirmed.`:
      `Booking ${bookingId} was cancelled. Simulated refund: INR ${Number(refundAmount || 0).toFixed(2)}.`,
    link:`/trips/${bookingId}`,read:false,createdAt:new Date(event.created_at),
  }},{upsert:true});
  return true;
}
