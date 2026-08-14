// ─── SHOPIFY PUBLISHING — THE FULL-PAGE TAB ──────────────────────────────────
// Junid's review surface for the one-way Shopify push (owner spec 2026-08-14):
// a home-row entry opens THIS page, where the whole catalogue is reviewable
// one name at a time. Layout is one column — a sticky header (search + state
// filter) over the catalogue grouped into collapsible category sections, all
// collapsed until opened.
//
// The primary path is the KEYBOARD: Enter approves the name under the cursor
// and moves focus to the next unreviewed one — thousands of names get through
// on Enter alone. The row's button is the single PUBLISH action (the old
// Approve → Nominate → Live chain is collapsed): it opens the one confirmation
// dialog this page allows and then writes desiredState INTENT only. The
// owner-run reconciler (scripts/shopify/reconcile.mjs) is what actually talks
// to Shopify — the browser cannot hold the client secret and NEVER calls
// Shopify — and the row shows pending until it confirms. The Live filter
// splits into On and Off groups; each live row carries an on/off switch
// (off is instant intent, on re-confirms like Publish).
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
import { FONT, GRAY, GREEN, RED, BLUE_L, GLASS_SOLID, tabOn, tabOff, input as inputStyle, bBlue, bGray, bGreen } from "../stock/ui";
import { cleanTitleFor } from "../../utils/shopifyTriggers";
import {
  CONDITIONS, STATE_FILTERS, checkCleanName, blockedReason, reviewStateFor, matchesStateFilter,
  normalizedState, isOn, isPendingSwitch, canGoLive,
} from "./shopifyPublishCore";
import {
  loadPipelineNodes, loadPublishKeys, loadNodesFor, approveName, publishProduct, setDesiredState, setCondition,
} from "./shopifyPublishStore";

const UNCAT = "Uncategorised";

// Row state chips — live/blocked keep the old pipeline colours; the review
// states use the neutral text tones from stock/ui's buttons. "publishing" and
// "switching" are the pending marker: an intent written, the reconciler not
// yet run.
const STATE_BADGE = {
  awaiting:   { label: "awaiting review", color: GRAY,    border: "rgba(255,255,255,.18)" },
  approved:   { label: "approved",        color: "#dfe7ff", border: "rgba(255,255,255,.3)" },
  publishing: { label: "publishing…",     color: BLUE_L,  border: "rgba(74,127,255,.5)" },
  switching:  { label: "switching…",      color: BLUE_L,  border: "rgba(74,127,255,.5)" },
  on:         { label: "ON — LIVE",       color: GREEN,   border: "rgba(74,222,128,.8)" },
  off:        { label: "off",             color: GRAY,    border: "rgba(255,255,255,.18)" },
  blocked:    { label: "blocked",         color: RED,     border: "rgba(248,113,113,.55)" },
};

// The chip a node shows: pending intent wins (that's what Junid is waiting
// on), then on/off for live products, then the review state.
function chipFor(state, node) {
  if (isPendingSwitch(node)) return state === "live" ? "switching" : "publishing";
  if (state === "live") return isOn(node) ? "on" : "off";
  return state;
}

function StateChip({ chip }) {
  const b = STATE_BADGE[chip] || STATE_BADGE.awaiting;
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

// What the storefront would show — the facts the confirmation dialog states.
function publicFacts(product, node, name) {
  const photos = new Set(
    [product?.photoUrl, ...(Array.isArray(product?.gallery) ? product.gallery : [])]
      .filter((u) => typeof u === "string" && u.trim() !== "")
  );
  const price = Number(product?.retailPrice);
  return {
    name,
    condition: node?.condition || null,
    price: price > 0 ? `R ${price.toFixed(2)}` : "no price set",
    photoCount: photos.size,
  };
}

// ─── THE ONE CONFIRMATION DIALOG ─────────────────────────────────────────────
// This page's rule is NO MODALS — with one deliberate exception (owner spec
// 2026-08-14): going live. Publishing puts a name on the PUBLIC storefront
// and the name is the compliance-critical field, so it is the most prominent
// thing here and the reviewer confirms it one last time. Nothing else on the
// page may grow a dialog; switching OFF never asks (it only reduces
// exposure). Cancel is the default focus — Enter must never publish blind.
function PublishConfirmDialog({ facts, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.62)",
               backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ ...GLASS_SOLID, width: "100%", maxWidth: 420, padding: "22px 20px", fontFamily: FONT }}>
        <div style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700 }}>
          Put on the public storefront?
        </div>
        <div style={{ fontSize: 19, fontWeight: 800, color: "#fff", marginTop: 10, lineHeight: 1.3, overflowWrap: "break-word" }}>
          {facts.name}
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.75)", marginTop: 12 }}>
          {facts.condition || "— no condition set —"}
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.75)", marginTop: 4 }}>
          {facts.price} · {facts.photoCount} photo{facts.photoCount === 1 ? "" : "s"}
        </div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 12, lineHeight: 1.45 }}>
          This makes the product publicly visible on the online store, under exactly the
          name above. Check the name once more — it is what the compliance rules protect.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button ref={cancelRef} onClick={onCancel} disabled={busy} style={{ ...bGray, flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...bGreen, flex: 1 }}>
            {busy ? "Saving…" : "Put it live"}
          </button>
        </div>
      </div>
    </div>
  );
}

