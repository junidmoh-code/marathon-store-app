// ─── MISSING PRODUCTS — WORKING OUT THE ROWS WITHOUT FREEZING THE PHONE ──────
// Junid, 22 Nov 2026. Every card is asked "what would a solve send?" BEFORE it
// is drawn (missingListCore.js). Across two divisions that is a few thousand
// plans — too much for one render on an iPhone, and it must not be redone on
// every stock tick of a trading day.
//
// So the rows are built in short slices, the list being looked at first:
//   • a bucket is one list (a division's sneakers, or its clothing);
//   • the first pass starts at once; later passes wait for the data to settle
//     (QUIET_MS) and never interrupt a pass that is running;
//   • a row whose content has not changed keeps its object, so its card does
//     not re-render and nothing on screen moves;
//   • results from the pass before stay up until the new pass replaces them —
//     a count never drops to zero and climbs back.
//
// It decides nothing: `build(card)` is the screen's, and returns a row or null.
import { useEffect, useRef, useState } from "react";

const SLICE_MS = 10;
// After a change, the next pass starts within this — a THROTTLE, not a
// debounce: a stock tick every second on a trading day must never hold the
// rows back (Sonnet architect review, PR #964).
const QUIET_MS = 1500;
const PAINT_MS = 100;   // the list is repainted at most this often while a pass runs
const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

// What makes two rows "the same card" on screen.
const signature = (r) => (r ? `${r.name}|${r.photo}|${r.source}|${r.sourceName}|${r.stock}|${r.twin}|${r.needsPolicy ? "np" : ""}|${r.dests.map((d) => `${d.id}:${d.name}:${d.ok ? d.sizes.join(",") : "-"}:${d.units}`).join(";")}` : "");

/**
 * buckets  [{ id, cards, build }]  — cards in the order the list opens in
 * active   the id of the list on screen (built first)
 * version  any value that changes when the inputs change
 * ready    false until every input has loaded — nothing is built before then
 *
 * Returns { rows: { id: row[] }, started: { id: bool }, complete: { id: bool } }.
 */
export function useSlicedRows({ buckets, active, version, ready }) {
  const latest = useRef({ buckets, active });
  latest.current = { buckets, active };
  const store = useRef({ results: {}, started: {}, complete: {}, running: false, ranVersion: null, wantVersion: null, timer: null, alive: true });
  const [, bump] = useState(0);

  useEffect(() => {
    const s = store.current;
    s.alive = true;
    // Unmount (or StrictMode's rehearsal) stops a pass outright, so a remount
    // starts a clean one rather than waiting on a pass that will never finish.
    return () => { s.alive = false; clearTimeout(s.timer); s.timer = null; s.running = false; };
  }, []);

  useEffect(() => {
    const s = store.current;
    if (!ready) { clearTimeout(s.timer); s.timer = null; return; }   // never a pass on half-loaded inputs
    s.wantVersion = version;
    const runPass = () => {
      if (s.running || !s.alive) return;
      s.running = true;
      s.ranVersion = s.wantVersion;
      const snap = latest.current.buckets.map((b) => ({ id: b.id, cards: b.cards, i: 0 }));
      const slice = () => {
        s.timer = null;   // this callback IS the pending timer — a finished pass leaves none (CodeRabbit, PR #964)
        if (!s.alive) return;
        const until = now() + SLICE_MS;
        for (;;) {
          const act = latest.current.active;
          const job = snap.find((j) => j.id === act && j.i < j.cards.length) || snap.find((j) => j.i < j.cards.length);
          if (!job) break;
          const bucket = latest.current.buckets.find((b) => b.id === job.id);
          const res = (s.results[job.id] ||= new Map());
          s.started[job.id] = true;
          // A handful per check of the clock.
          for (let n = 0; n < 8 && job.i < job.cards.length; n++, job.i++) {
            const card = job.cards[job.i];
            let row = null;
            try { row = bucket ? bucket.build(card) : null; } catch { row = null; }
            const prev = res.get(card.pid);
            res.set(card.pid, row && prev && signature(prev) === signature(row) ? Object.assign(prev, { card: row.card }) : row);
          }
          if (now() >= until) break;
        }
        const left = snap.some((j) => j.i < j.cards.length);
        // A bucket whose cards are all built is complete; products that are no
        // longer cards at all drop out of its results.
        for (const j of snap) {
          if (j.i < j.cards.length) continue;
          if (!s.complete[j.id] || !left) {
            const keep = new Set(j.cards.map((c) => c.pid));
            const res = (s.results[j.id] ||= new Map());
            for (const pid of [...res.keys()]) if (!keep.has(pid)) res.delete(pid);
          }
          s.started[j.id] = true;
          s.complete[j.id] = true;
        }
        const t = now();
        const finished = snap.some((j) => j.i >= j.cards.length && !j.painted);
        for (const j of snap) if (j.i >= j.cards.length) j.painted = true;
        if (!left || finished || t - (s.paintedAt || 0) >= PAINT_MS) { s.paintedAt = t; bump((n) => n + 1); }
        if (left) { s.timer = setTimeout(slice, 0); return; }
        s.running = false;
        // The data moved while this pass ran: one more, once it is quiet.
        if (s.wantVersion !== s.ranVersion) { s.timer = setTimeout(() => { s.timer = null; runPass(); }, QUIET_MS); }
      };
      slice();
    };
    if (s.running) return;                       // the running pass re-arms itself
    if (s.timer) return;                         // a pass is already due — never pushed back
    const first = !latest.current.buckets.every((b) => s.complete[b.id]);
    if (first) runPass(); else s.timer = setTimeout(() => { s.timer = null; runPass(); }, QUIET_MS);
  }, [version, ready]);

  const s = store.current;
  const rows = {};
  for (const b of buckets) {
    const res = s.results[b.id];
    rows[b.id] = res ? b.cards.map((c) => res.get(c.pid)).filter(Boolean) : [];
  }
  return { rows, started: { ...s.started }, complete: { ...s.complete } };
}
