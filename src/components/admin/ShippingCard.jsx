// ─── SHIPPING — THE NUMBERS A PARCEL IS BUILT FROM ───────────────────────────
//
// Super-admin only (#admin/shipping). Every number estimateParcel uses, as an
// editable field with an "unmeasured" marker until Junid measures it: the
// per-category packed sizes and weights (footwear by size band), the boxes he
// stocks, the volumetric divisors, and the drop-box (locker) rule. Below them,
// a "test an order" panel: type an /online_orders ref, it is read by EXACT
// path (one get, never the whole node), the parcel is computed with the
// numbers on screen, and live Courier Guy quotes are fetched beside it.
//
// NOTHING IN THIS CARD BOOKS ANYTHING. Quotes are rates calls, made by the
// Mac mini's quote runner (scripts/shipping/quote-runner.mjs) — the browser
// never holds the API key. The card writes a request to
// /shipping_quotes/requests/{id} and watches ONE answer node,
// /shipping_quotes/answers/{id}, until it arrives or times out. The live
// switch is shown, disabled: "Enable after measurement".
//
// Saving uses update() on /config/shipping with the editable keys only, so
// /config/shipping/live is never written from here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDatabase, ref, get, set, update, onValue, push } from "firebase/database";
import { ADMIN_EMAIL } from "../PermissionsContext";
import { DEFAULT_SHIPPING_CONFIG, ITEM_KINDS, mergeShippingConfig } from "../../shipping/shippingConfig.js";
import { estimateParcel } from "../../shipping/estimateParcel.js";
import { orderLines, deliveryAddress, deliveryContact, orderRef } from "../../shipping/orderShipment.js";
import { assertSafeSegment } from "../../utils/sizeKey.js";

export const QUOTE_TIMEOUT_MS = 60_000;

const EDITABLE_KEYS = ["collectionAddress", "collectionContact", "volumetricDivisor", "divisorByServiceGroup", "items", "boxes", "dropBox", "doorServiceCode", "excludeServiceCodes", "maxChargeRand"];

export const RULE_TEXT = `"config": {
  "shipping": {
    ".write": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
    "live": { ".validate": "newData.isBoolean()" }
  }
},
"shipping_quotes": {
  ".read": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
  ".write": "auth != null && auth.token.email === '${ADMIN_EMAIL}'",
  "answers": { ".indexOn": ["answeredAt"] }
}`;

const S = {
  page: { background: "#000", minHeight: "100vh", color: "#f2f2f7", padding: "16px 16px 80px", maxWidth: 900, margin: "0 auto" },
  btn: { background: "#2c2c2e", color: "#f2f2f7", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" },
  primary: { background: "#0a84ff", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, cursor: "pointer" },
  section: { marginTop: 22, border: "1px solid #2c2c2e", borderRadius: 10, padding: 14, background: "#1c1c1e" },
  h2: { fontSize: 13, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.6, margin: "0 0 10px" },
  row: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid #2c2c2e" },
  label: { fontSize: 14, minWidth: 180, flex: "1 1 180px" },
  num: { width: 64, background: "#000", color: "#f2f2f7", border: "1px solid #3a3a3c", borderRadius: 6, padding: "4px 6px", fontSize: 14 },
  text: { background: "#000", color: "#f2f2f7", border: "1px solid #3a3a3c", borderRadius: 6, padding: "4px 6px", fontSize: 14, minWidth: 120 },
  unmeasured: { fontSize: 11, color: "#ff9f0a", border: "1px solid #ff9f0a", borderRadius: 4, padding: "1px 5px" },
  measured: { fontSize: 11, color: "#30d158", border: "1px solid #30d158", borderRadius: 4, padding: "1px 5px" },
  muted: { fontSize: 13, color: "#8e8e93" },
};

function Num({ value, onChange, step = 0.1, label }) {
  return (
    <input
      aria-label={label}
      type="number"
      step={step}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      style={S.num}
    />
  );
}

function Measured({ value, onChange }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      <span style={value === true ? S.measured : S.unmeasured}>{value === true ? "measured" : "unmeasured"}</span>
    </label>
  );
}

