'use client';
import { useCallback,useEffect,useState } from 'react';
export async function request<T>(url:string,body?:unknown):Promise<T> {
  const response=await fetch(url,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.headers.get('content-type')?.includes('application/json')) throw new Error('This service is temporarily unavailable.');
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data as T;
}
export function useResource<T>(url:string) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[version,setVersion]=useState(0);
  const reload=useCallback(()=>setVersion(v=>v+1),[]);
  useEffect(()=>{
    let live=true;
    request<T>(url).then(d=>{if(live){setData(d);setError('');}}).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;};
  },[url,version]);
  return {data,error,reload};
}
export function money(value:unknown) { return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(value)); }
export function date(value:string) { return new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}); }
