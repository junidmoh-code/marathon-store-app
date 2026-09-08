// ─── STOCK AUDIT — THE SCREEN ────────────────────────────────────────────────
// Two tabs, a store chip row under each, and nothing else.
//
//   OUT OF STOCK   every clothing line that came back unavailable, each row
//                  naming the PLACE the stock was supposed to be and the
//                  quantity the system believed was there. That pair is the
//                  whole point: a line rejected against a cell that still reads
//                  seven is an overstated cell; a line the system calls empty
//                  that the shelf actually holds is an understated one.
//
//   NOT SELLING    a rotating batch of the clothing this store holds, oldest
//                  checked first, with two signals beside each row — sold in
//                  the last 21 days, and a display registered here.
//
// READS: one node per store (/settings/stockAudit/{store}/latest), plus today's
// results day-node so an actioned row does not come back. Nothing else. The
// lists are computed once a day inside refillHealthScan, from data that run
// already holds — see functions/stockAudit/dailyPass.cjs.
//
// There is no generate button, and there is not going to be one. The batch
// rotates on its own three mornings a week; a list that only appears when
// somebody remembers to press something is a list nobody reads.

import React, { useEffect, useMemo, useState } from "react";
import { CARD, BORDER, BLUE, BLUE_L, GRAY, GREEN, RED, AMBER, FONT, input, tabOn, tabOff } from "./ui";
import { usePathState } from "./useStock";
import { formatSize } from "../../utils/sizeLabel";
import { AUDIT_STORES, snapshotPath, resultsPath, saDateOf, locationLabel } from "../../config/stockAudit";
import { serverNowMs } from "../../utils/serverTime";
import { recordOutOfStockOutcome, recordRotationOutcome } from "./stockAuditStore";

// Short status words, not sentences. Staff need to know which shelf and what
// the system thinks; they do not need a description of the mechanism.
const REASON = {
  negative_cell: { text: "Negative", tone: RED },
  rejected: { text: "Rejected", tone: AMBER },
  unfillable: { text: "None upstream", tone: GRAY },
  awaiting_upstream: { text: "Source empty", tone: GRAY },
  open_source_empty: { text: "Waiting", tone: GRAY },
};

const chip = (on, tone = BLUE) => ({
  padding: "9px 15px", borderRadius: 999, fontWeight: 800, fontSize: 13.5, cursor: "pointer",
  fontFamily: FONT, border: `1.5px solid ${on ? tone : "rgba(255,255,255,.14)"}`,
  background: on ? "rgba(74,127,255,.16)" : "rgba(255,255,255,.03)",
  color: on ? BLUE_L : "rgba(233,238,255,.55)",
});

const pill = (tone) => ({
  padding: "3px 8px", borderRadius: 999, fontSize: 11, fontWeight: 800,
  border: `1px solid ${tone}44`, background: `${tone}1A`, color: tone, whiteSpace: "nowrap",
});

const actionBtn = (tone) => ({
  padding: "7px 11px", borderRadius: 9, fontSize: 12, fontWeight: 800, cursor: "pointer",
  fontFamily: FONT, border: `1px solid ${tone}55`, background: `${tone}14`, color: tone,
});

