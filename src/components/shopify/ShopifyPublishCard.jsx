// ─── SHOPIFY PUBLISHING — THE HOME CARD ──────────────────────────────────────
// Junid's control surface for the one-way Shopify push: see the cleaned name
// beside the original, edit it inline with the brand-trigger check running
// LIVE on every keystroke, set the condition grade (three fixed values, no
// default), nominate, and see where each product sits in the pipeline
// (none / nominated / draft / live / blocked — with the blocked reason said
// loudly). Writes ONLY /shopify_publish; the actual push is the Admin-SDK
// script (scripts/shopify/publish-run.mjs), never the browser.
//
// Structure/styling/data-loading follow the two existing home cards —
// HubCleanupCard.jsx and StockHoldCard.jsx (self-gating card, ui.js tokens,
// tiny one-shot get()s in a store module) — wired into RoleSelector's card
// slot in App.jsx the same way they are. Expands INLINE on the home page
// (the whole job is a handful of fields per product) rather than opening a
// full module route.
import React, { useMemo, useState } from "react";
import { CARD, BORDER, GRAY, GREEN, RED, AMBER, BLUE_L, tabOn, tabOff, input as inputStyle, bBlue, bGray } from "../stock/ui";
import { cleanTitleFor } from "../../utils/shopifyTriggers";
import {
  CONDITIONS, canUseShopifyPublish, checkCleanName, blockedReason, pipelineCounts,
} from "./shopifyPublishCore";
import {
  loadPublishNodes, nominateProduct, withdrawNomination, setCondition, setCleanName,
} from "./shopifyPublishStore";

const STATE_BADGE = {
  none:      { label: "not nominated", color: GRAY,   border: "rgba(255,255,255,.18)" },
  nominated: { label: "nominated",     color: BLUE_L, border: "rgba(74,127,255,.5)" },
  draft:     { label: "draft on shop", color: GREEN,  border: "rgba(74,222,128,.5)" },
  live:      { label: "LIVE",          color: GREEN,  border: "rgba(74,222,128,.8)" },
  blocked:   { label: "blocked",       color: RED,    border: "rgba(248,113,113,.55)" },
};

function StateBadge({ state }) {
  const b = STATE_BADGE[state] || STATE_BADGE.none;
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, color: b.color, border: `1px solid ${b.border}`,
                   borderRadius: 8, padding: "3px 7px", whiteSpace: "nowrap" }}>
      {b.label.toUpperCase()}
    </span>
  );
}

