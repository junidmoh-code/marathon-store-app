// ─── ARMING — EVERY PRODUCT EACH HUB IS HOLDING, SIDE BY SIDE ────────────────
//
// The third tab of the Engine Policy card. Categories says what the POLICY is,
// Seating says where ONE product sits, and neither can answer the question this
// screen exists for: which products has the engine made Hub 1 responsible for,
// which Hub 2, and where do those two answers overlap when they must not.
//
// ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
// Identification of products armed in the wrong place. Slides are deliberately
// split across the hubs and arming must never spread a product to both, so
// "armed at both hubs" is the primary defect class and sits at the top of the
// screen with its count on the header. Everything below it is the rest of the
// picture: armed where nothing is on the shelf, armed-then-switched-off, and
// the two full inventories.
//
// ── IT IS READ-ONLY, AND THAT IS A DESIGN DECISION ───────────────────────────
// No unarm button, no target edit, no bulk anything. Every change to a
// product's seating goes through the Seating tab, where the location's own
// numbers are on screen, the plan is previewed and the write is audited and
// reversible. A row here TAPS THROUGH to that — it identifies, and hands over.
//
// ── THE STANDING RULE OF THIS CARD APPLIES: NO PARAGRAPH ─────────────────────
// Numbers, labels, chips and controls. The explanations live in comments.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  armingIndex, sectionRows, BUCKET, BUCKET_ORDER, BUCKET_TITLE, BUCKET_OPEN_BY_DEFAULT,
  HUB1, HUB2, ARMING_HUBS, suppressed,
} from "./armingCore";
import { readArmingContext, resolveUndecided } from "./armingStore";
import { useLocations, useEngineConfigState } from "./useStock";
import { labelFor, allLocationIds } from "./locations";
import { PhotoThumb, PhotoLightbox, Badge, SizeFactChip, CHIP_GRID } from "./healthWidgets";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGhost, input } from "./ui";

// ── PAGED, NOT ALL AT ONCE ───────────────────────────────────────────────────
// Hub 2 alone holds over three thousand armed products. Rendering them is ~40
// DOM nodes each and a locked phone. The defect sections are small and open
// themselves; the two inventories open shut and grow a page at a time.
const PAGE = 60;

// The colour of a resolved target, by which source answered for it. Same
// vocabulary the Seating tab's SeatRow uses, so the two screens do not name the
// same fact two different ways.
const SOURCE_TONE = {
  explicit: BLUE_L,
  category_policy: GREEN,
  footwear_default: GREEN,
  subcategory_default: GREEN,
  default: GREEN,
};