const rowBox = { background: CARD, border: BORDER, borderRadius: 13, padding: "12px 14px", display: "flex", gap: 12, alignItems: "center" };
const nameStyle = { fontSize: 14, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const subStyle = { fontSize: 11.5, color: "rgba(233,238,255,.45)", marginTop: 3 };

// applyMovement's refusal reasons, said plainly. `stale_expectation` is the one
// staff will actually meet: stock moved between the list being built and the
// tap, so the correction was refused rather than applied to a base nobody
// counted. The honest instruction is to look again, not to retry blindly.
//
// THE STRING IS A CONTRACT WITH applyMovement.js, not a name chosen here. It
// shipped as "expect_mismatch" — a plausible invention that matches nothing —
// so the one message this feature built for its headline race never fired, and
// staff met a raw reason code instead. The unit test could not catch it because
// the mock invented the same wrong string on both sides. stockAuditReasons.test
// now reads applyMovement's own source, so a rename there fails here.
// (Adversarial architecture review, PR #580.)
export const STALE = "stale_expectation";
//
// EVERY reason applyMovement can return is answered here — stockAuditReasons
// .test reads its source and fails if one appears without a sentence. A
// correction that refuses is a correction staff must understand; a raw code is
// a dead end at a shelf.
export const FAILURE = {
  [STALE]: "Stock changed while you were looking. Check the shelf again.",
  insufficient_stock: "Not enough on hand to remove.",
  stock_received: "Stock arrived here since the list was built. Check the shelf again.",
  not_authenticated: "Signed out — sign in and try again.",
  retries_exhausted: "Could not save — try again in a moment.",
  write_failed: "Could not save — try again in a moment.",
  invalid_state: "Could not save — try again in a moment.",
  invalid_type: "Could not save — try again in a moment.",
  invalid_quantity: "Enter a whole number, 0 or more.",
  missing_location: "This row has no location.",
  missing_product_or_size: "This row is missing a product or size.",
  qty_must_be_positive: "Enter a whole number, 0 or more.",
  adjustment_requires_reason: "Could not save — try again in a moment.",
  expect_requires_single_cell: "Could not save — try again in a moment.",
  unknown_outcome: "Could not save — try again in a moment.",
  no_sizes: "Nothing to adjust on this row.",
};
function failureText(res) {
  return FAILURE[res?.reason] || `Could not save (${res?.reason || "unknown"}).`;
}

function Empty({ text }) {
  return <div style={{ ...rowBox, justifyContent: "center", color: GRAY, fontSize: 13, padding: "26px 14px" }}>{text}</div>;
}

// ── the snapshot, per store ──────────────────────────────────────────────────
// usePathState, not usePath: a store whose snapshot has never been written and
// a store whose read was DENIED both come back null, and gating on `value !=
// null` would leave the screen saying "loading" forever with no way out.
function useStoreAudit(store, saDate) {
  const snap = usePathState(snapshotPath(store), !!store);
  const results = usePathState(resultsPath(store, saDate), !!store && !!saDate);
  return { snap, results };
}

export default function StockAuditView({ onExit, actorRole = null }) {
  const [tab, setTab] = useState("oos");
  const [store, setStore] = useState(AUDIT_STORES[0].id);
  const [mode, setMode] = useState("product");         // Tab B: product view / size view

  // Server-anchored, so a till with a wrong date does not read yesterday's
  // results node and re-offer rows that were already actioned.
  //
  // AND IT FOLLOWS MIDNIGHT. It was frozen at mount, which is wrong on the one
  // screen most likely to be left open: a shop tablet standing on the counter
  // overnight would keep reading and WRITING yesterday's results node, so the
  // morning's actions would file under the wrong day and the rows they closed
  // would not disappear. The effect below re-reads the SA date exactly when it
  // changes, and the subscription follows the new path. (CodeRabbit, PR #580.)
  const [saDate, setSaDate] = useState(() => saDateOf(serverNowMs()));
  useEffect(() => {
    // Next SA midnight, from server time. Re-armed each time it fires, so a
    // screen left up for a week keeps up rather than drifting one day per
    // mount. The +1s puts the tick safely past the boundary.
    const now = serverNowMs();
    const nextMidnight = Date.parse(`${saDate}T00:00:00.000Z`) + 864e5 - 2 * 60 * 60 * 1000;
    const delay = Math.max(nextMidnight - now, 1000) + 1000;
    const t = setTimeout(() => setSaDate(saDateOf(serverNowMs())), delay);
    return () => clearTimeout(t);
  }, [saDate]);

  const { snap, results } = useStoreAudit(store, saDate);
  const [busy, setBusy] = useState(null);        // the key currently being written
  const [note, setNote] = useState(null);        // { tone, text }

  // One writer for both tabs. The row leaves the list only because the RESULTS
  // node it just wrote came back through the subscription — never because this
  // component optimistically hid it. A refused adjustment must stay on screen.
  const act = async (key, fn) => {
    if (busy) return;
    setBusy(key); setNote(null);
    try {
      const res = await fn();
      if (!res?.ok) setNote({ tone: RED, text: failureText(res) });
    } catch (e) {
      setNote({ tone: RED, text: e?.message || "Failed." });
    } finally { setBusy(null); }
  };

  const data = snap.value;
  // WHAT IS ALREADY ACTIONED IS NOT KNOWN UNTIL THE READ ANSWERS. `results.value
  // || {}` read "not answered yet" and "the read was denied" as "nothing has
  // been done today" — so rows staff had already closed would come back, and
  // they would be invited to action them again against a list that cannot show
  // the work. usePathState tells the three states apart; the list waits for
  // the answer, and if it never comes the rows are shown but not actionable.
  // (CodeRabbit, PR #580.)
  const done = results.value || {};
  const resultsKnown = results.settled && !results.error;

  const oosRows = useMemo(
    () => (data?.oos?.rows || []).filter((r) => !done[r.k]),
    [data, done]
  );
  const rotRows = useMemo(
    () => (data?.rotation?.rows || []).filter((r) => !done[r.p]),
    [data, done]
  );

  return (
    <div style={{ fontFamily: FONT, background: "#000", minHeight: "100vh", color: "#fff", padding: "14px 14px 60px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <button onClick={onExit} style={{ background: "transparent", border: "none", color: BLUE_L, fontSize: 15, cursor: "pointer", padding: 0, fontFamily: FONT }}>← Back</button>
        <div style={{ fontSize: 17, fontWeight: 800 }}>Stock Audit</div>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setTab("oos")} style={tab === "oos" ? tabOn : tabOff}>Out of Stock</button>
        <button onClick={() => setTab("rot")} style={tab === "rot" ? tabOn : tabOff}>Not Selling</button>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {AUDIT_STORES.map((s) => (
          <button key={s.id} onClick={() => setStore(s.id)} style={chip(store === s.id)}>{s.label}</button>
        ))}
      </div>

      {/* The pass rides on refillHealthScan, which stands down entirely while the
          refill engine is off or Central has a receiving session open — so on
          those days no list is recomputed. Staff must never act on a stale list
          believing it is this morning's, so the date is stated whenever it is
          not today's. Silence would be the lie. */}
      {data && data.saDate && data.saDate !== saDate && (
        <div style={{ ...rowBox, color: AMBER, fontSize: 12.5, marginBottom: 10 }}>{`Built ${data.saDate}.`}</div>
      )}

      {note && (
        <div style={{ ...rowBox, borderColor: `${note.tone}55`, color: note.tone, fontSize: 12.5, marginBottom: 10 }}>{note.text}</div>
      )}

      {results.settled && results.error && (
        <div style={{ ...rowBox, color: AMBER, fontSize: 12.5, marginBottom: 10 }}>
          Cannot read today&rsquo;s checks — this list may show work already done.
        </div>
      )}

      {!snap.settled || !results.settled ? <Empty text="Loading…" />
        : snap.error ? <Empty text="Cannot read this store's list." />
        : !data ? <Empty text="Nothing yet." />
        : tab === "oos"
          ? <OutOfStock rows={oosRows} total={data.oos?.total || 0} truncated={!!data.oos?.truncated}
              busy={busy} canAct={resultsKnown} onAction={(row, outcome, actual) =>
                act(row.k, () => recordOutOfStockOutcome({ store, row, outcome, actual, actorRole }))} />
          : <NotSelling data={data} rows={rotRows} mode={mode} setMode={setMode}
              busy={busy} canAct={resultsKnown} onAction={(row, outcome, sizes) =>
                act(row.p, () => recordRotationOutcome({ store, row, outcome, sizes, actorRole }))} />}
    </div>
  );
}

// ── TAB A ────────────────────────────────────────────────────────────────────
function OutOfStock({ rows, total, truncated, busy, canAct, onAction }) {
  if (!rows.length) return <Empty text={total ? "All checked." : "Nothing to check."} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => <OosRow key={r.k} r={r} busy={busy === r.k || !canAct} onAction={onAction} />)}
      {truncated && (
        <div style={{ fontSize: 11.5, color: GRAY, textAlign: "center", padding: "6px 0" }}>
          Showing {rows.length} of {total}.
        </div>
      )}
    </div>
  );
}