// One product's row: original vs cleaned name, inline editor, condition, state.
function ProductRow({ product, node, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const lexicon = useMemo(() => cleanTitleFor(product), [product]);
  const effectiveName = node?.cleanName
    ? { name: node.cleanName, source: node.cleanNameSource || "manual" }
    : lexicon.needsAI
      ? null
      : { name: lexicon.title, source: "lexicon" };
  const state = node?.state || "none";
  const verdict = editing ? checkCleanName(draft) : null; // the LIVE trigger check
  const blocked = blockedReason(node);

  const run = async (fn) => {
    setBusy(true); setError(null);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setError(res.message);
    else { setEditing(false); onChanged(); }
  };

  return (
    <div style={{ borderTop: "1px solid rgba(255,255,255,.06)", padding: "9px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: GRAY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {product.name}
          </div>
          {!editing && (
            effectiveName ? (
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#fff" }}>
                {effectiveName.name}{" "}
                <span style={{ fontSize: 9, fontWeight: 800, color: GRAY }}>({effectiveName.source})</span>
              </div>
            ) : (
              <div style={{ fontSize: 12, fontWeight: 700, color: AMBER }}>
                needs a name — the lexicon can't clean this one ({lexicon.reason})
              </div>
            )
          )}
        </div>
        <StateBadge state={state} />
      </div>

      {editing ? (
        <div style={{ marginTop: 7 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Compliant listing name…"
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box",
                     border: verdict && !verdict.ok ? "1px solid rgba(248,113,113,.6)" : inputStyle.border }}
            autoFocus
          />
          {verdict && !verdict.ok && (
            <div style={{ fontSize: 10.5, color: RED, marginTop: 4 }}>{verdict.problems.join(" · ")}</div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button
              disabled={busy || !verdict?.ok}
              onClick={() => run(() => setCleanName(product.id, draft))}
              style={{ ...bBlue, padding: "7px 12px", fontSize: "0.76rem", opacity: verdict?.ok ? 1 : 0.4 }}>
              Save name
            </button>
            <button disabled={busy} onClick={() => { setEditing(false); setError(null); }}
                    style={{ ...bGray, padding: "7px 12px", fontSize: "0.76rem" }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 7 }}>
            {CONDITIONS.map((c) => (
              <button key={c} disabled={busy}
                onClick={() => run(() => setCondition(product.id, node, c))}
                style={{ ...(node?.condition === c ? tabOn : tabOff), padding: "4px 9px", fontSize: "0.68rem" }}>
                {c.split(" — ")[0]}
              </button>
            ))}
          </div>
          {node?.condition && (
            <div style={{ fontSize: 10, color: GRAY, marginTop: 3 }}>{node.condition}</div>
          )}
          {blocked && (
            <div style={{ fontSize: 11, color: RED, fontWeight: 700, marginTop: 5 }}>⛔ {blocked}</div>
          )}
          <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
            {(state === "none" || state === "blocked") && (
              <button disabled={busy}
                onClick={() => run(() => nominateProduct(product.id, node))}
                style={{ ...bBlue, padding: "7px 12px", fontSize: "0.76rem" }}>
                Nominate →
              </button>
            )}
            {(state === "nominated" || state === "blocked") && (
              <button disabled={busy}
                onClick={() => run(() => withdrawNomination(product.id, node))}
                style={{ ...bGray, padding: "7px 12px", fontSize: "0.76rem" }}>
                Withdraw
              </button>
            )}
            <button disabled={busy}
              onClick={() => { setDraft(effectiveName?.name || ""); setEditing(true); }}
              style={{ ...bGray, padding: "7px 12px", fontSize: "0.76rem" }}>
              Edit name
            </button>
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 11, color: RED, marginTop: 5 }}>{error}</div>}
    </div>
  );
}

export default function ShopifyPublishCard({ viewer, products }) {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = () => {
    setLoading(true);
    loadPublishNodes()
      .then(setNodes)
      .catch(() => setNodes({}))
      .finally(() => setLoading(false));
  };

  const counts = pipelineCounts(nodes);
  const byId = useMemo(() => {
    const m = new Map();
    for (const p of products || []) m.set(p.id, p);
    return m;
  }, [products]);

  // Rows: search hits when typing, otherwise everything already in the pipeline.
  const rows = useMemo(() => {
    if (!nodes) return [];
    const q = query.trim().toLowerCase();
    if (q) {
      return (products || [])
        .filter((p) => String(p.name || "").toLowerCase().includes(q))
        .slice(0, 25)
        .map((p) => ({ product: p, node: nodes[p.id] || null }));
    }
    return Object.entries(nodes)
      .filter(([, n]) => n && n.state && n.state !== "none")
      .map(([pid, n]) => ({ product: byId.get(pid), node: n }))
      .filter((r) => r.product);
  }, [nodes, query, products, byId]);

  // Gate AFTER the hooks (rules of hooks) — same shape as StockHoldCard.
  if (!canUseShopifyPublish(viewer)) return null;

  return (
    <div style={{ background: CARD, border: BORDER, borderRadius: 14, padding: "12px 13px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
        <span style={{ fontSize: 17 }}>🛍️</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff" }}>Shopify Publishing</div>
          <div style={{ fontSize: 10.5, color: GRAY }}>Clean names · condition · nominate for the online store</div>
        </div>
      </div>

      {open && (
        <>
          <div style={{ fontSize: 12, color: GRAY, marginBottom: 8, lineHeight: 1.5 }}>
            {loading || !nodes ? "Loading pipeline…" : (
              <>
                <strong style={{ color: BLUE_L, fontSize: 13 }}>{counts.nominated}</strong> nominated ·{" "}
                <strong style={{ color: GREEN, fontSize: 13 }}>{counts.draft}</strong> draft ·{" "}
                <strong style={{ color: GREEN, fontSize: 13 }}>{counts.live}</strong> live
                {counts.blocked > 0 && <> · <strong style={{ color: RED, fontSize: 13 }}>{counts.blocked}</strong> blocked</>}
              </>
            )}
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search products to nominate…"
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 4 }}
          />
          {nodes && rows.length === 0 && (
            <div style={{ fontSize: 11.5, color: GRAY, padding: "10px 0" }}>
              {query.trim() ? "No products match." : "Nothing in the pipeline yet — search above to nominate the first one."}
            </div>
          )}
          {nodes && rows.map(({ product, node }) => (
            <ProductRow key={product.id} product={product} node={node} onChanged={refresh} />
          ))}
        </>
      )}

      <button
        onClick={() => { if (!open) refresh(); setOpen(!open); }}
        style={{ ...tabOn, width: "100%", borderRadius: 11, padding: "10px 12px", fontSize: "0.82rem", marginTop: open ? 9 : 0 }}>
        {open ? "Close" : "Open →"}
      </button>
    </div>
  );
}
