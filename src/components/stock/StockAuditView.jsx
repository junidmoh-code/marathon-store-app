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

import React, { useMemo, useState } from "react";
import { CARD, BORDER, BLUE, BLUE_L, GRAY, GREEN, RED, AMBER, FONT, tabOn, tabOff } from "./ui";
import { usePathState } from "./useStock";
import { formatSize } from "../../utils/sizeLabel";
import { AUDIT_STORES, snapshotPath, resultsPath, saDateOf, locationLabel } from "../../config/stockAudit";
import { serverNowMs } from "../../utils/serverTime";

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

const rowBox = { background: CARD, border: BORDER, borderRadius: 13, padding: "12px 14px", display: "flex", gap: 12, alignItems: "center" };
const nameStyle = { fontSize: 14, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const subStyle = { fontSize: 11.5, color: "rgba(233,238,255,.45)", marginTop: 3 };

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

export default function StockAuditView({ onExit }) {
  const [tab, setTab] = useState("oos");
  const [store, setStore] = useState(AUDIT_STORES[0].id);
  const [mode, setMode] = useState("product");         // Tab B: product view / size view

  // Server-anchored, so a till with a wrong date does not read yesterday's
  // results node and re-offer rows that were already actioned.
  const saDate = useMemo(() => saDateOf(serverNowMs()), []);
  const { snap, results } = useStoreAudit(store, saDate);

  const data = snap.value;
  const done = results.value || {};

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

      {!snap.settled ? <Empty text="Loading…" />
        : snap.error ? <Empty text="Cannot read this store's list." />
        : !data ? <Empty text="Nothing yet." />
        : tab === "oos"
          ? <OutOfStock rows={oosRows} total={data.oos?.total || 0} truncated={!!data.oos?.truncated} />
          : <NotSelling data={data} rows={rotRows} mode={mode} setMode={setMode} />}
    </div>
  );
}

// ── TAB A ────────────────────────────────────────────────────────────────────
function OutOfStock({ rows, total, truncated }) {
  if (!rows.length) return <Empty text={total ? "All checked." : "Nothing to check."} />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => {
        const meta = REASON[r.r] || { text: r.r, tone: GRAY };
        return (
          <div key={r.k} style={rowBox}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={nameStyle}>{r.n}</div>
              <div style={subStyle}>{formatSize(r.s)} · {locationLabel(r.w)} · system {r.q}</div>
            </div>
            <span style={pill(meta.tone)}>{meta.text}</span>
          </div>
        );
      })}
      {truncated && (
        <div style={{ fontSize: 11.5, color: GRAY, textAlign: "center", padding: "6px 0" }}>
          Showing {rows.length} of {total}.
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
function Signals({ sold, disp, slow }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {!sold && <span style={pill(AMBER)}>No sale</span>}
      {!disp && <span style={pill(GRAY)}>No display</span>}
      {slow && <span style={pill(GREEN)}>Slow</span>}
    </div>
  );
}

function NotSelling({ data, rows, mode, setMode }) {
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
      {!rows.length ? <Empty text={data.rotation?.rows?.length ? "All checked." : "Nothing to check."} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {mode === "product"
            ? rows.map((r) => (
                <div key={r.p} style={rowBox}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nameStyle}>{r.n}</div>
                    <div style={subStyle}>{(r.z || []).map((z) => `${formatSize(z.s)} ${z.q}`).join(" · ")}</div>
                  </div>
                  <Signals sold={r.sold} disp={r.disp} slow={r.slow} />
                </div>
              ))
            : sizeRows.map((z) => (
                <div key={z.key} style={rowBox}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={nameStyle}>{z.n}</div>
                    <div style={subStyle}>{formatSize(z.s)} · {z.q}</div>
                  </div>
                  <Signals sold={z.sold} disp={z.disp} slow={z.slow} />
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
