'use client';
import Link from 'next/link';
import { useResource,money,date } from './api';
import { localTime } from './ops/ui';
import { PageHead } from './page-head';
import { AIRPORT_BY_CODE } from '@/lib/airports';
type Trip={booking_id:string;booking_status:string;booking_date:string;total_amount:string;amount_paid:string;
  origin:string|null;destination:string|null;departure_time:string|null;flight_number:string|null;legs:number|null;travellers:number|null};
export function Trips() {
  const {data,error}=useResource<{trips:Trip[]}>('/api/commercial/trips');
  const upcoming=data?.trips.filter(t=>t.departure_time && Date.parse(t.departure_time)>Date.now() && t.booking_status!=='Cancelled').length;
  return <><PageHead eyebrow="YOUR JOURNEYS" title="My Trips" readouts={data?[['BOOKINGS',data.trips.length],['UPCOMING',upcoming ?? 0]]:undefined}/>
    <p role="alert">{error}</p>
    {!data && !error && <p className="loading">Loading your trips</p>}
    {data?.trips.length===0 && <p className="empty">No bookings yet. <Link href="/search">Find your next flight →</Link></p>}
    <div className="trip-list">{data?.trips.map(b=><Link className="trip-card" href={`/trips/${b.booking_id}`} key={b.booking_id}>
      <div className={`pass ${b.booking_status==='Cancelled'?'void':''}`}><div className="pass-main">
        <div className="pass-top"><span><b>STRATA</b> · {b.flight_number ?? 'BOOKING'}{Number(b.legs)>1?` +${Number(b.legs)-1}`:''}</span><span className={`pill ${b.booking_status}`}>{b.booking_status}</span></div>
        <div className="pass-route"><div><small>FROM</small><strong>{b.origin ?? '—'}</strong><span>{b.origin ? AIRPORT_BY_CODE[b.origin]?.city : ''}</span></div>
          <div className="pass-plane"/><div><small>TO</small><strong>{b.destination ?? '—'}</strong><span>{b.destination ? AIRPORT_BY_CODE[b.destination]?.city : ''}</span></div></div>
        <dl className="pass-fields"><div><dt>Departs</dt><dd>{b.departure_time && b.origin ? localTime(b.departure_time,b.origin,true) : '—'}</dd></div>
          <div><dt>Travellers</dt><dd>{b.travellers ?? '—'}</dd></div><div><dt>Total</dt><dd>{money(b.total_amount)}</dd></div></dl>
      </div><div className="pass-stub"><div><small style={{fontFamily:'var(--mono)',fontSize:9,letterSpacing:'.2em',color:'#6b737e'}}>PNR</small><br/><strong>{b.booking_id}</strong></div>
        <div className="barcode"/><small style={{color:'#59616c',fontFamily:'var(--mono)',fontSize:10}}>Paid {money(b.amount_paid)}</small></div></div>
    </Link>)}</div>
    <Notifications/></>;
}
function Notifications() {
  const {data,error,reload}=useResource<{notifications:{_id:string;title:string;body:string;link:string;read:boolean;createdAt:string}[]}>('/api/commercial/notifications');
  return <section className="card results"><h2>Notifications</h2><p role="alert">{error}</p>{data?.notifications.length===0 && <p className="empty">You’re all caught up</p>}
    {data?.notifications.map(n=><article key={n._id} className={`notice ${n.read?'':'unread'}`}><i/><div><Link href={n.link} onClick={async()=>{const {request}=await import('./api');await request('/api/commercial/notification-read',{id:n._id});reload();}}>
      {n.title}</Link><p>{n.body}</p></div><small>{date(n.createdAt)}</small></article>)}</section>;
}
