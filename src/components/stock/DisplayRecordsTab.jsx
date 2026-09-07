// ─── DISPLAY RECORDS — retire the ones a live record contradicts ─────────────
//
// (Owner ask, 2026-09-07 — the follow-on to PR #574, which was explicitly not
// worth building until the duplicate SOURCE was dead. It is now.)
//
// PR #574 stopped the display register feeding the shop marker. It changed no
// data, and the register is still read by the COUNT: offShelf.js subtracts
// every row from a hub cell's booked total to say "expect this many on the
// shelf". 140 rows across the two hubs describe displays that were replaced or
// sold, so each one under-states what the counter should find and hands them a
// discrepancy that is not real.
//
// ── WHY THIS SCREEN REFUSES MORE THAN IT OFFERS ──────────────────────────────
// Retiring a row moves NO stock; it raises that cell's expected-on-shelf by one.
// For a ghost that is the fix. For a REAL display it is a slow disaster: the
// next count expects a pair on the shelf that is genuinely out at a shop,
// does not find it, and posts a negative adjustment that destroys a unit which
// exists. So a row is only ever offered when a LIVE RECORD CONTRADICTS IT.
// 582 rows with no shop on record are shown and counted and have NO BUTTON —
// "we have no evidence" is not the same as "it is not there", and that is
// exactly the confusion that would count a real display away.
//
// The classification is pure (displayRecordCleanup.js) and
// scripts/census-display-record-cleanup.mjs runs the SAME function, so the live
// report and this screen can never disagree.
//
// WRITES: only displayRegistrationStore.removeDisplayFact — the existing
// retire writer, which decrements qty, floors at 0 and stamps retiredAt. Rows
// are NEVER deleted (movement linkage and the bumps ladder survive), and this
// screen never passes slotStores, so it can never clear a display slot. See
// retirePlan's comment for why that one is load-bearing.
//
// READS: the two nodes it judges — the picked hub's register (~175 KB) and the
// slots node (~120 KB) — both already streamed elsewhere, and the products list
// the tab is handed. Nothing else, and nothing until the tab is opened.

import React, { useMemo, useState } from "react";
import { classifyDisplayRecords, retirePlan, retireKey, retireEffectLine, CLEANUP_CLASSES } from "./displayRecordCleanup";
import { removeDisplayFact } from "./displayRegistrationStore";
import { useDisplaySlots, useDisplayRegister } from "./useStock";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { decodeSizeKey } from "../../utils/sizeKey";
import { isFootwearProduct } from "./availabilityCore";
import { CARD, BORDER, BLUE, BLUE_L, GREEN, RED, GRAY, AMBER, FONT, bGray, bRed } from "./ui";

const HUBS = ["hub1", "hub2"];

const CLASS_META = {
  replaced: { title: "Replaced", tone: AMBER, blurb: "A shop floor shows this product on display at a DIFFERENT size. This row is the pair that was replaced." },
  sold:     { title: "Sold",     tone: AMBER, blurb: "The display left the floor and nothing replaced it." },
  over:     { title: "Over-registered", tone: AMBER, blurb: "More units are claimed on display than there are shop floors showing that size. Only the surplus is offered." },
  gone:     { title: "Product gone", tone: RED,  blurb: "The product record was deleted or merged away — nothing can sell it, so nobody is looking after this display." },
  unverified: { title: "No shop on record", tone: GRAY, blurb: "Registered before shops were recorded, or with no shop picked. There is no evidence either way, so nothing here can be retired — use Display Registration to attach a shop." },
  matched:  { title: "Confirmed", tone: GREEN, blurb: "A shop floor shows this product at this size. These records are right and are left alone." },
};

const sizeText = (row) => formatSize(row.size ?? decodeSizeKey(row.sizeKey) ?? row.sizeKey);

function Evidence({ row }) {
  if (!row.evidence.length) return null;
  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
      {row.evidence.map((e, i) => (
        <div key={i} style={{ fontSize: 12, color: e.kind === "live" ? BLUE_L : GRAY }}>
          {e.kind === "live"
            ? `On display at ${labelFor(e.store)} — size ${formatSize(e.size ?? e.sizeKey)}`
            : `Left ${labelFor(e.store)}${e.size ? ` — was size ${formatSize(e.size)}` : ""}`}
          {e.at ? <span style={{ color: "rgba(255,255,255,.35)" }}>{`  ·  ${String(e.at).slice(0, 10)}`}</span> : null}
        </div>
      ))}
    </div>
  );
}

