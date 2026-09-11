// ─── ARMING — WHICH HUB IS HOLDING WHAT, AND CHANGE IT ON THE SPOT ───────────
//
// The third tab of the Engine Policy card. Categories says what the POLICY is,
// Seating says where ONE product sits, and neither can answer the question this
// screen exists for: which products has the engine made Hub 1 responsible for,
// which Hub 2, which BOTH — and which nothing at all.
//
// ── FOUR TABS, EXCLUSIVE AND EXHAUSTIVE ──────────────────────────────────────
//   Hub 1 · Hub 2 · Both hubs · Nowhere
//
// Every product is in exactly one, so the four counts add up to the catalogue.
// "Both hubs" is the defect: slides are deliberately split across the hubs and
// arming must never spread a line to both.
//
// The first build had five OVERLAPPING sections — a product could be in three
// of them, 960 products were in none, and "armed but not seated" and "armed
// then switched off" were navigation when they are really facts about a row.
// They are badges now. Same products, same counts, one list at a time.
//
// ── AND YOU CAN ACT ON IT HERE ───────────────────────────────────────────────
// Tap a row and it opens the SEATING TAB'S OWN ROWS for that product, inline:
// every location, its reason, its per-size numbers, and Switch off / Move and
// switch off / Re-seat. Not a copy — literally SeatRow and SeatingActions,
// imported. Identify and fix in one place, without losing your position in a
// list of three thousand.
//
// THE WRITE GATES ARE NOT THIS FILE'S. SeatingActions asks
// enginePolicySeatingWritable and enginePolicySeatingMovable for itself and
// renders the refusal in its own words, so a viewer who may look and not touch
// gets the same answer here as on the Seating tab. There is exactly one place
// that decides.
//
// ── THE STANDING RULE OF THIS CARD APPLIES: NO PARAGRAPH ─────────────────────
// Numbers, labels, chips and controls. The explanations live in comments.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  armingIndex, sectionRows,
  BUCKET, BUCKET_ORDER, BUCKET_TITLE, FLAG, FLAG_LABEL, ARMING_HUBS,
} from "./armingCore";
import { readArmingContext, resolveUndecided } from "./armingStore";
import { readSeatingContext } from "./seatingStore";
import { useLocations, useEngineConfigState } from "./useStock";
import { labelFor, allLocationIds, transferTargets, IN_TRANSIT } from "./locations";
import { seatingRows } from "./seatingCore";
import { SeatRow } from "./SeatingTab";
import { PhotoThumb, PhotoLightbox, Badge } from "./healthWidgets";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGhost, input, tabOn, tabOff } from "./ui";

// Hub 2 alone holds over three thousand armed products. Rendering them is ~30
// DOM nodes each and a locked phone.
const PAGE = 60;

const FLAG_TONE = {
  [FLAG.NOT_SEATED]: AMBER,
  [FLAG.SUPPRESSED]: GRAY,
  [FLAG.DEACTIVATED]: GRAY,
  [FLAG.UNDECIDED]: BLUE_L,
};

