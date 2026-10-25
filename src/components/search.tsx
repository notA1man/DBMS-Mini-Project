'use client';
import Link from 'next/link';
import { useState } from 'react';
import { request,money,date } from './api';
type Flight={flight_id:string;flight_number:string;origin:string;destination:string;departure_time:string;arrival_time:string;fare_class:string;price:string;remaining:string};
type Itinerary={legs:{flightId:string;flightNumber:string;origin:string;destination:string;departureTime:string;arrivalTime:string}[];totalFare:number};
export function Search() {
  const [flights,setFlights]=useState<Flight[]>([]),[itineraries,setItineraries]=useState<Itinerary[]>([]);
  const [status,setStatus]=useState(''),[busy,setBusy]=useState(false);
  return <><section className="hero"><p className="eyebrow">A CLEARER WAY TO FLY</p><h1>Good journeys<br/>start with a plan.</h1>
    <p>Find your flight. Choose your seat. Keep every detail of your journey together.</p></section>
    <section className="card"><form className="search-grid" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setStatus('');setFlights([]);setItineraries([]);
      const values=Object.fromEntries(new FormData(event.currentTarget));const query=new URLSearchParams(values as Record<string,string>);
      try {
        if(values.type==='connecting') {const result=await request<{itineraries:Itinerary[]}>(`/api/search/itineraries?${query}`);setItineraries(result.itineraries);if(!result.itineraries.length)setStatus('No matching connections. Try another date.');}
        else {const result=await request<{flights:Flight[]}>(`/api/search/flights?${query}`);setFlights(result.flights);if(!result.flights.length)setStatus('No matching flights. Try another date.');}
      } catch(e){setStatus((e as Error).message);}finally{setBusy(false);}
    }}>
      <label>From<input name="from" defaultValue="BLR" pattern="[A-Z]{3}" maxLength={3} required aria-label="Origin airport code"/></label>
      <label>To<input name="to" defaultValue="BOM" pattern="[A-Z]{3}" maxLength={3} required aria-label="Destination airport code"/></label>
      <label>Departure<input type="date" name="date" required defaultValue={new Date(Date.now()+86400000).toISOString().slice(0,10)}/></label>
      <label>Travelers<select name="pax">{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></label>
      <label>Journey<select name="type"><option value="direct">Direct</option><option value="connecting">Connecting</option></select></label>
      <button disabled={busy}>{busy?'Searching…':'Find flights →'}</button>
    </form><p role="status">{status}</p></section>
    <div className="stack results">{flights.map(f=><article className="card flight-row" key={`${f.flight_id}-${f.fare_class}`}>
      <div><p className="eyebrow">{f.flight_number} · {f.fare_class}</p><h2>{f.origin} → {f.destination}</h2><p>{date(f.departure_time)} — {date(f.arrival_time)}</p></div>
      <div><strong>{money(f.price)}</strong><p>{f.remaining} available · per traveler</p><Link className="button" href={`/book?flights=${f.flight_id}&fare=${f.fare_class}`}>Choose seats</Link></div>
    </article>)}
    {itineraries.map((it,index)=><article className="card" key={index}><h2>{it.legs.map(l=>l.origin).join(' → ')} → {it.legs.at(-1)?.destination}</h2>
      {it.legs.map(l=><p key={l.flightId}>{l.flightNumber} · {date(l.departureTime)} → {date(l.arrivalTime)}</p>)}
      <strong>{money(it.totalFare)} · indicative fare</strong> <Link className="button" href={`/book?flights=${it.legs.map(l=>l.flightId).join(',')}&fare=Economy`}>Choose seats</Link></article>)}
    </div><section className="feature-grid"><article><h2>Your seat, secured.</h2><p>Availability is checked again when you reserve. Prices can change until booking.</p></article>
      <article><h2>Everything in one place.</h2><p>Your bookings, receipts, check-in and boarding passes are together in My Trips.</p></article>
      <article><h2>Know before you go.</h2><p>Explore the SkyOps demo baggage, check-in and refund policies.</p><Link href="/policies">Read our policies →</Link></article></section>
  </>;
}