export default function ArmingTab({ products, onOpenSeating }) {
  const registry = useLocations();
  // ── GATED ON `settled`, NOT ON A NON-NULL VALUE ────────────────────────────
  // Every armed answer on this screen is a function of the category policy. The
  // config arrives over its own subscription, and the four one-shot reads
  // usually win that race on a warm page — so gating only on the reads showed a
  // fully-rendered screen saying "Armed at both hubs: 0" while the policy was
  // still in flight. A clean, confident, wrong verdict on the one defect this
  // tab exists to surface.
  //
  // `settled` is the honest gate: it is true once the listener has answered at
  // ALL, including with nothing and including with an error, so an empty or
  // unreadable node degrades to a visible answer rather than a permanent
  // spinner. (Adversarial review, PR #601 — and usePathState's own header says
  // exactly this.)
  const { value: config, settled: configSettled, error: configError } = useEngineConfigState();
  const [ctx, setCtx] = useState(null);          // { stock, targets, bytes, readCount }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [photo, setPhoto] = useState("");
  const [open, setOpen] = useState(BUCKET_OPEN_BY_DEFAULT);
  const [shown, setShown] = useState({});        // per-section page size
  const [resolving, setResolving] = useState(null); // { done, total }

  // The products this tab has read from EVERY location, so their dead-size
  // answer is final. Held as state rather than inside ctx so folding a resolve
  // in is one setState and the index recomputes once.
  const [resolvedPids, setResolvedPids] = useState(() => new Set());

  // ── TWO SEQUENCES, NOT ONE ─────────────────────────────────────────────────
  // Refresh and the resolve pass are both long, both cancellable, and both
  // visible at the same time — so they need separate identities.
  //
  // THE BUG ONE SHARED COUNTER CAUSED. resolve() used to capture `seq.current`
  // and gate its `finally` on it. Press Refresh while a resolve is in flight and
  // load() bumps the counter, so when the resolve settles its finally no longer
  // matches — `resolving` is never cleared, and the "Read the other N" button
  // sits disabled showing a frozen progress count for the life of the tab. The
  // only way out was to leave the tab and come back. (Senior-architect review.)
  //
  // Now: `seq` is the READ's identity and `resolveSeq` is the resolve's, load()
  // retires any resolve in flight and clears the progress itself, and a resolve
  // applies only if BOTH are still current — its own, and the read it was
  // computed against.
  const seq = useRef(0);
  const resolveSeq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    // Retire an in-flight resolve and clear its progress HERE — the resolve
    // itself can no longer be trusted to, because it is about to find itself
    // stale.
    resolveSeq.current += 1;
    setResolving(null);
    setLoading(true); setError("");
    try {
      const next = await readArmingContext(ARMING_HUBS);
      if (mine !== seq.current) return;
      // A fresh read invalidates every resolve: the hub cells it is folded into
      // have been replaced, and keeping the set would mark products decided
      // against stock that is no longer in the context.
      setResolvedPids((prev) => (prev.size ? new Set() : prev));
      setCtx(next);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e?.message || String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const full = useMemo(
    () => (ctx && configSettled
      ? { products: byIdOf(products), stock: ctx.stock, targets: ctx.targets, config, resolvedPids }
      : null),
    [ctx, configSettled, products, config, resolvedPids],
  );

  const index = useMemo(
    () => (full ? armingIndex(full, Object.keys(full.products)) : null),
    [full],
  );

  // ── THE RESIDUE ────────────────────────────────────────────────────────────
  // Products whose arming turns on the engine's dead-size rule with stock this
  // tab does not hold. Settled with the SEATING TAB'S OWN read — one product,
  // one location at a time — over the locations not already in the context.
  // Never a whole node: that is the read this tab was built to avoid.
  // ── THE LOCATIONS A RESOLVE MUST COVER ─────────────────────────────────────
  // Memoised on a SIGNATURE, not on the registry object: usePath hands back a
  // fresh object whenever anything under /locations changes, and `resolve` is a
  // callback that depends on this list. (Same reasoning, and the same trap, as
  // SeatingTab's locSig.)
  const locSig = JSON.stringify(allLocationIds(registry).slice().sort());
  const otherLocations = useMemo(
    () => JSON.parse(locSig).filter((l) => !ARMING_HUBS.includes(l)),
    [locSig],
  );

  // A LOCATION APPEARING AFTER A RESOLVE INVALIDATES IT. resolvedPids means
  // "this product's stock has been read from EVERY location"; a registry that
  // grows makes that false without any read having failed, and the products
  // would go on reading as decided against a location nobody ever asked.
  // Registering a location is rare and this costs one re-derive when it
  // happens. (CodeRabbit, PR #601.)
  //
  // AND IT MUST RETIRE A RESOLVE IN FLIGHT, not merely clear the set. resolve()
  // gates on its own counters, which this effect does not touch — so a pass
  // that started against the OLD location list still landed and unioned its
  // pids back in AFTER the clear. The residue vanished and every one of those
  // products read as "stock read from every location" with the new location
  // never asked. Clearing and retiring are one act.
  // NO EXTRA GUARD: the [locSig] dependency IS the guard. An earlier version
  // carried a ref and an `if (ref.current === locSig) return`, and three
  // separate mutations to that pair survived the whole suite — because React
  // only re-runs the effect when the dep VALUE changes, so the ref could never
  // disagree with it. The one run it did suppress is the mount run, which is a
  // no-op by construction: nothing is in flight and the set is empty.
  useEffect(() => {
    resolveSeq.current += 1;
    setResolving(null);
    // Identity matters: a fresh empty Set re-runs the whole armingIndex pass —
    // 9,520 seatingAt calls on live — for no change.
    setResolvedPids((prev) => (prev.size ? new Set() : prev));
  }, [locSig]);

  const resolve = useCallback(async () => {
    if (!index || !index.undecided) return;
    const mine = ++resolveSeq.current;   // this resolve
    const readAt = seq.current;          // the read it is computed against
    const current = () => mine === resolveSeq.current && readAt === seq.current;
    setResolving({ done: 0, total: 0 });
    try {
      const pids = index.undecidedPids;
      setResolving({ done: 0, total: pids.length });
      const { stock, bytes, readCount } = await resolveUndecided(pids, otherLocations, {
        onProgress: (done, total) => { if (current()) setResolving({ done, total }); },
      });
      if (!current()) return;
      // THE BILL INCLUDES THIS. A screen that reports its own read cost and then
      // quietly leaves out a 1,472-request pass is not reporting its read cost.
      setCtx((c) => (c ? { ...c, stock: mergeStock(c.stock, stock),
        bytes: c.bytes + bytes, readCount: c.readCount + readCount } : c));
      // UNION, NOT REPLACE. A resolve proves ABSENCE as much as presence — a
      // product with no cells anywhere else merges nothing, and mergeStock
      // cannot carry a negative. Only this set remembers that we looked, so
      // replacing it would make every earlier pass's products undecided again.
      // A fresh load() clears it outright, which is correct: the hub cells it
      // was proved against have been replaced. (CodeRabbit, PR #601.)
      setResolvedPids((prev) => new Set([...prev, ...pids]));
    } catch (e) {
      if (current()) setError(e?.message || String(e));
    } finally {
      // Only if no NEWER resolve has taken over. A load() that retired this one
      // has already cleared the progress; clearing it again would wipe a fresh
      // resolve's count.
      if (mine === resolveSeq.current) setResolving(null);
    }
  }, [index, otherLocations]);

  const more = (bucket) => setShown((s) => ({ ...s, [bucket]: (s[bucket] || PAGE) + PAGE }));
  const toggle = (bucket) => setOpen((o) => ({ ...o, [bucket]: !o[bucket] }));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: ".8rem" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter every section"
          aria-label="Filter armed products"
          style={{ ...input, flex: 1, minWidth: 0 }}
        />
        <button onClick={load} disabled={loading} style={{ ...bGhost, opacity: loading ? .5 : 1 }}>
          {loading ? "…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".8rem",
          border: "1px solid rgba(248,113,113,.45)", color: RED, fontSize: ".85rem" }}>{error}</div>
      )}

      <PhotoLightbox url={photo} onClose={() => setPhoto("")} />

      {!index && (loading || !configSettled) && (
        <div style={{ color: GRAY, padding: "2rem 0" }}>
          {loading ? "Reading both hubs…" : "Reading the policy…"}
        </div>
      )}

      {/* An unreadable policy node is not a quiet one. Every target on this
          screen resolves from it, so saying so is the only honest answer. */}
      {configError && (
        <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".8rem",
          border: "1px solid rgba(251,191,36,.35)", color: AMBER, fontSize: ".85rem" }}>
          The engine policy could not be read — every count below is against an empty policy.
        </div>
      )}

      {index && (
        <>
          {/* ── WHAT THIS SCREEN COST, EVERY TIME ──────────────────────────
              Four location-scoped reads, weighed and shown. A read nobody can
              see is a read nobody can object to, and this is the one screen on
              the card that asks about the whole catalogue at once. */}
          <div style={{ fontSize: 11, color: GRAY, marginBottom: ".8rem" }}>
            {`${index.rows.length} products · ${ctx.readCount} scoped reads · ≈${mb(ctx.bytes)}`
              + (index.deactivatedSkipped > 0 ? ` · ${index.deactivatedSkipped} deactivated, armed nowhere` : "")}
          </div>

          {/* ── THE RESIDUE, NAMED ─────────────────────────────────────────
              The dead-size rule (refill-engine.cjs:416) suppresses a size that
              holds no units ANYWHERE, and "anywhere" is the eight locations
              this tab does not read. The error is one-directional — an armed
              answer is always right — so this can only be hiding arming, never
              inventing it. Said out loud rather than swallowed. */}
          {index.undecidedProducts > 0 && (
            <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".8rem",
              border: "1px solid rgba(251,191,36,.35)", display: "flex", alignItems: "center",
              gap: 10, flexWrap: "wrap" }}>
              <span style={{ color: AMBER, fontSize: ".82rem", flex: 1, minWidth: 180 }}>
                {`${index.undecidedProducts} undecided — no units at either hub`}
              </span>
              {/* Disabled while a READ is in flight, because a resolve computed
                  against the old index would be merged into the new context.
                  Refresh is deliberately NOT disabled the other way round: it is
                  the escape hatch from a 1,472-request pass, and the sequence
                  guards above exist so that interrupting one is safe. */}
              <button onClick={resolve} disabled={!!resolving || loading}
                style={{ ...bGhost, opacity: (resolving || loading) ? .5 : 1 }}>
                {resolving ? `${resolving.done}/${resolving.total}` : `Read the other ${otherLocations.length}`}
              </button>
            </div>
          )}

          {BUCKET_ORDER.map((bucket) => (
            <Section
              key={bucket}
              bucket={bucket}
              rows={sectionRows(index.rows, bucket, query)}
              total={index.counts[bucket]}
              open={!!open[bucket]}
              shown={shown[bucket] || PAGE}
              registry={registry}
              onToggle={() => toggle(bucket)}
              onMore={() => more(bucket)}
              onPhoto={setPhoto}
              onOpenSeating={onOpenSeating}
            />
          ))}
        </>
      )}
    </div>
  );
}

