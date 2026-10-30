"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BoardingPass } from "./BoardingPass";
import { FRAME_SETS, FrameSequence, drawCover } from "./frame-sequence";
import { GlobeRenderer } from "./globe";
import styles from "./landing.module.css";

const BRAND = "SKYOPS";
const VIDEO_SECONDS = 10;
const HERO_HOLD = 0.05; // share of the flight track that holds frame 0 under the hero

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const range = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** fade in over [a,b], hold, fade out over [c,d] */
const window4 = (v: number, a: number, b: number, c: number, d: number) =>
  Math.min(range(v, a, b), 1 - range(v, c, d));

const FRAGMENTS = [
  { idx: "01", tag: "SEARCH", text: "Search 400+ routes.", t: [2.3, 2.9, 4.1, 4.7], side: "left" },
  { idx: "02", tag: "SEATS", text: "Real-time seat maps.", t: [5.0, 5.6, 6.9, 7.5], side: "right" },
  { idx: "03", tag: "BOARD", text: "One tap to board.", t: [8.2, 8.9, 99, 100], side: "left" },
] as const;

const STATS = [
  { value: 412, label: "ROUTES" },
  { value: 186, label: "AIRPORTS" },
  { value: 1240, label: "DAILY FLIGHTS" },
];

const RAIL = [
  { at: 0, label: "TO" },
  { at: 0.3, label: "CLB" },
  { at: 0.55, label: "CRZ" },
  { at: 0.78, label: "BRD" },
  { at: 1, label: "ARR" },
];

