'use client';
import Image from 'next/image';
import { useResource,money,date } from './api';
import { ActionForm } from './action-form';
type Ticket={ticket_seq:number;flight_id:string;flight_number:string;origin:string;destination:string;departure_time:string;
  arrival_time:string;first_name:string;last_name:string;fare_class:string;seat_number:string|null;ticket_status:string;checkin_status:string;boarding_pass_code:string|null};
type Detail={booking:{booking_id:string;booking_status:string;total_amount:string;amount_paid:string;amount_due:string;refund_amount:string};
  tickets:Ticket[];receipts:{receipt_number:string;amount:string;payment_mode:string;receipt_date:string}[];
  baggage:{ticket_seq:number;bag_seq:number;weight_kg:string;bag_type:string;tag_number:string}[]};
export function TripDetail({pnr}:{pnr:string}) {
  const {data,error,reload}=useResource<Detail>(`/api/commercial/booking?pnr=${pnr}`);
  if(!data) return <p role={error?'alert':'status'}>{error || 'Loading your booking…'}</p>;
  const b=data.booking;
  return <><p className="eyebrow">MANAGE YOUR JOURNEY</p><h1>Booking {pnr} <span className="badge">{b.booking_status}</span></h1><p role="alert">{error}</p>
    <section className="card flight-row"><p>Total <strong>{money(b.total_amount)}</strong> · Paid {money(b.amount_paid)} · Due {money(b.amount_due)}</p>
      {b.booking_status==='Cancelled' && <p>Simulated refund: {money(b.refund_amount)}</p>}</section>
    <div className="stack results">{data.tickets.map(t=><section className="card" key={t.ticket_seq}><div className="flight-row"><div><p className="eyebrow">{t.flight_number} · {t.fare_class}</p>
      <h2>{t.origin} → {t.destination}</h2><p>{date(t.departure_time)} — {date(t.arrival_time)}</p><p>{t.first_name} {t.last_name} · Seat {t.seat_number || 'Unassigned'} · {t.ticket_status}</p></div><span className="badge">{t.checkin_status==='CheckedIn'?'Checked in':'Not checked in'}</span></div>
      {t.ticket_status==='Active' && b.booking_status==='Confirmed' && t.checkin_status!=='CheckedIn' && <CheckIn t={t} pnr={pnr} reload={reload}/>}
      {t.boarding_pass_code && <div className="boarding"><div><p className="eyebrow">SKYOPS BOARDING PASS</p><h2>{t.first_name} {t.last_name}</h2><p>{t.flight_number} · {t.origin} → {t.destination}</p><p>Seat {t.seat_number} · {t.fare_class}</p><p>{date(t.departure_time)} · PNR {pnr}</p>
        <button className="subtle no-print" onClick={()=>window.print()}>Print boarding pass</button></div>
        <Image unoptimized src={`/api/boarding-pass?pnr=${pnr}&seq=${t.ticket_seq}`} width={150} height={150} alt={`Boarding QR for ${t.first_name} ${t.last_name}`}/></div>}
      {t.ticket_status==='Active' && <><details><summary>Add baggage</summary><p>Cabin: 7kg. Checked: Economy 20kg, Business 30kg, First 40kg total. Maximum 32kg per bag.</p>
        <ActionForm action="baggage" label="Add bag" onSuccess={reload} body={f=>({pnr,seq:t.ticket_seq,weight:Number(f.get('weight')),type:f.get('type')})}>
          <div className="grid2"><label>Weight (kg)<input type="number" name="weight" min="0.01" max="32" step="0.01" required/></label><label>Type<select name="type"><option>Checked</option><option>Cabin</option></select></label></div>
        </ActionForm></details><details><summary>Leave feedback</summary><p>Available after this flight has landed. One review per passenger per flight.</p><Feedback pnr={pnr} seq={t.ticket_seq}/></details></>}
      {data.baggage.filter(bag=>bag.ticket_seq===t.ticket_seq).map(bag=><p key={bag.bag_seq}><span className="badge">{bag.bag_type}</span> {bag.weight_kg}kg · Tag {bag.tag_number}</p>)}
    </section>)}</div>
    <div className="grid2 results">{b.booking_status==='Pending' && <section className="card"><h2>Simulated payment</h2><p>No card or bank details are collected. Choose an amount up to the balance.</p>
      <ActionForm action="pay" label="Record payment" onSuccess={reload} body={f=>({pnr,amount:Number(f.get('amount')),mode:f.get('mode'),reference:`PAY-${pnr}-${b.amount_paid}-${Number(f.get('amount'))}-${f.get('mode')}`})}>
        <label>Amount (INR)<input key={b.amount_due} name="amount" type="number" required min="0.01" step="0.01" max={b.amount_due} defaultValue={b.amount_due}/></label>
        <label>Method<select name="mode"><option>UPI</option><option>Card</option><option>NetBanking</option></select></label>
      </ActionForm></section>}
      <section className="card"><h2>Receipts</h2>{data.receipts.length===0 && <p>Receipts appear after successful payment.</p>}{data.receipts.map(r=><article key={r.receipt_number}><strong>{r.receipt_number}</strong><p>{money(r.amount)} · {r.payment_mode} · {date(r.receipt_date)}</p></article>)}</section>
    </div>
    {b.booking_status!=='Cancelled' && <section className="card results"><details><summary>Cancel booking</summary><p>This releases every ticket in this booking. Simulated refunds: 90% at least 24h before departure, 50% at least 2h before, otherwise 0%. Disrupted bookings receive 100%.</p>
      <ActionForm action="cancel" label="Cancel this booking" onSuccess={reload} body={f=>({pnr,reason:f.get('reason')})}>
        <label>Reason<textarea required name="reason" maxLength={1000}/></label><label><span><input type="checkbox" required style={{width:'auto'}}/> I understand this cancels every ticket in this booking.</span></label>
      </ActionForm></details></section>}
  </>;
}
function CheckIn({t,pnr,reload}:{t:Ticket;pnr:string;reload:()=>void}) {
  const {data,error}=useResource<{seats:{seat_number:string;seat_class:string;available:boolean}[]}>(`/api/commercial/seat-map?flight=${t.flight_id}`);
  return <details><summary>Web check-in</summary><p>Check-in opens 48 hours and closes 1 hour before departure.</p><p role="alert">{error}</p>
    <ActionForm action="check-in" label="Check in" onSuccess={reload} body={f=>({pnr,seq:t.ticket_seq,seat:f.get('seat')})}>
      <label>Seat<select key={data?'loaded':'loading'} name="seat" defaultValue={t.seat_number || ''} required><option value="">Choose a seat</option>
        {data?.seats.filter(s=>s.seat_class===t.fare_class && (s.available || s.seat_number===t.seat_number)).map(s=><option key={s.seat_number}>{s.seat_number}</option>)}</select></label>
    </ActionForm></details>;
}
function Feedback({pnr,seq}:{pnr:string;seq:number}) {
  return <ActionForm action="feedback" label="Submit feedback" body={f=>({pnr,seq,comment:f.get('comment'),tags:String(f.get('tags') || '').split(',').map(s=>s.trim()).filter(Boolean),
    ratings:Object.fromEntries(['punctuality','crew','seat','food','overall'].map(key=>[key,Number(f.get(key))]))})}>
    <div className="grid2">{['punctuality','crew','seat','food','overall'].map(key=><label key={key}>{key[0].toUpperCase()+key.slice(1)}<select name={key} defaultValue="5">{[1,2,3,4,5].map(n=><option key={n}>{n}</option>)}</select></label>)}</div>
    <label>Your experience<textarea name="comment" minLength={10} maxLength={3000} required/></label><label>Tags (comma separated)<input name="tags" maxLength={300}/></label>
  </ActionForm>;
}
