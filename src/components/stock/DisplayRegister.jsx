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
// This writes ONE new node, /settings/displayRegister/{store}/{productId}__{sizeKey},
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
import { useLocations } from "./useStock.js";
import { FONT } from "./ui";
import { usePermissions } from "../PermissionsContext.jsx";

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


// ─── REGISTER A DISPLAY PAIR FROM THE SEND ────────────────────────────────────
// The size the picker chooses when sending a Display Partner request IS the
// display registration — same physical fact, recorded once. Called from the
// Source send flow so the register fills itself as displays go out, instead of
// staff having to re-enter everything by hand afterwards.
//
// Best-effort and never throws: the send is the operation that matters, and a
// failed register write must not block a parcel leaving the building.
export async function registerDisplayPair({ store, product, size, actorName, orderId }) {
  if (!store || !product?.id || !size) return { ok: false, reason: "missing" };
  try {
    await update(ref(database, `${REGISTER_PATH}/${store}/${entryKey(product.id, size)}`), {
      productId: product.id,
      productName: product.name || "",
      photoUrl: product.photoUrl || null,
      size: String(size),
      registeredAt: serverNowIso(),
      registeredBy: actorName || null,
      source: "display_partner_send",
      orderId: orderId || null,
    });
    return { ok: true };
  } catch (err) {
    console.warn("[displayRegister] auto-register failed", err);
    return { ok: false, reason: String(err?.message || err) };
  }
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

// ── WHO MAY USE THE DISPLAY REGISTER ─────────────────────────────────────────
// Stock-capable users (the warehouse view of the floor) OR display staff (the
// people who actually put the pairs out and record them). Exported so App.jsx's
// tile and route gate evaluate the IDENTICAL rule — one definition, three call
// sites, no chance of the tile and the route disagreeing.
//
// Measured against live /users when this gate was added (31 accounts): 18 pass
// on stock access, all 6 store assistants pass on display_refills/display_checks,
// and the 7 refused are 6 POS-only till logins (stockRole "pos", no permissions)
// plus the TV display account. Nobody who was using the register loses it.
export function mayUseDisplayRegister({ canAccessStock = false, hasPermission = () => false } = {}) {
  return !!canAccessStock
    || !!hasPermission("display_refills")
    || !!hasPermission("display_checks");
}

// ── THE GATE (layer 2 of 2) ──────────────────────────────────────────────────
// Authorization only — no state, no effects, no subscription. The real screen
// mounts only once the answer is yes, so a refused viewer never opens the
// /settings/displayRegister listener and never gets a write surface.
//
// Split rather than an early return inside one component for the reason #302
// documents: the check must sit ABOVE the hooks, and a hook cannot live below a
// conditional return — permRecord arrives asynchronously, so the same instance
// would render first without it and then with it, changing its hook count.
//
// Layer 1 is the route mount in App.jsx, which independently refuses to render
// this component at all. Neither layer relies on the other; deleting either one
// leaves a working gate.
export default function DisplayRegister(props) {
  const { permRecord, hasPermission, isSuperAdmin } = usePermissions();
  const stockRole = isSuperAdmin ? "admin" : (permRecord?.stockRole || null);
  const canAccessStock =
    stockRole === "admin" || stockRole === "warehouse" || hasPermission("stock_management");

  if (!mayUseDisplayRegister({ canAccessStock, hasPermission })) {
    return <DisplayRegisterNotAuthorized onExit={props.onExit} />;
  }
  return <DisplayRegisterAuthed {...props} />;
}

function DisplayRegisterNotAuthorized({ onExit = null }) {
  return (
    <div style={{ padding: "48px 22px", textAlign: "center", color: "#cfd6e4", fontFamily: FONT }}>
      <div style={{ fontSize: 34, marginBottom: 10 }}>🔒</div>
      <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>Display Register</div>
      <div style={{ fontSize: 13, color: "rgba(233,238,255,.55)", maxWidth: 420, margin: "0 auto" }}>
        You don’t have access to the Display Register. Ask an admin for stock access, or the
        display permission if you work the floor.
      </div>
      {onExit && (
        <button onClick={onExit}
                style={{ marginTop: 18, padding: "9px 16px", borderRadius: 10, cursor: "pointer",
                         background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.14)",
                         color: "#cfd6e4", fontFamily: FONT, fontSize: 13, fontWeight: 700 }}>
          Back
        </button>
      )}
    </div>
  );
}

