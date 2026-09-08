// ─── DUPLICATE DISPLAYS — one product, more than one display registered ──────
//
// (Owner spec clause 4, 2026-09-08.)
//
// Every product holding MORE THAN ONE OPEN ROW at a store. The operator keeps
// the size that is actually on the wall and closes the rest, one tap per size
// with a confirm; if the real size is not listed they register it here.
//
// ── WHY THIS COULD NOT BE BUILT BEFORE ───────────────────────────────────────
// The display record used to be /settings/displaySlots/{store}/{productId} —
// ONE record per product per store. A second send overwrote the first, so "two
// displays registered for this shoe at this wall" was not a state the data
// could hold. Measured live 2026-09-08: 479 live slots, zero store+product
// pairs with more than one, and it could never have been any other number.
// Meanwhile the wall really does end up with two pairs, because a send that
// overwrites tells nobody the old pair is still standing there.
//
// displayRowCore.js gives the record a life instead of a cell: many rows per
// (store, product), each opened and closed with a reason and a timeline. This
// screen is what a human does with the ones that overlap.
//
// ── CLOSING CORRECTS THE RECORD AND MOVES NO STOCK ───────────────────────────
// Said on every confirm, from ONE function (closeEffectLine), because three
// screens each writing their own version of that promise is how one of them
// ends up wrong. The pair stays booked at its hub exactly as it was; what
// changes is what the record claims is on the wall.
//
// The direction of risk is the mirror of the Display Records tab's: there,
// retiring a row raises the shelf expectation and a wrong retire destroys a
// real unit. Here, closing a DUPLICATE lowers the number of pairs claimed to be
// off-shelf, which the count reads through the slot — and the slot is only
// re-pointed when a row survives, never cleared while another row is still
// open (displayRowStore.closeDisplayRow). So a mis-tap costs a record, not a
// unit, and it is reversible by registering the size again on this same screen.
//
// HUB 1 AND HUB 2 ONLY, per GATED_SNEAKER_HUBS. A Pine display is booked at
// hub3 and is out of this screen's scope; the header says so rather than
// silently showing a shorter list.

import React, { useMemo, useState } from "react";
import { duplicateDisplayGroups, duplicateRowCount } from "./displayRowCore";
import { closeDisplayRow, registerDisplayRow } from "./displayRowStore";
import { useDisplayRowsState } from "./useStock";
import { GATED_SNEAKER_HUBS } from "./availabilityCore";
import { labelFor } from "./locations";
import { formatSize } from "../../utils/sizeLabel";
import { card, Photo, SizePicker, HistoryToggle, RowLine, NoStockMovedLine } from "./displayRowUi";
import { BORDER, BLUE_L, GREEN, RED, GRAY, AMBER, FONT, bGray, bRed } from "./ui";