// One product's review row. Everything is inline: the cleaned name is a live
// input with the trigger check on every keystroke, condition is three chips,
// the primary action is PUBLISH (behind the page's one confirmation dialog).
// Live rows carry the on/off switch instead — off writes intent immediately,
// on re-confirms with the same dialog.
function ProductReviewRow({ product, node, onApproved, onChanged, onSkip, inputRef }) {
  const effective = useMemo(() => effectiveNameFor(product, node), [product, node]);
  const [draft, setDraft] = useState(effective.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirming, setConfirming] = useState(null); // "publish" | "switch-on"

  const state = reviewStateFor(node);
  const on = isOn(node);
  const pending = isPendingSwitch(node);
  const verdict = checkCleanName(draft); // the LIVE trigger check
  const blocked = blockedReason(node);
  const isLiveRow = state === "live";
  // An edit after approval un-approves in the UI: Enter returns to approving
  // until the new text is signed off, so Publish can never ship a name the
  // reviewer hasn't actually confirmed (the dialog shows the draft verbatim).
  // A live-OFF row's name is editable too (the reconciler re-syncs it at
  // turn-on) — Enter is its save path, and the switch refuses to go On while
  // an edit sits unsaved (the dialog must show the name that will ship).
  const editable = state === "approved" || (isLiveRow && !on);
  const dirty = editable && draft.trim() !== String(node?.cleanName || "");
  const enterApproves = state === "awaiting" || dirty;

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
    if (busy || !verdict.ok || !enterApproves) return;
    run(() => approveName(product.id, node, draft, sourceForDraft()),
        (res) => onApproved(product.id, res.node));
  };

  // Publish click: the condition gate is checked BEFORE the dialog opens — a
  // dialog stating "no condition" would be confirming a write the store
  // refuses anyway. The dialog is the only thing between here and intent.
  const requestPublish = () => {
    if (busy || !verdict.ok) return;
    if (!canGoLive(node)) {
      setError("Pick a condition grade first — a product cannot go live without one.");
      return;
    }
    setConfirming("publish");
  };

  const confirmGoLive = () => {
    const write = confirming === "publish"
      ? () => publishProduct(product.id, node, draft, sourceForDraft())
      : () => setDesiredState(product.id, node, "on");
    run(write, (res) => onChanged(product.id, res.node));
    setConfirming(null);
  };

  const dialogName = confirming === "switch-on" ? (node?.cleanName || draft.trim()) : draft.trim();

  return (
    <div style={{ display: "flex", gap: 11, padding: "12px 2px", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <Thumb p={product} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "rgba(255,255,255,.3)",
                        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {product.name}
          </div>
          <StateChip chip={chipFor(state, node)} />
        </div>
        <input
          ref={inputRef}
          value={draft}
          disabled={busy || (isLiveRow && on)}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            // Enter approves; on a row already approved and untouched it just
            // advances, so walking a mixed list never stalls the flow. Enter
            // NEVER publishes — that path always goes through the dialog.
            if (enterApproves) approve(); else onSkip(product.id);
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
          {isLiveRow ? (
            // The on/off switch. OFF is instant intent — reversible, reduces
            // exposure, no dialog. ON re-confirms with the same dialog as
            // Publish. While pending, the switch waits for the reconciler.
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {pending && (
                <span style={{ fontSize: 10.5, color: BLUE_L }}>
                  Saved — waiting for the reconciler run to update Shopify.
                </span>
              )}
              <button disabled={busy || pending || on}
                onClick={() => {
                  if (dirty) { setError("Save the edited name first (press Enter in the name field)."); return; }
                  setConfirming("switch-on");
                }}
                style={{ ...(on ? tabOn : tabOff), padding: "4px 11px", fontSize: "0.68rem" }}>
                On
              </button>
              <button disabled={busy || pending || !on}
                onClick={() => run(() => setDesiredState(product.id, node, "off"), (res) => onChanged(product.id, res.node))}
                style={{ ...(!on ? tabOn : tabOff), padding: "4px 11px", fontSize: "0.68rem" }}>
                Off
              </button>
            </div>
          ) : pending ? (
            // A publish intent the reconciler hasn't applied yet — cancellable
            // without a dialog (cancelling only reduces exposure). The plain
            // sentence is deliberate (owner feedback 2026-08-14): the chip
            // alone read as "in progress", and Junid didn't know a separate
            // reconciler run had to happen before anything reached Shopify.
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ fontSize: 10.5, color: BLUE_L }}>
                Saved — waiting for the reconciler run to send it to Shopify.
              </span>
              <button disabled={busy}
                onClick={() => run(() => setDesiredState(product.id, node, "off"), (res) => onChanged(product.id, res.node))}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: FONT,
                         fontSize: "0.72rem", fontWeight: 700, color: GRAY, padding: "7px 4px" }}>
                Cancel
              </button>
            </div>
          ) : (
            <button disabled={busy || !verdict.ok}
              onClick={requestPublish}
              style={{ ...bBlue, padding: "7px 12px", fontSize: "0.76rem", opacity: verdict.ok ? 1 : 0.4 }}>
              Publish
            </button>
          )}
        </div>
        {node?.condition && (
          <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>{node.condition}</div>
        )}
        {isLiveRow && (
          // The live row's provenance line: when it went ON (the reconciler's
          // liveAt stamp) and the direct Shopify admin link. Both are stamped
          // at confirm time — a row confirmed before this shipped shows
          // neither, honestly, until its next reconcile.
          <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>
            {on
              ? (node?.liveAt ? `Went live ${new Date(node.liveAt).toLocaleDateString()}` : "Live")
              : "On Shopify, not published"}
            {node?.adminUrl && (
              <>
                {" · "}
                <a href={node.adminUrl} target="_blank" rel="noreferrer" style={{ color: BLUE_L }}>
                  Shopify admin ↗
                </a>
              </>
            )}
          </div>
        )}
        {blocked && (
          <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>⛔ {blocked}</div>
        )}
        {error && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>{error}</div>}
      </div>
      {confirming && (
        <PublishConfirmDialog
          facts={publicFacts(product, node, dialogName)}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={confirmGoLive}
        />
      )}
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
  const [pipeline, setPipeline] = useState(null);  // {pid: node} for live/blocked (+legacy)
  const [nodes, setNodes] = useState({});          // every node body this session has loaded
  const [open, setOpen] = useState(() => new Set());
  const [loadError, setLoadError] = useState(null);       // mount reads failed — page unusable
  const [sectionError, setSectionError] = useState(null); // a body batch failed — clears on the next good batch
  const inputRefs = useRef(new Map());             // pid -> input element
  const refCallbacks = useRef(new Map());          // pid -> STABLE ref callback (see refFor)
  const requestedPids = useRef(new Set());         // in-flight/done per-pid body fetches
  const autoFocusCat = useRef(null);               // focus first awaiting row once this category loads

  // Mount reads: shallow keys + the indexed pipeline queries. Both are
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
  // price live/blocked, "all" is the catalogue itself. (A node holding only a
  // condition counts as seen here even though its row still says "awaiting"
  // once its body loads — the honest number needs bodies, and bodies are
  // strictly on-expand. The count is an approximation; the ROWS are always
  // judged from real fields.)
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
        // exists but was never name-approved (condition-only) still awaits
        // review, and pricing it from keys alone would hide its whole
        // section under this filter.
        count = keys ? matched.filter((p) =>
          !keys.has(p.id) ||
          (nodes[p.id] !== undefined && reviewStateFor(nodes[p.id]) === "awaiting")).length : null;
      }
      else count = pipeline ? matched.filter((p) => pipeline[p.id] && reviewStateFor(pipeline[p.id]) === filter).length : null;
      const pending = keys ? matched.filter((p) => keys.has(p.id) && nodes[p.id] === undefined).length : 0;
      return { cat, list, matched, count, pending };
    }).filter((s) => (q ? s.matched.length > 0 : true))
      .filter((s) => (filter === "all" ? true : s.count !== 0));
  }, [sections, q, filter, keys, pipeline, nodes]);

  // The Live filter abandons category sections for the owner's real question
  // — what is ON the storefront and what is OFF — as two collapsible groups
  // (same header treatment as the category sections). Bodies are already in
  // hand: the pipeline query loads every live node at mount. Pending rows
  // group under their CONFIRMED side — the truthful one until the reconciler
  // says otherwise.
  const liveGroups = useMemo(() => {
    if (filter !== "live") return null;
    const byId = new Map();
    for (const p of products) if (p?.id) byId.set(p.id, p);
    const on = [];
    const off = [];
    for (const [pid, n] of Object.entries(nodes)) {
      if (!n || normalizedState(n) !== "live") continue;
      const p = byId.get(pid);
      if (!p) continue;
      if (q && !(String(p.name || "").toLowerCase().includes(q) ||
                 String(n.cleanName || "").toLowerCase().includes(q))) continue;
      (isOn(n) ? on : off).push(p);
    }
    const cmp = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
    on.sort(cmp); off.sort(cmp);
    return [
      { key: "__liveOn",  label: "On — visible to customers", list: on },
      { key: "__liveOff", label: "Off — on Shopify, not published", list: off },
    ];
  }, [filter, products, nodes, q]);

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
            setSectionError(`${failed.length} product record(s) didn't load — reopen the section or adjust the search to retry`);
          } else {
            setSectionError(null); // a clean batch clears the stale banner
          }
        })
        .catch((e) => {
          for (const pid of want) requestedPids.current.delete(pid);
          setSectionError(String(e?.message || e));
        });
    }
  }, [viewSections, keys, open, q]); // eslint-disable-line react-hooks/exhaustive-deps

  // The reconciler runs in Junid's terminal, outside this session — without a
  // listener (deliberately: reads stay one-shot and partial) the pending
  // marker would only ever clear on a full reload. Window focus is the
  // natural "I ran the script, back to the page" moment: refetch ONLY the
  // pids currently pending (a handful of bodies, never the node).
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onFocus = () => {
      const pendingPids = Object.entries(nodes)
        .filter(([, n]) => isPendingSwitch(n))
        .map(([pid]) => pid);
      if (!pendingPids.length) return;
      loadNodesFor(pendingPids)
        .then(({ nodes: got, failed }) => {
          setNodes((prev) => {
            const next = { ...prev };
            for (const pid of pendingPids) if (!failed.includes(pid)) next[pid] = got[pid] || null;
            return next;
          });
          setPipeline((prev) => {
            if (!prev) return prev;
            const next = { ...prev };
            for (const pid of pendingPids) {
              if (failed.includes(pid)) continue;
              const n = got[pid];
              if (n && normalizedState(n) !== "awaiting") next[pid] = n; else delete next[pid];
            }
            return next;
          });
        })
        .catch(() => {}); // a failed refresh just keeps showing pending
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [nodes]);

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
    // Keep the pipeline map (which prices the live/blocked filter counts) in
    // step with the write — otherwise a fresh block is invisible to the
    // Blocked filter, and an unblock leaves a phantom count behind.
    setPipeline((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      if (node && normalizedState(node) !== "awaiting") next[pid] = node;
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
    if (filter === "live") return; // the On/Off groups have no review walk
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
      // wholly condition-only nodes would be skipped here and reached by a
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

  // One section/group header row — the home list's row treatment (RoleCard):
  // name, right-aligned count badge, chevron. Shared by the category sections
  // and the Live view's On/Off groups.
  const sectionHeader = (key, label, count, opened) => (
    <div onClick={() => toggle(key)}
      style={{ display: "flex", alignItems: "center", gap: 11, padding: "13px 2px",
               cursor: "pointer", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      <div style={{ flex: 1, fontSize: 15, fontWeight: 500, color: "rgba(255,255,255,.9)" }}>{label}</div>
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
  );

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
        {sectionError && (
          <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px" }}>
            {sectionError}
          </div>
        )}
        {!loadError && (!keys || !pipeline) && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading pipeline…</div>
        )}

        {/* LIVE FILTER — the On / Off groups replace the category sections */}
        {keys && pipeline && liveGroups && (
          liveGroups.every((g) => g.list.length === 0) ? (
            <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>
              {q ? "No live products match." : "Nothing on Shopify yet."}
            </div>
          ) : (
            liveGroups.map(({ key, label, list }) => {
              const opened = isOpen(key);
              return (
                <div key={key}>
                  {sectionHeader(key, label, list.length, opened)}
                  {opened && list.length === 0 && (
                    <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px" }}>Nothing here.</div>
                  )}
                  {opened && list.map((p) => (
                    <ProductReviewRow
                      key={p.id}
                      product={p}
                      node={nodes[p.id] || null}
                      onApproved={onApproved}
                      onChanged={applyWrite}
                      onSkip={advanceFrom}
                      inputRef={refFor(p.id)}
                    />
                  ))}
                </div>
              );
            })
          )
        )}

        {keys && pipeline && !liveGroups && viewSections.length === 0 && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>
            {q ? "No products match." : "Nothing to show under this filter."}
          </div>
        )}

        {keys && pipeline && !liveGroups && viewSections.map(({ cat, matched, count, pending }) => {
          const opened = isOpen(cat);
          return (
            <div key={cat}>
              {sectionHeader(cat, cat, count, opened)}

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
