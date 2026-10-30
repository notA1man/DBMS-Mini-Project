'use client';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
import { useState } from 'react';
import { request } from './api';
export function LoginForm({register=false}:{register?:boolean}) {
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <div className="account-layout"><div className="account-story">
    <p className="eyebrow">THE WORLD IS STILL OUT THERE</p><h2 className="account-title">The sky <br/>is yours.</h2>
    <p>One account. Every journey.<br/>Your flights, seats and boarding passes, together.</p>
    <Link className="account-explore" href="/search">Explore flights <span aria-hidden="true">↗</span></Link>
  </div><section className="account-pass card narrow"><p className="eyebrow">YOUR SKYOPS ACCOUNT</p><h1>{register?'Make room for your next trip.':'Welcome aboard.'}</h1>
    <form className="stack" onSubmit={async event=>{
      event.preventDefault();setBusy(true);setError('');const fields=Object.fromEntries(new FormData(event.currentTarget));
      try {
        if(register) await request('/api/register',fields);
        const result=await signIn('credentials',{email:fields.email,password:fields.password,redirect:false});
        if(result?.error) throw new Error('Sign-in failed. Check your details or try again after 15 minutes.');
        // Each role lands on its own home: passengers -> My Trips, ops/admin -> Ops console, crew -> roster.
        const {user}=await request<{user:{role:string}}>('/api/commercial/identity');
        window.location.href=user.role==='CREW'?'/crew':['ADMIN','OPS'].includes(user.role)?'/ops':'/trips';
      }catch(e){setError((e as Error).message);setBusy(false);}
    }}>
      {register && <><label>First name<input name="firstName" autoComplete="given-name" required maxLength={80}/></label>
        <label>Last name<input name="lastName" autoComplete="family-name" required maxLength={80}/></label>
        <label>Date of birth<input type="date" name="dateOfBirth" required max={new Date().toISOString().slice(0,10)}/></label></>}
      <label>Email<input type="email" name="email" autoComplete="email" required maxLength={254}/></label>
      <label>Password<input type="password" name="password" autoComplete={register?'new-password':'current-password'} required minLength={12} maxLength={72} aria-describedby="password-help"/></label>
      <small id="password-help">12–72 bytes. Avoid using a password from another service.</small>
      <button disabled={busy}>{busy?'Please wait…':register?'Create account':'Sign in'} <span aria-hidden="true">↗</span></button><p role="alert">{error}</p>
    </form><p>{register?'Already registered?':'New to SkyOps?'} <Link href={register?'/login':'/register'}>{register?'Sign in':'Create an account'}</Link></p>
  </section></div>;
}
