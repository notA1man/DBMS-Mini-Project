'use client';
import { useResource } from './api';
import { ActionForm } from './action-form';
export function Users() {
  const {data,error,reload}=useResource<{users:{user_id:string;email:string;role:string;is_active:boolean;crew_id:string|null}[]}>('/api/commercial/users');
  return <><p className="eyebrow">ADMINISTRATION</p><h1>Users & roles</h1><p role="alert">{error}</p><div className="stack">
    {data?.users.map(u=><section className="card" key={u.user_id}><h2>{u.email}</h2><p>{u.role} · {u.is_active?'Active':'Disabled'}</p>
      <ActionForm action="user" label="Update user" onSuccess={reload} body={f=>({id:u.user_id,role:f.get('role'),active:f.get('active')==='true',crewId:f.get('crewId') || null})}>
        <div className="grid2"><label>Role<select name="role" defaultValue={u.role}>{(u.role==='PASSENGER'?['PASSENGER']:['ADMIN','OPS','CREW']).map(r=><option key={r}>{r}</option>)}</select></label>
          <label>Status<select name="active" defaultValue={String(u.is_active)}><option value="true">Active</option><option value="false">Disabled</option></select></label>
          {u.role!=='PASSENGER' && <label>Crew ID (crew accounts only)<input name="crewId" defaultValue={u.crew_id || ''} pattern="[0-9]+"/></label>}</div>
      </ActionForm></section>)}
    <section className="card"><h2>Create staff account</h2><ActionForm action="staff" label="Create staff account" onSuccess={reload} body={f=>({email:f.get('email'),password:f.get('password'),role:f.get('role'),crewId:f.get('crewId') || null})}>
      <div className="grid2"><label>Email<input name="email" type="email" required/></label><label>Temporary password<input name="password" type="password" minLength={12} maxLength={72} required autoComplete="new-password"/></label>
      <label>Role<select name="role"><option>OPS</option><option>CREW</option><option>ADMIN</option></select></label><label>Crew ID (required for crew)<input name="crewId" pattern="[0-9]+"/></label></div>
    </ActionForm></section></div></>;
}
