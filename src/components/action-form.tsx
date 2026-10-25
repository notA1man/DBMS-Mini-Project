'use client';
import { useState,type ReactNode } from 'react';
import { request } from './api';
export function ActionForm({action,body,children,onSuccess,label='Save'}:{action:string;body:(data:FormData)=>unknown;
  children:ReactNode;onSuccess?:()=>void;label?:string}) {
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  return <form className="stack" onSubmit={async event=>{
    event.preventDefault();setBusy(true);setMessage('');
    try { await request(`/api/commercial/${action}`,body(new FormData(event.currentTarget)));setMessage('Saved.');onSuccess?.(); }
    catch(error) {setMessage((error as Error).message);} finally {setBusy(false);}
  }}>{children}<button disabled={busy}>{busy?'Saving…':label}</button><p role="status">{message}</p></form>;
}