export default function DuplicateDisplaysTab({ products = [], isAdmin = false }) {
  // `settled`, never `value != null`: an empty ledger and a subscription that
  // has not answered are the same null, and a screen that offers a CLOSE button
  // must never offer one on the strength of data it has not received.
  const { value: rows, settled: loaded } = useDisplayRowsState(true);
  const [confirm, setConfirm] = useState(null);   // `${store}::${pid}::${rowId}` awaiting a second tap
  const [adding, setAdding] = useState(null);     // `${store}::${pid}` — the "not listed" picker
  const [addHub, setAddHub] = useState(null);     // which hub, when the group's rows disagree
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  const productsById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) if (p && p.id) m.set(p.id, p);
    return m;
  }, [products]);

  const groups = useMemo(
    () => duplicateDisplayGroups({ rows, productsById, hubs: GATED_SNEAKER_HUBS }),
    [rows, productsById]
  );
  const surplus = duplicateRowCount(groups);

  if (!isAdmin) return <div style={{ ...card, color: GRAY, fontFamily: FONT }}>Display records are admin-only.</div>;

  const close = async (group, row) => {
    const k = `${row.store}::${row.productId}::${row.rowId}`;
    setBusy(k); setNote(null);
    const res = await closeDisplayRow({ rows, row, reason: "corrected", via: "duplicate_tab",
                                        detail: { reason: "corrected", keptAtWall: true } });
    setBusy(null); setConfirm(null);
    if (!res.ok) { setNote({ tone: "err", text: `Could not close that record: ${res.message}` }); return; }
    if (res.warning) setNote({ tone: "err", text: res.warning });
    else setNote({ tone: "ok", text: `Closed the size ${formatSize(row.size)} record for ${group.productName} at ${labelFor(row.store)}. No stock moved.` });
  };

  // THE HUB THE NEW ROW IS BOOKED AT, when the group agrees on one.
  // duplicateDisplayGroups groups by (store, product), so a group can hold a
  // hub1 row AND a hub2 row — and `rows[0]` is only the OLDEST row, not a
  // decision. Copying its hub onto a newly registered size guessed, and the
  // slot mirror then carried the guess. When the rows disagree the operator
  // picks; when they agree there is nothing to ask. (CodeRabbit.)
  const hubsOf = (g) => [...new Set(g.rows.map((r) => r.bookedHub).filter(Boolean))];

  // WHICH HUB THE NEW ROW GETS, resolved at PICK time and never earlier.
  //
  // Three ways this went wrong before (adversarial review of the fix round):
  //   • `addHub` outlived its validity — pick hub1, someone closes the hub1 row
  //     from another device, the group collapses to hub2 only, the picker is
  //     skipped and the stale hub1 is written anyway;
  //   • a group of [hub1, null] has ONE named hub, so it skipped the question
  //     and applied hub1 — the same guess by another route;
  //   • a group where EVERY row is hubless wrote bookedHub null, minting the
  //     one row the till trigger can never close while it blocks every other
  //     close at that wall.
  // So: the choice must still be among the group's current hubs, a hubless row
  // present means the group cannot speak for itself, and a group with no hub at
  // all offers the two real hubs. Nothing here falls back to a guess.
  const hubChoiceFor = (g) => {
    const named = hubsOf(g);
    const anyHubless = g.rows.some((r) => !r.bookedHub);
    if (named.length === 1 && !anyHubless) return { needsPick: false, hub: named[0], options: named };
    const options = named.length ? (anyHubless ? [...named, ...GATED_SNEAKER_HUBS.filter((h) => !named.includes(h))] : named)
                                 : [...GATED_SNEAKER_HUBS];
    return { needsPick: true, hub: null, options };
  };

  const addSize = async (group, size, hub) => {
    const k = `${group.store}::${group.productId}`;
    setBusy(k); setNote(null);
    // keepOpen: the operator is about to decide which of the existing rows
    // stays. Closing them here would take that decision away from them, and
    // they are standing at the wall and we are not.
    const res = await registerDisplayRow({
      rows, store: group.store, productId: group.productId, productName: group.productName,
      size, bookedHub: hub, via: "wall_walk", keepOpen: true,
    });
    setBusy(null); setAdding(null); setAddHub(null);
    if (!res.ok) { setNote({ tone: "err", text: `Could not register size ${formatSize(size)}: ${res.message}` }); return; }
    setNote({ tone: "ok", text: `Registered size ${formatSize(size)} at ${labelFor(group.store)}. Now close the sizes that are not on the wall.` });
  };

  return (
    <div style={{ fontFamily: FONT, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 15, color: "#fff" }}>Products with more than one display registered</span>
          <span style={{ fontWeight: 800, fontSize: 15, color: groups.length ? AMBER : GREEN }}>{loaded ? groups.length : "…"}</span>
          {loaded && surplus > 0 && (
            <span style={{ fontSize: 12, color: GRAY }}>{surplus} record{surplus === 1 ? "" : "s"} too many</span>
          )}
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 13, color: "rgba(233,238,255,.72)", lineHeight: 1.5 }}>
          Each of these says a shop's wall is holding two or more pairs of the same shoe. Walk to the wall,
          keep the size that is really there and close the rest. <b style={{ color: "#fff" }}>Closing a record
          moves no stock</b> — the pair stays booked at its hub exactly as it is; this only corrects what the
          record says is on the wall. If the size on the wall is not listed, register it here first.
        </p>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: GRAY, lineHeight: 1.5 }}>
          Hub 1 and Hub 2 only. A Pine display is booked at Hub 3 and is not shown here.
        </p>
      </div>

      {note && (
        <div style={{ ...card, borderColor: note.tone === "err" ? RED : GREEN, color: note.tone === "err" ? RED : GREEN, fontSize: 13, fontWeight: 700 }}>
          {note.text}
        </div>
      )}

      {loaded && groups.length === 0 && (
        <div style={{ ...card, color: GREEN, fontSize: 13, fontWeight: 700 }}>
          No product is registered on display more than once. Nothing to correct.
        </div>
      )}

      {groups.map((g) => {
        const gk = `${g.store}::${g.productId}`;
        const sizes = (Array.isArray(g.product?.sizes) ? g.product.sizes : [])
          .map(String).map((x) => x.trim()).filter((x) => x && x !== "_");
        return (
          <div key={gk} style={card}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <Photo url={g.product?.photoUrl || g.product?.photo} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, fontWeight: 800, color: "#fff" }}>{g.productName}</div>
                <div style={{ fontSize: 12.5, color: BLUE_L, marginTop: 2 }}>
                  {labelFor(g.store)} · {g.rows.length} display records open
                </div>
              </div>
            </div>

            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {g.rows.map((row) => {
                const k = `${row.store}::${row.productId}::${row.rowId}`;
                const asking = confirm === k;
                return (
                  <div key={row.rowId} style={{ border: BORDER, borderRadius: 12, padding: 11, background: "rgba(255,255,255,.02)" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                        <RowLine row={row} />
                        <HistoryToggle row={row} />
                      </div>
                      <div style={{ flex: "0 0 auto" }}>
                        {!asking ? (
                          <button type="button" onClick={() => { setConfirm(k); setNote(null); }} disabled={!!busy}
                            style={{ ...bGray, opacity: busy ? 0.5 : 1 }}>
                            Not on the wall — close it
                          </button>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
                            <NoStockMovedLine row={row} />
                            <div style={{ display: "flex", gap: 6 }}>
                              <button type="button" onClick={() => close(g, row)} disabled={!!busy} style={{ ...bRed, opacity: busy ? 0.5 : 1 }}>
                                {busy === k ? "Closing…" : "Confirm"}
                              </button>
                              <button type="button" onClick={() => setConfirm(null)} disabled={!!busy} style={bGray}>Cancel</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 10 }}>
              {adding === gk ? (() => {
                const choice = hubChoiceFor(g);
                // A hub picked earlier that the group no longer offers is
                // DISCARDED, not carried: the rows moved under the operator.
                const picked = choice.options.includes(addHub) ? addHub : null;
                if (choice.needsPick && !picked) {
                  return (
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>Which hub is this pair booked at?</div>
                      <div style={{ fontSize: 12, color: "rgba(233,238,255,.65)", lineHeight: 1.5 }}>
                        The records here do not agree on one hub, so it cannot be assumed. Pick the hub the pair on
                        the wall came out of.
                      </div>
                      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                        {choice.options.map((h) => (
                          <button key={h} type="button" onClick={() => setAddHub(h)} style={bGray}>{labelFor(h)}</button>
                        ))}
                        <button type="button" onClick={() => { setAdding(null); setAddHub(null); }} style={bGray}>Cancel</button>
                      </div>
                    </div>
                  );
                }
                const hub = choice.needsPick ? picked : choice.hub;
                return (
                  <SizePicker
                    sizes={sizes}
                    busy={busy === gk}
                    title="Which size is actually on the wall?"
                    note={`Nothing is chosen for you. Pick the size you can see, and it is registered at this shop (booked at ${labelFor(hub)}) alongside the records above — then close the ones that are not there.`}
                    confirmLabel="Register"
                    onPick={(sz) => addSize(g, sz, hub)}
                    onCancel={() => { setAdding(null); setAddHub(null); }}
                  />
                );
              })() : (
                <button type="button" onClick={() => { setAdding(gk); setAddHub(null); setNote(null); }} disabled={!!busy}
                  style={{ ...bGray, opacity: busy ? 0.5 : 1 }}>
                  The size on the wall is not listed
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
