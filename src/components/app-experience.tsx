'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { FrameSequence, FRAME_SETS, drawCover } from './landing/frame-sequence';

/** Reuse the landing flight imagery, with a shorter scroll flight for application pages. */
export function AppAtmosphere() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const progress = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const surface = canvas.current!;
    const context = surface.getContext('2d', { alpha: false });
    if (!context) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sequence = new FrameSequence(matchMedia('(max-width:768px)').matches ? FRAME_SETS.mobile : FRAME_SETS.desktop);
    let pending = 0;
    let alive = true;
    const paint = () => {
      pending = 0;
      if (!alive) return;
      const ratio = Math.min(devicePixelRatio, 1.5);
      const width = Math.round(innerWidth * ratio), height = Math.round(innerHeight * ratio);
      if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
      const fraction = Math.min(1, scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight));
      const frame = sequence.nearest(reduced ? 0 : Math.round(fraction * (sequence.count - 1)));
      if (frame) drawCover(context, frame, width, height);
      if (progress.current) progress.current.style.transform = `scaleY(${fraction})`;
    };
    const update = () => { if (!pending) pending = requestAnimationFrame(paint); };
    // A coarse sequence keeps these shorter pages light; no animation loop while idle.
    const frames = reduced ? [0] : Array.from({length:32}, (_,i) => Math.round(i * (sequence.count - 1) / 31));
    void sequence.load(frames, update, 3);
    addEventListener('scroll', update, { passive:true });
    addEventListener('resize', update);
    paint();
    return () => { alive = false; sequence.cancel(); cancelAnimationFrame(pending); removeEventListener('scroll', update); removeEventListener('resize', update); };
  }, []);
  return <>
    <div className="app-atmosphere" aria-hidden="true"><canvas ref={canvas}/><div className="atmosphere-shade"/><div className="atmosphere-grain"/></div>
    <div className="app-flight-rail" aria-hidden="true"><span>DEP</span><div><i ref={progress}/></div><span>ARR</span></div>
  </>;
}

/** A route change replays the landing's masked title reveal and staggered content entrance. */
export function AppPage({ children }: { children:ReactNode }) {
  const pathname = usePathname();
  return <div key={pathname} className="app-page">{children}</div>;
}
