'use client';
import Link from 'next/link';
import { BoardingPass } from './landing/BoardingPass';
import { useCallback,useEffect,useRef,useState } from 'react';
import { request,money,date } from './api';
type Flight={flight_id:string;flight_number:string;origin:string;destination:string;departure_time:string;arrival_time:string;fare_class:string;price:string;remaining:string};
type Itinerary={legs:{flightId:string;flightNumber:string;origin:string;destination:string;departureTime:string;arrivalTime:string}[];totalFare:number};
export type SearchInitial={from?:string;to?:string;date?:string;pax?:string;type?:string};
export function Search({initial={}}:{initial?:SearchInitial}={}) {
  const [flights,setFlights]=useState<Flight[]>([]),[itineraries,setItineraries]=useState<Itinerary[]>([]);
  const [status,setStatus]=useState(''),[busy,setBusy]=useState(false);
  const run=useCallback(async(values:Record<string,string>)=>{
    setBusy(true);setStatus('');setFlights([]);setItineraries([]);
    const query=new URLSearchParams(values);
    try {
      if(values.type==='connecting') {const result=await request<{itineraries:Itinerary[]}>(`/api/search/itineraries?${query}`);setItineraries(result.itineraries);if(!result.itineraries.length)setStatus('No matching connections. Try another date.');}
      else {const result=await request<{flights:Flight[]}>(`/api/search/flights?${query}`);setFlights(result.flights);if(!result.flights.length)setStatus('No direct flights that day. Try a connecting journey.');}
    } catch(e){setStatus((e as Error).message);}finally{setBusy(false);}
  },[]);
  // Arriving from the landing page's boarding pass (/search?from=..&to=..&date=..&pax=..) runs the search straight away.
  const auto=useRef(false);
  useEffect(()=>{
    if(auto.current || !initial.from || !initial.to || !initial.date) return;
    auto.current=true;
    void run({from:initial.from,to:initial.to,date:initial.date,pax:initial.pax || '1',type:initial.type || 'direct'});
  },[initial,run]);
  return <><section className="hero"><p className="eyebrow">YOUR JOURNEY STARTS HERE</p><h1>Book the sky.</h1>
    <p>Find your flight. Choose your seat. Keep every detail of your journey together.</p></section>
    <section className="search-ticket" aria-label="Find your flight">
      <BoardingPass initial={{...initial, to:initial.to || 'BOM', date:initial.date || new Date(Date.now()+86400000).toISOString().slice(0,10)}} onSearch={values => void run(values)} busy={busy}/>
      <p role="status">{status}</p>
    </section>
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