export default function DisplayRecordsTab({ products = [], isAdmin = false }) {
  const [hub, setHub] = useState("hub1");
  const [open, setOpen] = useState(() => new Set(["replaced", "sold", "over", "gone"]));
  const [confirm, setConfirm] = useState(null);     // retireKey awaiting a second tap
  const [bulk, setBulk] = useState(false);          // the bulk confirm is showing
  const [busy, setBusy] = useState(null);           // retireKey | "bulk"
  const [done, setDone] = useState(() => new Set()); // retired this session
  const [note, setNote] = useState(null);           // { tone, text }

  const slots = useDisplaySlots(true);
  const register = useDisplayRegister(hub, true);

  // FOOTWEAR ONLY, matching Display Registration: the display walls hold shoes,
  // and a stray clothing row would be judged against slots that never describe
  // it. The catalogue is also what tells `gone` from `not loaded yet`.
  const productsById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) if (p && p.id && isFootwearProduct(p)) m.set(p.id, p);
    return m;
  }, [products]);

  // A HALF-LOADED CATALOGUE MUST NOT MAKE ROWS ACTIONABLE. With no products in
  // hand every pid looks deleted, and a bulk retire would wipe the register.
  const catalogueComplete = (products || []).length > 0;
  const registerLoaded = register != null;
  const slotsLoaded = slots != null;

  const { byClass, counts, actionableCount } = useMemo(
    () => classifyDisplayRecords({ register, slots, hub, productsById, catalogueComplete }),
    [register, slots, hub, productsById, catalogueComplete]
  );

  const pending = (cls) => (byClass[cls] || []).filter((r) => !done.has(retireKey(hub, r)));
  const allActionable = useMemo(
    () => ["replaced", "sold", "over", "gone"].flatMap((c) => pending(c)),
    [byClass, done, hub]
  );

  const retire = async (row) => {
    const k = retireKey(hub, row);
    setBusy(k); setNote(null);
    const plan = retirePlan(row, hub);
    try {
      // ONE GUARDED TRANSACTION, not one call per unit. An over-registered row
      // retires only its surplus, and `expectQty` makes that safe against a
      // stale view: if someone else has already changed the row, this aborts
      // rather than taking a legitimate record down with the surplus.
      const res = await removeDisplayFact({
        hub: plan.hub, product: plan.product, sizeKey: plan.sizeKey,
        slotStores: plan.slotStores, units: plan.times, expectQty: plan.expectQty,
      });
      if (res && res.ok === true && res.superseded) {
        // NOT done — the row stays, and the subscription will re-classify it.
        setNote({ tone: "err", text: res.message || `${row.productName} changed while it was open — look again.` });
        setBusy(null); setConfirm(null); return false;
      }
      if (!res || res.ok !== true) {
        setNote({ tone: "err", text: `Could not retire ${row.productName}: ${res?.message || "write failed"}` });
        setBusy(null); return false;
      }
      setDone((d) => new Set(d).add(k));
      setBusy(null); setConfirm(null);
      return true;
    } catch (err) {
      setNote({ tone: "err", text: `Could not retire ${row.productName}: ${String(err?.message || err)}` });
      setBusy(null); return false;
    }
  };

  const retireAll = async () => {
    setBusy("bulk"); setBulk(false); setNote(null);
    let ok = 0, failed = 0;
    for (const row of allActionable) {
      // eslint-disable-next-line no-await-in-loop
      const good = await retire(row);
      if (good) ok++; else { failed++; break; }   // stop on the first failure — do not hammer a broken write, and do not
                                                  // walk on past a row somebody else is editing
    }
    setBusy(null);
    setNote(failed
      ? { tone: "err", text: `Retired ${ok}, then stopped at a failure. Nothing else was touched — try again when it is fixed.` }
      : { tone: "ok", text: `Retired ${ok} display record${ok === 1 ? "" : "s"}. No stock moved.` });
  };

  const toggle = (c) => setOpen((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });

  if (!isAdmin) {
    return <div style={{ ...card, color: GRAY }}>Display records are admin-only.</div>;
  }

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {HUBS.map((h) => (
            <button key={h} onClick={() => { setHub(h); setConfirm(null); setBulk(false); setNote(null); }}
              style={{ ...bGray, ...(hub === h ? { borderColor: BLUE, color: BLUE_L, background: "rgba(74,127,255,.14)" } : null) }}>
              {labelFor(h)}
            </button>
          ))}
          <div style={{ marginLeft: "auto", fontSize: 12, color: GRAY }}>
            {registerLoaded && slotsLoaded ? `${Object.values(counts).reduce((a, b) => a + b, 0)} live records` : "Loading…"}
          </div>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "rgba(233,238,255,.72)", lineHeight: 1.5 }}>
          A display record tells the count that a booked pair is standing on a shop floor, so the
          shelf should be one short. When the record is wrong the counter is handed a difference
          that is not real. <b style={{ color: "#fff" }}>Retiring one moves no stock</b> — it only stops the
          hub expecting that pair to be out at a shop.
        </p>
      </div>

      {note && (
        <div style={{ ...card, borderColor: note.tone === "err" ? RED : GREEN, color: note.tone === "err" ? RED : GREEN, fontSize: 13, fontWeight: 700 }}>
          {note.text}
        </div>
      )}

      {registerLoaded && slotsLoaded && actionableCount > 0 && (
        <div style={{ ...card, borderColor: "rgba(251,191,36,.4)" }}>
          {!bulk ? (
            <button onClick={() => setBulk(true)} disabled={!!busy}
              style={{ ...bRed, width: "100%", opacity: busy ? 0.5 : 1 }}>
              Retire all {allActionable.length} contradicted record{allActionable.length === 1 ? "" : "s"} at {labelFor(hub)}
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 13, color: "#fff", fontWeight: 700 }}>
                Retire {allActionable.length} record{allActionable.length === 1 ? "" : "s"}?
              </div>
              <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.7)", lineHeight: 1.5 }}>
                Every one of these is contradicted by a live shop record. No stock moves. Each hub cell
                will expect one more pair on the shelf at the next count. Nothing with an unknown shop
                is included.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={retireAll} disabled={!!busy} style={{ ...bRed, opacity: busy ? 0.5 : 1 }}>
                  {busy === "bulk" ? "Retiring…" : "Yes, retire them"}
                </button>
                <button onClick={() => setBulk(false)} disabled={!!busy} style={bGray}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {CLEANUP_CLASSES.map((cls) => {
        const rows = pending(cls);
        const meta = CLASS_META[cls];
        const isOpen = open.has(cls);
        const actionable = cls !== "unverified" && cls !== "matched";
        if (!rows.length && !counts[cls]) return null;
        return (
          <div key={cls} style={card}>
            <button onClick={() => toggle(cls)} style={{ ...bGray, width: "100%", display: "flex", alignItems: "center", gap: 10, background: "transparent", border: "none", padding: 0, cursor: "pointer" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: meta.tone, flexShrink: 0 }} />
              <span style={{ fontWeight: 800, fontSize: 15, color: "#fff" }}>{meta.title}</span>
              <span style={{ fontWeight: 800, fontSize: 15, color: meta.tone }}>{rows.length}</span>
              <span style={{ marginLeft: "auto", color: GRAY, fontSize: 18, lineHeight: 1 }}>{isOpen ? "−" : "+"}</span>
            </button>
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "rgba(233,238,255,.6)", lineHeight: 1.5 }}>{meta.blurb}</p>

            {isOpen && rows.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                {rows.map((row) => {
                  const k = retireKey(hub, row);
                  const asking = confirm === k;
                  return (
                    <div key={k} style={{ border: BORDER, borderRadius: 12, padding: 12, background: "rgba(255,255,255,.02)" }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                        <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: "#fff" }}>
                            {row.productName}
                            {row.deactivated && <span style={{ marginLeft: 8, fontSize: 11, color: GRAY, fontWeight: 600 }}>finished line</span>}
                          </div>
                          <div style={{ fontSize: 12.5, color: "rgba(233,238,255,.6)", marginTop: 2 }}>
                            Registered size <b style={{ color: "#fff" }}>{sizeText(row)}</b>
                            {row.qty > 1 ? ` · ${row.qty} units` : ""}
                            {row.at ? ` · ${String(row.at).slice(0, 10)}` : ""}
                          </div>
                          <div style={{ fontSize: 12.5, color: meta.tone, marginTop: 4 }}>{row.why}</div>
                          <Evidence row={row} />
                        </div>
                        {actionable && (
                          <div style={{ flex: "0 0 auto" }}>
                            {!asking ? (
                              <button onClick={() => { setConfirm(k); setNote(null); }} disabled={!!busy} style={{ ...bGray, opacity: busy ? 0.5 : 1 }}>
                                Retire
                              </button>
                            ) : (
                              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 300 }}>
                                <div style={{ fontSize: 11.5, color: "rgba(233,238,255,.7)", lineHeight: 1.45 }}>{retireEffectLine(row)}</div>
                                <div style={{ display: "flex", gap: 6 }}>
                                  <button onClick={() => retire(row)} disabled={!!busy} style={{ ...bRed, opacity: busy ? 0.5 : 1 }}>
                                    {busy === k ? "Retiring…" : "Confirm"}
                                  </button>
                                  <button onClick={() => setConfirm(null)} disabled={!!busy} style={bGray}>Cancel</button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const card = { background: CARD, border: BORDER, borderRadius: 15, padding: 14 };
