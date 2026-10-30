// Dotted globe with great-circle flight arcs, drawn with the plain Canvas 2D API
// (orthographic projection, no WebGL / three.js).

import { AIRPORT_BY_CODE, FEATURED_ROUTES } from "@/lib/airports";
import landMask from "../../../public/flight/land.json";

const RAD = Math.PI / 180;

type Vec3 = [number, number, number];
type Arc = { pts: Vec3[]; lift: number[]; delay: number };

function toVec(lat: number, lon: number): Vec3 {
  const p = lat * RAD;
  const l = lon * RAD;
  return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
}

const ACCENT = "255,181,71";
const INK = "214,226,245";

export class GlobeRenderer {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private dots: Float32Array = new Float32Array(0); // x,y,z unit vectors
  private arcs: Arc[] = [];
  private airports: { v: Vec3; hub: boolean }[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;

    const SEG = 64;
    FEATURED_ROUTES.forEach(([a, b], idx) => {
      const A = AIRPORT_BY_CODE[a];
      const B = AIRPORT_BY_CODE[b];
      if (!A || !B) return;
      const va = toVec(A.lat, A.lon);
      const vb = toVec(B.lat, B.lon);
      const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
      const om = Math.acos(dot);
      const so = Math.sin(om) || 1;
      // A small bulge reads as altitude. Anything taller lifts the far side off the disc.
      const height = 0.015 + 0.05 * (om / Math.PI);
      const pts: Vec3[] = [];
      const lift: number[] = [];
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG;
        const k1 = Math.sin((1 - t) * om) / so;
        const k2 = Math.sin(t * om) / so;
        pts.push([va[0] * k1 + vb[0] * k2, va[1] * k1 + vb[1] * k2, va[2] * k1 + vb[2] * k2]);
        lift.push(1 + height * Math.sin(Math.PI * t));
      }
      this.arcs.push({ pts, lift, delay: (idx % 9) / 9 });
    });
    const seen = new Set<string>();
    FEATURED_ROUTES.flat().forEach((c) => {
      if (seen.has(c) || !AIRPORT_BY_CODE[c]) return;
      seen.add(c);
      const a = AIRPORT_BY_CODE[c];
      this.airports.push({ v: toVec(a.lat, a.lon), hub: !!a.hub });
    });
    this.setLand(landMask);
  }

  setLand(latLon: number[]) {
    const n = latLon.length / 2;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = toVec(latLon[i * 2], latLon[i * 2 + 1]);
      out[i * 3] = v[0];
      out[i * 3 + 1] = v[1];
      out[i * 3 + 2] = v[2];
    }
    this.dots = out;
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  /**
   * @param lon0,lat0 view centre in degrees
   * @param draw 0..1 how much of the route network has been drawn
   * @param time seconds, for the travelling pulses
   */
  render(opts: { cx: number; cy: number; r: number; lon0: number; lat0: number; draw: number; time: number }) {
    const { ctx, dpr } = this;
    const { cx, cy, r, draw, time } = opts;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    // view rotation: world vector -> (x right, y up, z towards viewer)
    const l0 = opts.lon0 * RAD;
    const p0 = opts.lat0 * RAD;
    const cl = Math.cos(l0), sl = Math.sin(l0), cp = Math.cos(p0), sp = Math.sin(p0);
    const proj = (v: Vec3 | Float32Array, o = 0): Vec3 => {
      const x0 = v[o], y0 = v[o + 1], z0 = v[o + 2];
      // rotate around z by -lon0
      const xr = x0 * cl + y0 * sl;
      const yr = -x0 * sl + y0 * cl;
      // tilt around y by lat0
      const depth = xr * cp + z0 * sp;
      const up = -xr * sp + z0 * cp;
      return [yr, up, depth];
    };

    // atmosphere
    const glow = ctx.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.35);
    glow.addColorStop(0, "rgba(90,140,220,0.20)");
    glow.addColorStop(1, "rgba(90,140,220,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.35, 0, Math.PI * 2);
    ctx.fill();

    // body
    const body = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
    body.addColorStop(0, "#0d1626");
    body.addColorStop(1, "#05080f");
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(140,175,230,0.18)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // land dots
    const d = this.dots;
    const s = Math.max(1, r / 260);
    for (let i = 0; i < d.length; i += 3) {
      const [x, y, z] = proj(d, i);
      if (z < -0.05) continue;
      const a = z > 0 ? 0.25 + 0.65 * z : 0.04;
      ctx.fillStyle = `rgba(${INK},${a.toFixed(3)})`;
      ctx.fillRect(cx + x * r - s / 2, cy - y * r - s / 2, s * 1.4, s * 1.4);
    }

    // arcs
    ctx.lineCap = "round";
    for (const arc of this.arcs) {
      const local = Math.min(1, Math.max(0, (draw - arc.delay * 0.55) / 0.45));
      if (local <= 0) continue;
      const end = Math.max(1, Math.floor(local * (arc.pts.length - 1)));
      let prev: [number, number, boolean] | null = null;
      for (let i = 0; i <= end; i++) {
        const [x, y, z] = proj(arc.pts[i]);
        const k = arc.lift[i];
        const sx = cx + x * r * k;
        const sy = cy - y * r * k;
        // Front hemisphere only, and only while the lifted point is still inside the disc.
        const visible = z > 0.02 && x * x * k * k + y * y * k * k <= 1.02;
        if (prev && prev[2] && visible) {
          const t = i / end;
          ctx.strokeStyle = `rgba(${INK},${(0.12 + 0.5 * t * local).toFixed(3)})`;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(prev[0], prev[1]);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
        prev = [sx, sy, visible];
      }
      // head while drawing, travelling pulse once drawn
      const headIdx = local < 1 ? end : Math.floor(((time * 0.18 + arc.delay) % 1) * (arc.pts.length - 1));
      const [hx, hy, hz] = proj(arc.pts[headIdx]);
      const hk = arc.lift[headIdx];
      if (hz > 0.02 && hx * hx * hk * hk + hy * hy * hk * hk <= 1.02) {
        const px = cx + hx * r * hk;
        const py = cy - hy * r * hk;
        const g = ctx.createRadialGradient(px, py, 0, px, py, 7);
        g.addColorStop(0, `rgba(${ACCENT},0.95)`);
        g.addColorStop(1, `rgba(${ACCENT},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // airports
    for (const ap of this.airports) {
      const [x, y, z] = proj(ap.v);
      if (z <= 0) continue;
      const px = cx + x * r;
      const py = cy - y * r;
      if (ap.hub) {
        const pulse = (time * 0.6) % 1;
        ctx.strokeStyle = `rgba(${ACCENT},${(0.6 * (1 - pulse)).toFixed(3)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(px, py, 3 + pulse * 10, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgb(${ACCENT})`;
      } else {
        ctx.fillStyle = `rgba(${INK},${(0.5 + 0.5 * z).toFixed(3)})`;
      }
      ctx.beginPath();
      ctx.arc(px, py, ap.hub ? 2.6 : 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