export default function Landing() {
  const [ready, setReady] = useState(false);
  const [pct, setPct] = useState(0);

  const root = useRef<HTMLDivElement>(null);
  const videoCanvas = useRef<HTMLCanvasElement>(null);
  const globeCanvas = useRef<HTMLCanvasElement>(null);
  const flightTrack = useRef<HTMLDivElement>(null);
  const globeTrack = useRef<HTMLDivElement>(null);
  const passSection = useRef<HTMLElement>(null);
  const footer = useRef<HTMLElement>(null);
  const hero = useRef<HTMLDivElement>(null);
  const fragments = useRef<(HTMLDivElement | null)[]>([]);
  const stats = useRef<HTMLDivElement>(null);
  const statNums = useRef<(HTMLSpanElement | null)[]>([]);
  const shade = useRef<HTMLDivElement>(null);
  const dawn = useRef<HTMLDivElement>(null);
  const pass = useRef<HTMLDivElement>(null);
  const magnet = useRef<HTMLButtonElement>(null);
  const hud = {
    alt: useRef<HTMLSpanElement>(null),
    kts: useRef<HTMLSpanElement>(null),
    hdg: useRef<HTMLSpanElement>(null),
    phase: useRef<HTMLSpanElement>(null),
    rail: useRef<HTMLSpanElement>(null),
    clock: useRef<HTMLSpanElement>(null),
  };
  const hudRefs = useRef(hud).current;

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mobile = window.matchMedia("(max-width: 768px)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;

    const seq = new FrameSequence(mobile ? FRAME_SETS.mobile : FRAME_SETS.desktop);
    const vCanvas = videoCanvas.current!;
    const vctx = vCanvas.getContext("2d", { alpha: false })!;
    const globe = new GlobeRenderer(globeCanvas.current!);

    let vw = 0, vh = 0, dpr = 1;
    let flightLen = 1, globeStart = 0, globeLen = 1, passTop = 0, footerTop = 0, maxScroll = 1;
    let smooth = window.scrollY;
    let lastFrame = -1;
    let raf = 0;
    let alive = true;

    const measure = () => {
      vw = window.innerWidth;
      vh = window.innerHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      vCanvas.width = Math.round(vw * dpr);
      vCanvas.height = Math.round(vh * dpr);
      // resizing resets context state
      vctx.imageSmoothingEnabled = true;
      vctx.imageSmoothingQuality = "high";
      globe.resize(vw, vh, Math.min(window.devicePixelRatio || 1, 2));
      flightLen = flightTrack.current!.offsetHeight;
      globeStart = globeTrack.current!.offsetTop;
      globeLen = Math.max(1, globeTrack.current!.offsetHeight - vh);
      passTop = passSection.current!.offsetTop;
      footerTop = footer.current!.offsetTop;
      maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
      lastFrame = -1;
    };

    // ---- preload: takeoff frames first ------------------------------------
    const { first, rest } = seq.priorityOrder();
    const unlock = () => {
      if (!alive) return;
      setReady(true);
      document.documentElement.classList.remove(styles.locked);
    };
    document.documentElement.classList.add(styles.locked);
    const failsafe = window.setTimeout(unlock, 9000);
    seq
      .load(first, (d, t) => setPct(Math.round((d / t) * 100)))
      .then(() => {
        window.clearTimeout(failsafe);
        lastFrame = -1;
        unlock();
        return seq.load(rest, () => (lastFrame = -1), 4);
      });

    // ---- magnetic CTA ------------------------------------------------------
    const onMove = (e: PointerEvent) => {
      const btn = magnet.current;
      if (btn && !reduced) {
        const r = btn.getBoundingClientRect();
        const mx = r.left + r.width / 2, my = r.top + r.height / 2;
        const dx = e.clientX - mx, dy = e.clientY - my;
        const near = Math.abs(dx) < r.width * 0.9 && Math.abs(dy) < r.height * 1.6;
        btn.style.transform = near ? `translate(${dx * 0.25}px, ${dy * 0.35}px)` : "";
      }
    };
    if (finePointer && !reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
    }

    // ---- per-frame update ---------------------------------------------------
    const t0 = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const time = (now - t0) / 1000;
      const target = window.scrollY;
      smooth = reduced ? target : lerp(smooth, target, 0.14);
      if (Math.abs(smooth - target) < 0.2) smooth = target;
      const y = smooth;

      // ---------- flight (video) ----------
      const fTrack = clamp(y / flightLen);
      const f = range(fTrack, HERO_HOLD, 1);
      const sec = f * VIDEO_SECONDS;
      const fi = f * (seq.count - 1);
      // One whole frame at a time: blending neighbours ghosts the image (reads as blur).
      const frame = Math.round(fi);
      if (frame !== lastFrame) {
        const img = seq.nearest(frame);
        if (img) {
          drawCover(vctx, img, vCanvas.width, vCanvas.height);
          lastFrame = frame;
        }
      }

      // hero out
      const heroOut = range(fTrack, 0, HERO_HOLD + 0.05);
      if (hero.current) {
        hero.current.style.opacity = String(1 - heroOut);
        hero.current.style.transform = `translate3d(0, ${-heroOut * 12}vh, 0)`;
      }

      // ---------- globe ----------
      const g = (y - globeStart) / globeLen; // may be <0 or >1
      const gIn = range(g, 0.1, 0.38);
      const pIn = range(y, passTop - vh, passTop - vh * 0.1);
      const fIn = range(y, footerTop - vh, maxScroll);

      // video zooms toward the sun and dissolves into night
      const vOut = range(g, -0.06, 0.26);
      vCanvas.style.opacity = String(1 - ease(vOut));
      // no transform at rest, so the canvas is never resampled by the compositor
      vCanvas.style.transform = vOut > 0 ? `scale(${1 + ease(vOut) * 0.22})` : "none";
      if (shade.current) shade.current.style.opacity = String(0.55 + 0.45 * ease(vOut));

      const gc = globeCanvas.current!;
      const globeOpacity = ease(gIn) * (1 - 0.72 * ease(pIn)) * (1 - 0.6 * fIn);
      gc.style.opacity = String(globeOpacity);
      if (globeOpacity > 0.001) {
        const desktop = vw > 900;
        const r = (desktop ? Math.min(vw * 0.3, vh * 0.4) : Math.min(vw * 0.42, vh * 0.27)) * lerp(0.82, 1, easeOut(gIn)) * (1 + 0.15 * ease(pIn));
        const cx = desktop ? lerp(vw * 0.62, vw * 0.5, ease(pIn)) : vw / 2;
        const cy = (desktop ? vh * 0.52 : vh * 0.42) - ease(pIn) * vh * 0.12;
        globe.render({
          cx,
          cy,
          r,
          lon0: 62 + clamp(g, 0, 1.4) * 34 + (reduced ? 0 : time * 1.6),
          lat0: lerp(8, 22, clamp(g)),
          draw: reduced ? 1 : range(g, 0.15, 0.8),
          time: reduced ? 0 : time,
        });
      }
      if (stats.current) {
        const so = window4(g, 0.22, 0.4, 0.95, 1.1) * (1 - pIn);
        stats.current.style.opacity = String(so);
        stats.current.style.transform = `translate3d(0, ${(1 - easeOut(range(g, 0.22, 0.45))) * 30}px, 0)`;
        const count = easeOut(range(g, 0.3, 0.75));
        STATS.forEach((s, i) => {
          const el = statNums.current[i];
          if (el) el.textContent = Math.round(s.value * (reduced ? 1 : count)).toLocaleString("en-IN");
        });
      }

      // fragments
      FRAGMENTS.forEach((fr, i) => {
        const el = fragments.current[i];
        if (!el) return;
        let o = window4(sec, fr.t[0], fr.t[1], fr.t[2], fr.t[3]);
        if (i === FRAGMENTS.length - 1) o *= 1 - range(g, -0.02, 0.12);
        if (fTrack <= HERO_HOLD) o = 0;
        el.style.opacity = String(o);
        el.style.setProperty("--reveal", String(easeOut(o)));
      });

      // pass assembly
      if (pass.current) {
        const pp = reduced ? 1 : range(y, passTop - vh * 0.9, passTop - vh * 0.05);
        pass.current.querySelectorAll<HTMLElement>("[data-piece]").forEach((el) => {
          const delay = el.dataset.piece === "main" ? 0 : el.dataset.piece === "perf" ? 0.25 : 0.12;
          el.style.setProperty("--a", String(easeOut(range(pp, delay, delay + 0.75))));
        });
      }

      if (dawn.current) dawn.current.style.opacity = String(ease(fIn));

      // ---------- HUD ----------
      let alt: number, kts: number, hdg: number, phase: string;
      if (y < globeStart) {
        kts = sec < 3 ? Math.pow(sec / 3, 1.3) * 165 : 165 + ((sec - 3) / 7) * 115;
        alt = sec < 3 ? 0 : Math.pow((sec - 3) / 7, 1.4) * 9800;
        hdg = 274 + (sec > 3.4 ? Math.sin((sec - 3.4) * 0.8) * 3 : 0);
        phase =
          fTrack <= HERO_HOLD ? "HOLDING · RWY 27" :
          sec < 2.6 ? "TAKEOFF ROLL" :
          sec < 3.5 ? "ROTATE" :
          sec < 5.4 ? "CLIMB" :
          sec < 8.3 ? "IN CLOUD" : "CLOUD BREAK";
      } else if (fIn <= 0) {
        const c = ease(clamp(g / 0.9));
        alt = lerp(9800, 37000, c);
        kts = lerp(280, 488, c);
        hdg = (274 + clamp(g, 0, 1.4) * 34 * 1.8 + 360) % 360;
        phase = pIn > 0.4 ? "CRUISE · CHECK-IN" : c > 0.98 ? "CRUISE · FL370" : "CLIMB";
      } else {
        const d = ease(fIn);
        alt = lerp(37000, 0, d);
        kts = fIn > 0.98 ? 0 : lerp(488, 140, d);
        hdg = 274;
        phase = fIn > 0.98 ? "ARRIVED" : "DESCENT";
      }
      const pad = (n: number, l: number) => String(Math.max(0, Math.round(n))).padStart(l, "0");
      if (hudRefs.alt.current) hudRefs.alt.current.textContent = pad(alt, 5);
      if (hudRefs.kts.current) hudRefs.kts.current.textContent = pad(kts, 3);
      if (hudRefs.hdg.current) hudRefs.hdg.current.textContent = pad(hdg, 3);
      if (hudRefs.phase.current && hudRefs.phase.current.textContent !== phase) hudRefs.phase.current.textContent = phase;
      const prog = clamp(y / maxScroll);
      if (hudRefs.rail.current) hudRefs.rail.current.style.transform = `scaleY(${prog})`;
      if (hudRefs.clock.current) {
        const s = Math.round(prog * 2 * 3600 + 49 * 60); // flight-time readout, cosmetic
        hudRefs.clock.current.textContent = `T+${pad(Math.floor(s / 3600), 2)}:${pad((s / 60) % 60, 2)}`;
      }

    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    window.addEventListener("resize", measure);
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      seq.cancel();
      ro.disconnect();
      window.clearTimeout(failsafe);
      window.removeEventListener("resize", measure);
      window.removeEventListener("pointermove", onMove);
      document.documentElement.classList.remove(styles.locked);
    };
  }, [hudRefs]);

  return (
    <div ref={root} className={`${styles.root} ${ready ? styles.ready : ""}`} data-landing>
      {/* ---------------- fixed stage ---------------- */}
      <div className={styles.stage} aria-hidden>
        <canvas ref={videoCanvas} className={styles.video} />
        <canvas ref={globeCanvas} className={styles.globe} />
        <div ref={shade} className={styles.shade} />
        <div ref={dawn} className={styles.dawn} />
        <div className={styles.vignette} />
        <div className={styles.grain} />
      </div>

      <div className={styles.overlay}>
        <div ref={hero} className={styles.hero}>
          <p className={styles.heroKicker}>AIRLINE OPERATIONS &amp; TICKETING</p>
          <h1 className={styles.wordmark} aria-label={BRAND}>
            {BRAND.split("").map((ch, i) => (
              <span key={i} className={styles.letterMask} aria-hidden>
                <span className={styles.letter} style={{ "--i": i } as React.CSSProperties}>
                  {ch}
                </span>
              </span>
            ))}
          </h1>
          <p className={styles.tagline}>
            Book the sky<span className={styles.accent}>.</span>
          </p>
          <div className={styles.cue}>
            <span>SCROLL TO TAKE OFF</span>
            <i />
          </div>
        </div>

        {FRAGMENTS.map((fr, i) => (
          <div
            key={fr.idx}
            ref={(el) => {
              fragments.current[i] = el;
            }}
            className={`${styles.fragment} ${fr.side === "right" ? styles.fragmentRight : ""}`}
          >
            <span className={styles.fragmentTag}>
              {fr.idx} / {fr.tag}
            </span>
            <p className={styles.fragmentText}>{fr.text}</p>
          </div>
        ))}

        <div ref={stats} className={styles.stats}>
          <p className={styles.statsKicker}>NETWORK · LIVE GRAPH</p>
          <h2 className={styles.statsTitle}>
            Every route.
            <br />
            One graph.
          </h2>
          <dl className={styles.statsList}>
            {STATS.map((s, i) => (
              <div key={s.label}>
                <dd
                  ref={(el) => {
                    statNums.current[i] = el;
                  }}
                >
                  0
                </dd>
                <dt>{s.label}</dt>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {/* ---------------- chrome ---------------- */}
      <header className={styles.nav}>
        <Link href="/" className={styles.navBrand} prefetch={false}>
          <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden>
            <path d="M10 1 L19 10 L10 19 L1 10 Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="10" cy="10" r="2.2" fill="currentColor" />
          </svg>
          {BRAND}
        </Link>
        <nav className={styles.navLinks}>
          <Link href="/search" prefetch={false}>Flights</Link>
          <Link href="/board" prefetch={false}>Live board</Link>
          <Link href="/login" prefetch={false} className={styles.navSignin}>Sign in</Link>
        </nav>
      </header>

      <div className={styles.hud} aria-hidden>
        <div className={styles.hudCell}>
          <span className={styles.hudK}>ALT</span>
          <span ref={hudRefs.alt} className={styles.hudV}>00000</span>
          <span className={styles.hudU}>FT</span>
        </div>
        <div className={styles.hudCell}>
          <span className={styles.hudK}>KTS</span>
          <span ref={hudRefs.kts} className={styles.hudV}>000</span>
        </div>
        <div className={`${styles.hudCell} ${styles.hudHideSm}`}>
          <span className={styles.hudK}>HDG</span>
          <span ref={hudRefs.hdg} className={styles.hudV}>274</span>
          <span className={styles.hudU}>°</span>
        </div>
        <div className={`${styles.hudCell} ${styles.hudPhase}`}>
          <i className={styles.hudDot} />
          <span ref={hudRefs.phase}>HOLDING · RWY 27</span>
        </div>
      </div>

      <div className={styles.rail} aria-hidden>
        <span ref={hudRefs.clock} className={styles.railClock}>T+00:49</span>
        <div className={styles.railTrack}>
          <span ref={hudRefs.rail} className={styles.railFill} />
          {RAIL.map((r) => (
            <span key={r.label} className={styles.railTick} style={{ top: `${r.at * 100}%` }}>
              {r.label}
            </span>
          ))}
        </div>
      </div>

      <div className={styles.loader} aria-live="polite">
        <div className={styles.loaderInner}>
          <span className={styles.loaderBrand}>{BRAND}</span>
          <span>
            PREPARING FLIGHT <b>{String(pct).padStart(3, "0")}%</b>
          </span>
          <span className={styles.loaderBar}>
            <i style={{ transform: `scaleX(${pct / 100})` }} />
          </span>
        </div>
      </div>

      {/* ---------------- scroll tracks ---------------- */}
      <main className={styles.tracks}>
        <div ref={flightTrack} className={styles.flightTrack}>
          <span className={styles.snap} style={{ top: 0 }} />
          <span className={styles.snap} style={{ top: "30%" }} />
          <span className={styles.snap} style={{ top: "58%" }} />
          <span className={styles.snap} style={{ top: "86%" }} />
        </div>
        <div ref={globeTrack} className={styles.globeTrack}>
          <span className={styles.snap} style={{ top: "40%" }} />
        </div>

        <section ref={passSection} className={styles.passSection} aria-labelledby="pass-title">
          <span className={styles.snap} style={{ top: 0 }} />
          <div className={styles.passHead}>
            <p className={styles.statsKicker}>CHECK-IN</p>
            <h2 id="pass-title" className={styles.passTitle}>
              Where to?
            </h2>
          </div>
          <BoardingPass ref={pass} magnetRef={magnet} />
        </section>

        <footer ref={footer} className={styles.footer}>
          <span className={styles.snap} style={{ bottom: 0, top: "auto" }} />
          <div className={styles.footerGrid}>
            <div>
              <p className={styles.footerWord}>{BRAND}</p>
              <p className={styles.footerNote}>
                Disruption-aware airline operations &amp; ticketing.
                <br />
                PostgreSQL · Neo4j · MongoDB · pgvector
              </p>
            </div>
            <nav className={styles.footerCols} aria-label="Footer">
              <div>
                <span>FLY</span>
                <Link href="/search" prefetch={false}>Flight search</Link>
                <Link href="/board" prefetch={false}>Live departures</Link>
                <Link href="/policies" prefetch={false}>Policy assistant</Link>
              </div>
              <div>
                <span>STAFF</span>
                <Link href="/ops" prefetch={false}>Ops console</Link>
                <Link href="/crew" prefetch={false}>Crew portal</Link>
                <Link href="/admin" prefetch={false}>Admin</Link>
              </div>
              <div>
                <span>PROJECT</span>
                <Link href="/showcase" prefetch={false}>DB showcase</Link>
                <Link href="/api/health" prefetch={false}>System health</Link>
              </div>
            </nav>
          </div>
          <div className={styles.footerBase}>
            <span>DBMS MINI PROJECT · PES UNIVERSITY · 2026</span>
            <span>AIMAN A NAWAB · ADITYA VATS</span>
            <span>ALT 00000 FT · ARRIVED</span>
          </div>
        </footer>
      </main>
    </div>
  );
}
