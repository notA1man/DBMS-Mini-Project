'use client';
import { useEffect,useState } from 'react';
import { request,money } from './api';
import { PageHead } from './page-head';
type Seat={seat_number:string;seat_class:string;available:boolean;price:string};
export function BookingForm({flights,fare}:{flights:string[];fare:string}) {
  const [maps,setMaps]=useState<Record<string,Seat[]>>({});
  const [travelers,setTravelers]=useState(1),[chosen,setChosen]=useState<Record<string,string>>({});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{let live=true;
    Promise.all(flights.map(async id=>[id,(await request<{seats:Seat[]}>(`/api/commercial/seat-map?flight=${id}`)).seats] as const))
      .then(entries=>{if(live)setMaps(Object.fromEntries(entries));}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[flights]);
  const loaded = Object.keys(maps).length;
  return <><PageHead eyebrow="RESERVE YOUR JOURNEY" title="A seat for everyone." lede="Fares are finalized when you reserve. Your booking stays pending until it is fully paid."
    readouts={[['LEGS', flights.length], ['CABIN', fare], ['SEAT MAPS', loaded === flights.length ? 'Ready' : `${loaded}/${flights.length}`]]} />
    <form className="stack" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');const f=new FormData(event.currentTarget);
      try {
        const others=Array.from({length:travelers-1},(_,i)=>({firstName:f.get(`first${i}`),lastName:f.get(`last${i}`),email:f.get(`email${i}`),dateOfBirth:f.get(`dob${i}`)}));
        const items=flights.flatMap(flightId=>Array.from({length:travelers},(_,travelerIndex)=>({flightId,fareClass:fare,travelerIndex,seatNumber:chosen[`${flightId}-${travelerIndex}`] || null})));
        const result=await request<{pnr:string}>('/api/commercial/book',{items,travelers:others});
        window.location.href=`/trips/${result.pnr}`;
      }catch(e){setError((e as Error).message);setBusy(false);}
    }}>
      <label className="card">Travelers (including you)<select value={travelers} onChange={e=>{setTravelers(Number(e.target.value));setChosen({});}}>{[1,2,3,4,5,6].map(n=><option key={n}>{n}</option>)}</select></label>
      {Array.from({length:travelers-1},(_,i)=><section className="card grid2" key={i}><h2>Traveler {i+2}</h2><p className="muted">Use a unique contact email for each traveler.</p>
        <label>First name<input required name={`first${i}`} maxLength={80}/></label><label>Last name<input required name={`last${i}`} maxLength={80}/></label>
        <label>Email<input required name={`email${i}`} type="email"/></label><label>Date of birth<input required name={`dob${i}`} type="date" max={new Date().toISOString().slice(0,10)}/></label></section>)}
      {flights.map(id=><section className="card stack" key={id}><h2>Flight {id} · {fare}</h2><p>{maps[id]?.find(s=>s.seat_class===fare)?`From ${money(maps[id].find(s=>s.seat_class===fare)!.price)} per traveler`:'Loading seats…'}</p>
        {Array.from({length:travelers},(_,i)=><fieldset key={i}><legend>Choose a seat for {i===0?'you':`traveler ${i+1}`}</legend><div className="seat-options">
          {maps[id]?.filter(s=>s.seat_class===fare).map(s=>{const selected=chosen[`${id}-${i}`]===s.seat_number;
            const used=Object.entries(chosen).some(([key,value])=>key.startsWith(`${id}-`) && key!==`${id}-${i}` && value===s.seat_number);
            return <button type="button" className="seat" key={s.seat_number} disabled={!s.available || used} aria-pressed={selected}
              onClick={()=>setChosen({...chosen,[`${id}-${i}`]:selected?'':s.seat_number})}>{s.seat_number}</button>;})}
        </div><small>A seat may be assigned at check-in if you leave it unselected.</small></fieldset>)}
      </section>)}
      <p role="alert">{error}</p><button disabled={busy || Object.keys(maps).length!==flights.length}>{busy?'Reserving…':'Reserve & continue to payment'}</button>
    </form></>;
}
