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
import { useLocations, useEngineConfig } from "./useStock";
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
  const config = useEngineConfig();
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

  // A stale load must never land on a newer one — Refresh and the resolve pass
  // can both be in flight.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true); setError("");
    try {
      const next = await readArmingContext(ARMING_HUBS);
      if (mine !== seq.current) return;
      // A fresh read invalidates every resolve: the hub cells it is folded into
      // have been replaced, and keeping the set would mark products decided
      // against stock that is no longer in the context.
      setResolvedPids(new Set());
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
    () => (ctx ? { products: byIdOf(products), stock: ctx.stock, targets: ctx.targets, config, resolvedPids } : null),
    [ctx, products, config, resolvedPids],
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
  const otherLocations = useMemo(
    () => allLocationIds(registry).filter((l) => !ARMING_HUBS.includes(l)),
    // labelFor/allLocationIds read the registry object; a fresh identity on
    // every render would re-make the list but not re-read anything.
    [registry],
  );

  const resolve = useCallback(async () => {
    if (!index || !index.undecided) return;
    const mine = seq.current;
    setResolving({ done: 0, total: 0 });
    try {
      const pids = index.undecidedPids;
      setResolving({ done: 0, total: pids.length });
      const { stock } = await resolveUndecided(pids, otherLocations, {
        onProgress: (done, total) => { if (mine === seq.current) setResolving({ done, total }); },
      });
      if (mine !== seq.current) return;
      setCtx((c) => (c ? { ...c, stock: mergeStock(c.stock, stock) } : c));
      setResolvedPids(new Set(pids));
    } catch (e) {
      if (mine === seq.current) setError(e?.message || String(e));
    } finally {
      if (mine === seq.current) setResolving(null);
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

      {loading && !index && <div style={{ color: GRAY, padding: "2rem 0" }}>Reading both hubs…</div>}

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
          {index.undecided > 0 && (
            <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".8rem",
              border: "1px solid rgba(251,191,36,.35)", display: "flex", alignItems: "center",
              gap: 10, flexWrap: "wrap" }}>
              <span style={{ color: AMBER, fontSize: ".82rem", flex: 1, minWidth: 180 }}>
                {`${index.undecided} undecided — no units at either hub`}
              </span>
              <button onClick={resolve} disabled={!!resolving} style={{ ...bGhost, opacity: resolving ? .5 : 1 }}>
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
function Section({ bucket, rows, total, open, shown, registry, onToggle, onMore, onPhoto, onOpenSeating }) {
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
function ArmRow({ row, bucket, registry, onPhoto, onOpenSeating }) {
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

function HubColumn({ hub, label, highlight }) {
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
export function bySize(a, b) {
  const na = Number(String(a.size).replace("_", "."));
  const nb = Number(String(b.size).replace("_", "."));
  const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
  if (aNum && bNum) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
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
