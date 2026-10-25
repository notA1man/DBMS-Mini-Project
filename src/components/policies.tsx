'use client';
import { useState } from 'react';
import { request } from './api';
type Results={mode:string;passages:{doc_id:string;title:string;category:string;content:string;score:string}[]};
export function Policies() {
  const [data,setData]=useState<Results|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <><p className="eyebrow">KNOW BEFORE YOU GO</p><h1>Your policy guide.</h1><p>Ask about SkyOps demo travel policies. Each result includes its source passage. This assistant retrieves policy text; it does not generate answers.</p>
    <section className="card results"><form className="stack" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');const f=new FormData(event.currentTarget);
      try{setData(await request<Results>('/api/policies/search',{query:f.get('query'),category:f.get('category') || undefined}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}
    }}><label>Your question<input name="query" placeholder="How much baggage can I bring?" minLength={2} maxLength={500} required/></label>
      <label>Topic<select name="category"><option value="">All topics</option>{['baggage','refund','check-in','assistance','pets','travel-docs'].map(c=><option key={c}>{c}</option>)}</select></label>
      <button disabled={busy}>{busy?'Finding policy passages…':'Find policy passages'}</button><p role="alert">{error}</p></form></section>
    {data && <section className="stack results"><p className="muted">{data.mode==='hybrid'?'Semantic + keyword retrieval':'Keyword retrieval · semantic search is currently unavailable'}</p>
      {data.passages.length===0 && <p>No matching policies. Try different wording or another topic.</p>}
      {data.passages.map((p,i)=><article className="card" key={`${p.doc_id}-${i}`}><p className="eyebrow">SOURCE {i+1} · {p.category}</p><h2>{p.title}</h2><p>{p.content}</p><small>SkyOps demo knowledge base · Document {p.doc_id}</small></article>)}
    </section>}
  </>;
}
