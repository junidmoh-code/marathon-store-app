// ─── SHOPIFY PUBLISHING — THE FULL-PAGE TAB ──────────────────────────────────
// Junid's review surface for the one-way Shopify push, replacing the old home
// card (owner spec 2026-08-14): a home-row entry opens THIS page, where the
// whole catalogue is reviewable one name at a time. Layout is one column —
// a sticky header (search + state filter) over the catalogue grouped into
// collapsible category sections, all collapsed until opened.
//
// The primary path is the KEYBOARD: Enter approves the product under the
// cursor and moves focus to the next unreviewed one — thousands of names get
// through on Enter alone. Approving stamps `nameApprovedAt` on the product's
// /shopify_publish node (state stays "none"; the live rules' state enum has
// no "approved" value); nominating is the separate, deliberate step that
// queues a product for the owner-run publish script.
//
// LOAD DISCIPLINE (hard requirement — this is the read pattern that keeps the
// Firebase bill flat): nothing whole-node, nothing eager.
//   · The catalogue itself arrives via the app-wide /products subscription in
//     App.jsx (the `products` prop) — this page adds NO catalogue read.
//   · /shopify_publish is read in three partial slices (see the store):
//     indexed per-state queries for the pipeline, a REST shallow KEY list for
//     the awaiting-review counts, and per-pid bodies fetched only when a
//     category section expands. Thumbnails carry loading="lazy".
//
// Structure and styling match the existing full-page views: the top bar and
// Thumb follow LabelPrintView.jsx, rows use the home list's separator
// treatment (RoleCard in App.jsx), and every colour/spacing value comes from
// stock/ui.js. Writes go ONLY to /shopify_publish, through the store.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, BLUE_L, tabOn, tabOff, input as inputStyle, bBlue } from "../stock/ui";
import { cleanTitleFor } from "../../utils/shopifyTriggers";
import {
  CONDITIONS, STATE_FILTERS, checkCleanName, blockedReason, reviewStateFor, matchesStateFilter,
} from "./shopifyPublishCore";
import {
  loadPipelineNodes, loadPublishKeys, loadNodesFor, approveName, nominateProduct, withdrawNomination, setCondition,
} from "./shopifyPublishStore";

const UNCAT = "Uncategorised";

// Row state chips — the pipeline chips keep the old card's colours; the two
// review-flow states use the neutral text tones from stock/ui's buttons.
const STATE_BADGE = {
  awaiting:  { label: "awaiting review", color: GRAY,    border: "rgba(255,255,255,.18)" },
  approved:  { label: "approved",        color: "#dfe7ff", border: "rgba(255,255,255,.3)" },
  nominated: { label: "nominated",       color: BLUE_L,  border: "rgba(74,127,255,.5)" },
  draft:     { label: "draft on shop",   color: GREEN,   border: "rgba(74,222,128,.5)" },
  live:      { label: "LIVE",            color: GREEN,   border: "rgba(74,222,128,.8)" },
  blocked:   { label: "blocked",         color: RED,     border: "rgba(248,113,113,.55)" },
};

function StateChip({ state }) {
  const b = STATE_BADGE[state] || STATE_BADGE.awaiting;
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, color: b.color, border: `1px solid ${b.border}`,
                   borderRadius: 8, padding: "3px 7px", whiteSpace: "nowrap", flexShrink: 0 }}>
      {b.label.toUpperCase()}
    </span>
  );
}

