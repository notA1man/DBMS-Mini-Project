'use client';
import { useState } from 'react';
import { Bars, DataTable, Unavailable, ist, ops, useResource } from './ui';

type Row = Record<string, unknown>;
type Opt<T> = { data: T | null; error: string | null };

export function Maintenance() {
  const { data, error, reload } = useResource<{ logs: Opt<Row[]>; summary: Opt<{ aogByAircraft: Row[]; replacedParts: Row[]; findingsByAta: Row[] }[]> }>('/api/ops/maintenance');
  const fleet = useResource<{ fleet: Row[] }>('/api/ops/fleet');
  const s = data?.summary.data?.[0];
  const [message, setMessage] = useState('');
  return <>
    <p className="eyebrow">OPERATIONS · MAINTENANCE (MONGODB)</p><h1>Maintenance work orders</h1>
    <p>Work orders are semi-structured documents (nested findings by ATA chapter and component actions) stored in MongoDB with a strict <code>$jsonSchema</code> validator.</p>
    <p role="alert">{error}</p><Unavailable store="MongoDB" error={data?.logs.error} />
    <div className="split">
      <section className="card"><h2>Aircraft-on-ground hours</h2>
        <Bars rows={(s?.aogByAircraft ?? []).slice(0, 12).map(r => ({ label: String(r._id), value: Number(r.aogHours) }))} format={v => `${v.toFixed(0)} h`} /></section>
      <section className="card"><h2>Most replaced parts</h2>
        <Bars rows={(s?.replacedParts ?? []).map(r => ({ label: String(r._id), value: Number(r.replacements) }))} />
        <h2 className="results">Findings by ATA chapter</h2>
        <Bars rows={(s?.findingsByAta ?? []).map(r => ({ label: `ATA ${r._id}`, value: Number(r.count) }))} /></section>
    </div>
    <section className="card results"><h2>Log a work order</h2>
      <form className="stack" onSubmit={async e => {
        e.preventDefault(); setMessage('');
        const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        try {
          await ops('maintenance', { aircraftId: f.aircraftId, checkType: f.checkType, technician: f.technician, aogHours: Number(f.aogHours),
            closed: f.closed === 'on', findings: [{ ata: f.ata, description: f.description, severity: f.severity }],
            components: f.partNo ? [{ partNo: f.partNo, action: f.action }] : [] });
          setMessage('Work order saved.'); reload(); (e.target as HTMLFormElement).reset();
        } catch (err) { setMessage((err as Error).message); }
      }}><div className="grid2">
        <label>Aircraft<select name="aircraftId" required>{fleet.data?.fleet.map(a => <option key={String(a.aircraftId)} value={String(a.aircraftId)}>{String(a.registration)} · {String(a.model)}</option>)}</select></label>
        <label>Check<select name="checkType">{['DEFECT', 'A', 'B', 'C', 'D'].map(c => <option key={c}>{c}</option>)}</select></label>
        <label>Technician<input name="technician" required minLength={2} /></label>
        <label>AOG hours<input name="aogHours" type="number" step="0.5" min="0" defaultValue="2" /></label>
        <label>ATA chapter<input name="ata" required pattern="[0-9]{2}(-[0-9]{2})?" placeholder="32-41" /></label>
        <label>Severity<select name="severity"><option>minor</option><option>major</option><option>critical</option></select></label>
        <label>Finding<input name="description" required minLength={3} placeholder="Main wheel tyre worn to limit" /></label>
        <label>Part number (optional)<input name="partNo" placeholder="TYR-H44.5" /></label>
        <label>Part action<select name="action"><option>replaced</option><option>repaired</option><option>inspected</option></select></label>
        <label style={{ alignContent: 'end' }}><span><input type="checkbox" name="closed" style={{ width: 'auto' }} /> Closed</span></label>
      </div><button>Save work order</button><p role="status">{message}</p></form>
    </section>
    <section className="card results"><h2>Recent work orders</h2>
      <DataTable rows={data?.logs.data ?? []} columns={[['registration', 'Aircraft'], ['checkType', 'Check'], ['openedAt', 'Opened', r => ist(String(r.openedAt))],
        ['closedAt', 'Status', r => r.closedAt ? <span className="pill good">closed</span> : <span className="pill warn">open</span>],
        ['findings', 'Findings', r => (r.findings as Row[]).map(x => `${x.ata} ${x.description} (${x.severity})`).join('; ')], ['aogHours', 'AOG h']]} />
    </section>
  </>;
}
