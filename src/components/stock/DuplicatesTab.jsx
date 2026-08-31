// ─── DUPLICATES — "do not make me guess which copy to keep" ──────────────────
// (Owner spec 2026-08-31, BUILD 3.)
//
// The owner is afraid to deactivate, because deactivating the WRONG copy of a
// duplicated product is worse than leaving both. The system already holds every
// fact needed to tell them apart, so this screen puts those facts side by side
// and names a survivor:
//
//   photo · full name · style code and aliases · stock by location with sizes ·
//   units sold · last sold · whether it has a real product photo
//
// and one line of reasoning — "keeps: has 84 units across 2 locations, 7 sold,
// real photo". The recommendation is PRE-SELECTED and swappable with a tap.
// NOTHING merges automatically: one button opens the EXISTING MergeProducts
// overlay with both sides already chosen, and that screen's own confirmation is
// still the only thing that merges anything.
//
// Grouping, ranking and the reason line are pure — duplicateGroups.js, which is
// also what scripts/duplicate-groups-census.mjs runs, so the live report and
// this screen can never disagree.
//
// READS: /stock per location (the same loadAllStock the Leftovers tab uses) and
// a KEY-RANGE page of /insights_log (duplicateSales.js). Both are lazy — this
// tab costs nothing until it is opened.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { buildDuplicateGroups } from "./duplicateGroups";
import { loadSalesByPid, SINCE_LABEL } from "./duplicateSales";
import { loadAllStock } from "./hubCleanupStore";
import { useLabelIdentity } from "../../utils/labelIdentityStore";
import { allLocationIds, labelFor } from "./locations";
import { decodeSizeKey } from "../../utils/sizeKey";
import { formatSize } from "../../utils/sizeLabel";
import { DeactivatedChip, useCanRetireProducts } from "./ProductActions.jsx";
import MergeProducts from "./MergeProducts.jsx";
import { GRAY, GREEN, AMBER, BLUE_L, BORDER, FONT, bGray, bBlue } from "./ui";

function Photo({ url, size = 62 }) {
  if (url) return <img src={url} alt="" loading="lazy" style={{ width: size, height: size, objectFit: "cover", borderRadius: 10, flexShrink: 0 }} />;
  return <div style={{ width: size, height: size, borderRadius: 10, background: "rgba(120,150,255,.08)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.42, flexShrink: 0 }}>👟</div>;
}

const when = (ms) => (ms ? new Date(ms).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "2-digit" }) : "never");

/** One member row — every fact the owner asked to see, side by side. */
function MemberRow({ m, registry, recommended, chosen, onChoose }) {
  return (
    <button type="button" onClick={() => onChoose(m.id)}
      style={{
        display: "flex", gap: 12, width: "100%", textAlign: "left", cursor: "pointer",
        padding: 12, borderRadius: 14, fontFamily: FONT,
        background: chosen ? "rgba(74,222,128,.09)" : "rgba(255,255,255,.02)",
        border: chosen ? "1px solid rgba(74,222,128,.5)" : BORDER,
      }}>
      <Photo url={m.photoUrl} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "#fff", lineHeight: 1.3 }}>
          {m.name}
          {m.deactivated && <DeactivatedChip small />}
        </div>
        <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3 }}>
          {m.codes.length ? `Code ${m.codes.join(" · ")}` : "No style code"}
          {m.aliases.length ? ` · answers to ${m.aliases.slice(0, 3).join(", ")}` : ""}
          {!m.hasPhoto && " · no product photo"}
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: m.units > 0 ? BLUE_L : GRAY, marginTop: 5, fontVariantNumeric: "tabular-nums" }}>
          {m.units} unit{m.units === 1 ? "" : "s"} · {m.sold} sold · last sold {when(m.lastSoldMs)}
        </div>
        {m.byLoc.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
            {m.byLoc.map((l) => (
              <span key={l.loc} style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: "3px 8px", fontVariantNumeric: "tabular-nums",
                                         background: "rgba(74,127,255,.09)", border: "1px solid rgba(74,127,255,.28)", color: BLUE_L }}>
                {labelFor(l.loc, registry)} {l.qty}
                <span style={{ color: GRAY, fontWeight: 600 }}>
                  {" "}{l.sizes.map((s) => `${formatSize(decodeSizeKey(s.sizeKey))}×${s.qty}`).join(" ")}
                </span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, alignSelf: "center", textAlign: "right" }}>
        {chosen
          ? <span style={{ fontSize: 11, fontWeight: 800, color: GREEN, letterSpacing: ".05em" }}>KEEP</span>
          : <span style={{ fontSize: 11, fontWeight: 700, color: GRAY }}>merge away</span>}
        {recommended && !chosen && <div style={{ fontSize: 10, color: GRAY, marginTop: 3 }}>recommended</div>}
      </div>
    </button>
  );
}

