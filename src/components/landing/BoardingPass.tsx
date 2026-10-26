"use client";

import { forwardRef, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { AIRPORTS, AIRPORT_BY_CODE } from "@/lib/airports";
import styles from "./landing.module.css";

function todayISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

const iata = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use a 3-letter code")
  .refine((c) => c in AIRPORT_BY_CODE, "Not in our network");

// UX validation only — the database stays the authority on what can be booked.
const searchSchema = z
  .object({
    from: iata,
    to: iata,
    date: z.iso.date("Pick a date").refine((d) => d >= todayISO(), "Date is in the past"),
    pax: z.coerce.number().int().min(1).max(6),   // same limit as the search API
  })
  .refine((v) => v.from !== v.to, { path: ["to"], message: "Same as origin" });

type Field = "from" | "to" | "date" | "pax";

/** Deterministic barcode bars from a seed string. */
function bars(seed: string) {
  let h = 2166136261;
  const out: number[] = [];
  for (let i = 0; i < 64; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out.push(1 + (h % 4));
  }
  return out;
}

export const BoardingPass = forwardRef<HTMLDivElement, { magnetRef?: React.Ref<HTMLButtonElement> }>(
  function BoardingPass({ magnetRef }, ref) {
    const router = useRouter();
    const listId = useId();
    const [form, setForm] = useState({ from: "BLR", to: "DEL", date: "", pax: "1" });
    const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});

    const set = (k: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = k === "from" || k === "to" ? e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) : e.target.value;
      setForm((f) => ({ ...f, [k]: value }));
      setErrors((er) => ({ ...er, [k]: undefined }));
    };

    const caption = (code: string) => {
      if (code.length < 3) return "City or airport code";
      const a = AIRPORT_BY_CODE[code];
      return a ? `${a.city} · ${a.name}` : "Not in our network";
    };

    const barcode = useMemo(() => bars(`${form.from}${form.to}${form.date}${form.pax}`), [form]);

    const submit = (e: React.FormEvent) => {
      e.preventDefault();
      const parsed = searchSchema.safeParse(form);
      if (!parsed.success) {
        const next: Partial<Record<Field, string>> = {};
        for (const issue of parsed.error.issues) {
          const k = issue.path[0] as Field;
          if (!next[k]) next[k] = issue.message;
        }
        setErrors(next);
        return;
      }
      const q = new URLSearchParams({
        from: parsed.data.from,
        to: parsed.data.to,
        date: parsed.data.date,
        pax: String(parsed.data.pax),
      });
      router.push(`/search?${q}`);
    };

    const from = AIRPORT_BY_CODE[form.from];
    const to = AIRPORT_BY_CODE[form.to];

    return (
      <div ref={ref} className={styles.pass}>
        <datalist id={listId}>
          {AIRPORTS.map((a) => (
            <option key={a.code} value={a.code}>
              {a.city} — {a.name}
            </option>
          ))}
        </datalist>

        <form className={styles.passCard} onSubmit={submit} noValidate>
          <div className={`${styles.passMain} ${styles.piece}`} data-piece="main">
            <div className={styles.passTop}>
              <span>SKYOPS</span>
              <span>BOARDING PASS</span>
              <span className={styles.passTopDim}>ECONOMY · ANY FARE</span>
            </div>

            <div className={styles.passRoute}>
              <label className={styles.passField}>
                <span className={styles.passLabel}>FROM</span>
                <input
                  className={styles.passIata}
                  value={form.from}
                  onChange={set("from")}
                  list={listId}
                  aria-invalid={!!errors.from}
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                  aria-label="Origin airport code"
                />
                <span className={errors.from ? styles.passErr : styles.passCaption}>
                  {errors.from ?? caption(form.from)}
                </span>
              </label>

              <div className={styles.passPath} aria-hidden>
                <span />
                <svg viewBox="0 0 24 24" width="22" height="22">
                  <path
                    d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"
                    fill="currentColor"
                    transform="rotate(90 12 12)"
                  />
                </svg>
                <span />
              </div>

              <label className={styles.passField}>
                <span className={styles.passLabel}>TO</span>
                <input
                  className={styles.passIata}
                  value={form.to}
                  onChange={set("to")}
                  list={listId}
                  aria-invalid={!!errors.to}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Destination airport code"
                />
                <span className={errors.to ? styles.passErr : styles.passCaption}>
                  {errors.to ?? caption(form.to)}
                </span>
              </label>
            </div>

            <div className={styles.passMeta}>
              <label className={styles.passField}>
                <span className={styles.passLabel}>DATE</span>
                <input
                  type="date"
                  className={styles.passInput}
                  value={form.date}
                  min={todayISO()}
                  onChange={set("date")}
                  aria-invalid={!!errors.date}
                />
                {errors.date && <span className={styles.passErr}>{errors.date}</span>}
              </label>
              <label className={styles.passField}>
                <span className={styles.passLabel}>PASSENGERS</span>
                <select className={styles.passInput} value={form.pax} onChange={set("pax")}>
                  {Array.from({ length: 6 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {String(i + 1).padStart(2, "0")}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.passField}>
                <span className={styles.passLabel}>GATE</span>
                <span className={styles.passStatic}>—</span>
              </div>
              <div className={styles.passField}>
                <span className={styles.passLabel}>SEAT</span>
                <span className={styles.passStatic}>ANY</span>
              </div>
            </div>
          </div>

          <div className={`${styles.passPerf} ${styles.piece}`} data-piece="perf" aria-hidden />

          <div className={`${styles.passStub} ${styles.piece}`} data-piece="stub">
            <div className={styles.passTop}>
              <span>
                {form.from || "———"} → {form.to || "———"}
              </span>
            </div>
            <div className={styles.passStubCities}>
              <span>{from?.city ?? "—"}</span>
              <span>{to?.city ?? "—"}</span>
            </div>
            <div className={styles.barcode} aria-hidden>
              {barcode.map((w, i) => (
                <i key={i} style={{ width: w, opacity: i % 7 === 3 ? 0 : 1 }} />
              ))}
            </div>
            <button ref={magnetRef} type="submit" className={styles.cta} data-magnetic>
              <span>Find your flight</span>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" fill="none" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    );
  },
);