// Same thumbnail treatment as LabelPrintView, plus lazy loading — rows exist
// by the hundred per section and must not fetch a photo until scrolled to.
function Thumb({ p }) {
  if (p?.photoUrl) {
    return <img src={p.photoUrl} alt="" loading="lazy"
                style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 10, flexShrink: 0 }}
                onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  }
  return <div style={{ width: 44, height: 44, borderRadius: 10, background: "rgba(120,150,255,.08)",
                       display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{p?.photo || "👟"}</div>;
}

// The name Junid is signing off for a product: an already-saved cleanName
// wins, else the lexicon's automatic clean, else empty (needs typing).
function effectiveNameFor(product, node) {
  if (node?.cleanName) return { name: node.cleanName, source: node.cleanNameSource || "manual" };
  const lex = cleanTitleFor(product);
  if (!lex.needsAI) return { name: lex.title, source: "lexicon" };
  return { name: "", source: "manual", needsAI: true, reason: lex.reason };
}

// One product's review row. Everything is inline: the cleaned name is a live
// input with the trigger check on every keystroke, condition is three chips,
// the primary action follows the review state. No modals anywhere.
function ProductReviewRow({ product, node, onApproved, onChanged, onSkip, inputRef }) {
  const effective = useMemo(() => effectiveNameFor(product, node), [product, node]);
  const [draft, setDraft] = useState(effective.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const state = reviewStateFor(node);
  const verdict = checkCleanName(draft); // the LIVE trigger check
  const blocked = blockedReason(node);
  // An edit after approval un-approves in the UI: the primary action returns
  // to Approve until the new text is signed off, so Nominate can never queue
  // a name the reviewer hasn't actually approved.
  const dirty = state === "approved" && draft.trim() !== String(node?.cleanName || "");
  const primaryIsApprove = state === "awaiting" || dirty;

  // The source recorded on approval: an untouched saved name keeps its
  // provenance, an untouched lexicon suggestion records "lexicon", any edit
  // is "manual".
  const sourceForDraft = () =>
    node?.cleanName && draft.trim() === node.cleanName ? (node.cleanNameSource || "manual")
      : effective.source === "lexicon" && draft.trim() === effective.name ? "lexicon"
      : "manual";

  // finally-reset: the store never throws today, but a row frozen for the
  // session because a future caller broke that invariant is too costly.
  const run = async (fn, after) => {
    setBusy(true); setError(null);
    try {
      const res = await fn();
      if (!res?.ok) { setError(res?.message || "Not saved."); return; }
      after?.(res);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const approve = () => {
    if (busy || !verdict.ok || !primaryIsApprove) return;
    run(() => approveName(product.id, node, draft, sourceForDraft()),
        (res) => onApproved(product.id, res.node));
  };

  return (
    <div style={{ display: "flex", gap: 11, padding: "12px 2px", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <Thumb p={product} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "rgba(255,255,255,.3)",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {product.name}
          </div>
          <StateChip state={state} />
        </div>
        <input
          ref={inputRef}
          value={draft}
          disabled={busy}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            // Enter approves; on a row already approved and untouched it just
            // advances, so walking a mixed list never stalls the flow.
            if (primaryIsApprove) approve(); else onSkip(product.id);
          }}
          placeholder={effective.needsAI ? `needs a name — ${effective.reason}` : "Cleaned listing name…"}
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginTop: 6,
                   border: !verdict.ok && draft !== "" ? "1px solid rgba(248,113,113,.6)" : inputStyle.border }}
        />
        {!verdict.ok && draft !== "" && (
          <div style={{ fontSize: 10.5, color: RED, marginTop: 4 }}>{verdict.problems.join(" · ")}</div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 7 }}>
          {CONDITIONS.map((c) => (
            <button key={c} disabled={busy}
              onClick={() => run(() => setCondition(product.id, node, c), (res) => onChanged(product.id, res.node))}
              style={{ ...(node?.condition === c ? tabOn : tabOff), padding: "4px 9px", fontSize: "0.68rem" }}>
              {c.split(" — ")[0]}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {(state === "awaiting" || state === "approved") && (
            <button disabled={busy || !verdict.ok}
              onClick={primaryIsApprove ? approve
                : () => run(() => nominateProduct(product.id, node), (res) => onChanged(product.id, res.node))}
              style={{ ...bBlue, padding: "7px 12px", fontSize: "0.76rem", opacity: verdict.ok ? 1 : 0.4 }}>
              {primaryIsApprove ? "Approve" : "Nominate →"}
            </button>
          )}
          {state === "nominated" && (
            <button disabled={busy}
              onClick={() => run(() => withdrawNomination(product.id, node), (res) => onChanged(product.id, res.node))}
              style={{ background: "none", border: "none", cursor: "pointer", fontFamily: FONT,
                       fontSize: "0.72rem", fontWeight: 700, color: GRAY, padding: "7px 4px" }}>
              Withdraw
            </button>
          )}
        </div>
        {node?.condition && (
          <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>{node.condition}</div>
        )}
        {blocked && (
          <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>⛔ {blocked}</div>
        )}
        {error && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>{error}</div>}
      </div>
    </div>
  );
}

// Home-badge hook: how many products have never been seen by the review flow.
// One shallow KEY read (session-cached in the store) against the in-memory
// catalogue — no bodies, no extra catalogue read. null until known (the row
// simply shows no badge while loading, matching the other home badges' "no
// count, no badge" behaviour).
export function useShopifyAwaitingCount(products, enabled) {
  const [keys, setKeys] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let on = true;
    loadPublishKeys().then((k) => { if (on) setKeys(k); }).catch(() => {});
    return () => { on = false; };
  }, [enabled]);
  return useMemo(() => {
    if (!enabled || !keys) return null;
    let n = 0;
    for (const p of products || []) if (p?.id && !keys.has(p.id)) n += 1;
    return n;
  }, [enabled, keys, products]);
}

export default function ShopifyPublishView({ products = [], onExit }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState("all");

  // The search drives section matching (and, when narrow enough, section
  // auto-open + body fetches) — debounce it so a fast typist doesn't fan out
  // work on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [keys, setKeys] = useState(null);          // Set<pid> — pids with ANY node
  const [pipeline, setPipeline] = useState(null);  // {pid: node} for the 4 pipeline states
  const [nodes, setNodes] = useState({});          // every node body this session has loaded
  const [open, setOpen] = useState(() => new Set());
  const [loadError, setLoadError] = useState(null);
  const inputRefs = useRef(new Map());             // pid -> input element
  const refCallbacks = useRef(new Map());          // pid -> STABLE ref callback (see refFor)
  const requestedPids = useRef(new Set());         // in-flight/done per-pid body fetches
  const autoFocusCat = useRef(null);               // focus first awaiting row once this category loads

  // Mount reads: shallow keys + the four indexed pipeline queries. Both are
  // partial by design — never get(/shopify_publish).
  useEffect(() => {
    let on = true;
    Promise.all([loadPublishKeys({ fresh: true }), loadPipelineNodes()])
      .then(([k, pipe]) => {
        if (!on) return;
        setKeys(new Set(k));
        setPipeline(pipe);
        setNodes((prev) => ({ ...pipe, ...prev }));
      })
      .catch((e) => { if (on) setLoadError(String(e?.message || e)); });
    return () => { on = false; };
  }, []);

  // The catalogue grouped by its existing category field, subcategory kept for
  // the in-section subheaders. Categories and their products sort by name.
  const sections = useMemo(() => {
    const byCat = new Map();
    for (const p of products) {
      if (!p?.id || !p?.name) continue;
      const cat = String(p.category || UNCAT);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(p);
    }
    const cmp = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
    return [...byCat.entries()]
      .sort(([a], [b]) => cmp(a, b))
      .map(([cat, list]) => ({
        cat,
        list: list.sort((a, b) =>
          cmp(a.subcategory || "", b.subcategory || "") || cmp(a.name, b.name)),
      }));
  }, [products]);

  // Per-section view data under the current search + filter. Counts come from
  // cheap sources only: key ABSENCE prices "awaiting", the pipeline queries
  // price their four states, "all" is the catalogue itself. (A node holding
  // only a condition or a withdrawn nomination counts as seen here even
  // though its row still says "awaiting" once its body loads — the honest
  // number needs bodies, and bodies are strictly on-expand. The count is an
  // approximation; the ROWS are always judged from real fields.)
  // `pending` = displayed pids whose body is still unfetched — the section
  // renders rows only once it hits zero, so a row never mounts with a node it
  // doesn't have yet (its editable draft is seeded from the node at mount).
  const q = debouncedQuery.trim().toLowerCase();
  const viewSections = useMemo(() => {
    return sections.map(({ cat, list }) => {
      const matched = q
        ? list.filter((p) =>
            String(p.name || "").toLowerCase().includes(q) ||
            String(nodes[p.id]?.cleanName || "").toLowerCase().includes(q))
        : list;
      let count;
      if (filter === "all") count = matched.length;
      else if (filter === "awaiting") {
        // Key absence, refined by any bodies already loaded: a node that
        // exists but was never name-approved (condition-only, withdrawn
        // nomination) still awaits review, and pricing it from keys alone
        // would hide its whole section under this filter.
        count = keys ? matched.filter((p) =>
          !keys.has(p.id) ||
          (nodes[p.id] !== undefined && reviewStateFor(nodes[p.id]) === "awaiting")).length : null;
      }
      else count = pipeline ? matched.filter((p) => pipeline[p.id]?.state === filter).length : null;
      const pending = keys ? matched.filter((p) => keys.has(p.id) && nodes[p.id] === undefined).length : 0;
      return { cat, list, matched, count, pending };
    }).filter((s) => (q ? s.matched.length > 0 : true))
      .filter((s) => (filter === "all" ? true : s.count !== 0));
  }, [sections, q, filter, keys, pipeline, nodes]);

  // A section is effectively open when toggled open, or when a search has
  // narrowed the page far enough that showing the matches outright is cheap.
  // A broad search (a one-letter query can match most of the catalogue)
  // leaves sections collapsed — auto-opening them all would fan out a body
  // fetch per reviewed match, exactly the eager load this page must not do.
  const totalMatches = q ? viewSections.reduce((n, s) => n + s.matched.length, 0) : 0;
  const searchExpands = q !== "" && totalMatches <= 60;
  const isOpen = (cat) => searchExpands || open.has(cat);

  // On-expand fetch: bodies for exactly the pids a section is about to
  // display that we don't hold yet. Tracked PER PID (not per category) so a
  // search-narrowed fetch never masks the rest of the category, and a later
  // full expand fetches only what's still missing. Missing bodies (deleted
  // between the shallow read and the get) are recorded as null so `pending`
  // can settle.
  useEffect(() => {
    if (!keys) return;
    for (const { cat, matched } of viewSections) {
      if (!isOpen(cat)) continue;
      const want = matched
        .filter((p) => keys.has(p.id) && nodes[p.id] === undefined && !requestedPids.current.has(p.id))
        .map((p) => p.id);
      if (!want.length) continue;
      for (const pid of want) requestedPids.current.add(pid);
      loadNodesFor(want)
        .then(({ nodes: got, failed }) => {
          setNodes((prev) => {
            const next = { ...prev };
            for (const pid of want) {
              if (!failed.includes(pid)) next[pid] = got[pid] || null;
            }
            return next;
          });
          if (failed.length) {
            for (const pid of failed) requestedPids.current.delete(pid); // let a re-open retry
            setLoadError(`${failed.length} product record(s) didn't load — reopen the section or adjust the search to retry`);
          }
        })
        .catch((e) => {
          for (const pid of want) requestedPids.current.delete(pid);
          setLoadError(String(e?.message || e));
        });
    }
  }, [viewSections, keys, open, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ordered pids of rows currently on screen whose state is "awaiting" — the
  // Enter key walks this list.
  const visibleRows = useMemo(() => {
    const rows = [];
    for (const { cat, matched, pending } of viewSections) {
      if (!isOpen(cat) || pending !== 0) continue;
      for (const p of matched) {
        const st = reviewStateFor(nodes[p.id]);
        if (matchesStateFilter(filter, st)) rows.push({ pid: p.id, cat, state: st });
      }
    }
    return rows;
  }, [viewSections, open, q, nodes, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fold a completed write straight into local state. The store's
  // transactions return the committed node, so no refetch is needed — and
  // none must happen: keys and nodes update in ONE batch, because a keys-only
  // update would flip the section's `pending` and unmount every row (killing
  // the Enter flow's focus) until a refetch landed.
  const applyWrite = (pid, node) => {
    setKeys((prev) => (prev ? new Set(prev).add(pid) : prev));
    // Keep the pipeline map (which prices the four state-filter counts) in
    // step with the write — otherwise a fresh nomination is invisible to the
    // Nominated filter, and a withdrawal leaves a phantom count behind.
    setPipeline((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      if (node && ["nominated", "draft", "live", "blocked"].includes(node.state)) next[pid] = node;
      else delete next[pid];
      return next;
    });
    if (node !== undefined) {
      setNodes((prev) => ({ ...prev, [pid]: node || null }));
    } else {
      // A store result without a node (shouldn't happen) — refetch to stay honest.
      loadNodesFor([pid])
        .then(({ nodes: got, failed }) => {
          if (!failed.length) setNodes((prev) => ({ ...prev, [pid]: got[pid] || null }));
        })
        .catch(() => {});
    }
  };

  // Enter's advance: focus the next awaiting row after the approved one; when
  // the open sections are exhausted, open the next category that still has
  // unreviewed products and focus its first row once its bodies load.
  const advanceFrom = (pid) => {
    const awaiting = visibleRows.filter((r) => r.state === "awaiting" && r.pid !== pid);
    const idx = visibleRows.findIndex((r) => r.pid === pid);
    const next = awaiting.find((r) => visibleRows.findIndex((v) => v.pid === r.pid) > idx) || awaiting[0];
    if (next) {
      const el = inputRefs.current.get(next.pid);
      if (el) { el.focus(); el.scrollIntoView({ block: "center" }); return; }
    }
    if (keys) {
      // Next category to open: one that still has products never seen (no
      // node key), or whose LOADED bodies still read awaiting. Unloaded
      // node-bearing pids are approximated as reviewed — the honest answer
      // needs their bodies, which are strictly on-expand; a category that is
      // wholly withdrawn-nominations would be skipped here and reached by a
      // manual expand instead.
      const openCats = new Set([...open]);
      const candidate = viewSections.find(({ cat, matched }) =>
        !openCats.has(cat) && matched.some((p) =>
          !keys.has(p.id) ||
          (nodes[p.id] !== undefined && reviewStateFor(nodes[p.id]) === "awaiting")));
      if (candidate) {
        autoFocusCat.current = candidate.cat;
        setOpen((prev) => new Set(prev).add(candidate.cat));
      }
    }
  };

  const onApproved = (pid, node) => { applyWrite(pid, node); advanceFrom(pid); };

  // Complete the section-hop: once the auto-opened category's bodies are in
  // (pending === 0), put the cursor on its first unreviewed row.
  useEffect(() => {
    const cat = autoFocusCat.current;
    if (!cat || !keys) return;
    const section = viewSections.find((s) => s.cat === cat);
    if (!section || section.pending !== 0) return;
    autoFocusCat.current = null;
    const first = section.matched.find((p) => reviewStateFor(nodes[p.id]) === "awaiting");
    const el = first && inputRefs.current.get(first.id);
    if (el) { el.focus(); el.scrollIntoView({ block: "center" }); }
  }, [viewSections, nodes, keys]);

  // Ref callbacks must keep a stable identity per pid: a fresh arrow every
  // render makes React detach (null) and re-attach every row ref on each
  // re-render, and the approve continuation can observe the emptied Map in
  // that window — Enter would approve but never advance.
  const refFor = (pid) => {
    let cb = refCallbacks.current.get(pid);
    if (!cb) {
      cb = (el) => {
        if (el) {
          inputRefs.current.set(pid, el);
        } else {
          inputRefs.current.delete(pid);
          refCallbacks.current.delete(pid); // unmount frees the closure too
        }
      };
      refCallbacks.current.set(pid, cb);
    }
    return cb;
  };

  const toggle = (cat) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(cat)) next.delete(cat); else next.add(cat);
    return next;
  });

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", overflowX: "hidden", paddingBottom: 40 }}>
      {/* TOP BAR — same shape as the other full-page views (LabelPrintView) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 14px 12px" }}>
        <div onClick={onExit}
          style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>← Switch View</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: "0.5px" }}>Viewing as:</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#4A7FFF", letterSpacing: "0.5px" }}>SHOPIFY PUBLISHING</div>
        </div>
        <div style={{ width: 92 }} />
      </div>

      {/* STICKY HEADER — search + state filter, nothing else */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "#000", padding: "10px 14px 12px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search products…"
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {STATE_FILTERS.map(({ key, label }) => (
            <button key={key} onClick={() => setFilter(key)}
              style={{ ...(filter === key ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.74rem" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "6px 14px 0" }}>
        {loadError && (
          <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px" }}>
            Couldn't load the publishing pipeline: {loadError}
          </div>
        )}
        {!loadError && (!keys || !pipeline) && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading pipeline…</div>
        )}

        {keys && pipeline && viewSections.length === 0 && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>
            {q ? "No products match." : "Nothing to show under this filter."}
          </div>
        )}

        {keys && pipeline && viewSections.map(({ cat, matched, count, pending }) => {
          const opened = isOpen(cat);
          return (
            <div key={cat}>
              {/* Section header row — the home list's row treatment (RoleCard):
                  name, right-aligned count badge, chevron. */}
              <div onClick={() => toggle(cat)}
                style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 2px",
                         cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
                <div style={{ flex: 1, fontSize: 15, fontWeight: 500, color: "rgba(255,255,255,.9)" }}>{cat}</div>
                {count != null && count !== 0 && (
                  <div style={{ minWidth: 28, height: 28, padding: "0 8px", boxSizing: "border-box", borderRadius: 999,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                fontSize: 11, fontWeight: 600, fontVariantNumeric: "tabular-nums",
                                background: "rgba(60,110,255,.18)", color: "#6A9FFF",
                                boxShadow: "0 0 8px rgba(60,110,255,.3),inset 0 0 6px rgba(60,110,255,.15)" }}>
                    {count}
                  </div>
                )}
                <span style={{ color: "rgba(255,255,255,.18)", fontSize: 14,
                               transform: opened ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>
              </div>

              {opened && pending !== 0 && (
                <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Loading section…</div>
              )}
              {opened && pending === 0 && (() => {
                const rows = matched.filter((p) => matchesStateFilter(filter, reviewStateFor(nodes[p.id])));
                if (rows.length === 0) {
                  return <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Nothing here under this filter.</div>;
                }
                let lastSub = null;
                return rows.map((p) => {
                  const sub = String(p.subcategory || "");
                  const showSub = sub !== lastSub && sub !== "";
                  lastSub = sub;
                  return (
                    <React.Fragment key={p.id}>
                      {showSub && (
                        <div style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase",
                                      color: "rgba(233,238,255,.3)", fontWeight: 700, padding: "12px 2px 2px" }}>
                          {sub}
                        </div>
                      )}
                      <ProductReviewRow
                        product={p}
                        node={nodes[p.id] || null}
                        onApproved={onApproved}
                        onChanged={applyWrite}
                        onSkip={advanceFrom}
                        inputRef={refFor(p.id)}
                      />
                    </React.Fragment>
                  );
                });
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
