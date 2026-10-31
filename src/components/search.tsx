'use client';
import Link from 'next/link';
import { BoardingPass } from './landing/BoardingPass';
import { useCallback,useEffect,useRef,useState } from 'react';
import { request,money } from './api';
import { localTime } from './ops/ui';
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
    {(flights.length>0 || itineraries.length>0) && <div className="results-head"><span><strong>{flights.length || itineraries.length}</strong> {flights.length?'fares':'itineraries'} found</span>
      <span>Local times · prices per traveler</span></div>}
    <div className="result-list">{flights.map((f,i)=><article className="result" key={`${f.flight_id}-${f.fare_class}`} style={{animationDelay:`${Math.min(i,8)*60}ms`}}>
      <div className="result-legs"><Leg id={f.flight_number} cabin={f.fare_class} origin={f.origin} destination={f.destination} dep={f.departure_time} arr={f.arrival_time}/></div>
      <div className="result-price"><small>{f.fare_class}</small><strong>{money(f.price)}</strong><small>{f.remaining} seats left</small>
        <Link className="button arrow" href={`/book?flights=${f.flight_id}&fare=${f.fare_class}`}>Choose seats</Link></div>
    </article>)}
    {itineraries.map((it,index)=><article className="result" key={index} style={{animationDelay:`${Math.min(index,8)*60}ms`}}>
      <div className="result-legs">{it.legs.map((l,i)=><div className="stack" style={{gap:'.7rem'}} key={l.flightId}>
        {i>0 && <p className="layover">{Math.round((Date.parse(l.departureTime)-Date.parse(it.legs[i-1].arrivalTime))/60000)} min connection in {l.origin}</p>}
        <Leg id={l.flightNumber} cabin={`Leg ${i+1} of ${it.legs.length}`} origin={l.origin} destination={l.destination} dep={l.departureTime} arr={l.arrivalTime}/></div>)}</div>
      <div className="result-price"><small>{it.legs.length-1} stop{it.legs.length>2?'s':''} · Economy</small><strong>{money(it.totalFare)}</strong><small>indicative fare</small>
        <Link className="button arrow" href={`/book?flights=${it.legs.map(l=>l.flightId).join(',')}&fare=Economy`}>Choose seats</Link></div>
    </article>)}
    </div><section className="feature-grid"><article><h2>Your seat, secured.</h2><p>Availability is checked again when you reserve. Prices can change until booking.</p></article>
      <article><h2>Everything in one place.</h2><p>Your bookings, receipts, check-in and boarding passes are together in My Trips.</p></article>
      <article><h2>Know before you go.</h2><p>Explore the Strata demo baggage, check-in and refund policies.</p><Link href="/policies">Read our policies →</Link></article></section>
  </>;
}
function Leg({id,cabin,origin,destination,dep,arr}:{id:string;cabin:string;origin:string;destination:string;dep:string;arr:string}) {
  const minutes=Math.round((Date.parse(arr)-Date.parse(dep))/60000);
  return <div className="leg"><div className="leg-id"><b>{id}</b>{cabin}</div>
    <div className="leg-end"><strong>{localTime(dep,origin)}</strong><span>{origin} · {localTime(dep,origin,true).split(',')[0]}</span></div>
    <div className="leg-line"><span>{Math.floor(minutes/60)}h {String(minutes%60).padStart(2,'0')}m</span><i/><span>DIRECT</span></div>
    <div className="leg-end"><strong>{localTime(arr,destination)}</strong><span>{destination}</span></div></div>;
}