// One Tab A row. The quantity input only appears once "Adjust" is tapped —
// a number box on every row invites a number nobody counted.
function OosRow({ r, busy, onAction }) {
  const [adjusting, setAdjusting] = useState(false);
  const [qty, setQty] = useState("");
  const meta = REASON[r.r] || { text: r.r, tone: GRAY };
  return (
    <div style={{ ...rowBox, flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={nameStyle}>{r.n}</div>
          <div style={subStyle}>{formatSize(r.s)} · {locationLabel(r.w)} · system {r.q}</div>
        </div>
        <span style={pill(meta.tone)}>{meta.text}</span>
      </div>
      {adjusting ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" placeholder="On the shelf"
            style={{ ...input, flex: 1, minWidth: 0 }} />
          <button disabled={busy} style={actionBtn(GREEN)}
            onClick={() => onAction(r, "adjusted", qty.trim())}>Save</button>
          <button disabled={busy} style={actionBtn(GRAY)} onClick={() => setAdjusting(false)}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={busy} style={actionBtn(GREEN)} onClick={() => onAction(r, "confirmed_empty")}>Confirmed empty</button>
          <button disabled={busy} style={actionBtn(BLUE_L)} onClick={() => setAdjusting(true)}>Adjust</button>
          <button disabled={busy} style={actionBtn(AMBER)} onClick={() => onAction(r, "flagged")}>Flag</button>
        </div>
      )}
    </div>
  );
}

// ── TAB B ────────────────────────────────────────────────────────────────────
// The two signals render as their ABSENCE, because absence is what staff are
// looking for: a row shows "No sale" when it has not sold, and "No display"
// when none is registered. A product that sold and is on display draws no
// pills at all and needs no reading.
function Signals({ sold, disp, slow, displayKnown = true }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {!sold && <span style={pill(AMBER)}>No sale</span>}
      {/* A DARK SIGNAL IS NOT A NEGATIVE ONE. When the display read failed the
          pass writes displaySignal "unavailable" and every `disp` is false —
          so drawing the pill would put "No display" on every row in the batch
          and read as a finding. Half of Tab B's whole purpose is the
          difference between no-sale-with-a-display and no-sale-without one;
          inventing the answer is worse than not showing it. The banner above
          says the signal is missing, and the pill stays off. */}
      {displayKnown && !disp && <span style={pill(GRAY)}>No display</span>}
      {slow && <span style={pill(GREEN)}>Slow</span>}
    </div>
  );
}

