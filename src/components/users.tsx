'use client';
import { useState } from 'react';
import { useResource } from './api';
import { ActionForm } from './action-form';
import { PageHead } from './page-head';

export function Users() {
  const { data, error, reload } = useResource<{ users: { user_id: string; email: string; role: string; is_active: boolean; crew_id: string | null }[] }>('/api/commercial/users');
  const users = data?.users ?? [];
  const staff = users.filter(u => u.role !== 'PASSENGER').length;
  // Thousands of passengers: render a filtered page of rows, not one edit form per account.
  const [role, setRole] = useState('STAFF'), [q, setQ] = useState('');
  const matches = users.filter(u => (role === 'ALL' || (role === 'STAFF' ? u.role !== 'PASSENGER' : u.role === role)) && u.email.toLowerCase().includes(q.trim().toLowerCase()));
  const shown = matches.slice(0, 100);
  return <>
    <PageHead eyebrow="ADMINISTRATION" title="Users & roles" lede="Staff accounts and passenger roles. Passengers cannot be promoted; crew accounts must point at a crew record."
      readouts={data ? [['ACCOUNTS', users.length], ['STAFF', staff], ['DISABLED', users.filter(u => !u.is_active).length]] : undefined} />
    <p role="alert">{error}</p>
    <section className="card"><div className="toolbar">
      <label>Show<select value={role} onChange={e => setRole(e.target.value)}>{['STAFF', 'ALL', 'ADMIN', 'OPS', 'CREW', 'PASSENGER'].map(r => <option key={r}>{r}</option>)}</select></label>
      <label>Email<input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="passenger12@" /></label>
      {data && <span className="mono">{matches.length > shown.length ? `First ${shown.length} of ${matches.length}` : `${matches.length} shown`}</span>}
    </div><div className="overflow"><table><thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Crew</th><th></th></tr></thead>
      <tbody>{shown.map(u => <tr key={u.user_id}>
        <td>{u.email}</td>
        <td><span className="pill">{u.role}</span></td>
        <td><span className={`pill ${u.is_active ? 'good' : 'bad'}`}>{u.is_active ? 'Active' : 'Disabled'}</span></td>
        <td className="mono">{u.crew_id ?? '—'}</td>
        <td><details><summary>Edit</summary>
          <ActionForm action="user" label="Update user" onSuccess={reload} body={f => ({ id: u.user_id, role: f.get('role'), active: f.get('active') === 'true', crewId: f.get('crewId') || null })}>
            <div className="grid2"><label>Role<select name="role" defaultValue={u.role}>{(u.role === 'PASSENGER' ? ['PASSENGER'] : ['ADMIN', 'OPS', 'CREW']).map(r => <option key={r}>{r}</option>)}</select></label>
              <label>Status<select name="active" defaultValue={String(u.is_active)}><option value="true">Active</option><option value="false">Disabled</option></select></label>
              {u.role !== 'PASSENGER' && <label>Crew ID (crew accounts only)<input name="crewId" defaultValue={u.crew_id || ''} pattern="[0-9]+" /></label>}</div>
          </ActionForm></details></td>
      </tr>)}{!data && !error && <tr><td colSpan={5}>Loading accounts…</td></tr>}{data && !matches.length && <tr><td colSpan={5}>No accounts match.</td></tr>}</tbody></table></div></section>
    <section className="card results"><h2>Create staff account</h2>
      <ActionForm action="staff" label="Create staff account" onSuccess={reload} body={f => ({ email: f.get('email'), password: f.get('password'), role: f.get('role'), crewId: f.get('crewId') || null })}>
        <div className="grid2"><label>Email<input name="email" type="email" required /></label><label>Temporary password<input name="password" type="password" minLength={12} maxLength={72} required autoComplete="new-password" /></label>
          <label>Role<select name="role"><option>OPS</option><option>CREW</option><option>ADMIN</option></select></label><label>Crew ID (required for crew)<input name="crewId" pattern="[0-9]+" /></label></div>
      </ActionForm></section>
  </>;
}