function Dims({ obj, onChange, prefix }) {
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
      <Num label={`${prefix} length cm`} value={obj.lengthCm} step={0.5} onChange={(v) => onChange({ ...obj, lengthCm: v })} />×
      <Num label={`${prefix} width cm`} value={obj.widthCm} step={0.5} onChange={(v) => onChange({ ...obj, widthCm: v })} />×
      <Num label={`${prefix} height cm`} value={obj.heightCm} step={0.5} onChange={(v) => onChange({ ...obj, heightCm: v })} />
      <span style={S.muted}>cm</span>
    </span>
  );
}

function RatesList({ title, block }) {
  if (!block) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
      {block.error && <div style={{ color: "#ff453a", fontSize: 13 }}>{block.error}</div>}
      {!block.error && !(block.rates?.length) && <div style={S.muted}>No rates for this parcel.</div>}
      {(block.rates ?? []).map((r) => (
        <div key={r.code} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "2px 0" }}>
          <span>{r.code} · {r.name}</span>
          <span>R {Number(r.rate).toFixed(2)} · {r.chargedKg} kg</span>
        </div>
      ))}
    </div>
  );
}

export default function ShippingCard({ authUser, products = null, onExit }) {
  // Strict, case-sensitive — the same comparison the RTDB rule makes.
  const isSuperAdmin = authUser?.email === ADMIN_EMAIL;

  const [cfg, setCfg] = useState(null);
  const [live, setLive] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveState, setSaveState] = useState(null);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    get(ref(getDatabase(), "config/shipping"))
      .then((snap) => {
        if (cancelled) return;
        const v = snap.exists() ? snap.val() : null;
        setLive(v?.live === true);
        setCfg(mergeShippingConfig(v));
      })
      .catch((e) => { if (!cancelled) { setLoadError(String(e?.message || e)); setCfg(mergeShippingConfig(null)); } });
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  const patch = useCallback((fn) => { setCfg((c) => fn(JSON.parse(JSON.stringify(c)))); setSaveState(null); }, []);

  const save = useCallback(async () => {
    setSaveState("saving");
    try {
      const out = {};
      for (const k of EDITABLE_KEYS) out[k] = cfg[k];
      await update(ref(getDatabase(), "config/shipping"), out);
      setSaveState("saved");
    } catch (e) {
      setSaveState(/permission_denied/i.test(String(e?.message || e)) ? "denied" : `error: ${e?.message || e}`);
    }
  }, [cfg]);

  // ── test an order ──
  const [refInput, setRefInput] = useState("");
  const [order, setOrder] = useState(null);
  const [orderState, setOrderState] = useState(null);
  const [quote, setQuote] = useState(null);
  const quoteUnsub = useRef(null);
  const quoteTimer = useRef(null);
  // Every request (and every order read) takes a ticket; an answer or timeout
  // for a stale ticket — a newer request, a new order, an unmounted card —
  // writes nothing. Same guard as CostWatchCard's loadGen.
  const quoteGen = useRef(0);
  const stopQuote = () => {
    quoteGen.current += 1;
    if (quoteUnsub.current) { quoteUnsub.current(); quoteUnsub.current = null; }
    if (quoteTimer.current) { clearTimeout(quoteTimer.current); quoteTimer.current = null; }
  };
  useEffect(() => stopQuote, []);

  const loadOrder = useCallback(async () => {
    stopQuote();
    setQuote(null);
    setOrder(null);
    let seg;
    try { seg = assertSafeSegment(refInput.trim(), "order ref"); }
    catch { setOrderState("That is not a valid order ref."); return; }
    // Orders are keyed by their Shopify order id; the three-letter code (KQZ)
    // is a field on the order, looked up through its registry by exact path.
    if (/^[a-z]{3}$/i.test(seg)) {
      const code = seg.toUpperCase();
      try {
        const claim = await get(ref(getDatabase(), `online_order_refs/${code}`));
        if (!claim.exists()) { setOrderState(`No order has the code ${code}.`); return; }
        seg = String(claim.val().orderId);
      } catch (e) {
        setOrderState(`Could not look up ${code}: ${e?.message || e}`);
        return;
      }
    }
    setOrderState("Reading…");
    try {
      const snap = await get(ref(getDatabase(), `online_orders/${seg}`));
      if (!snap.exists()) { setOrderState(`No order at /online_orders/${seg}.`); return; }
      setOrder({ key: seg, ...snap.val() });
      setOrderState(null);
    } catch (e) {
      setOrderState(`Could not read the order: ${e?.message || e}`);
    }
  }, [refInput]);

  const test = useMemo(() => {
    if (!order || !cfg) return null;
    const lines = orderLines(order, products);
    const addr = deliveryAddress(order);
    const contact = deliveryContact(order);
    let parcel = null, parcelError = null;
    try { parcel = estimateParcel(lines, cfg); } catch (e) { parcelError = String(e?.message || e); }
    return { lines, addr, contact, parcel, parcelError };
  }, [order, cfg, products]);

  const requestQuotes = useCallback(async () => {
    if (!test?.parcel) return;
    stopQuote();
    const gen = quoteGen.current;
    const current = () => quoteGen.current === gen;
    const db = getDatabase();
    const reqRef = push(ref(db, "shipping_quotes/requests"));
    const id = reqRef.key;
    setQuote({ state: "waiting", id });
    try {
      await set(reqRef, {
        ref: orderRef(order) || order.key,
        collectionAddress: cfg.collectionAddress,
        deliveryAddress: test.addr.address,
        parcel: {
          lengthCm: test.parcel.lengthCm, widthCm: test.parcel.widthCm,
          heightCm: test.parcel.heightCm, actualKg: test.parcel.actualKg,
        },
        dropBox: {
          pickupPointId: cfg.dropBox.pickupPointId,
          pickupPointProvider: cfg.dropBox.pickupPointProvider,
        },
        requestedAt: Date.now(),
        by: authUser?.email ?? null,
      });
    } catch (e) {
      if (current()) setQuote({ state: /permission_denied/i.test(String(e?.message || e)) ? "denied" : "error", error: String(e?.message || e) });
      return;
    }
    if (!current()) return; // the order changed (or the card closed) while the request was being written
    // ONE answer node, by exact path; dropped as soon as it answers.
    quoteUnsub.current = onValue(ref(db, `shipping_quotes/answers/${id}`), (snap) => {
      if (!snap.exists() || !current()) return;
      stopQuote();
      setQuote({ state: "answered", id, answer: snap.val() });
    }, (e) => { stopQuote(); setQuote({ state: "error", error: String(e?.message || e) }); });
    quoteTimer.current = setTimeout(() => {
      stopQuote();
      setQuote({ state: "timeout", id });
    }, QUOTE_TIMEOUT_MS);
  }, [test, order, cfg, authUser]);

  if (!isSuperAdmin) {
    return (
      <div style={{ padding: 24, color: "#8e8e93", background: "#000", minHeight: "100vh" }}>
        This card is for the account owner only.
        <div><button onClick={onExit} style={{ ...S.btn, marginTop: 16 }}>Back</button></div>
      </div>
    );
  }

  if (!cfg) return <div style={{ ...S.page, color: "#8e8e93" }}>Reading…</div>;

  const unmeasuredCount =
    ITEM_KINDS.filter((k) => cfg.items[k]?.measured !== true).length +
    (cfg.boxes ?? []).filter((b) => b.measured !== true).length +
    (cfg.dropBox?.lockers ?? []).filter((l) => l.measured !== true).length;

  return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Shipping</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} style={S.primary} disabled={saveState === "saving"}>Save</button>
          <button onClick={onExit} style={S.btn}>Back</button>
        </div>
      </div>
      <div style={{ ...S.muted, marginTop: 4 }}>
        Courier Guy parcels are worked out from these numbers — nobody types a size or a weight.
        {unmeasuredCount > 0 && <> <span style={{ color: "#ff9f0a" }}>{unmeasuredCount} still unmeasured.</span></>}
      </div>
      {saveState === "saved" && <div style={{ color: "#30d158", fontSize: 13, marginTop: 6 }}>Saved.</div>}
      {saveState === "denied" && (
        <div style={{ ...S.section, borderColor: "#ff9f0a" }}>
          <div style={{ color: "#ff9f0a", fontWeight: 600, fontSize: 14 }}>The database rule for /config/shipping has not been added yet</div>
          <pre style={{ marginTop: 10, padding: 10, background: "#000", borderRadius: 8, color: "#d1d1d6", fontSize: 12, overflowX: "auto" }}>{RULE_TEXT}</pre>
        </div>
      )}
      {saveState?.startsWith?.("error") && <div style={{ color: "#ff453a", fontSize: 13, marginTop: 6 }}>{saveState}</div>}
      {loadError && <div style={{ color: "#ff9f0a", fontSize: 13, marginTop: 6 }}>Showing defaults — could not read /config/shipping: {loadError}</div>}

      {/* ── live switch: shown, never enabled from here ── */}
      <div style={{ ...S.section, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Book real shipments</div>
          <div style={S.muted}>Enable after measurement</div>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: 0.5 }}>
          <input type="checkbox" aria-label="Book real shipments" checked={live} disabled readOnly />
          <span style={{ fontSize: 13 }}>{live ? "On" : "Off — dry run"}</span>
        </label>
      </div>

      {/* ── items ── */}
      <div style={S.section}>
        <h2 style={S.h2}>What each item packs as</h2>
        {ITEM_KINDS.map((k) => {
          const it = cfg.items[k];
          if (!it) return null;
          const setIt = (next) => patch((c) => { c.items[k] = next; return c; });
          return (
            <div key={k} style={S.row}>
              <span style={S.label}>{it.label}</span>
              <Dims obj={it} prefix={it.label} onChange={setIt} />
              {Array.isArray(it.bands) ? (
                <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                  {it.bands.map((b, i) => (
                    <span key={i} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 13 }}>
                      ≤ {it.sizeScale === "euKids" ? "EU" : "UK"} <Num label={`${it.label} band ${i + 1} size`} value={b.upToSize} step={0.5}
                        onChange={(v) => patch((c) => { c.items[k].bands[i].upToSize = v; return c; })} />
                      <Num label={`${it.label} band ${i + 1} kg`} value={b.kg} step={0.05}
                        onChange={(v) => patch((c) => { c.items[k].bands[i].kg = v; return c; })} /> kg
                    </span>
                  ))}
                </span>
              ) : (
                <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <Num label={`${it.label} kg`} value={it.kg} step={0.05} onChange={(v) => setIt({ ...it, kg: v })} /><span style={S.muted}>kg</span>
                </span>
              )}
              <Measured value={it.measured} onChange={(v) => setIt({ ...it, measured: v })} />
            </div>
          );
        })}
      </div>

      {/* ── boxes ── */}
      <div style={S.section}>
        <h2 style={S.h2}>Boxes in stock</h2>
        {(cfg.boxes ?? []).map((b, i) => {
          const setB = (next) => patch((c) => { c.boxes[i] = next; return c; });
          return (
            <div key={b.id ?? `seed-${i}`} style={S.row}>
              <input aria-label={`box ${i + 1} code`} value={b.code} onChange={(e) => setB({ ...b, code: e.target.value })} style={{ ...S.text, minWidth: 70, width: 70 }} />
              <input aria-label={`box ${i + 1} label`} value={b.label ?? ""} onChange={(e) => setB({ ...b, label: e.target.value })} style={{ ...S.text, flex: "1 1 140px" }} />
              <Dims obj={b} prefix={`box ${b.code}`} onChange={setB} />
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <Num label={`box ${b.code} empty kg`} value={b.tareKg} step={0.05} onChange={(v) => setB({ ...b, tareKg: v })} /><span style={S.muted}>kg empty</span>
              </span>
              <Measured value={b.measured} onChange={(v) => setB({ ...b, measured: v })} />
              <button style={S.btn} onClick={() => patch((c) => { c.boxes.splice(i, 1); return c; })}>Remove</button>
            </div>
          );
        })}
        <button style={{ ...S.btn, marginTop: 8 }} onClick={() => patch((c) => {
          c.boxes.push({ id: `box-${Date.now().toString(36)}`, code: `BOX${c.boxes.length + 1}`, label: "New box", lengthCm: 30, widthCm: 20, heightCm: 10, tareKg: 0.2, measured: false });
          return c;
        })}>Add a box</button>
      </div>

      {/* ── weight maths ── */}
      <div style={S.section}>
        <h2 style={S.h2}>Volumetric weight</h2>
        <div style={S.row}>
          <span style={S.label}>Divisor the estimate uses (cm³ per kg)</span>
          <Num label="volumetric divisor" value={cfg.volumetricDivisor} step={500}
            onChange={(v) => patch((c) => { c.volumetricDivisor = v; return c; })} />
          <span style={S.measured}>measured from TCG rates</span>
        </div>
        {Object.entries(cfg.divisorByServiceGroup ?? {}).map(([g, d]) => (
          <div key={g} style={S.row}>
            <span style={S.label}>{g}</span>
            <Num label={`divisor ${g}`} value={d} step={500} onChange={(v) => patch((c) => { c.divisorByServiceGroup[g] = v; return c; })} />
          </div>
        ))}
        <div style={{ ...S.muted, marginTop: 6 }}>Chargeable weight = the larger of actual and L×W×H ÷ divisor. Courier Guy's own quote is always the price.</div>
      </div>

      {/* ── drop box ── */}
      <div style={S.section}>
        <h2 style={S.h2}>Drop box (TCG locker)</h2>
        <div style={S.row}>
          <span style={S.label}>Use a locker when the parcel fits one</span>
          <input type="checkbox" aria-label="drop box enabled" checked={cfg.dropBox.enabled === true}
            onChange={(e) => patch((c) => { c.dropBox.enabled = e.target.checked; return c; })} />
          <span style={S.muted}>drop-off point {cfg.dropBox.pickupPointId} ({cfg.dropBox.pickupPointProvider}) — "Any locker"</span>
        </div>
        {(cfg.dropBox.lockers ?? []).map((lk, i) => {
          const setL = (next) => patch((c) => { c.dropBox.lockers[i] = next; return c; });
          return (
            <div key={lk.size} style={S.row}>
              <span style={{ ...S.label, minWidth: 60, flex: "0 0 60px" }}>Locker {lk.size}</span>
              <Dims obj={lk} prefix={`locker ${lk.size}`} onChange={setL} />
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                ≤ <Num label={`locker ${lk.size} max kg`} value={lk.maxKg} step={0.5} onChange={(v) => setL({ ...lk, maxKg: v })} /><span style={S.muted}>kg</span>
              </span>
              <input aria-label={`locker ${lk.size} service`} value={lk.serviceCode} onChange={(e) => setL({ ...lk, serviceCode: e.target.value })} style={S.text} />
              <Measured value={lk.measured} onChange={(v) => setL({ ...lk, measured: v })} />
            </div>
          );
        })}
        <div style={S.row}>
          <span style={S.label}>Above every locker: door collection, service</span>
          <input aria-label="door service" value={cfg.doorServiceCode} onChange={(e) => patch((c) => { c.doorServiceCode = e.target.value; return c; })} style={S.text} />
          <span style={S.muted}>(booking takes the cheapest door quote, never</span>
          <input aria-label="excluded services" value={(cfg.excludeServiceCodes ?? []).join(", ")}
            onChange={(e) => patch((c) => { c.excludeServiceCodes = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); return c; })} style={S.text} />
          <span style={S.muted}>)</span>
        </div>
      </div>

      <div style={S.section}>
        <h2 style={S.h2}>Spend ceiling</h2>
        <div style={S.row}>
          <span style={S.label}>Never book a parcel quoted above (R, incl. VAT)</span>
          <Num label="max charge rand" value={cfg.maxChargeRand} step={10} onChange={(v) => patch((c) => { c.maxChargeRand = v; return c; })} />
        </div>
      </div>

      {/* ── collection address ── */}
      <div style={S.section}>
        <h2 style={S.h2}>Collected from</h2>
        {["company", "street_address", "local_area", "city", "zone", "code"].map((f) => (
          <div key={f} style={S.row}>
            <span style={S.label}>{f.replace("_", " ")}</span>
            <input aria-label={`collection ${f}`} value={cfg.collectionAddress?.[f] ?? ""}
              onChange={(e) => patch((c) => { c.collectionAddress[f] = e.target.value; return c; })} style={{ ...S.text, flex: "1 1 220px" }} />
          </div>
        ))}
      </div>

      <div style={S.section}>
        <h2 style={S.h2}>Collection contact (Courier Guy calls or emails them)</h2>
        {[["name", "name"], ["mobile_number", "mobile"], ["email", "email"]].map(([f, label]) => (
          <div key={f} style={S.row}>
            <span style={S.label}>{label}</span>
            <input aria-label={`collection contact ${label}`} value={cfg.collectionContact?.[f] ?? ""}
              onChange={(e) => patch((c) => { c.collectionContact = { ...(c.collectionContact ?? {}), [f]: e.target.value }; return c; })} style={{ ...S.text, flex: "1 1 220px" }} />
          </div>
        ))}
        {!cfg.collectionContact?.mobile_number && !cfg.collectionContact?.email && (
          <div style={{ color: "#ff9f0a", fontSize: 13, marginTop: 6 }}>A mobile or email is needed before anything can be booked.</div>
        )}
      </div>

      {/* ── test an order ── */}
      <div style={S.section}>
        <h2 style={S.h2}>Test an order</h2>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input aria-label="order ref" placeholder="Order code (KQZ) or Shopify order id" value={refInput}
            onChange={(e) => setRefInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") loadOrder(); }}
            style={{ ...S.text, flex: "1 1 200px" }} />
          <button style={S.btn} onClick={loadOrder}>Read order</button>
        </div>
        {orderState && <div style={{ ...S.muted, marginTop: 8 }}>{orderState}</div>}
        {test && (
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
            <div style={{ flex: "1 1 280px" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{orderRef(order) || order.key} <span style={S.muted}>· /online_orders/{order.key}</span></div>
              {test.lines.map((l, i) => (
                <div key={i} style={{ fontSize: 13 }}>{l.qty} × {l.name || l.productId} {l.size && `(${l.size})`}</div>
              ))}
              <div style={{ ...S.muted, marginTop: 6 }}>
                {[test.addr.address.street_address, test.addr.address.local_area, test.addr.address.city, test.addr.address.code].filter(Boolean).join(", ")}
              </div>
              {[...test.addr.missing, ...test.contact.missing].length > 0 && (
                <div style={{ color: "#ff9f0a", fontSize: 13 }}>Missing: {[...test.addr.missing, ...test.contact.missing].join(", ")}</div>
              )}
              {test.parcelError && <div style={{ color: "#ff453a", fontSize: 13 }}>{test.parcelError}</div>}
              {test.parcel && (
                <div style={{ marginTop: 10, fontSize: 14 }}>
                  <div><b>{test.parcel.boxCode ?? "No standard box fits"}</b> · {test.parcel.lengthCm}×{test.parcel.widthCm}×{test.parcel.heightCm} cm</div>
                  <div>{test.parcel.actualKg} kg actual · {test.parcel.volumetricKg} kg volumetric · <b>{test.parcel.chargeableKg} kg chargeable</b></div>
                  <div>{test.parcel.dropBoxEligible ? `Drop box — locker ${test.parcel.lockerSize}` : "Door collection"} · {test.parcel.service}</div>
                  {test.parcel.guessed.length > 0 && <div style={{ color: "#ff9f0a", fontSize: 13 }}>Guessed as a folded top: {test.parcel.guessed.join(", ")}</div>}
                  {test.parcel.unmeasured.length > 0 && <div style={{ color: "#ff9f0a", fontSize: 13 }}>Built from unmeasured: {test.parcel.unmeasured.join(", ")}</div>}
                  <button style={{ ...S.primary, marginTop: 10 }} onClick={requestQuotes} disabled={quote?.state === "waiting"}>Get live quotes</button>
                </div>
              )}
            </div>
            <div style={{ flex: "1 1 280px" }}>
              {quote?.state === "waiting" && <div style={S.muted}>Asking Courier Guy (via the Mac mini)…</div>}
              {quote?.state === "timeout" && <div style={{ color: "#ff9f0a", fontSize: 13 }}>The Mac mini did not answer within a minute — is com.marathon.shippingquotes running?</div>}
              {quote?.state === "denied" && <pre style={{ padding: 10, background: "#000", borderRadius: 8, color: "#d1d1d6", fontSize: 12, overflowX: "auto" }}>{RULE_TEXT}</pre>}
              {quote?.state === "error" && <div style={{ color: "#ff453a", fontSize: 13 }}>{quote.error}</div>}
              {quote?.state === "answered" && (
                <>
                  {quote.answer.error && <div style={{ color: "#ff453a", fontSize: 13 }}>{quote.answer.error}</div>}
                  <RatesList title="Drop box (locker)" block={quote.answer.locker} />
                  <RatesList title="Door collection" block={quote.answer.door} />
                  {quote.answer.chosen && (
                    <div style={{ marginTop: 10, fontSize: 14 }}>
                      Booking would choose <b>{quote.answer.chosen.code}</b> at R {Number(quote.answer.chosen.rate).toFixed(2)}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