// Everything below here runs ONLY for a viewer who passed the gate.
function DisplayRegisterAuthed({ products = [], onExit = null, standalone = false }) {
  // Self-sufficient: it is its own top-level module, not a Stock sub-tab, so it
  // sources its own registry and its own user rather than being threaded props.
  const registry = useLocations();
  const { permRecord } = usePermissions();
  const fixedStore = permRecord?.destShop || null;
  const actorName = permRecord?.name || permRecord?.username || null;

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

  // ── SEARCH: name, brand, SKU, and BARCODE — including the last few digits ──
  // Staff read the tail of a barcode off the label rather than the whole 8-digit
  // code, and the codes are zero-padded ("00022806"), so a leading-zero-stripped
  // suffix like "22806" — or just "2806" — has to find it. Every per-size barcode
  // is searched too, so scanning or typing a SIZE code lands on the product and
  // pre-selects that size.
  const codesOf = (p) => {
    const out = [];
    if (p.barcode) out.push(["", String(p.barcode)]);
    const bs = p.barcodes && typeof p.barcodes === "object" ? p.barcodes : {};
    for (const [size, code] of Object.entries(bs)) if (code) out.push([String(size), String(code)]);
    if (p.sku) out.push(["", String(p.sku)]);
    return out;
  };
  const digitsOnly = (v) => String(v).replace(/\D/g, "");
  const codeHit = (code, term, termDigits) => {
    const c = String(code).toLowerCase();
    if (c.includes(term)) return true;
    if (!termDigits) return false;
    const cd = digitsOnly(code);
    // suffix match ("22806" or "2806" finds "00022806") and leading-zero-stripped
    return cd.endsWith(termDigits) || cd.replace(/^0+/, "") === termDigits.replace(/^0+/, "");
  };

  const searchResults = useMemo(() => {
    const term = q.trim().toLowerCase();
    const termDigits = digitsOnly(term);
    // No query -> LIST EVERYTHING, so staff can browse the floor and tick things
    // off rather than having to know what to type.
    if (!term) return footwear.slice(0, 400);
    const scored = [];
    for (const p of footwear) {
      const text = `${p.name || ""} ${p.brand || ""} ${p.sku || ""}`.toLowerCase();
      let matchedSize = null;
      let hit = text.includes(term);
      if (termDigits.length >= 3) {
        for (const [size, code] of codesOf(p)) {
          if (codeHit(code, term, termDigits)) { hit = true; if (size) matchedSize = size; break; }
        }
      }
      if (hit) scored.push({ p, matchedSize });
      if (scored.length >= 400) break;
    }
    return scored.map((x) => Object.assign(x.p, { __matchedSize: x.matchedSize }));
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

  const body = (
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
                <button key={p.id} type="button"
                  onClick={() => (p.__matchedSize ? addEntry(p, p.__matchedSize) : setPicking(p))}
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
                      {(() => {
                        const on = realSizes(p).filter((s2) => registeredKeys.has(entryKey(p.id, s2)));
                        return on.length
                          ? <span style={{ color: "#4ACA7A", fontWeight: 700 }}>{" · on display: " + on.join(", ")}</span>
                          : null;
                      })()}
                      {p.__matchedSize ? <span style={{ color: "#9DBCFF", fontWeight: 700 }}>{" · code → size " + p.__matchedSize}</span> : null}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
          {searchResults.length === 0 && (
            <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.4)", padding: "12px 2px" }}>
              {q.trim() ? `No sneaker matches “${q.trim()}”.` : "No sneakers in the catalogue."}
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

  if (!standalone) return body;
  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff",
                  fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif",
                  maxWidth: 720, margin: "0 auto", paddingBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 14px 12px" }}>
        <div onClick={onExit} style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
                                       borderRadius: 10, padding: "8px 14px", fontSize: 12,
                                       color: "rgba(255,255,255,.7)", cursor: "pointer" }}>← Back</div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: ".5px" }}>Module</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#4A7FFF", letterSpacing: ".5px" }}>DISPLAY</div>
        </div>
        <div style={{ width: 78 }} />
      </div>
      {body}
    </div>
  );
}
