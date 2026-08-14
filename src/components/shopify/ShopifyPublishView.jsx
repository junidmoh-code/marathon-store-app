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
function ProductReviewRow({ product, node, onApproved, onChanged, inputRef }) {
  const effective = useMemo(() => effectiveNameFor(product, node), [product, node]);
  const [draft, setDraft] = useState(effective.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const state = reviewStateFor(node);
  const verdict = checkCleanName(draft); // the LIVE trigger check
  const blocked = blockedReason(node);

  // The source recorded on approval: an untouched saved name keeps its
  // provenance, an untouched lexicon suggestion records "lexicon", any edit
  // is "manual".
  const sourceForDraft = () =>
    node?.cleanName && draft.trim() === node.cleanName ? (node.cleanNameSource || "manual")
      : effective.source === "lexicon" && draft.trim() === effective.name ? "lexicon"
      : "manual";

  const run = async (fn, after) => {
    setBusy(true); setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) { setError(res.message); return; }
    after?.();
  };

  const approve = () => {
    if (busy || !verdict.ok) return;
    run(() => approveName(product.id, node, draft, sourceForDraft()),
        () => onApproved(product.id));
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
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); approve(); } }}
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
              onClick={() => run(() => setCondition(product.id, node, c), () => onChanged(product.id))}
              style={{ ...(node?.condition === c ? tabOn : tabOff), padding: "4px 9px", fontSize: "0.68rem" }}>
              {c.split(" — ")[0]}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          {(state === "awaiting" || state === "approved") && (
            <button disabled={busy || !verdict.ok}
              onClick={state === "awaiting" ? approve
                : () => run(() => nominateProduct(product.id, node), () => onChanged(product.id))}
              style={{ ...bBlue, padding: "7px 12px", fontSize: "0.76rem", opacity: verdict.ok ? 1 : 0.4 }}>
              {state === "awaiting" ? "Approve" : "Nominate →"}
            </button>
          )}
          {state === "nominated" && (
            <button disabled={busy}
              onClick={() => run(() => withdrawNomination(product.id, node), () => onChanged(product.id))}
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
  const [filter, setFilter] = useState("all");
  const [keys, setKeys] = useState(null);          // Set<pid> — pids with ANY node
  const [pipeline, setPipeline] = useState(null);  // {pid: node} for the 4 pipeline states
  const [nodes, setNodes] = useState({});          // every node body this session has loaded
  const [open, setOpen] = useState(() => new Set());
  const [loadedCats, setLoadedCats] = useState(() => new Set());
  const [loadError, setLoadError] = useState(null);
  const inputRefs = useRef(new Map());             // pid -> input element
  const fetchedCats = useRef(new Set());           // fetch-once guard per category
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
  // though its row still says "awaiting" once loaded — the honest number
  // needs the body, and bodies are strictly on-expand.)
  const q = query.trim().toLowerCase();
  const viewSections = useMemo(() => {
    return sections.map(({ cat, list }) => {
      const matched = q
        ? list.filter((p) =>
            String(p.name || "").toLowerCase().includes(q) ||
            String(nodes[p.id]?.cleanName || "").toLowerCase().includes(q))
        : list;
      let count;
      if (filter === "all") count = matched.length;
      else if (filter === "awaiting") count = keys ? matched.filter((p) => !keys.has(p.id)).length : null;
      else count = pipeline ? matched.filter((p) => pipeline[p.id]?.state === filter).length : null;
      return { cat, list, matched, count };
    }).filter((s) => (q ? s.matched.length > 0 : true))
      .filter((s) => (filter === "all" ? true : s.count !== 0));
  }, [sections, q, filter, keys, pipeline, nodes]);

  // A section is effectively open when toggled open, or when a search is
  // narrowing the page (matches would be invisible inside collapsed sections).
  const isOpen = (cat) => (q ? true : open.has(cat));

  // On-expand fetch: bodies for exactly this section's reviewed pids that we
  // don't hold yet. Runs once per category (fetch-once guard) — later row
  // updates refresh single pids through onRowChanged.
  useEffect(() => {
    for (const { cat, matched } of viewSections) {
      if (!isOpen(cat) || !keys || fetchedCats.current.has(cat)) continue;
      fetchedCats.current.add(cat);
      const want = matched.filter((p) => keys.has(p.id) && !nodes[p.id]).map((p) => p.id);
      Promise.resolve(want.length ? loadNodesFor(want) : {})
        .then((got) => {
          setNodes((prev) => ({ ...prev, ...got }));
          setLoadedCats((prev) => new Set(prev).add(cat));
        })
        .catch((e) => {
          fetchedCats.current.delete(cat); // let a re-open retry
          setLoadError(String(e?.message || e));
        });
    }
  }, [viewSections, keys, open, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ordered pids of rows currently on screen whose state is "awaiting" — the
  // Enter key walks this list.
  const visibleRows = useMemo(() => {
    const rows = [];
    for (const { cat, matched } of viewSections) {
      if (!isOpen(cat) || !loadedCats.has(cat)) continue;
      for (const p of matched) {
        const st = reviewStateFor(nodes[p.id]);
        if (matchesStateFilter(filter, st)) rows.push({ pid: p.id, cat, state: st });
      }
    }
    return rows;
  }, [viewSections, open, q, loadedCats, nodes, filter]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshPid = (pid) => {
    setKeys((prev) => (prev ? new Set(prev).add(pid) : prev));
    loadNodesFor([pid])
      .then((got) => setNodes((prev) => ({ ...prev, ...got })))
      .catch(() => {});
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
      const openCats = new Set([...open]);
      const candidate = viewSections.find(({ cat, matched }) =>
        !openCats.has(cat) && matched.some((p) => !keys.has(p.id)));
      if (candidate) {
        autoFocusCat.current = candidate.cat;
        setOpen((prev) => new Set(prev).add(candidate.cat));
      }
    }
  };

  const onApproved = (pid) => { refreshPid(pid); advanceFrom(pid); };

  // Complete the section-hop: once the auto-opened category's bodies are in,
  // put the cursor on its first unreviewed row.
  useEffect(() => {
    const cat = autoFocusCat.current;
    if (!cat || !loadedCats.has(cat) || !keys) return;
    autoFocusCat.current = null;
    const section = viewSections.find((s) => s.cat === cat);
    const first = section?.matched.find((p) => reviewStateFor(nodes[p.id]) === "awaiting");
    const el = first && inputRefs.current.get(first.id);
    if (el) { el.focus(); el.scrollIntoView({ block: "center" }); }
  }, [loadedCats, viewSections, nodes, keys]);

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

        {keys && pipeline && viewSections.map(({ cat, matched, count }) => {
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

              {opened && !loadedCats.has(cat) && (
                <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Loading section…</div>
              )}
              {opened && loadedCats.has(cat) && (() => {
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
                        onChanged={refreshPid}
                        inputRef={(el) => {
                          if (el) inputRefs.current.set(p.id, el);
                          else inputRefs.current.delete(p.id);
                        }}
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
