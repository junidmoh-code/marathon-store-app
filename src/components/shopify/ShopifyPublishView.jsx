// ─── SHOPIFY PUBLISHING — THE FULL-PAGE TAB ──────────────────────────────────
// Junid's review surface for the one-way Shopify push. A home-row entry opens
// THIS page: a sticky header (search + tabs) over ONE FLAT LIST.
//
// ── NO CATEGORIES (owner instruction 2026-08-28) ─────────────────────────────
// This page used to group the catalogue into thirty-odd collapsible category
// sections, all collapsed until opened. Categories are a fact about what a
// product IS; publishing only ever asks where it is in the pipeline — so the
// grouping put a heading between the reviewer and every answer, and on a phone
// "what is on the shop" took thirty taps. Now there are two tabs and a lane:
//
//   Live            — published and ON. What a customer can see right now.
//   Awaiting review — everything else, in one list: never reviewed, reviewed
//                     and unpublished, refused, and ON SHOPIFY BUT OFF. That
//                     last group had been filed behind a second collapsed
//                     heading inside the old Live tab, which is where 152
//                     products have been sitting unnoticed — 97 of them
//                     switched off in August to be renamed and never put back
//                     (docs/PUBLISH-AUTO-OFF.md).
//   Suggested names — the vision-naming review lane, unchanged.
//
// The list is NAVIGATION (owner spec 2026-08-14): tapping a row opens that
// product's own full page (ShopifyProductPage, hash route #shopify/{pid} —
// the same list→detail pattern as the admin catalogue's #product/{id} →
// AdminProductDetail in App.jsx). ALL editing lives on the product page —
// name, photos, publish, on/off. The list keeps exactly two kinds of control:
// the condition chips (batch selection needs a grade settable in place — a
// condition-unset row is unselectable) and the batch checkboxes with Publish
// Selected. Back from a product returns here at the same scroll position
// (UserManagement.jsx's listScrollRef treatment) with the same tab, search and
// selection (this component stays mounted under the detail).
//
// Publishing writes desiredState INTENT only. The reconciler
// (scripts/shopify/reconcile.mjs) is what actually talks to Shopify — the
// browser cannot hold the client secret and NEVER calls Shopify — and the row
// shows pending until it confirms.
//
// LOAD DISCIPLINE (hard requirement — this is the read pattern that keeps the
// Firebase bill flat): nothing whole-node, nothing eager. Losing the sections
// did NOT loosen it; the WINDOW took over their job.
//   · The catalogue itself arrives via the app-wide /products subscription in
//     App.jsx (the `products` prop) — this page adds NO catalogue read.
//   · /shopify_publish is read in three partial slices (see the store):
//     indexed per-state queries for the pipeline, a REST shallow KEY list for
//     the awaiting-review counts, and per-pid bodies fetched only for the rows
//     actually on screen. Live costs nothing extra at all — every live node
//     arrives in the mount query. Thumbnails carry loading="lazy".
//
// Structure and styling match the existing full-page views: the top bar and
// Thumb follow LabelPrintView.jsx, rows use the home list's separator
// treatment (RoleCard in App.jsx), and every colour/spacing value comes from
// stock/ui.js. Writes go ONLY to /shopify_publish, through the store.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, BLUE_L, GLASS_SOLID, tabOn, tabOff, input as inputStyle, bBlue, bGray, bGreen } from "../stock/ui";
import {
  CONDITIONS, STATE_FILTERS, checkCleanName, blockStatus, reviewStateFor, publishTabFor,
  pendingProposal, proposalApplyBlocker,
  normalizedState, isOn, isPendingSwitch, batchSelectBlocker, effectivePhotoList, effectiveNameFor,
  isPublishableProduct,
} from "./shopifyPublishCore";
import { describeOff } from "./publishAudit";
import { RECONCILE_MAX_APPLY } from "./publishShared";
import { topCategory, UNCATEGORIZED_TOP } from "../../utils/productCategory.js";
import {
  loadPipelineNodes, loadPublishKeys, loadNodesFor, publishProduct, setCondition,
  applyNameProposal, dismissNameProposal, loadProposalPage,
} from "./shopifyPublishStore";
import ShopifyProductPage from "./ShopifyProductPage";

const UNCAT = "Uncategorised";

// How often the page re-asks whether a pending intent has been applied. Only
// ticks while something IS pending, and only for those pids — see the pending
// refresh below. 20s is the reconciler's own granularity: a run takes tens of
// seconds per product, so anything faster just re-reads the same answer.
const PENDING_POLL_MS = 20000;

// How many rows of a flat list render at once. Every visible row costs one
// point read of its publishing node, so this is a bandwidth number as much as
// a rendering one: it is the size of the fetch a tab change makes. A screenful
// on a phone is about a dozen rows, so 60 is several scrolls' worth in hand
// without ever approaching the whole-node read this page refuses to make.
const PAGE_SIZE = 60;

