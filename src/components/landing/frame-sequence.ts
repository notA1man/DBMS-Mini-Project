// Scroll-scrubbed image sequence: the takeoff video pre-extracted to WebP frames
// (public/flight/{d,m}/NNN.webp). Seeking an <video> on scroll is choppy, drawing
// decoded frames to a canvas is not.

export type FrameSet = { base: string; count: number };

export const FRAME_SETS: Record<"desktop" | "mobile", FrameSet> = {
  desktop: { base: "/flight/d", count: 240 }, // 1920×1080 (Real-ESRGAN x4plus from 720p, scripts/upscale-flight-frames.sh), 24 fps
  mobile: { base: "/flight/m", count: 120 }, //  960×540, 12 fps
};

export class FrameSequence {
  readonly count: number;
  private readonly base: string;
  private readonly imgs: (HTMLImageElement | null)[];
  private cancelled = false;

  constructor(set: FrameSet) {
    this.base = set.base;
    this.count = set.count;
    this.imgs = new Array(set.count).fill(null);
  }

  url(i: number) {
    return `${this.base}/${String(i).padStart(3, "0")}.webp`;
  }

  /** Takeoff frames first, plus a coarse pass over the whole clip so any scroll position has something to show. */
  priorityOrder(): { first: number[]; rest: number[] } {
    const takeoff = Math.round(this.count * 0.32);
    const stride = Math.max(2, Math.round(this.count / 30));
    const first = new Set<number>();
    for (let i = 0; i < takeoff; i++) first.add(i);
    for (let i = 0; i < this.count; i += stride) first.add(i);
    first.add(this.count - 1);
    const rest: number[] = [];
    for (let i = 0; i < this.count; i++) if (!first.has(i)) rest.push(i);
    return { first: [...first], rest };
  }

  async load(order: number[], onEach?: (done: number, total: number) => void, concurrency = 6) {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (!this.cancelled && next < order.length) {
        const i = order[next++];
        const img = new Image();
        img.decoding = "async";
        img.src = this.url(i);
        try {
          await img.decode();
          this.imgs[i] = img;
        } catch {
          /* skip a bad frame; nearest() falls back to a neighbour */
        }
        done++;
        onEach?.(done, order.length);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /** Closest decoded frame to index i (searching outward). */
  nearest(i: number): HTMLImageElement | null {
    const n = this.count;
    i = Math.max(0, Math.min(n - 1, i));
    for (let d = 0; d < n; d++) {
      const a = this.imgs[i - d];
      if (a) return a;
      const b = this.imgs[i + d];
      if (b) return b;
    }
    return null;
  }

  cancel() {
    this.cancelled = true;
  }
}

/** Draw an image with object-fit: cover semantics. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  w: number,
  h: number,
  alpha = 1,
) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}
