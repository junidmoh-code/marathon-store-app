// ─── DISPLAY REGISTER — what is actually on the shop floor, and in what size ──
// Owner ask 2026-07-29. Two problems, one register:
//
//   1. NOBODY KNOWS WHAT IS ON DISPLAY. A pair goes out on a Display Partner
//      request and there is no record of it afterwards — not what, not which
//      size, not when. The shop cannot audit its own floor.
//   2. THE SIZE IS LOST. A Display Partner request is deliberately size-optional
//      ("send a pair for the display, any size"), so 17 of 51 live partner
//      footwear orders carry no size. The pair still has one.
//
// This is the sneaker counterpart of Display Checks (live for clothing at
// /displayChecks_active): same idea — know what the floor should be holding, and
// notice when it changes — but display is a STANDING state, not an event, so it
// is a register you walk and confirm rather than a queue you clear.
//
// ── DELIBERATELY INERT ───────────────────────────────────────────────────────
// This writes ONE new node, /display_register/{store}/{productId}__{sizeKey},
// and NOTHING else. It does not touch /stock, does not move inventory, does not
// create orders, and no automation reads it yet. Registering a pair is a record
// of a physical fact, not a transaction — so a mistake here can never cost
// stock, and the register can be corrected freely while staff learn it.
//
// The auto-request-on-sale trigger is the OBVIOUS next step and is deliberately
// NOT here: that one writes orders, so it needs its own build and its own
// review. This is the half that is safe to put in front of staff immediately.

import { useEffect, useMemo, useState } from "react";
import { ref, onValue, update, remove } from "firebase/database";
import { database } from "../../firebase.js";
import { encodeSizeKey } from "../../utils/sizeKey.js";
import { serverNowIso } from "../../utils/serverTime.js";
import { productIsFootwear } from "../../utils/footwearLine.js";
import { SizeTag } from "../SizeTag.jsx";
import { sellableLocations, labelFor } from "./locations.js";

const PANEL = "rgba(12,16,30,.55)";

// WHY IT LIVES UNDER /settings: the live RTDB rules have no root cascade (removed
// in PR #57), so a fresh top-level node like /display_register would be denied
// BOTH read and write until someone hand-edited the console. /settings already
// carries `.read: auth != null` / `.write: non-anon`, which is exactly the access
// shop staff need — so this works the moment it deploys, with no rules change.
//
// A dedicated /display_register node with per-store read scoping (the way
// /displayChecks_active is scoped to a user's destShop) is the cleaner long-term
// home. That is a console rule edit, not a code change — worth doing when the
// register has proven itself, not on the night it ships.
const REGISTER_PATH = "settings/displayRegister";

const entryKey = (productId, size) => `${productId}__${encodeSizeKey(String(size))}`;

// Real, sellable sizes — the "_" one-size sentinel is never a display size.
function realSizes(product) {
  const raw = product && product.sizes;
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? Object.values(raw) : []);
  return arr.map(String).map((s) => s.trim()).filter((s) => s && s !== "_");
}

export function useDisplayRegister(store) {
  const [entries, setEntries] = useState({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!store) { setEntries({}); setLoaded(true); return; }
    const unsub = onValue(
      ref(database, `${REGISTER_PATH}/${store}`),
      (snap) => { setEntries(snap.val() || {}); setLoaded(true); },
      () => { setEntries({}); setLoaded(true); },
    );
    return () => unsub();
  }, [store]);
  return { entries, loaded };
}