// `#shopify/{pid}` is the product-page route — the publishing twin of the
// admin catalogue's #product/{id}. Returns null when the hash is anything
// else.
function parseShopifyHash() {
  if (typeof window === "undefined") return null;
  const m = (window.location.hash || "").match(/^#shopify\/(.+)$/);
  return m ? m[1] : null;
}

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
// Shows the PUBLISHING primary (first of the effective photo set), so a
// custom-ordered set changes what the row leads with — the thumb never lies
// about what the storefront would lead with.
function Thumb({ p, node }) {
  const primary = effectivePhotoList(p, node).photos[0];
  if (primary) {
    return <img src={primary} alt="" loading="lazy"
                style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 10, flexShrink: 0 }}
                onError={(e) => { e.currentTarget.style.display = "none"; }} />;
  }
  return <div style={{ width: 44, height: 44, borderRadius: 10, background: "rgba(120,150,255,.08)",
                       display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>{p?.photo || "👟"}</div>;
}

// ─── PROPOSED-NAME ROW ───────────────────────────────────────────────────────
// One product under the "Proposed names" filter: the photo, the name it has
// now, the name read off that photo, and the two decisions. Deliberately NOT
// ProductListRow — that row is built around publishing (state chip, condition
// chips, batch checkbox) and none of it is the question being asked here. The
// question is only ever "is this name better than that one", and the row shows
// exactly the two strings that answer it.
//
// The thumbnail is not decoration: the proposal was written from that photo,
// so the photo is the evidence. Tapping the row still opens the product page
// for anyone who wants the rest of the picture.
export function ProposalRow({ product, node, busy, onOpen, onApply, onDismiss }) {
  const proposal = pendingProposal(node);
  if (!proposal) return null;
  const gate = proposalApplyBlocker(node);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "11px 2px",
                  borderBottom: "1px solid rgba(255,255,255,.06)" }}>
      {/* THE NAVIGABLE PART, and only it — the same treatment ProductListRow
          uses, for the same reasons. A keyboard user must be able to reach the
          product page from this lane; without it the identity guess, the
          confidence and the photos are mouse-only (reviewer finding). It holds
          NO other control: role="button" makes its descendants presentational
          to assistive technology, and a keydown from a nested button bubbles
          here, where preventDefault would cancel that button's activation. The
          two decision buttons are therefore SIBLINGS below, not children. */}
      <div onClick={() => onOpen(product.id)}
        role="button"
        tabIndex={0}
        aria-label={`Open ${proposal.name}`}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
          e.preventDefault();
          onOpen(product.id);
        }}
        style={{ display: "flex", gap: 11, alignItems: "flex-start", minWidth: 0, cursor: "pointer" }}>
        <Thumb p={product} node={node} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", lineHeight: 1.35,
                        overflowWrap: "break-word" }}>
            {proposal.name}
          </div>
          <div style={{ fontSize: 11, color: GRAY, marginTop: 3, overflowWrap: "break-word" }}>
            replaces {proposal.previousName ? `“${proposal.previousName}”` : "no listing name"}
          </div>
        </div>
      </div>
      <div style={{ paddingLeft: 55 }}>
        {!gate.ok && <div style={{ fontSize: 10.5, color: RED, marginBottom: 5 }}>{gate.reason}</div>}
        <div style={{ display: "flex", gap: 7 }}>
          <button disabled={busy || !gate.ok} onClick={() => onApply(product.id, proposal.proposedAt)}
            style={{ ...bBlue, padding: "5px 10px", fontSize: "0.68rem",
                     opacity: busy || !gate.ok ? 0.5 : 1 }}>
            Use this name
          </button>
          <button disabled={busy} onClick={() => onDismiss(product.id, proposal.proposedAt)}
            style={{ ...bGray, padding: "5px 10px", fontSize: "0.68rem" }}>
            Keep the old one
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── BATCH CONFIRMATION ──────────────────────────────────────────────────────
// The SAME going-live confirmation as the product page's single publish —
// same overlay, same Cancel-default-focus, same "public storefront" statement
// — listing every product about to go on, each under its cleaned name (every
// one is a compliance decision; the list is the last look). A batch of N is N
// independent publish intents: the reconciler validates each product on its
// own and any one can be refused (blocked) without touching the others.
function BatchPublishConfirmDialog({ items, busy, onCancel, onConfirm }) {
  const cancelRef = useRef(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  // Escape CANCELS, same as the single-publish dialog — every reflex key
  // press does the safe thing.
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onKey = (e) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <div onClick={onCancel}
      style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.62)",
               backdropFilter: "blur(5px)", WebkitBackdropFilter: "blur(5px)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-label="Put products on the public storefront?"
        style={{ ...GLASS_SOLID, width: "100%", maxWidth: 460, padding: "22px 20px", fontFamily: FONT }}>
        <div style={{ fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700 }}>
          Put {items.length} product{items.length === 1 ? "" : "s"} on the public storefront?
        </div>
        <div style={{ maxHeight: "42vh", overflowY: "auto", marginTop: 12 }}>
          {items.map((it) => (
            <div key={it.pid} style={{ padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", lineHeight: 1.3, overflowWrap: "break-word" }}>
                {it.name}
              </div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,.75)", marginTop: 2 }}>
                {it.condition} · {it.price}
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 12, lineHeight: 1.45 }}>
          Every product above becomes publicly visible on the online store, under exactly the
          name shown. Check each name once more — the names are what the compliance rules protect.
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
          <button ref={cancelRef} onClick={onCancel} disabled={busy} style={{ ...bGray, flex: 1 }}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={{ ...bGreen, flex: 1 }}>
            {busy ? "Saving…" : `Put ${items.length} live`}
          </button>
        </div>
      </div>
    </div>
  );
}

// One product's list row — a NAVIGATION target (tap → the product page), not
// an editor. What stays interactive in place, and why:
//   · the batch checkbox (`selection`, optional: { selected, blocker, atCap,
//     onToggle }) — blocker non-null ⇒ disabled with the reason inline, never
//     a silent skip; styling matches the SpecialsTab batch rows (PR #355);
//   · the condition chips — batch selection refuses a condition-unset row, so
//     the grade must be settable without leaving the list (hidden only while
//     the listing is ON, when the store refuses the write anyway).
// Everything else — name, photos, publish, on/off, cancel — lives on the
// product page. The row still TELLS the whole story: state chip, cleaned
// name (read-only), publishing photo count, the pending "waiting for the
// reconciler" sentence, the blocked reason, and the live row's went-live
// date + Shopify admin link.
function ProductListRow({ product, node, onOpen, onChanged, selection }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const effective = effectiveNameFor(product, node);
  const state = reviewStateFor(node);
  const on = isOn(node);
  const pending = isPendingSwitch(node);
  const photoCount = effectivePhotoList(product, node).photos.length;
  // The block is judged against the name the product has NOW — a refusal
  // recorded under a name it no longer carries is not a block (blockStatus).
  const { blocked, staleNote } = blockStatus(node, effective.name);
  const nameVerdict = checkCleanName(effective.name);
  // Why this product came off the shop, in one sentence — null while it is on.
  const offStory = state === "live" && !on ? describeOff(node) : null;

  const setGrade = async (c) => {
    setBusy(true); setError(null);
    try {
      const res = await setCondition(product.id, node, c);
      if (!res?.ok) { setError(res?.message || "Not saved."); return; }
      onChanged(product.id, res.node);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 11, padding: "12px 2px", borderBottom: "1px solid rgba(255,255,255,.04)" }}>
      {selection && (
        <input type="checkbox"
          checked={selection.selected}
          disabled={busy || !!selection.blocker || (selection.atCap && !selection.selected)}
          onChange={selection.onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${product.name || product.id} for batch publish`}
          title={selection.blocker || (selection.atCap && !selection.selected
            ? `Selection is capped at ${RECONCILE_MAX_APPLY} per batch` : undefined)}
          style={{ width: 16, height: 16, accentColor: BLUE_L, cursor: selection.blocker ? "not-allowed" : "pointer",
                   flexShrink: 0, alignSelf: "center", opacity: selection.blocker ? 0.4 : 1 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* THE NAVIGABLE PART, and only it. Since the product page took over
            the name, the photos, Publish and the on/off switch, a row that
            only answered to a mouse would put every editing action out of a
            keyboard user's reach — so this carries real button semantics.
            It deliberately holds NO other control: an element with
            role="button" makes its descendants presentational to assistive
            technology, and a keydown from a nested button bubbles here, where
            preventDefault would cancel that button's own activation. The
            condition chips and the admin link are therefore SIBLINGS below,
            not children (reviewer findings, 2026-08-14). */}
        <div onClick={() => onOpen(product.id)}
          role="button"
          tabIndex={0}
          aria-label={`Open ${effective.name || product.name || product.id}`}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
            e.preventDefault();
            onOpen(product.id);
          }}
          style={{ display: "flex", gap: 11, minWidth: 0, cursor: "pointer" }}>
          <Thumb p={product} node={node} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: "rgba(255,255,255,.3)",
                            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {product.name}
              </div>
              <StateChip chip={chipFor(state, node)} />
            </div>
            {/* The name a publish would ship — read-only here; the page edits it. */}
            {effective.name ? (
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginTop: 5, lineHeight: 1.3,
                            overflowWrap: "break-word" }}>
                {effective.name}
                {!nameVerdict.ok && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: RED, marginLeft: 7 }}>
                    {nameVerdict.problems.join(" · ")}
                  </span>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: GRAY, marginTop: 5 }}>
                needs a name{effective.reason ? ` — ${effective.reason}` : ""} — tap to fix
              </div>
            )}
          </div>
          <span style={{ color: "rgba(255,255,255,.18)", fontSize: 14, alignSelf: "center", flexShrink: 0 }}>›</span>
        </div>

        {/* Everything below sits OUTSIDE the navigable element, indented to
            the thumbnail's width so the column still reads as one row. */}
        <div style={{ marginLeft: 55 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 5, marginTop: 7 }}>
            {!(state === "live" && on) && CONDITIONS.map((c) => (
              <button key={c} disabled={busy}
                onClick={() => setGrade(c)}
                style={{ ...(node?.condition === c ? tabOn : tabOff), padding: "4px 9px", fontSize: "0.68rem" }}>
                {c.split(" — ")[0]}
              </button>
            ))}
            <span style={{ fontSize: 10.5, color: GRAY }}>
              {photoCount} photo{photoCount === 1 ? "" : "s"}
            </span>
          </div>
          {pending && (
            // The plain sentence is deliberate (owner feedback 2026-08-14):
            // the chip alone read as "in progress", and Junid didn't know a
            // separate reconciler run had to happen before anything reached
            // Shopify. Cancelling lives on the product page.
            <div style={{ fontSize: 10.5, color: BLUE_L, marginTop: 5 }}>
              Saved — waiting for the reconciler run to {state === "live" ? "update Shopify" : "send it to Shopify"}.
            </div>
          )}
          {selection?.blocker && (
            <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>
              Can't batch-select — {selection.blocker}.
            </div>
          )}
          {node?.condition && state === "live" && on && (
            <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>{node.condition}</div>
          )}
          {state === "live" && (
            // The live row's provenance line: when it went ON (the
            // reconciler's liveAt stamp) and the direct Shopify admin link.
            //
            // OFF ROWS SAY WHY, AND WHEN. "On Shopify, not published" was all
            // this line ever said, and it is the sentence 97 products have
            // been sitting behind since 22 August — switched off so their
            // brand-leaking names could be changed, renamed, and never put
            // back (docs/PUBLISH-AUTO-OFF.md). describeOff is the one builder
            // for that sentence; it degrades honestly for a node that went off
            // before the audit shipped.
            <div style={{ fontSize: 10, color: GRAY, marginTop: 4 }}>
              {on
                ? (node?.liveAt ? `Went live ${new Date(node.liveAt).toLocaleDateString()}` : "Live")
                : (offStory?.text || "On Shopify, not published")}
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
          {staleNote && (
            <div style={{ fontSize: 10.5, color: GRAY, marginTop: 5 }}>{staleNote}</div>
          )}
          {error && <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>{error}</div>}
        </div>
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
    // Price records are not merchandise and never enter the review flow, so
    // counting them would leave the home badge permanently 35 too high with
    // nothing on the page to work off.
    for (const p of products || []) if (p?.id && isPublishableProduct(p) && !keys.has(p.id)) n += 1;
    return n;
  }, [enabled, keys, products]);
}

export default function ShopifyPublishView({ products = [], onExit }) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Opens on Awaiting review — the work. "All" is gone with the categories,
  // and the home badge this page is reached from counts exactly this tab, so
  // landing anywhere else would answer a different question than the one that
  // was tapped.
  const [filter, setFilter] = useState("awaiting");

  // The search drives section matching (and, when narrow enough, section
  // auto-open + body fetches) — debounce it so a fast typist doesn't fan out
  // work on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [keys, setKeys] = useState(null);          // Set<pid> — pids with ANY node
  const [pipeline, setPipeline] = useState(null);  // {pid: node} for live/blocked (+legacy)
  // Batch publish (owner spec 2026-08-14): selection lives at page level so it
  // survives collapsing a section; capped at the reconciler's per-run cap.
  const [selected, setSelected] = useState(() => new Set());
  const [batchNotice, setBatchNotice] = useState(null);
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [nodes, setNodes] = useState({});          // every node body this session has loaded
  const [loadError, setLoadError] = useState(null);       // mount reads failed — page unusable
  const [sectionError, setSectionError] = useState(null); // a body batch failed — clears on the next good batch
  const requestedPids = useRef(new Set());         // in-flight/done per-pid body fetches

  // ── Product-page routing (hash-driven, matching AdminProductDetail) ────────
  // #shopify/{pid} opens the product page, browser back clears it. The list
  // stays mounted underneath (this component keeps rendering), so open
  // sections, filter, search and batch selection all survive the round trip;
  // the scroll position is saved on open and restored on return
  // (UserManagement.jsx's listScrollRef treatment).
  const [detailPid, setDetailPid] = useState(() => parseShopifyHash());
  const listScrollRef = useRef(0);
  useEffect(() => {
    const onHashChange = () => setDetailPid(parseShopifyHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  // The pid THIS view pushed onto the history stack, if any. Back can only
  // safely pop when the product on screen is the one we pushed.
  const pushedPid = useRef(null);
  const openProduct = (pid) => {
    listScrollRef.current = window.scrollY;
    pushedPid.current = pid;
    window.location.hash = "shopify/" + pid;
    // The document keeps its offset across the swap, so a row tapped far down
    // the list would open the product already scrolled past its photos —
    // which are its first section. Open at the top; the list's own position
    // is remembered above and restored on the way back.
    window.scrollTo(0, 0);
  };
  // Back to the list. Pop the history entry only when it is OURS — i.e. this
  // product is the one a row tap pushed. Anything else (a tab opened straight
  // onto a shared #shopify/{pid} link, a hand-edited address bar) has no
  // in-app entry to pop: history.back() would either do nothing, stranding
  // the page with a dead Back button, or leave the app entirely for whatever
  // the tab was showing before. Clearing the hash always lands on the list.
  // (window.history.length can't answer this — it counts the whole tab's
  // history, including pages from other sites.)
  const backToList = () => {
    if (pushedPid.current && pushedPid.current === detailPid) {
      pushedPid.current = null;
      window.history.back();
    } else {
      window.location.hash = "";
    }
  };
  const prevDetailPid = useRef(detailPid);
  useEffect(() => {
    if (prevDetailPid.current && !detailPid) {
      requestAnimationFrame(() => window.scrollTo(0, listScrollRef.current));
    }
    prevDetailPid.current = detailPid;
  }, [detailPid]);

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

  // The ONE publishable-product index for this page: the sections, the Live
  // groups, the product-page route and the batch dialog all read it, so a price
  // record is absent from every one of them for the same reason. Declared here,
  // above its first consumer (liveGroups) — a later `const` would be in the
  // temporal dead zone when that memo runs.
  const productById = useMemo(() => {
    const m = new Map();
    for (const p of products) if (p?.id && isPublishableProduct(p)) m.set(p.id, p);
    return m;
  }, [products]);

  // ─── ONE FLAT LIST PER TAB ────────────────────────────────────────────────
  // Categories are gone (owner instruction 2026-08-28). They grouped the
  // catalogue by a fact the publishing job never asks about, and thirty
  // collapsible headings on a phone meant "what is on the shop" took thirty
  // taps to answer. Each tab is now one list, sorted by the name the listing
  // ships under — the string the reviewer is actually reading.
  //
  // READ ECONOMY IS UNCHANGED, and it had to be: this page's whole discipline
  // is never pulling /shopify_publish whole.
  //   · Live reads NOTHING extra. The pipeline query already loaded every
  //     live node at mount, and a live product is on-the-shop by its node.
  //   · Awaiting is WINDOWED. Bodies are fetched for the rows on screen and
  //     nothing else (the effect below), so a 2,700-row list costs the same
  //     as one screen of it until somebody asks for more.
  // THE SEARCH READS THE ORIGINAL NAME (owner instruction 2026-08-28): the
  // catalogue name staff know from the box label and barcode — "Sneaker Bad
  // Bunny x Indoor Benito" — never the cleaned listing name the website shows.
  // The person searching is holding the shoe, not reading the storefront.
  // Style codes match too, because that is the other string on the label.
  const q = debouncedQuery.trim().toLowerCase();
  const matchesQuery = useCallback((p) => {
    if (!q) return true;
    return String(p.name || "").toLowerCase().includes(q) ||
           String(p.styleCode || "").toLowerCase().includes(q);
  }, [q]);

  // ── THE SORT KEY MUST NOT BE SOMETHING THE WINDOW FETCHES ─────────────────
  // This sorted on the LISTING name, which comes from the node — and the nodes
  // are exactly what the window goes and fetches for the rows it is showing. So
  // every batch of bodies re-sorted the list, changed which products fell
  // inside the window, and sent the effect after a fresh set: a feedback loop
  // that terminates only because a pid is never fetched twice, having walked an
  // unbounded slice of a 3,600-product catalogue to get there. On this page, of
  // all pages (CodeRabbit review, 2026-08-28).
  //
  // The catalogue name is already in hand for every product, costs nothing, and
  // never moves under us — so the window is settled from the first render and
  // fetches exactly the rows it shows. It is also the name staff know and the
  // one the row's top line carries.
  const byCatalogueName = useCallback((a, b) =>
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }) ||
    String(a.id).localeCompare(String(b.id)), []);

  // LIVE — published and on. Built from NODES, not from a catalogue walk: the
  // question "what can a customer see" is answered by the node, and every one
  // of them is already in hand from the mount query.
  const liveList = useMemo(() => {
    if (filter !== "live") return null;
    const out = [];
    for (const [pid, n] of Object.entries(nodes)) {
      if (!isOn(n)) continue;
      // productById, never a fresh walk — it is the one index that keeps a
      // price record out of every list on this page.
      const p = productById.get(pid);
      if (!p || !matchesQuery(p)) continue;
      out.push(p);
    }
    return out.sort(byCatalogueName);
  }, [filter, nodes, productById, matchesQuery, byCatalogueName]);

  // AWAITING REVIEW — everything that is not on the shop. Never reviewed,
  // reviewed and unpublished, refused, and ON SHOPIFY BUT OFF: that last group
  // is the 152 nodes the old Live tab filed under a second collapsed heading,
  // including the 97 switched off in August to be renamed and never put back.
  // They are not live and they are not finished, so they belong here.
  //
  // A product whose body has not loaded yet is INCLUDED. Its tab is decided by
  // publishTabFor(undefined) → "awaiting", which is right: a node we have not
  // read cannot be on the storefront, because every on node arrived at mount.
  //
  // ── THE CATALOGUE, BACK (owner instruction 2026-08-28) ────────────────────
  // Not as the thirty collapsed sections #492 removed — as FILTER CHIPS over
  // the same flat windowed list: pick a department (Footwear / Clothing / …),
  // optionally a shelf inside it (Sneakers, T-Shirts, …), and the list narrows.
  // One tap to a department instead of thirty to an answer, and the read
  // discipline is untouched: chips only filter what membership already
  // computed from fields in hand — no node body is fetched for a count.
  // catSub resets IN THE SAME STATE UPDATE as the department change (pickTop
  // below), never in an effect: an effect fires after the commit that used the
  // stale pair, so Clothing→Tees → tap Footwear would paint one frame filtered
  // on "Footwear AND Tees" — an empty list lying "nothing matches" — before
  // correcting itself (reviewer finding, 2026-08-28).
  const [catTop, setCatTop] = useState("all");
  const [catSub, setCatSub] = useState("all");
  const pickTop = useCallback((top) => { setCatTop(top); setCatSub("all"); }, []);

  // Membership first (tab logic only), then the chips are counted from it,
  // then search + catalogue narrow it. Counting after the query would make
  // every chip's number jump on each keystroke.
  const awaitingAll = useMemo(() => {
    if (filter !== "awaiting") return null;
    const out = [];
    for (const p of productById.values()) {
      if (publishTabFor(nodes[p.id]) !== "awaiting") continue;
      out.push(p);
    }
    return out;
  }, [filter, productById, nodes]);

  // Department chips (top-level category), and shelf chips within the picked
  // department. Both from the catalogue fields already in hand.
  const catalogueTops = useMemo(() => {
    if (!awaitingAll) return null;
    const counts = new Map();
    for (const p of awaitingAll) {
      const t = topCategory(p);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    // Stable, meaningful order: the real departments first, Uncategorized last.
    return [...counts.entries()].sort((a, b) =>
      (a[0] === UNCATEGORIZED_TOP) - (b[0] === UNCATEGORIZED_TOP) || b[1] - a[1]);
  }, [awaitingAll]);
  const catalogueSubs = useMemo(() => {
    if (!awaitingAll || catTop === "all") return null;
    const counts = new Map();
    for (const p of awaitingAll) {
      if (topCategory(p) !== catTop) continue;
      const s = String(p.subcategory || "").trim() || "No shelf";
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [awaitingAll, catTop]);

  const awaitingList = useMemo(() => {
    if (!awaitingAll) return null;
    return awaitingAll.filter((p) => {
      if (catTop !== "all" && topCategory(p) !== catTop) return false;
      if (catSub !== "all") {
        const s = String(p.subcategory || "").trim() || "No shelf";
        if (s !== catSub) return false;
      }
      return matchesQuery(p);
    }).sort(byCatalogueName);
  }, [awaitingAll, catTop, catSub, matchesQuery, byCatalogueName]);

  const fullList = liveList || awaitingList;

  // ─── THE PROPOSED-NAMES LANE: ITS OWN READ, ON DEMAND AND BOUNDED ──────────
  // Selecting the lane is what fetches it, and it fetches in pages. Awaiting
  // nodes are the big set (one per proposal, growing toward one per catalogue
  // product); pulling them at mount for every visit to this page would be the
  // whole node arriving through the index, which is the exact bandwidth class
  // this page is built to avoid. Pages fold into `nodes`, so a decided row
  // leaves the lane through the same path every other write uses.
  const [proposalsLoaded, setProposalsLoaded] = useState(false);
  const [proposalPage, setProposalPage] = useState({ lastKey: null, done: false, loading: false });
  // In-flight guard as a REF for the same reason the auto-load uses one: the
  // `loading` flag commits asynchronously, so between a click and the re-render
  // that disables the button a second click gets through and fetches the same
  // cursor twice. Harmless (the fold is FILL-only) but it is a wasted read of
  // 300 nodes, and this page's whole discipline is not making those.
  const proposalLoading = useRef(false);
  const loadMoreProposals = useCallback(async ({ fromStart = false } = {}) => {
    if (proposalLoading.current) return;
    proposalLoading.current = true;
    setProposalPage((p) => (p.loading ? p : { ...p, loading: true }));
    try {
      const { nodes: got, lastKey, done } = await loadProposalPage({
        after: fromStart ? null : proposalPage.lastKey,
      });
      setNodes((prev) => {
        const next = { ...prev };
        // FILL, never overwrite — a write committed while this read was in
        // flight holds the newer node, exactly as the section fetch does.
        for (const [pid, n] of Object.entries(got)) if (prev[pid] === undefined) next[pid] = n;
        return next;
      });
      // STORED AS RETURNED, null included. The `?? p.lastKey` that used to be
      // here was written when null meant "no new key"; since loadProposalPage
      // started returning null to MEAN FINISHED, that fallback quietly put the
      // spent cursor back — defeating the very contract it was paired with
      // (reviewer finding). The store is the authority on what the cursor is.
      setProposalPage({ lastKey, done, loading: false });
      setProposalsLoaded(true);
    } catch (e) {
      setProposalPage((p) => ({ ...p, loading: false }));
      setProposalError(String(e?.message || e));
      setProposalsLoaded(true);
    } finally {
      proposalLoading.current = false;
    }
  }, [proposalPage.lastKey]);

  // A REF, not the state flags. The auto-load must fire exactly once, and the
  // state it would have to guard on (loading, loaded, lastKey) is set
  // asynchronously — so between the effect firing and its first setState
  // committing, a re-render for any other reason re-enters and fetches a
  // second page nobody asked for. A ref flips synchronously and cannot race.
  const proposalsRequested = useRef(false);
  // A ref so restartProposalWalk can reach the CURRENT loader without taking
  // it as a dependency (which would rebuild the callback on every page).
  // ASSIGNED IN AN EFFECT, not during render: React may discard a render, and
  // a ref written during one keeps a callback that was never committed
  // (reviewer finding). The effect only runs for renders that survived.
  const loadMoreProposalsRef = useRef(loadMoreProposals);
  useEffect(() => { loadMoreProposalsRef.current = loadMoreProposals; }, [loadMoreProposals]);

  useEffect(() => {
    if (filter !== "proposed" || proposalsRequested.current) return;
    proposalsRequested.current = true;
    loadMoreProposals();
  }, [filter, loadMoreProposals]);

  // Walk the range again from the top. The only way to see a suggestion whose
  // product sorts BEHIND wherever the last pass got to — which is every
  // product the naming runner stamps while this page is open, because a
  // product's key is its creation time and not its arrival in the queue.
  const restartProposalWalk = useCallback(() => {
    if (proposalLoading.current) return;
    setProposalPage({ lastKey: null, done: false, loading: false });
    setProposalError(null);
    loadMoreProposalsRef.current({ fromStart: true });
  }, []);

  // ─── THE PROPOSED-NAMES LANE ───────────────────────────────────────────────
  // Built from NODES, exactly like liveGroups and for the same reason: the
  // question "which products have a name waiting" is answered by the node, and
  // walking the catalogue's category sections to find them would need a body
  // for every product on the page. The pipeline query already holds every
  // proposal-carrying node — the runner stamps state:"awaiting" on any node it
  // touches that has none, so all of them land inside the ONE index that
  // exists (.indexOn ["state"]) and the lane costs no extra read.
  //
  // Sorted by when the proposal was made, oldest first: a run's output is
  // reviewed in the order it was produced, so a session that stops halfway
  // resumes where it stopped instead of re-reading the same names.
  const proposedList = useMemo(() => {
    if (filter !== "proposed") return null;
    if (!proposalsLoaded) return [];
    const out = [];
    for (const [pid, n] of Object.entries(nodes)) {
      if (!pendingProposal(n)) continue;
      const p = productById.get(pid);
      if (!p) continue;
      // Same matcher as the tabs: the ORIGINAL catalogue name and style code,
      // never the cleaned/proposed listing text — see matchesQuery above.
      if (!matchesQuery(p)) continue;
      out.push(p);
    }
    out.sort((a, b) =>
      (Number(nodes[a.id]?.nameProposal?.proposedAt) || 0) -
      (Number(nodes[b.id]?.nameProposal?.proposedAt) || 0));
    return out;
  }, [filter, productById, nodes, matchesQuery, proposalsLoaded]);

  // ─── THE WINDOW ───────────────────────────────────────────────────────────
  // A flat Awaiting list is ~2,700 rows. Rendering them all would be slow on a
  // phone and, far worse, would fetch a node body for every one — the eager
  // whole-node read this page exists to avoid. So the list is windowed: a
  // screenful at a time, extended by a tap.
  //
  // Reset on a tab change and on a new search, because "show 60 more" means
  // nothing against a list you are no longer looking at.
  const [shown, setShown] = useState(PAGE_SIZE);
  useEffect(() => { setShown(PAGE_SIZE); }, [filter, q, catTop, catSub]);
  const visible = useMemo(() => (fullList ? fullList.slice(0, shown) : null), [fullList, shown]);
  // Pids whose body read FAILED. They must not count as pending: a read that
  // errored is never coming back on its own — the effect below is keyed on the
  // window and the window has not changed — so counting it would hold the tab
  // on "Loading…" for ever, hiding every row AND the retry, on one transient
  // network blip (Codex review, 2026-08-28). The banner says what happened and
  // the button re-arms the read.
  const [failedBodies, setFailedBodies] = useState(() => new Set());
  // Cleared on a tab change AND on a new search: both rebuild the window, and a
  // pid carried over as "failed" would render its row from a null node — saying
  // "awaiting review" about a product whose body simply did not arrive.
  useEffect(() => { setFailedBodies(new Set()); }, [filter, q, catTop, catSub]);
  const retryBodies = useCallback(() => {
    for (const pid of failedBodies) requestedPids.current.delete(pid);
    setFailedBodies(new Set());
    setSectionError(null);
  }, [failedBodies]);
  // Rows render only once every visible body is in hand — a row that mounted
  // without its node would show "awaiting review" for a product that is live,
  // and then flip.
  const pendingBodies = useMemo(
    () => (visible && keys
      ? visible.filter((p) => keys.has(p.id) && nodes[p.id] === undefined && !failedBodies.has(p.id)).length
      : 0),
    [visible, keys, nodes, failedBodies]
  );

  // Bodies for exactly the rows on screen, and nothing else. Tracked PER PID so
  // extending the window fetches only the new slice, and a missing body is
  // recorded as null so `pendingBodies` can settle.
  useEffect(() => {
    if (!keys || !visible) return;
    const want = visible
      .filter((p) => keys.has(p.id) && nodes[p.id] === undefined && !requestedPids.current.has(p.id))
      .map((p) => p.id);
    // NOTE the requestedPids guard above is what stops this effect looping: it
    // is written synchronously, before the async read, and the read's own
    // setNodes is what the effect re-runs on.
    if (!want.length) return;
    for (const pid of want) requestedPids.current.add(pid);
    loadNodesFor(want)
      .then(({ nodes: got, failed }) => {
        setNodes((prev) => {
          const next = { ...prev };
          for (const pid of want) {
            // FILL, never overwrite: a write committed while this batch was
            // in flight holds the NEWER node (the store returns it), and a
            // late read would silently roll it back.
            if (!failed.includes(pid) && prev[pid] === undefined) next[pid] = got[pid] || null;
          }
          return next;
        });
        if (failed.length) {
          setFailedBodies((prev) => { const next = new Set(prev); for (const pid of failed) next.add(pid); return next; });
          setSectionError(`${failed.length} product record(s) didn't load.`);
        } else {
          setSectionError(null); // a clean batch clears the stale banner
        }
      })
      .catch((e) => {
        setFailedBodies((prev) => { const next = new Set(prev); for (const pid of want) next.add(pid); return next; });
        setSectionError(String(e?.message || e));
      });
    // failedBodies IS a dependency, and it is the one that makes Try again
    // work: clearing the set is the ONLY state that changes on a retry — the
    // window, the keys and the nodes are all identical — so without it here
    // the button would clear the flags and re-fire nothing at all. (Caught
    // checking my own fix for the wedge Codex found; the mutation proof for
    // it is the "failed body read" render test.)
  }, [visible, keys, nodes, failedBodies]);

  // The product page needs ITS body even when no section fetched it — a
  // direct landing on #shopify/{pid} (reload, shared link) skips the
  // on-expand path entirely. Same per-pid tracking, same null-for-missing
  // convention, so the page's readiness gate can settle.
  useEffect(() => {
    if (!detailPid || !keys) return;
    if (!keys.has(detailPid) || nodes[detailPid] !== undefined) return;
    if (requestedPids.current.has(detailPid)) return;
    requestedPids.current.add(detailPid);
    loadNodesFor([detailPid])
      .then(({ nodes: got, failed }) => {
        if (failed.length) {
          requestedPids.current.delete(detailPid);
          setSectionError("This product's publishing record didn't load — go back and retry");
          return;
        }
        // FILL, never overwrite — same rule as the section fetch: a write
        // that landed while this read was in flight (applyWrite adds the pid
        // to `keys`, which is what triggers this effect) must survive.
        setNodes((prev) => (prev[detailPid] !== undefined ? prev : { ...prev, [detailPid]: got[detailPid] || null }));
      })
      .catch((e) => {
        requestedPids.current.delete(detailPid);
        setSectionError(String(e?.message || e));
      });
  }, [detailPid, keys, nodes]);

  // ─── KEEPING UP WITH THE RECONCILER ────────────────────────────────────────
  // The reconciler runs OUTSIDE this session, and this page deliberately holds
  // no RTDB listener (reads stay one-shot and partial — that is what keeps the
  // bill flat). So the only way a row learns its intent was applied is to ask.
  //
  // Window focus used to be the ONLY moment it asked, which got the common
  // case exactly backwards: the operator who publishes a batch and then WATCHES
  // — tab focused, never clicking away — is the one who never saw the update.
  // Their rows sat on "publishing…" and stayed in Awaiting review until they
  // clicked to another window and back, or reloaded. Worse on a product page,
  // where a product that had gone live still offered Publish.
  //
  // Now it asks on focus AND on a slow tick, under three limits that keep it
  // inside the page's load discipline:
  //   · ONLY the pending pids — per-pid bodies, never get(/shopify_publish),
  //     and the set is bounded by the batch cap.
  //   · ONLY while something is pending. Nothing pending ⇒ no timer at all ⇒
  //     an idle page makes zero requests, which is the steady state.
  //   · NOT while the tab is hidden — the focus handler covers coming back.
  const pendingPids = useMemo(
    () => Object.entries(nodes).filter(([, n]) => isPendingSwitch(n)).map(([pid]) => pid),
    [nodes]
  );
  const hasPending = pendingPids.length > 0;
  // Read from the long-lived timer/listener closures so neither is re-created
  // on every node change (an interval rebuilt each render would never fire).
  // Both are written in an EFFECT, not during render: React may replay or
  // discard render work, and a ref written there can leak values from a render
  // that never committed. An effect gives exactly the semantics both readers
  // want anyway — the last COMMITTED state.
  const pendingPidsRef = useRef(pendingPids);
  const nodesRef = useRef(nodes);
  useEffect(() => {
    pendingPidsRef.current = pendingPids;
    nodesRef.current = nodes;
  }, [pendingPids, nodes]);
  // Bumped by applyWrite, per pid. Written in the write path (not during
  // render), so it is current the instant the write commits — which is what a
  // read resolving moments later has to compare against.
  const writeGenRef = useRef(Object.create(null));
  // Read ORDER, which the write generation deliberately does not track. Two
  // refreshes can be in flight at once (the interval plus a window-focus one)
  // and they can land out of order; without this, a LATER read that landed
  // FIRST would be overwritten by the earlier, staler one and the row would
  // revert for a whole tick. Object.create(null) on both: a pid is a key, and
  // an inherited "constructor" would silently wedge that pid forever.
  const readSeqRef = useRef(0);
  const appliedSeqRef = useRef(Object.create(null));

  const refreshNodes = useCallback((pids) => {
    if (!pids.length) return;
    // The LOCAL-WRITE generation each pid was on when this read went OUT. The
    // section fetch has a FILL-never-overwrite rule for the same reason; this
    // one has to overwrite (replacing a stale node IS its job), so it needs a
    // sharper test: apply only where no local write has landed underneath.
    // Without it, a Cancel clicked while a read was in flight would be silently
    // rolled back by the older server value and the row would jump to pending.
    //
    // A GENERATION, not the node object: two reads can be in flight at once
    // (the interval plus a window-focus refresh), and comparing objects made
    // the first read's own apply look like a change — so the SECOND, fresher
    // result was discarded and the row sat stale for another whole tick. Only
    // a local write bumps the generation, which is exactly what must invalidate.
    const before = Object.create(null);
    for (const pid of pids) before[pid] = writeGenRef.current[pid] ?? 0;
    const seq = ++readSeqRef.current;
    loadNodesFor(pids)
      .then(({ nodes: got, failed }) => {
        const apply = pids.filter(
          (pid) => !failed.includes(pid)
            && (writeGenRef.current[pid] ?? 0) === before[pid]   // no local write landed
            && seq > (appliedSeqRef.current[pid] ?? 0));          // and nothing NEWER already did
        if (!apply.length) return;
        for (const pid of apply) appliedSeqRef.current[pid] = seq;
        setNodes((prev) => {
          const next = { ...prev };
          for (const pid of apply) next[pid] = got[pid] || null;
          return next;
        });
        // The pipeline map prices the Live and Blocked filter counts; letting
        // it drift would leave a phantom count behind a row that has moved on.
        setPipeline((prev) => {
          if (!prev) return prev;
          const next = { ...prev };
          for (const pid of apply) {
            const n = got[pid];
            if (n && normalizedState(n) !== "awaiting") next[pid] = n; else delete next[pid];
          }
          return next;
        });
      })
      .catch(() => {}); // a failed refresh just keeps showing pending
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onFocus = () => refreshNodes(pendingPidsRef.current);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshNodes]);

  useEffect(() => {
    if (!hasPending || typeof window === "undefined") return undefined;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      refreshNodes(pendingPidsRef.current);
    }, PENDING_POLL_MS);
    return () => clearInterval(id);
  }, [hasPending, refreshNodes]);

  // Fold a completed write straight into local state. The store's
  // transactions return the committed node, so no refetch is needed — and
  // none must happen: keys and nodes update in ONE batch, because a keys-only
  // update would flip the section's `pending` and unmount every row until a
  // refetch landed.
  const applyWrite = (pid, node) => {
    // Any in-flight refresh for this pid now holds an OLDER answer than we do.
    writeGenRef.current[pid] = (writeGenRef.current[pid] ?? 0) + 1;
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
      // A store result without a node (shouldn't happen) — refetch to stay
      // honest. Guarded like every other read: a write landing while this is in
      // flight is NEWER than what comes back, and applying the older value
      // would be the very rollback the generation exists to prevent.
      const gen = writeGenRef.current[pid] ?? 0;
      loadNodesFor([pid])
        .then(({ nodes: got, failed }) => {
          if (failed.length) return;
          if ((writeGenRef.current[pid] ?? 0) !== gen) return;
          setNodes((prev) => ({ ...prev, [pid]: got[pid] || null }));
        })
        .catch(() => {});
    }
  };

  // ─── Proposed-name decisions ───────────────────────────────────────────────
  // One in flight at a time, tracked by pid so only the row being decided goes
  // busy. The write returns the new node and applyWrite folds it in, which is
  // what makes the row leave the lane — the lane's membership test is the
  // node's own pending-proposal flag, so nothing has to be removed by hand.
  const [proposalBusy, setProposalBusy] = useState(null);
  const [proposalError, setProposalError] = useState(null);
  const decideProposal = useMemo(() => {
    const run = (write) => async (pid, seenProposedAt) => {
      if (proposalBusy) return;
      setProposalBusy(pid);
      setProposalError(null);
      try {
        const res = await write(pid, nodesRef.current[pid] || null, seenProposedAt);
        if (!res?.ok) { setProposalError(res?.message || "Not saved."); return; }
        applyWrite(pid, res.node);
      } catch (e) {
        setProposalError(String(e?.message || e));
      } finally {
        setProposalBusy(null);
      }
    };
    return { apply: run(applyNameProposal), dismiss: run(dismissNameProposal) };
  }, [proposalBusy]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Batch-publish selection ───────────────────────────────────────────────
  // Only awaiting-review rows in the CATEGORY sections are selectable — every
  // name is a compliance decision and the category boundary is the review
  // unit, so there is no cross-category select-all and no batch in the Live
  // view. A row that fails the same gates the publish write enforces
  // (condition unset, no valid name) gets a disabled checkbox with the reason
  // inline — never a silent skip.
  // A STALE BLOCK IS NOT A BLOCK. reviewStateFor reads the stored `state`,
  // which still says "blocked" for a product whose recorded refusal was about
  // a handle its current name no longer produces — so without this it would
  // stay unselectable for ever, behind a sentence the row itself no longer
  // shows. The name is what settles it, so the product comes in too.
  const selectionEligible = (node, product) => {
    if (isPendingSwitch(node)) return false;
    const st = reviewStateFor(node);
    if (st === "awaiting" || st === "approved") return true;
    if (st !== "blocked" || !product) return false;
    return !blockStatus(node, effectiveNameFor(product, node).name).blocked;
  };
  // Prune the selection whenever ANY node update disqualifies a selected row
  // — local writes and external ones alike (the window-focus refetch can pull
  // in a reconciler-side block; publishing that stale selection would clear
  // the validator's refusal and re-queue the very product it refused).
  //
  // Also prune anything that has LEFT productById. The selection is page-level
  // and survives collapsing a section, so a product that stops being publishable
  // while it sits selected — the /products subscription delivers an edit that
  // makes it a price record, or the record is deleted in another tab — would
  // otherwise stay in the set with no row to unselect it from.
  //
  // It could never have been PUBLISHED that way: batchItems already dropped a
  // pid missing from productById, and runBatch iterates batchItems. The defect
  // was ACCOUNTING — the bar counted a phantom in "n of 25 selected" and it
  // consumed one of the 25 cap slots, while the dialog silently listed one
  // fewer product than the bar promised. productById is the one index the rest
  // of the page reads, so pruning against it keeps all three in step.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const pid of prev) {
        if (!productById.has(pid)) { next.delete(pid); continue; }
        const node = nodes[pid];
        if (node !== undefined && !selectionEligible(node, productById.get(pid))) next.delete(pid);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [nodes, productById]); // eslint-disable-line react-hooks/exhaustive-deps
  // (nodesRef — the freshest nodes for runBatch's long-lived closure — is
  // declared with the pending refresh above, which needs the same thing.)
  const capNotice = () =>
    setBatchNotice(`Selection is capped at ${RECONCILE_MAX_APPLY} — the reconciler applies at most ${RECONCILE_MAX_APPLY} products per run.`);
  const toggleSelect = (pid, blocker) => {
    if (selected.has(pid)) {
      const next = new Set(selected);
      next.delete(pid);
      setSelected(next);
      return;
    }
    if (blocker) return;
    if (selected.size >= RECONCILE_MAX_APPLY) { capNotice(); return; }
    setSelected(new Set(selected).add(pid));
  };
  // Per-render cache: the blocker needs the lexicon (effectiveNameFor) and
  // the photo list, and both selectionFor and the section select-all walk the
  // same rows — compute each pid once per render, not twice.
  const blockerCache = new Map();
  const blockerFor = (p) => {
    if (!blockerCache.has(p.id)) {
      const node = nodes[p.id] || null;
      blockerCache.set(p.id, batchSelectBlocker(
        node, effectiveNameFor(p, node).name, effectivePhotoList(p, node).photos.length, p));
    }
    return blockerCache.get(p.id);
  };
  const selectionFor = (p) => {
    if (filter === "live") return undefined;
    const node = nodes[p.id] || null;
    if (!selectionEligible(node, p)) return undefined;
    const blocker = blockerFor(p);
    return {
      selected: selected.has(p.id),
      blocker,
      atCap: selected.size >= RECONCILE_MAX_APPLY,
      onToggle: () => toggleSelect(p.id, blocker),
    };
  };
  // Select-all over the rows ON SCREEN — the category select-all's replacement.
  // Deliberately the WINDOW and not the whole list: the batch is capped at the
  // reconciler's per-run cap anyway, and "select all" over 2,700 invisible
  // products would be a button whose effect nobody could see.
  // Ineligible rows stay out and keep their inline reason.
  const selectAllIn = (pids) => {
    const next = new Set(selected);
    let capped = false;
    for (const pid of pids) {
      if (next.size >= RECONCILE_MAX_APPLY) { capped = true; break; }
      next.add(pid);
    }
    setSelected(next);
    if (capped) capNotice();
  };

  // Product-page stale-hash guard: a hash pointing at a product that no
  // longer exists (deleted in another tab, or a mistyped link) returns to the
  // list — same treatment as AdminView's detailProduct guard, except the hash
  // is CLEARED rather than popped. There may be nothing to pop (a tab opened
  // straight onto the bad link), and a no-op back() would leave the page
  // stuck on "Loading product…" with no way out.
  useEffect(() => {
    if (detailPid && products.length > 0 && !productById.get(detailPid)) {
      window.location.hash = "";
    }
  }, [detailPid, products.length, productById]);

  // The rows on screen that a batch could actually take. Computed here, below
  // blockerFor, so the Select-all button and each row's checkbox agree by
  // construction rather than by two similar-looking filters.
  const selectableShown = (filter === "live" || !visible)
    ? []
    : visible.filter((p) => selectionEligible(nodes[p.id] || null, p) &&
                            !blockerFor(p) && !selected.has(p.id));

  // What the batch dialog states, per product: the cleaned name that will
  // ship (saved name or lexicon — never an unsaved page draft), condition,
  // price. Built from the same effectiveNameFor the rows use.
  const batchItems = useMemo(() => {
    return [...selected].map((pid) => {
      const p = productById.get(pid);
      if (!p) return null;
      const node = nodes[pid] || null;
      const eff = effectiveNameFor(p, node);
      const price = Number(p.retailPrice);
      return {
        pid, node, name: eff.name, source: eff.source,
        condition: node?.condition || "— no condition set —",
        price: price > 0 ? `R ${price.toFixed(2)}` : "no price set",
      };
    }).filter(Boolean);
  }, [selected, nodes, productById]);

  // Sequential on purpose: each publishProduct is its own transaction with
  // its own server-side refusals, and a failure only skips ITS product — the
  // batch is N independent intents, exactly like the reconciler treats them.
  const runBatch = async () => {
    if (batchBusy) return;
    setBatchBusy(true);
    const failures = [];
    let okCount = 0;
    try {
      for (const it of batchItems) {
        // Re-check against the FRESHEST node before each write: a row the
        // reconciler blocked (or another session published) since the dialog
        // opened must be skipped, not silently re-queued with its refusal
        // reason wiped.
        const freshest = nodesRef.current[it.pid] === undefined ? it.node : nodesRef.current[it.pid];
        if (!selectionEligible(freshest, productById.get(it.pid))) {
          failures.push(`${it.name || it.pid} — its state changed since selection, skipped`);
          continue;
        }
        try {
          const res = await publishProduct(it.pid, freshest, it.name, it.source); // eslint-disable-line no-await-in-loop
          if (res?.ok) { okCount += 1; applyWrite(it.pid, res.node); }
          else failures.push(`${it.name || it.pid} — ${res?.message || "not saved"}`);
        } catch (e) {
          // A rejection is one product's failure, never the batch's — and the
          // flags must reset regardless (a dialog stuck disabled forces a
          // reload).
          failures.push(`${it.name || it.pid} — ${String(e?.message || e)}`);
        }
      }
    } finally {
      setBatchBusy(false);
      setBatchConfirm(false);
    }
    setBatchNotice(
      [
        okCount ? `${okCount} publish intent${okCount === 1 ? "" : "s"} saved — nothing reaches Shopify until the reconciler runs.` : "",
        failures.length ? `${failures.length} not saved: ${failures.join("; ")}` : "",
      ].filter(Boolean).join(" ")
    );
  };

  // ── THE PRODUCT PAGE — renders INSTEAD of the list while the hash points at
  // a product. All list state (open sections, filter, search, selection)
  // survives underneath; Back pops the hash and drops us into the
  // scroll-restore effect above.
  if (detailPid) {
    const detailProduct = productById.get(detailPid);
    const nodeReady = keys && detailProduct &&
      (!keys.has(detailPid) || nodes[detailPid] !== undefined);
    if (!nodeReady) {
      // A failed MOUNT read leaves `keys` null forever, so this gate would sit
      // on "Loading product…" indefinitely — the load error has to be shown
      // HERE too, not only on the list route (reviewer finding, 2026-08-14).
      const problem = loadError
        ? `Couldn't load the publishing pipeline: ${loadError}`
        : sectionError;
      return (
        <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", paddingBottom: 40 }}>
          <div style={{ display: "flex", alignItems: "center", padding: "50px 14px 12px" }}>
            <button onClick={backToList} type="button"
              style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "8px 14px", cursor: "pointer", fontFamily: FONT }}>
              <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>← Publishing</span>
            </button>
          </div>
          <div style={{ fontSize: 12, color: problem ? RED : GRAY, fontWeight: problem ? 700 : 400, padding: "12px 16px" }}>
            {problem || "Loading product…"}
          </div>
        </div>
      );
    }
    return (
      // KEYED BY PID — load-bearing, not decoration. detailPid can go straight
      // from one product to another without the list rendering in between (a
      // pasted #shopify/{pid} link, forward/back across two product hashes).
      // Without the key React reconciles in place and the page keeps its
      // useState — so product A's unsaved name draft would sit under product
      // B's data, and saving would write A's text onto B's listing name
      // (reviewer finding, 2026-08-14).
      <ShopifyProductPage
        key={detailPid}
        product={detailProduct}
        node={nodes[detailPid] || null}
        onBack={backToList}
        onChanged={applyWrite}
      />
    );
  }

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
          placeholder="Search the original name (as on the label)…"
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
        {/* THE CATALOGUE — department, then shelf, as one-tap filter chips over
            the same flat list. Awaiting review only: that is where the work
            is, and where "show me just the sneakers" was asked for. */}
        {filter === "awaiting" && catalogueTops && catalogueTops.length > 0 && (
          <>
            <div style={{ display: "flex", gap: 6, marginTop: 10, overflowX: "auto",
                          WebkitOverflowScrolling: "touch", paddingBottom: 2 }}>
              <button onClick={() => pickTop("all")}
                style={{ ...(catTop === "all" ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.72rem", flexShrink: 0 }}>
                All departments
              </button>
              {catalogueTops.map(([top, n]) => (
                <button key={top} onClick={() => pickTop(top)}
                  style={{ ...(catTop === top ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.72rem",
                           flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                  {top}
                  <span style={{ fontSize: 10, opacity: 0.65, fontVariantNumeric: "tabular-nums" }}>{n}</span>
                </button>
              ))}
            </div>
            {catalogueSubs && catalogueSubs.length > 1 && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, overflowX: "auto",
                            WebkitOverflowScrolling: "touch", paddingBottom: 2 }}>
                <button onClick={() => setCatSub("all")}
                  style={{ ...(catSub === "all" ? tabOn : tabOff), padding: "5px 11px", fontSize: "0.7rem", flexShrink: 0 }}>
                  All {catTop.toLowerCase()}
                </button>
                {catalogueSubs.map(([sub, n]) => (
                  <button key={sub} onClick={() => setCatSub(sub)}
                    style={{ ...(catSub === sub ? tabOn : tabOff), padding: "5px 11px", fontSize: "0.7rem",
                             flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
                    {sub}
                    <span style={{ fontSize: 10, opacity: 0.65, fontVariantNumeric: "tabular-nums" }}>{n}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
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
            {failedBodies.size > 0 && (
              <button onClick={retryBodies}
                style={{ ...tabOff, padding: "5px 11px", fontSize: "0.68rem", marginLeft: 8 }}>
                Try again
              </button>
            )}
          </div>
        )}
        {!loadError && (!keys || !pipeline) && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading pipeline…</div>
        )}

        {/* PROPOSED NAMES — the vision run's output, one decision per row */}
        {proposedList && proposalError && (
          <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px" }}>
            {proposalError}
          </div>
        )}
        {proposedList && !proposalsLoaded && (
          <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading suggested names…</div>
        )}
        {keys && pipeline && proposedList && proposalsLoaded && (
          proposedList.length === 0 ? (
            // AN EMPTY PAGE IS NOT AN EMPTY LANE. The pages come from the
            // `state == "awaiting"` index, which holds every product in the
            // review queue — not only the ones carrying a pending suggestion.
            // A product whose name has been decided keeps its awaiting state
            // and drops out of this lane, so once Junid has worked through the
            // first few hundred, the FIRST page is all decided while thousands
            // still wait behind it. Saying "no names are waiting" there would
            // be a flat lie with no way forward, because the Load more button
            // used to live only in the non-empty branch (reviewer finding).
            // So the terminal message is gated on the paging actually being
            // finished, and the lane keeps offering the next page until it is.
            proposalPage.done ? (
              <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px", lineHeight: 1.6 }}>
                {q ? "No suggested names match." : (
                  <>
                    No names are waiting here. Suggestions appear after a naming run
                    reads the product photos — nothing on this page changes until you
                    take one.
                    {/* NOT "the queue is empty". The walk moves forward through
                        keys and a product's key is its CREATION time, so a
                        suggestion written while this page was open can land
                        behind where the reading got to. Saying it plainly, and
                        offering the re-walk, is cheaper than pretending the
                        pass was exhaustive (reviewer finding). */}
                    <div style={{ marginTop: 6 }}>
                      A run happening right now can add more behind what has already
                      been read.
                    </div>
                  </>
                )}
                <div>
                  <button onClick={restartProposalWalk} disabled={proposalPage.loading}
                    style={{ ...tabOff, padding: "8px 14px", fontSize: "0.72rem", marginTop: 10 }}>
                    {proposalPage.loading ? "Checking…" : "Check again"}
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px", lineHeight: 1.6 }}>
                {q
                  ? "No suggested names match so far — there are more to look through."
                  : "Nothing waiting in the first stretch of the queue — there are more to look through."}
                <div>
                  <button onClick={loadMoreProposals} disabled={proposalPage.loading}
                    style={{ ...tabOff, padding: "8px 14px", fontSize: "0.72rem", marginTop: 10 }}>
                    {proposalPage.loading ? "Looking…" : "Keep looking"}
                  </button>
                </div>
              </div>
            )
          ) : (
            <>
              <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 2px 4px", lineHeight: 1.6 }}>
                {proposedList.length} name{proposedList.length === 1 ? "" : "s"} read from the
                product photos, waiting for a decision. Taking one changes only the listing
                name — it never puts anything on the storefront, and the old name is kept so
                the change can be undone.
              </div>
              {proposedList.map((p) => (
                <ProposalRow
                  key={p.id}
                  product={p}
                  node={nodes[p.id] || null}
                  busy={proposalBusy === p.id}
                  onOpen={openProduct}
                  onApply={decideProposal.apply}
                  onDismiss={decideProposal.dismiss}
                />
              ))}
              {!proposalPage.done ? (
                <button onClick={loadMoreProposals} disabled={proposalPage.loading}
                  style={{ ...tabOff, padding: "8px 14px", fontSize: "0.72rem", marginTop: 12 }}>
                  {proposalPage.loading ? "Loading…" : "Load more suggestions"}
                </button>
              ) : (
                // AVAILABLE WITH ROWS SHOWING, not only on an empty lane. The
                // walk moves forward through keys, so a suggestion written
                // while this page was open can sit behind everything already
                // read — and a reviewer part-way through a full list is
                // exactly the person it happens to. Offering the re-walk only
                // when the lane looked empty left them no way to see it.
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: GRAY, marginBottom: 6 }}>
                    That is everything read so far. A naming run happening now can add
                    more behind it.
                  </div>
                  <button onClick={restartProposalWalk} disabled={proposalPage.loading}
                    style={{ ...tabOff, padding: "8px 14px", fontSize: "0.72rem" }}>
                    {proposalPage.loading ? "Checking…" : "Check again"}
                  </button>
                </div>
              )}
            </>
          )
        )}

        {/* ─── ONE FLAT LIST ─────────────────────────────────────────────────
            No category headings, no collapsed sections, no per-section
            select-all. Two tabs and a lane; the tab decides the membership and
            the window decides how much of it is on screen. */}
        {keys && pipeline && !proposedList && visible && (
          fullList.length === 0 ? (
            <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px", lineHeight: 1.6 }}>
              {q || (filter === "awaiting" && catTop !== "all")
                 ? "Nothing matches that search or catalogue pick."
                 : filter === "live" ? "Nothing is on the shop yet."
                 : "Nothing is waiting — every product is on the shop."}
            </div>
          ) : pendingBodies !== 0 ? (
            <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading…</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 2px 2px" }}>
                <div style={{ flex: 1, fontSize: 11.5, color: GRAY }}>
                  {/* The count is the WHOLE list, not the window — "60" under a
                      Show more button would read as the answer to "how many
                      are waiting", which is the question this page exists to
                      answer. */}
                  {fullList.length} product{fullList.length === 1 ? "" : "s"}
                  {visible.length < fullList.length ? ` · showing ${visible.length}` : ""}
                </div>
                {selectableShown.length > 0 && (
                  <button onClick={() => selectAllIn(selectableShown.map((p) => p.id))}
                    style={{ ...tabOff, padding: "5px 11px", fontSize: "0.68rem" }}>
                    Select all shown
                  </button>
                )}
              </div>
              {visible.map((p) => (
                <ProductListRow
                  key={p.id}
                  product={p}
                  node={nodes[p.id] || null}
                  onOpen={openProduct}
                  onChanged={applyWrite}
                  selection={selectionFor(p)}
                />
              ))}
              {visible.length < fullList.length && (
                <button onClick={() => setShown((n) => n + PAGE_SIZE)}
                  style={{ ...tabOff, padding: "9px 14px", fontSize: "0.74rem", marginTop: 12 }}>
                  Show {Math.min(PAGE_SIZE, fullList.length - visible.length)} more
                </button>
              )}
            </>
          )
        )}

        {batchNotice && (
          <div style={{ fontSize: 12, color: BLUE_L, fontWeight: 700, padding: "12px 2px", overflowWrap: "break-word" }}>
            {batchNotice}
            <button onClick={() => setBatchNotice(null)}
              style={{ background: "none", border: "none", color: GRAY, cursor: "pointer",
                       fontFamily: FONT, fontSize: 11, marginLeft: 8 }}>✕</button>
          </div>
        )}
      </div>

      {/* BATCH BAR — sticky while anything is selected: the running count,
          the cap (stated, and shared with the reconciler so the two cannot
          disagree), and the one Publish Selected action behind the same
          going-live confirmation as a single publish. */}
      {selected.size > 0 && (
        <div style={{ position: "sticky", bottom: 10, zIndex: 30, ...GLASS_SOLID, margin: "14px 14px 0",
                      padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>
            {selected.size} of {RECONCILE_MAX_APPLY} selected
          </span>
          <span style={{ fontSize: 10.5, color: GRAY }}>
            cap {RECONCILE_MAX_APPLY} — matches the reconciler's per-run cap
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setSelected(new Set())} disabled={batchBusy}
            style={{ ...bGray, padding: "8px 12px", fontSize: "0.76rem" }}>Clear</button>
          <button onClick={() => setBatchConfirm(true)} disabled={batchBusy || batchItems.length === 0}
            style={{ ...bGreen, padding: "8px 12px", fontSize: "0.76rem" }}>
            Publish selected…
          </button>
        </div>
      )}
      {batchConfirm && (
        <BatchPublishConfirmDialog
          items={batchItems}
          busy={batchBusy}
          onCancel={() => setBatchConfirm(false)}
          onConfirm={runBatch}
        />
      )}
    </div>
  );
}
