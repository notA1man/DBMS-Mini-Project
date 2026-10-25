'use client';
import Link from 'next/link';
import { useResource,money,date } from './api';
export function Trips() {
  const {data,error}=useResource<{trips:{booking_id:string;booking_status:string;booking_date:string;total_amount:string;amount_paid:string}[]}>('/api/commercial/trips');
  return <><p className="eyebrow">YOUR JOURNEYS</p><h1>My Trips</h1><p role="alert">{error}</p><div className="stack">
    {!data && !error && <p>Loading your trips…</p>}{data?.trips.length===0 && <p>No bookings yet. <Link href="/">Find your next flight →</Link></p>}
    {data?.trips.map(b=><article className="card flight-row" key={b.booking_id}><div><span className="badge">{b.booking_status}</span><h2>{b.booking_id}</h2><p>Booked {date(b.booking_date)}</p></div>
      <div><p>Total {money(b.total_amount)} · Paid {money(b.amount_paid)}</p><Link className="button" href={`/trips/${b.booking_id}`}>Manage trip</Link></div></article>)}
    </div><Notifications/></>;
}
function Notifications() {
  const {data,error,reload}=useResource<{notifications:{_id:string;title:string;body:string;link:string;read:boolean;createdAt:string}[]}>('/api/commercial/notifications');
  return <section className="card results"><h2>Notifications</h2><p role="alert">{error}</p>{data?.notifications.length===0 && <p>You’re all caught up.</p>}
    {data?.notifications.map(n=><article key={n._id}><Link href={n.link} onClick={async()=>{const {request}=await import('./api');await request('/api/commercial/notification-read',{id:n._id});reload();}}>
      {n.read?'':'● '}{n.title}</Link><p>{n.body}</p><small>{date(n.createdAt)}</small></article>)}</section>;
}
