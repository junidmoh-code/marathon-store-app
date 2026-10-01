// ─── STOCK AUDIT — THE SCREEN ────────────────────────────────────────────────
// Two tabs, each with its own chip row, because they do not share a scope.
//
//   OUT OF STOCK   per HUB, SNEAKERS. Every line a hub answered with "sold out"
//                  or "coming tomorrow" — the two answers that send a customer
//                  away — with the quantity that hub's own cell believed. Said
//                  against a cell reading three, that is a phantom worth
//                  walking to; against zero it is a hub that is genuinely out.
//
//   AUDIT          per SHOP, CLOTHING. The lines the shop holds and has not
//                  sold in three weeks — 30 a batch, three mornings a week.
//
// ONE ACTION, AND IT SAYS "FIXED". Not three answers on one tab and four on the
// other: the question at a shelf is not which sentence describes what you
// found, it is whether you have dealt with it. Correcting a quantity belongs to
// the Adjust screen, which is the one writer for that, so nothing here moves
// stock.
//
// ONE LINE PER ROW. A product and its size read together or they read as two
// facts — so there is no product/size toggle, and the sizes sit on the same
// line as the name.
//
// READS: the snapshot for the selected hub or shop, plus that day's results so
// an actioned row does not come back. Photos come from the products list App
// already streams, so a picture costs the snapshot nothing.

import React, { useEffect, useMemo, useState } from "react";
import { FONT } from "./ui";
import { usePathState } from "./useStock";
import { formatSize } from "../../utils/sizeLabel";
import {
  AUDIT_STORES, AUDIT_HUBS, snapshotPath, resultsPath,
  hubSnapshotPath, hubResultsPath, saDateOf, locationLabel,
} from "../../config/stockAudit";
import { serverNowMs } from "../../utils/serverTime";
import { markHubRowFixed, markRotationRowFixed } from "./stockAuditStore";

// ── the palette ──────────────────────────────────────────────────────────────
// Deliberately narrow, and deliberately without amber (owner, 2026-09-08).
// White carries the content, one grey carries everything secondary, and the
// only colour is the single accent the app already uses. A screen that reaches
// for a third hue to say "look here" is a screen that has stopped ranking.
const INK = "#fff";
const DIM = "rgba(235,238,245,.46)";
const FAINT = "rgba(235,238,245,.30)";
const LINE = "1px solid rgba(255,255,255,.07)";
const ACCENT = "#4A7FFF";
const ACCENT_SOFT = "#9DBCFF";
const ALERT = "#F87171";

const shell = {
  minHeight: "100vh", background: "#000", color: INK, fontFamily: FONT,
  padding: "22px 18px 72px", maxWidth: 680, margin: "0 auto",
  WebkitFontSmoothing: "antialiased",
};

const seg = (on) => ({
  flex: 1, padding: "9px 0", borderRadius: 8, border: "none", cursor: "pointer",
  fontFamily: "inherit", fontSize: 13.5, fontWeight: on ? 700 : 500,
  letterSpacing: "-.01em",
  background: on ? "rgba(255,255,255,.10)" : "transparent",
  color: on ? INK : DIM,
  transition: "background .15s ease, color .15s ease",
});

const chip = (on) => ({
  padding: "6px 13px", borderRadius: 999, cursor: "pointer", fontFamily: "inherit",
  fontSize: 12.5, fontWeight: on ? 700 : 500, letterSpacing: "-.01em",
  border: `1px solid ${on ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.09)"}`,
  background: on ? "rgba(255,255,255,.08)" : "transparent",
  color: on ? INK : DIM,
});

const fixBtn = (busy) => ({
  padding: "7px 15px", borderRadius: 999, cursor: busy ? "default" : "pointer",
  fontFamily: "inherit", fontSize: 12.5, fontWeight: 700, letterSpacing: "-.01em",
  border: `1px solid ${busy ? "rgba(255,255,255,.12)" : "rgba(74,127,255,.42)"}`,
  background: busy ? "transparent" : "rgba(74,127,255,.13)",
  color: busy ? FAINT : ACCENT_SOFT,
  whiteSpace: "nowrap",
});

