'use client';
import { useState } from 'react';
import { request } from './api';
import { PageHead } from './page-head';
type Results={mode:string;passages:{doc_id:string;title:string;category:string;content:string;score:string}[]};
export function Policies() {
  const [data,setData]=useState<Results|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <><PageHead eyebrow="KNOW BEFORE YOU GO" title="Your policy guide." lede="Ask about Strata demo travel policies. Each result includes its source passage. This assistant retrieves policy text; it does not generate answers."
    readouts={data?[['PASSAGES',data.passages.length],['RETRIEVAL',data.mode==='hybrid'?'Hybrid':'Keyword']]:undefined}/>
    <section className="card results"><form className="stack" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');const f=new FormData(event.currentTarget);
      try{setData(await request<Results>('/api/policies/search',{query:f.get('query'),category:f.get('category') || undefined}));}catch(e){setError((e as Error).message);}finally{setBusy(false);}
    }}><label>Your question<input name="query" placeholder="How much baggage can I bring?" minLength={2} maxLength={500} required/></label>
      <label>Topic<select name="category"><option value="">All topics</option>{['baggage','refund','check-in','assistance','pets','travel-docs'].map(c=><option key={c}>{c}</option>)}</select></label>
      <button disabled={busy}>{busy?'Finding policy passages…':'Find policy passages'}</button><p role="alert">{error}</p></form></section>
    {data && <section className="card results"><p className="muted">{data.mode==='hybrid'?'Semantic + keyword retrieval':'Keyword retrieval · semantic search is currently unavailable'}</p>
      {data.passages.length===0 && <p className="empty">No matching policies. Try different wording or another topic.</p>}
      {data.passages.map((p,i)=><article className="hit" key={`${p.doc_id}-${i}`}><p className="eyebrow">SOURCE {String(i+1).padStart(2,'0')} · {p.category}<span className="score" title={`score ${p.score}`}><i style={{width:`${Math.min(100,Math.round(Number(p.score)*100))}%`}}/></span></p><h2>{p.title}</h2><p>{p.content}</p><small>Strata demo knowledge base · Document {p.doc_id}</small></article>)}
    </section>}
  </>;
}