export default function DuplicatesTab({ products = [], registry }) {
  const identity = useLabelIdentity();
  const canRetire = useCanRetireProducts();
  const [allStock, setAllStock] = useState(null);
  const [sales, setSales] = useState(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState({});     // groupKey → chosen survivor id
  const [merge, setMerge] = useState(null);     // { loser, survivor }
  const [limit, setLimit] = useState(25);

  const locs = useMemo(() => allLocationIds(registry), [registry]);

  const load = useCallback(async () => {
    setError("");
    const [stock, byPid] = await Promise.all([
      loadAllStock(locs).catch((e) => { setError(String(e?.message || e)); return null; }),
      loadSalesByPid().catch(() => ({})),      // sales are evidence, never a blocker
    ]);
    setAllStock(stock);
    setSales(byPid || {});
  }, [locs]);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    if (!allStock || !identity.ready) return null;
    return buildDuplicateGroups({ products, allStock, identityMap: identity.map, salesByPid: sales || {} });
  }, [products, allStock, identity.map, identity.ready, sales]);

  const openMerge = (group) => {
    const survivorId = picked[group.key] || group.survivorId;
    const survivor = group.members.find((m) => m.id === survivorId);
    // The FIRST non-survivor is the loser this tap opens. A group of three is
    // two merges — the screen comes back with the third still listed.
    const loser = group.members.find((m) => m.id !== survivorId);
    if (!survivor || !loser) return;
    setMerge({ loser: loser.product, survivor: survivor.product });
  };

  if (merge) {
    return (
      <MergeProducts initialLoser={merge.loser} initialSurvivor={merge.survivor}
                     products={products} allStock={allStock} registry={registry}
                     onEnsureStock={async () => { const s = await loadAllStock(locs); setAllStock(s); return s; }}
                     onClose={() => setMerge(null)}
                     onMerged={() => { setMerge(null); load(); }} />
    );
  }

  if (groups === null) {
    return <div style={{ padding: 24, color: GRAY, fontSize: 13, fontFamily: FONT }}>
      Reading stock and sales…{error && <div style={{ color: AMBER, marginTop: 8 }}>{error}</div>}
    </div>;
  }

  const shown = groups.slice(0, limit);

  return (
    <div style={{ fontFamily: FONT, maxWidth: 860 }}>
      <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.55, marginBottom: 14 }}>
        <strong style={{ color: "#fff" }}>{groups.length} groups</strong> of records that look like the
        same product — worst first: the ones whose stock is <em>split</em> across copies lead, because
        those are the ones losing sales at the till. Sold counts cover {SINCE_LABEL} onward (before
        that the log carries no product id and could only be joined by name — which is the very thing
        that is broken here). Nothing merges automatically: the recommended survivor is pre-selected,
        tap another row to swap, then open the merge screen and confirm there.
      </div>

      {groups.length === 0 && (
        <div style={{ padding: 24, color: GRAY, fontSize: 13 }}>No duplicate groups. Nothing to decide.</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {shown.map((g) => {
          const chosen = picked[g.key] || g.survivorId;
          return (
            <div key={g.key} style={{ border: BORDER, borderRadius: 18, padding: 14, background: "rgba(255,255,255,.015)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <span style={{ fontSize: 13.5, fontWeight: 800, color: g.split ? AMBER : "#fff" }}>
                  {g.members.length} records · {g.units} units{g.split ? " · STOCK IS SPLIT" : ""}
                </span>
                <span style={{ fontSize: 12, color: GREEN, fontWeight: 700 }}>{g.reason}</span>
              </div>
              {g.codesDiffer && (
                <div style={{ fontSize: 11.5, color: AMBER, marginBottom: 10, lineHeight: 1.45 }}>
                  These carry different style codes ({g.codes.join(", ")}). A shared model name with
                  different codes can be legitimate colourway siblings — check the photos before merging.
                </div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {g.members.map((m) => (
                  <MemberRow key={m.id} m={m} registry={registry} recommended={m.id === g.survivorId}
                             chosen={m.id === chosen}
                             onChoose={(id) => setPicked((p) => ({ ...p, [g.key]: id }))} />
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <button type="button" disabled={!canRetire} onClick={() => openMerge(g)}
                        style={{ ...(canRetire ? bBlue : bGray), width: "100%", padding: "12px 14px", fontSize: "0.92rem", opacity: canRetire ? 1 : .5 }}>
                  {canRetire
                    ? `Open merge — keep "${(g.members.find((m) => m.id === chosen) || {}).name}"`
                    : "Merging needs a stock admin"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {groups.length > shown.length && (
        <button type="button" onClick={() => setLimit((n) => n + 25)}
                style={{ ...bGray, width: "100%", marginTop: 16, padding: "12px 14px" }}>
          Show 25 more · {groups.length - shown.length} left
        </button>
      )}
    </div>
  );
}
