// Page header used across the application: eyebrow, oversized title, optional lede and a row of
// instrument-style readouts (label over value), the same visual language as the landing HUD.
import type { ReactNode } from 'react';

export type Readout = [label: string, value: ReactNode, tone?: 'warn' | 'bad' | 'good'];

export function PageHead({ eyebrow, title, lede, readouts, aside }: { eyebrow: string; title: ReactNode; lede?: ReactNode;
  readouts?: Readout[]; aside?: ReactNode }) {
  return <header className="page-head">
    <div className="page-head-main">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {lede && <p className="lede">{lede}</p>}
    </div>
    {aside && <div className="page-head-aside">{aside}</div>}
    {readouts && readouts.length > 0 && <dl className="readouts">{readouts.map(([label, value, tone]) =>
      <div key={label} className={tone}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
  </header>;
}

/** Placeholder for an empty list or panel. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