export default function DisplayRegister({ products = [], registry, fixedStore = null, actorName = null }) {
  // Shop staff are pinned to their own shop by their /users record; an admin or
  // warehouse user has no destShop and picks. The register is per-shop because
  // a display is a physical shelf in one building.
  const shops = useMemo(() => sellableLocations(registry), [registry]);
  const [chosenStore, setChosenStore] = useState(null);
  const store = fixedStore || chosenStore;
  const storeLabel = store ? labelFor(store, registry) : null;

  const { entries, loaded } = useDisplayRegister(store);
  const [q, setQ] = useState("");
  const [picking, setPicking] = useState(null);   // product awaiting a size choice
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Footwear only. Clothing display is already covered by Display Checks; mixing
  // the two here would produce a register nobody trusts for either.
  const footwear = useMemo(
    () => (products || []).filter((p) => p && p.id && productIsFootwear(p)),
    [products],
  );

  const registered = useMemo(() => {
    const rows = Object.entries(entries || {}).map(([key, v]) => ({ key, ...v }));
    rows.sort((a, b) => String(a.productName || "").localeCompare(String(b.productName || "")));
    return rows;
  }, [entries]);

  const registeredKeys = useMemo(() => new Set(Object.keys(entries || {})), [entries]);

  const searchResults = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return [];
    return footwear
      .filter((p) => `${p.name || ""} ${p.brand || ""} ${p.sku || ""}`.toLowerCase().includes(term))
      .slice(0, 25);
  }, [footwear, q]);

  const addEntry = async (product, size) => {
    if (!store || !product || !size) return;
    setBusy(true);
    setMsg("");
    try {
      const key = entryKey(product.id, size);
      await update(ref(database, `${REGISTER_PATH}/${store}/${key}`), {
        productId: product.id,
        productName: product.name || "",
        photoUrl: product.photoUrl || null,
        size: String(size),
        registeredAt: serverNowIso(),
        registeredBy: actorName || null,
      });
      setPicking(null);
      setQ("");
      setMsg(`${product.name} — size ${size} registered on display.`);
    } catch (e) {
      setMsg(`Could not register: ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  const removeEntry = async (row) => {
    if (!store || !row?.key) return;
    setBusy(true);
    try {
      await remove(ref(database, `${REGISTER_PATH}/${store}/${row.key}`));
      setMsg(`${row.productName} — size ${row.size} taken off the register.`);
    } catch (e) {
      setMsg(`Could not remove: ${e?.message || e}`);
    } finally { setBusy(false); }
  };

  const field = {
    background: "#08090C", border: "2px solid rgba(74,127,255,.28)", borderRadius: 12,
    padding: "13px 15px", color: "#fff", fontSize: 16, fontWeight: 600, outline: "none",
    width: "100%", boxSizing: "border-box", minHeight: 50,
  };

  return (
    <div style={{ padding: "0 14px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "6px 0 10px" }}>
        <span style={{ fontSize: 19, fontWeight: 800, color: "#fff", letterSpacing: "-0.01em" }}>Display Register</span>
        <span style={{ background: "rgba(74,127,255,.15)", border: "1px solid rgba(74,127,255,.35)", color: "#9DBCFF",
                       fontSize: 12.5, fontWeight: 800, padding: "3px 11px", borderRadius: 12, fontVariantNumeric: "tabular-nums" }}>
          {registered.length} on display
        </span>
        {storeLabel && (
          <span style={{ fontSize: 12.5, color: "rgba(233,238,255,.5)" }}>{storeLabel}</span>
        )}
      </div>

      <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.45)", marginBottom: 12, lineHeight: 1.5 }}>
        Walk the floor and register every sneaker on display, with the size that is actually out.
        This is a record only — it does not move stock or change anything.
      </div>

      {/* Which shop's floor. Pinned for shop staff, chosen by admin/warehouse. */}
      {!store && (
        <div style={{ background: PANEL, border: "1px solid rgba(74,127,255,.3)", borderRadius: 14,
                      padding: "14px 15px", marginBottom: 14 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "#E9EEFF", marginBottom: 10 }}>
            Which shop are you registering?
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {shops.map((l) => (
              <button key={l.id} type="button" onClick={() => setChosenStore(l.id)}
                style={{ padding: "11px 16px", borderRadius: 11, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                         background: "rgba(74,127,255,.14)", border: "1px solid rgba(74,127,255,.45)", color: "#9DBCFF" }}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── ADD ─────────────────────────────────────────────────────────────── */}
      {store && !picking ? (
        <>
          <input value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Search a sneaker to register…" style={field} />
          {searchResults.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 10 }}>
              {searchResults.map((p) => (
                <button key={p.id} type="button" onClick={() => setPicking(p)}
                  style={{ display: "flex", alignItems: "center", gap: 11, padding: "9px 11px", textAlign: "left",
                           background: PANEL, border: "1px solid rgba(120,150,255,.16)", borderRadius: 12, cursor: "pointer" }}>
                  <div style={{ width: 42, height: 42, borderRadius: 9, overflow: "hidden", flexShrink: 0,
                                background: "rgba(255,255,255,.04)" }}>
                    {p.photoUrl && <img src={p.photoUrl} alt="" loading="lazy"
                      style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "#fff", overflow: "hidden",
                                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.42)" }}>
                      {p.brand || "no brand"} · {realSizes(p).length} sizes
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {q.trim() && searchResults.length === 0 && (
            <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.4)", padding: "12px 2px" }}>
              No sneaker matches “{q.trim()}”.
            </div>
          )}
        </>
      ) : store && picking ? (
        <div style={{ background: PANEL, border: "1px solid rgba(74,127,255,.3)", borderRadius: 14, padding: "14px 15px" }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: "#fff", marginBottom: 3 }}>{picking.name}</div>
          <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.45)", marginBottom: 12 }}>
            Which size is on the display?
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            {realSizes(picking).map((s) => {
              const already = registeredKeys.has(entryKey(picking.id, s));
              return (
                <button key={s} type="button" disabled={busy || already} onClick={() => addEntry(picking, s)}
                  style={{ padding: "11px 15px", borderRadius: 11, fontSize: 14, fontWeight: 800, minWidth: 54,
                           cursor: already ? "not-allowed" : "pointer",
                           background: already ? "rgba(255,255,255,.05)" : "rgba(74,127,255,.14)",
                           border: `1px solid ${already ? "rgba(255,255,255,.12)" : "rgba(74,127,255,.45)"}`,
                           color: already ? "rgba(233,238,255,.3)" : "#9DBCFF" }}>
                  <SizeTag size={s} />
                </button>
              );
            })}
            {realSizes(picking).length === 0 && (
              <div style={{ fontSize: 12.5, color: "#FBBF24" }}>This product has no sizes on record.</div>
            )}
          </div>
          <button type="button" onClick={() => setPicking(null)}
            style={{ background: "transparent", border: "1px solid rgba(255,255,255,.18)", color: "rgba(233,238,255,.7)",
                     borderRadius: 10, padding: "9px 15px", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      ) : null}

      {msg && (
        <div style={{ marginTop: 12, background: "rgba(74,202,122,.08)", border: "1px solid rgba(74,202,122,.25)",
                      borderRadius: 11, padding: "9px 13px", fontSize: 12.5, color: "#B7F0CC" }}>{msg}</div>
      )}

      {/* ── THE REGISTER ────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 20, display: store ? "block" : "none" }}>
        <div style={{ fontSize: 11.5, fontWeight: 800, letterSpacing: ".09em", textTransform: "uppercase",
                      color: "rgba(233,238,255,.55)", marginBottom: 10 }}>
          On display now
        </div>
        {!loaded ? (
          <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.4)" }}>Loading…</div>
        ) : registered.length === 0 ? (
          <div style={{ textAlign: "center", padding: "34px 16px", color: "rgba(233,238,255,.42)" }}>
            <div style={{ fontSize: 26, marginBottom: 8 }}>▦</div>
            <div style={{ fontSize: 13.5 }}>Nothing registered yet. Search a sneaker above to start.</div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {registered.map((row) => (
              <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 11, padding: "10px 12px",
                                          background: PANEL, border: "1px solid rgba(120,150,255,.14)", borderRadius: 12 }}>
                <div style={{ width: 42, height: 42, borderRadius: 9, overflow: "hidden", flexShrink: 0,
                              background: "rgba(255,255,255,.04)" }}>
                  {row.photoUrl && <img src={row.photoUrl} alt="" loading="lazy"
                    style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.productName}</div>
                  <div style={{ fontSize: 11, color: "rgba(233,238,255,.4)", marginTop: 2 }}>
                    {row.registeredBy ? `${row.registeredBy} · ` : ""}
                    {row.registeredAt ? new Date(row.registeredAt).toLocaleDateString() : ""}
                  </div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 800, color: "#9DBCFF", background: "rgba(74,127,255,.12)",
                               border: "1px solid rgba(74,127,255,.3)", borderRadius: 9, padding: "5px 11px" }}>
                  <SizeTag size={row.size} />
                </span>
                <button type="button" disabled={busy} onClick={() => removeEntry(row)} aria-label="Remove from display"
                  style={{ background: "transparent", border: "1px solid rgba(255,255,255,.14)", color: "rgba(255,255,255,.45)",
                           borderRadius: 9, padding: "7px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