export default function ArmingTab({ products, viewer, flash }) {
  const registry = useLocations();
  // ── GATED ON `settled`, NOT ON A NON-NULL VALUE ────────────────────────────
  // Every armed answer here is a function of the category policy, which arrives
  // over its own subscription. The four one-shot reads usually win that race on
  // a warm page, so gating only on them showed a fully-rendered screen saying
  // "Both hubs: 0" while the policy was still in flight — a clean, confident,
  // wrong verdict on the one defect this tab exists to surface. `settled` is
  // true once the listener has answered at ALL, so an empty or unreadable node
  // degrades to a visible answer rather than a permanent spinner.
  const { value: config, settled: configSettled, error: configError } = useEngineConfigState();

  const [ctx, setCtx] = useState(null);          // { stock, targets, bytes, readCount }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [photo, setPhoto] = useState("");
  const [tab, setTab] = useState(BUCKET.BOTH_HUBS);
  const [shown, setShown] = useState(PAGE);
  const [openPid, setOpenPid] = useState("");
  const [settling, setSettling] = useState(null);  // { done, total }

  // Products whose stock has been read from EVERY location, so their dead-size
  // answer is final. See armingCore's `undecided` note.
  const [resolvedPids, setResolvedPids] = useState(() => new Set());

  const seq = useRef(0);
  const settleSeq = useRef(0);

  // ── THE LOCATION LISTS ─────────────────────────────────────────────────────
  // Memoised on a SIGNATURE, not on the registry object: usePath hands back a
  // fresh object whenever anything under /locations changes, and callbacks
  // depend on these lists. (Same reasoning as SeatingTab's locSig.)
  //
  // BOTH ids in the digest. transferTargets reads `l.id` off the VALUE while
  // allLocationIds reads the KEY, and nothing guarantees the two agree.
  const locSig = JSON.stringify(
    Object.entries(registry || {})
      .map(([key, l]) => [key, l?.id, l?.active !== false, l?.kind])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );
  const { contextLocations, destinations, otherLocations } = useMemo(() => {
    const dest = transferTargets(registry).filter((l) => l.id !== IN_TRANSIT).map((l) => l.id);
    const all = new Set(dest);
    for (const l of allLocationIds(registry)) all.add(l);
    const ctxIds = [...all];
    return {
      contextLocations: ctxIds,
      destinations: dest,
      otherLocations: ctxIds.filter((l) => !ARMING_HUBS.includes(l)),
    };
    // registry is deliberately not a dependency — locSig is its stable digest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locSig]);

  const byId = useMemo(() => Object.fromEntries((products || []).map((p) => [p.id, p])), [products]);

  // ── THE READ ───────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const mine = ++seq.current;
    // Retire a settle in flight and clear its progress HERE — it is about to
    // find itself stale, and gating its own cleanup on the read's sequence is
    // how the button used to wedge.
    settleSeq.current += 1;
    setSettling(null);
    setLoading(true); setError("");
    try {
      const next = await readArmingContext(ARMING_HUBS);
      if (mine !== seq.current) return;
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

  // A location registered mid-session invalidates every settle: "read from
  // every location" stops being true with no read having failed. The [locSig]
  // dependency IS the guard — React re-runs only when the value changes — and
  // the mount run is a no-op by construction.
  useEffect(() => {
    settleSeq.current += 1;
    setSettling(null);
    setResolvedPids((prev) => (prev.size ? new Set() : prev));
  }, [locSig]);

  const full = useMemo(
    () => (ctx && configSettled
      ? { products: byId, stock: ctx.stock, targets: ctx.targets, config, resolvedPids }
      : null),
    [ctx, configSettled, byId, config, resolvedPids],
  );

  const index = useMemo(() => (full ? armingIndex(full, Object.keys(byId)) : null), [full, byId]);

  // ── SETTLING THE RESIDUE, AUTOMATICALLY ────────────────────────────────────
  // The engine suppresses a size holding no units ANYWHERE, and "anywhere" is
  // the eight locations the hub-scoped read does not hold. The error is
  // one-directional — it can only UNDER-arm — and on live it left 64 products
  // sitting in Nowhere that are in fact armed at a hub.
  //
  // That was behind a button, and a list that is wrong until you press
  // something is a list that is wrong. It runs by itself now, straight after
  // the read: 184 products × 8 locations of the SEATING TAB'S OWN per-(location,
  // product) reads — about 320 KB, against the 3.8 MB reading those locations
  // whole would cost. Never a whole node.
  const settle = useCallback(async (pids) => {
    if (!pids?.length || !otherLocations.length) return;
    const mine = ++settleSeq.current;
    const readAt = seq.current;
    const current = () => mine === settleSeq.current && readAt === seq.current;
    setSettling({ done: 0, total: pids.length });
    try {
      const { stock, bytes, readCount } = await resolveUndecided(pids, otherLocations, {
        onProgress: (done, total) => { if (current()) setSettling({ done, total }); },
      });
      if (!current()) return;
      // The bill includes this. A screen that reports its own read cost and
      // leaves out a 1,472-request pass is not reporting its read cost.
      setCtx((c) => (c ? { ...c, stock: mergeStock(c.stock, stock),
        bytes: c.bytes + bytes, readCount: c.readCount + readCount } : c));
      // UNION, NOT REPLACE. A settle proves ABSENCE as much as presence — a
      // product with no cells elsewhere merges nothing, and mergeStock cannot
      // carry a negative. Only this set remembers that we looked.
      setResolvedPids((prev) => new Set([...prev, ...pids]));
    } catch (e) {
      if (current()) setError(e?.message || String(e));
    } finally {
      if (mine === settleSeq.current) setSettling(null);
    }
  }, [otherLocations]);

  // Fires once per read: `index.undecidedPids` is empty after the settle lands,
  // so this cannot loop.
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    if (!index?.undecidedPids?.length || settling) return;
    settleRef.current(index.undecidedPids);
    // `settle` is held in a ref so its identity cannot re-trigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const rows = useMemo(() => (index ? sectionRows(index.rows, tab, query) : []), [index, tab, query]);
  const page = rows.slice(0, shown);

  // Changing tab or query starts the list again from the top.
  useEffect(() => { setShown(PAGE); setOpenPid(""); }, [tab, query]);

  return (
    <div>
      {/* ── FOUR CHIPS ── */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: ".8rem" }}>
        {BUCKET_ORDER.map((b) => (
          <button
            key={b}
            onClick={() => setTab(b)}
            aria-pressed={tab === b}
            style={{ ...(tab === b ? tabOn : tabOff),
              ...(b === BUCKET.BOTH_HUBS && index?.counts[b] ? { borderColor: "rgba(248,113,113,.55)" } : null) }}
          >
            {`${BUCKET_TITLE[b]} ${index ? index.counts[b] : "…"}`}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: ".8rem" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this list"
          aria-label="Search armed products"
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

      {/* An unreadable policy node is not a quiet one — every target here
          resolves from it, so saying so is the only honest answer. */}
      {configError && (
        <div style={{ ...GLASS, padding: ".7rem .9rem", marginBottom: ".8rem",
          border: "1px solid rgba(251,191,36,.35)", color: AMBER, fontSize: ".85rem" }}>
          The engine policy could not be read — every count above is against an empty policy.
        </div>
      )}

      {index && (
        <>
          <div style={{ fontSize: 11, color: GRAY, marginBottom: ".8rem" }}>
            {`${rows.length} shown · ${ctx.readCount} scoped reads · ≈${mb(ctx.bytes)}`
              + (settling ? ` · checking ${settling.done}/${settling.total}` : "")
              + (index.deactivatedSkipped > 0 ? ` · ${index.deactivatedSkipped} deactivated` : "")}
          </div>

          {rows.length === 0 && (
            <div style={{ color: GRAY, fontSize: ".85rem", padding: "1.4rem 0" }}>
              {query.trim() ? "No match in this list." : "Nothing here."}
            </div>
          )}

          {page.map((r) => (
            <ArmRow
              key={r.pid}
              row={r}
              product={byId[r.pid]}
              registry={registry}
              locations={contextLocations}
              destinations={destinations}
              config={config}
              viewer={viewer}
              open={openPid === r.pid}
              onToggle={() => setOpenPid(openPid === r.pid ? "" : r.pid)}
              onPhoto={setPhoto}
              onChanged={() => load()}
              flash={flash}
            />
          ))}

          {rows.length > page.length && (
            <button onClick={() => setShown((n) => n + PAGE)} style={{ ...bGhost, width: "100%", marginTop: 6 }}>
              {`${rows.length - page.length} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ── ONE PRODUCT ──────────────────────────────────────────────────────────────
// Shut: photo, name, category, where it is armed, and any flag.
// Open: the Seating tab's own rows for every location, with its own actions.
export function ArmRow({ row, product, registry, locations, destinations, config, viewer, open, onToggle, onPhoto, onChanged, flash }) {
  return (
    <div style={{ ...GLASS, padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Looking is not choosing — the thumb opens full screen without
            expanding the row, exactly as the Seating tab's list does. */}
        <PhotoThumb url={row.photoUrl} alt={row.name} onOpen={row.photoUrl ? onPhoto : undefined} />
        <button
          onClick={onToggle}
          aria-expanded={open}
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
        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {/* WHERE, in two words. The tab already says which list this is, so
              the badge earns its place only by naming the units behind it. */}
          {row.hub1.armed && <Badge tone={GREEN}>{`Hub 1 · ${row.hub1.units}`}</Badge>}
          {row.hub2.armed && <Badge tone={GREEN}>{`Hub 2 · ${row.hub2.units}`}</Badge>}
          {row.flags.map((f) => <Badge key={f} tone={FLAG_TONE[f] || GRAY}>{FLAG_LABEL[f]}</Badge>)}
          <span style={{ color: GRAY, fontSize: 12 }}>{open ? "Close" : "Open"}</span>
        </div>
      </div>

      {open && (
        <ProductSeating
          product={product}
          registry={registry}
          locations={locations}
          destinations={destinations}
          config={config}
          viewer={viewer}
          onChanged={onChanged}
          flash={flash}
        />
      )}
    </div>
  );
}

// ── THE SEATING TAB, INLINE, FOR ONE PRODUCT ─────────────────────────────────
//
// Opening a row reads that ONE product from every location — readSeatingContext,
// the same call the Seating tab makes and the same one the write path re-reads
// through — and hands the result to SeatRow and SeatingActions unchanged. It is
// not a second implementation of seating: it is the first one, mounted here.
//
// WHY THE FULL LOCATION LIST AND NOT JUST THE TWO HUBS. Three reasons, all
// load-bearing. The engine's dead-size rule counts units ANYWHERE, so a partial
// snapshot makes a size read as dead and the row would say "not carried" for a
// line the engine is actively seating. Move needs somewhere to move TO. And
// switchOff REFUSES outright unless the location list it is given covers the
// seat it is acting on (seatingStore.js — "a failed check that looks like a
// passed one, over live stock").
export function ProductSeating({ product, registry, locations, destinations, config, viewer, onChanged, flash }) {
  const [ctx, setCtx] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openLoc, setOpenLoc] = useState("");
  const seq = useRef(0);

  const pid = product?.id || "";

  const load = useCallback(async () => {
    if (!pid || !locations.length) return;
    const mine = ++seq.current;
    setLoading(true); setError("");
    try {
      const next = await readSeatingContext(locations, pid);
      if (mine !== seq.current) return;
      setCtx(next);
    } catch (e) {
      if (mine !== seq.current) return;
      setError(e?.message || String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [pid, locations]);

  useEffect(() => { load(); }, [load]);

  const fullCtx = useMemo(
    () => (ctx && product ? { products: { [pid]: product }, stock: ctx.stock, targets: ctx.targets, config } : null),
    [ctx, product, pid, config],
  );

  // Rows for the places a product can be SEATED: active, not in_transit — the
  // Seating tab's own `rowLocations`.
  const rows = useMemo(
    () => (fullCtx ? seatingRows(fullCtx, destinations, pid) : []),
    [fullCtx, destinations, pid],
  );

  if (!product) return null;

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.07)" }}>
      {loading && !ctx && <div style={{ color: GRAY, fontSize: ".82rem", padding: ".4rem 0" }}>Reading every location…</div>}
      {error && (
        <div style={{ color: RED, fontSize: ".82rem", padding: ".4rem 0" }}>{error}</div>
      )}
      {rows.map((seat) => (
        <SeatRow
          key={seat.loc}
          seat={seat}
          product={product}
          label={labelFor(seat.loc, registry)}
          registry={registry}
          locations={locations}
          destinations={destinations}
          ctx={fullCtx}
          viewer={viewer}
          expanded={openLoc === seat.loc}
          onToggle={() => setOpenLoc(openLoc === seat.loc ? "" : seat.loc)}
          onDone={(msg) => {
            flash?.("ok", msg);
            setOpenLoc("");
            // Re-read this product AND the hub lists: a switch-off changes which
            // tab this row belongs in, and a list that still shows it under
            // "Both hubs" after you have just fixed it is the screen lying about
            // the work you did.
            load();
            onChanged?.();
          }}
          onFail={(msg) => flash?.("bad", msg)}
        />
      ))}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Fold a per-product read into the context without losing the hub cells there.
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