// The four outcomes. All of them stamp and send the product to the back of the
// rotation; only "Not there" moves stock, and only ever to zero, through the
// same single adjustment path.
function RotationRow({ row, title, sub, signals, busy, onAction }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div style={{ ...rowBox, flexDirection: "column", alignItems: "stretch", gap: 10 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={nameStyle}>{title}</div>
          <div style={subStyle}>{sub}</div>
        </div>
        <Signals {...signals} />
      </div>
      {confirm ? (
        // Second tap. "Not there" writes the shelf to zero, and a mis-tap on a
        // product view would zero every size at once — that is worth one more
        // deliberate press.
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: GRAY, flex: 1 }}>Set to zero?</span>
          <button disabled={busy} style={actionBtn(RED)} onClick={() => { setConfirm(false); onAction(row, "not_there"); }}>Yes</button>
          <button disabled={busy} style={actionBtn(GRAY)} onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button disabled={busy} style={actionBtn(GREEN)} onClick={() => onAction(row, "present")}>Present</button>
          <button disabled={busy} style={actionBtn(RED)} onClick={() => setConfirm(true)}>Not there</button>
          <button disabled={busy} style={actionBtn(AMBER)} onClick={() => onAction(row, "not_on_display")}>Not on display</button>
          <button disabled={busy} style={actionBtn(BLUE_L)} onClick={() => onAction(row, "slow")}>Present but slow</button>
        </div>
      )}
    </div>
  );
}

// THE SIZE VIEW READS; THE PRODUCT VIEW ACTS.
//
// It offered the same buttons at first, and that quietly broke the rotation's
// one guarantee. The check stamp is per PRODUCT — that is what the ordering is
// built on — so confirming a single size present stamped the whole product as
// freshly checked and sent its other sizes, which nobody had looked at, to the
// back of a fourteen-week queue. Starving a product is exactly what this
// rotation exists to prevent.
//
// The product row already lists every size with its quantity, so nothing is
// lost by acting there: a rotation outcome is a judgement about a product on a
// floor, and it should be recorded where the whole product is in view.
// (Adversarial architecture review, PR #580.)
function NotSelling({ data, rows, mode, setMode, busy, canAct, onAction }) {
  const displayKnown = data.displaySignal !== "unavailable";
  const sizeRows = useMemo(
    () => rows.flatMap((r) => (r.z || []).map((z) => ({ ...z, p: r.p, n: r.n, slow: r.slow, key: `${r.p}__${z.sk}` }))),
    [rows]
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setMode("product")} style={mode === "product" ? tabOn : tabOff}>Products</button>
        <button onClick={() => setMode("size")} style={mode === "size" ? tabOn : tabOff}>Sizes</button>
      </div>
      {!displayKnown && (
        <div style={{ ...rowBox, color: AMBER, fontSize: 12.5, marginBottom: 10 }}>Display registrations could not be read.</div>
      )}
      {/* An empty list has two very different meanings and they must not look
          the same: the batch was walked, or there was never anything in it. */}
      {!rows.length ? (
        <Empty text={
          data.rotation?.walked ? `Batch done — ${data.rotation.walked} checked.`
            : data.rotation?.rows?.length ? "All checked."
            : "Nothing to check."} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {mode === "product"
            ? rows.map((r) => (
                <RotationRow key={r.p} row={r} busy={busy === r.p || !canAct} onAction={onAction}
                  title={r.n} sub={(r.z || []).map((z) => `${formatSize(z.s)} ${z.q}`).join(" · ")}
                  signals={{ sold: r.sold, disp: r.disp, slow: r.slow, displayKnown }} />
              ))
            : sizeRows.map((z) => (
                <div key={z.key} style={rowBox}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nameStyle}>{z.n}</div>
                    <div style={subStyle}>{formatSize(z.s)} · {z.q}</div>
                  </div>
                  <Signals sold={z.sold} disp={z.disp} slow={z.slow} displayKnown={displayKnown} />
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