// ── ONE SECTION ──────────────────────────────────────────────────────────────
// Count on the header, always — the unfiltered count, so collapsing a section
// does not hide how big it is, and a search that matches nothing still says
// what it searched.
export function Section({ bucket, rows, total, open, shown, registry, onToggle, onMore, onPhoto, onOpenSeating }) {
  const tone = bucket === BUCKET.BOTH_HUBS ? RED
    : bucket === BUCKET.NOT_SEATED ? AMBER
    : bucket === BUCKET.SUPPRESSED ? GRAY
    : BLUE_L;
  const page = rows.slice(0, shown);

  return (
    <div style={{ marginBottom: "1rem" }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{ ...GLASS, width: "100%", padding: "11px 13px", display: "flex", alignItems: "center",
          gap: 10, cursor: "pointer", color: "#fff", textAlign: "left", font: "inherit" }}
      >
        <span style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 0 }}>{BUCKET_TITLE[bucket]}</span>
        <Badge tone={tone}>{total}</Badge>
        <span style={{ color: GRAY, fontSize: 12 }}>{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div style={{ marginTop: 8 }}>
          {total === 0 && <div style={{ color: GRAY, fontSize: ".82rem", padding: ".5rem .2rem" }}>Nothing here.</div>}
          {total > 0 && rows.length === 0 && (
            <div style={{ color: GRAY, fontSize: ".82rem", padding: ".5rem .2rem" }}>No match in this section.</div>
          )}
          {page.map((r) => (
            <ArmRow key={r.pid} row={r} bucket={bucket} registry={registry}
              onPhoto={onPhoto} onOpenSeating={onOpenSeating} />
          ))}
          {rows.length > page.length && (
            <button onClick={onMore} style={{ ...bGhost, width: "100%", marginTop: 6 }}>
              {`${rows.length - page.length} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── ONE PRODUCT ──────────────────────────────────────────────────────────────
// Photo, name, category, and the per-size target run at each hub. Tapping it
// opens the product in Seating, which is where anything can be changed.
export function ArmRow({ row, bucket, registry, onPhoto, onOpenSeating }) {
  return (
    <div style={{ ...GLASS, padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Looking is not choosing — the thumb opens full screen without
            navigating, exactly as the Seating tab's search list does. */}
        <PhotoThumb url={row.photoUrl} alt={row.name} onOpen={row.photoUrl ? onPhoto : undefined} />
        <button
          onClick={() => onOpenSeating?.(row.pid)}
          style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", color: "inherit",
            font: "inherit", padding: 0, cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {row.name}
          </div>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 2 }}>
            {`${row.category || "No category"}${row.categoryKey ? ` · ${row.categoryKey}` : ""}`}
          </div>
        </button>
      </div>

      {/* BOTH hubs, always — including the one that is NOT armed. The comparison
          is the point; showing only the armed side would leave the reader to
          remember what the other one said. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8, marginTop: 8 }}>
        {ARMING_HUBS.map((hub) => (
          <HubColumn key={hub} hub={hub === HUB1 ? row.hub1 : row.hub2}
            label={labelFor(hub, registry)} highlight={bucket} />
        ))}
      </div>
    </div>
  );
}

export function HubColumn({ hub, label, highlight }) {
  const armed = hub.armed;
  const off = suppressed(hub);
  const run = hub.sizes.filter((s) => s.target > 0).sort(bySize);
  const tone = armed ? (hub.hasCell ? GREEN : AMBER) : off ? GRAY : GRAY;
  const state = armed ? (hub.hasCell ? "Armed" : "Armed · not seated")
    : off ? "Switched off"
    : hub.deactivated ? "Deactivated"
    : hub.undecided ? "Undecided"
    : "Not armed";

  return (
    <div style={{ border: "1px solid rgba(255,255,255,.07)", borderRadius: 11, padding: "8px 9px",
      // The hub that puts this row in ITS section is the one worth looking at.
      background: armed && highlight === BUCKET.NOT_SEATED && !hub.hasCell
        ? "rgba(251,191,36,.06)" : "transparent" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 12, flex: 1, minWidth: 0 }}>{label}</span>
        <Badge tone={tone}>{state}</Badge>
      </div>
      <div style={{ fontSize: 11, color: GRAY, marginTop: 3 }}>
        {`${hub.units} on hand · ${hub.rowCount} row${hub.rowCount === 1 ? "" : "s"}`}
      </div>
      {run.length > 0 && (
        <div style={{ ...CHIP_GRID, gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", marginTop: 6 }}>
          {run.map((s) => (
            <SizeFactChip key={s.sizeKey} size={s.size === "" ? "One" : s.size}
              value={s.target} tone={SOURCE_TONE[s.source] || BLUE_L} />
          ))}
        </div>
      )}
      {/* A deliberate zero is a fact, not an absence. Named so a quiet hub is
          diagnosed in one look instead of read as never having been armed. */}
      {off && (
        <div style={{ fontSize: 11, color: GRAY, marginTop: 5 }}>
          {`${hub.zeroRows.length} size${hub.zeroRows.length === 1 ? "" : "s"} at 0`}
        </div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

const byIdOf = (products) => Object.fromEntries((products || []).map((p) => [p.id, p]));

// Numeric sizes in numeric order, letter sizes after them alphabetically —
// "10" must not sort before "3", which is what a bare string compare does.
//
// THE ONE-SIZE CELL IS NOT THE NUMBER ZERO. `Number("")` is 0 and 0 is finite,
// so the no-size chip sorted in FRONT of size 3 — a "One" chip opening a shoe
// run. It is not a size at all; it goes last. (Found by giving this exported
// helper the unit test it never had. Adversarial review, PR #601.)
const sizeRank = (size) => {
  const raw = String(size ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace("_", "."));
  return Number.isFinite(n) ? n : null;
};

const blankSize = (v) => String(v ?? "").trim() === "";

export function bySize(a, b) {
  // BLANK FIRST, BECAUSE BLANK GOES LAST. Both a blank and a letter size rank
  // `null`, so the fallback used to fall through to localeCompare — and "" sorts
  // BEFORE "L" and "M", putting the one-size chip back at the front for exactly
  // the products that have letter sizes. Handled before the other two
  // comparisons ever run. (CodeRabbit, PR #601.)
  const ab = blankSize(a.size), bb = blankSize(b.size);
  if (ab || bb) return ab && bb ? 0 : ab ? 1 : -1;
  const na = sizeRank(a.size), nb = sizeRank(b.size);
  if (na !== null && nb !== null) return na - nb;
  if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
  return String(a.size).localeCompare(String(b.size));
}

// Fold a resolve into the context without losing the hub cells already there.
export function mergeStock(base, extra) {
  const out = { ...base };
  for (const [loc, byPid] of Object.entries(extra || {})) {
    out[loc] = { ...(out[loc] || {}), ...byPid };
  }
  return out;
}

// "2.7 MB" / "812 KB" — one short number, never a paragraph.
export function mb(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