// ── the two answers a hub can give ───────────────────────────────────────────
// Short words. Staff need the shelf and the number, not a description of the
// mechanism.
const ANSWER = { out_of_stock: "Sold out", coming_tomorrow: "Tomorrow" };

// A product picture, or the space one would have taken. The fixed box keeps
// every row's text on the same left edge whether the photo loads, fails, or was
// never there — a list that shifts under the eye is hard to walk.
function Photo({ url }) {
  return (
    <div style={{
      width: 38, height: 46, flexShrink: 0, borderRadius: 7, overflow: "hidden",
      background: "rgba(255,255,255,.045)",
    }}>
      {url ? <img src={url} alt="" loading="lazy"
        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /> : null}
    </div>
  );
}

function Empty({ text }) {
  return <div style={{ padding: "44px 0", textAlign: "center", color: FAINT, fontSize: 13 }}>{text}</div>;
}

export default function StockAuditView({ onExit, products = [] }) {
  const [tab, setTab] = useState("oos");
  const [hub, setHub] = useState(AUDIT_HUBS[0].id);
  const [store, setStore] = useState(AUDIT_STORES[0].id);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);

  // Server-anchored, and it FOLLOWS MIDNIGHT. Frozen at mount, a tablet left on
  // the counter overnight keeps reading and writing yesterday's results node,
  // so the morning's checks file under the wrong day and the rows they close do
  // not disappear.
  const [saDate, setSaDate] = useState(() => saDateOf(serverNowMs()));
  useEffect(() => {
    const nextMidnight = Date.parse(`${saDate}T00:00:00.000Z`) + 864e5 - 2 * 60 * 60 * 1000;
    const delay = Math.max(nextMidnight - serverNowMs(), 1000) + 1000;
    const t = setTimeout(() => setSaDate(saDateOf(serverNowMs())), delay);
    return () => clearTimeout(t);
  }, [saDate]);

  // ONE subscription pair, following whichever tab is up. Holding both would
  // double the read for a list nobody is looking at.
  const onHubs = tab === "oos";
  const scope = onHubs ? hub : store;
  const snap = usePathState(onHubs ? hubSnapshotPath(hub) : snapshotPath(store), true);
  const results = usePathState(onHubs ? hubResultsPath(hub, saDate) : resultsPath(store, saDate), true);

  // Photos off the products list App already streams — no snapshot bytes, no
  // read of our own. A renamed or merged product simply has no picture, and the
  // row still reads because the name travelled in the snapshot.
  const photoById = useMemo(() => {
    const m = new Map();
    for (const p of products || []) if (p && p.id) m.set(p.id, p.photoUrl || p.photo || null);
    return m;
  }, [products]);

  const data = snap.value;
  const done = results.value || {};
  // "Not answered yet" and "the read was denied" are not "nothing has been done
  // today" — usePathState tells the three apart, so the list waits for the
  // answer and, if it never comes, shows the rows without offering to act.
  const resultsKnown = results.settled && !results.error;

  const rows = useMemo(() => {
    if (!data) return [];
    return onHubs
      ? (data.oos?.rows || []).filter((r) => !done[r.k])
      : (data.rotation?.rows || []).filter((r) => !done[r.p]);
  }, [data, done, onHubs]);

  const act = async (key, fn) => {
    if (busy) return;
    setBusy(key); setNote(null);
    try {
      const res = await fn();
      if (!res?.ok) setNote(res?.reason === "not_authenticated" ? "Signed out — sign in and try again." : "Could not save.");
    } catch (e) {
      setNote(e?.message || "Could not save.");
    } finally { setBusy(null); }
  };

  const chips = onHubs ? AUDIT_HUBS : AUDIT_STORES;
  const stale = data && data.saDate && data.saDate !== saDate;

  return (
    <div style={shell}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: "-.02em" }}>Stock Audit</div>
        <button onClick={onExit}
          style={{ background: "transparent", border: "none", color: DIM, fontSize: 14, cursor: "pointer", fontFamily: "inherit", padding: 0 }}>
          Done
        </button>
      </div>

      {/* One segmented control, full width — the iOS shape, not a row of pills
          competing with the chips below it. */}
      <div style={{ display: "flex", gap: 2, padding: 2, borderRadius: 10, background: "rgba(255,255,255,.045)", marginBottom: 16 }}>
        <button onClick={() => setTab("oos")} style={seg(onHubs)}>Out of Stock</button>
        <button onClick={() => setTab("rot")} style={seg(!onHubs)}>Audit</button>
      </div>

      <div style={{ display: "flex", gap: 7, marginBottom: 18 }}>
        {chips.map((x) => (
          <button key={x.id} onClick={() => (onHubs ? setHub(x.id) : setStore(x.id))} style={chip(scope === x.id)}>
            {x.label}
          </button>
        ))}
        <div style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, color: FAINT }}>
          {snap.settled && data ? `${rows.length}` : ""}
        </div>
      </div>

      {/* The pass rides on refillHealthScan, which stands down entirely while
          the refill engine is off or Central is receiving — so a list can be
          days old, and silence about that is the lie. */}
      {stale && (
        <div style={{ fontSize: 12, color: FAINT, marginBottom: 12 }}>{`Built ${data.saDate}`}</div>
      )}
      {results.settled && results.error && (
        <div style={{ fontSize: 12, color: ALERT, marginBottom: 12 }}>
          Cannot read today’s checks — this list may show work already done.
        </div>
      )}
      {note && <div style={{ fontSize: 12.5, color: ALERT, marginBottom: 12 }}>{note}</div>}

      {!snap.settled || !results.settled ? <Empty text="Loading…" />
        : snap.error ? <Empty text="Cannot read this list." />
        : !data ? <Empty text="Nothing yet." />
        : !rows.length ? (
            <Empty text={
              onHubs ? (data.oos?.total ? "All checked." : "Nothing to check.")
                : data.rotation?.walked ? `Batch done — ${data.rotation.walked} checked.`
                : data.rotation?.rows?.length ? "All checked." : "Nothing to check."} />
          )
        : (
          <div>
            {rows.map((r) => (
              <Row key={onHubs ? r.k : r.p}
                photo={photoById.get(r.p)}
                name={r.n}
                detail={onHubs ? hubDetail(r) : rotationDetail(r)}
                busy={busy === (onHubs ? r.k : r.p) || !resultsKnown}
                onFix={() => act(onHubs ? r.k : r.p, () =>
                  onHubs ? markHubRowFixed({ hub, row: r }) : markRotationRowFixed({ store, row: r }))}
              />
            ))}
          </div>
        )}
    </div>
  );
}

// ONE LINE, and it has to carry the size. A hub row is a size at a place with a
// number the system believed; a shop row is the sizes standing on the floor.
function hubDetail(r) {
  const bits = [
    `${ANSWER[r.r] || r.r} · ${formatSize(r.s)}`,
    `${locationLabel(r.w)} says ${r.q}`,
  ];
  if (r.c > 1) bits.push(`${r.c} customers`);
  return bits.join("  ·  ");
}

function rotationDetail(r) {
  const sizes = (r.z || []).map((z) => `${formatSize(z.s)} ${z.q}`).join("   ");
  return r.slow ? `${sizes}   ·   slow` : sizes;
}

function Row({ photo, name, detail, busy, onFix }) {
  return (
    <div style={{ display: "flex", gap: 13, alignItems: "center", padding: "13px 0", borderBottom: LINE }}>
      <Photo url={photo} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: "-.01em", color: INK,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
        <div style={{ fontSize: 12.5, color: DIM, marginTop: 3,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{detail}</div>
      </div>
      <button onClick={onFix} disabled={busy} style={fixBtn(busy)}>Fixed</button>
    </div>
  );
}
