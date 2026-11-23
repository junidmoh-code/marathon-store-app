// ─── BF CANDIDATES — Junid's card (23 Nov 2026) ──────────────────────────────
// Stock that isn't moving: on hand (every location added together) and nothing
// sold in the last 30 days (the window is adjustable). Two tabs, Clothing and
// Sneakers, sorted by quantity, highest first. Per product or multi-select:
//   Put on sale   ONE sale price, until Mon 30 Nov 23:59 (extendable). While on
//                 sale every till charges that single price to every customer;
//                 the stock and retail prices are never changed and come back
//                 by themselves at the end. A price at or above the stock price
//                 warns before saving. The tap also alerts the stores and
//                 queues the product for the WhatsApp groups (Black Friday sale).
//   Photos        Use current photo, Generate / Regenerate (the shared New Arrivals
//                 generator, full resolution), Replace photo: the Black Friday
//                 card's own options. The photo shown is the one that posts.
//   Not for sale  off this list for good; "Removed (n)" at the bottom undoes it.
// IN-STORE ONLY: the website keeps its normal price.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { photoToBase64 } from "../blackFriday/BlackFridayScreen";
import { FONT, BG, GLASS, GLASS_SOLID, GREEN, GRAY, AMBER, RED, BLUE_L, bGreen, bGray, bBlue, bRed, tabOn, tabOff, input } from "../stock/ui";

const price = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);
const TAB_LABEL = { clothing: "Clothing", sneakers: "Sneakers" };
const MAX_PICK = 500; // one tap = one call, so the warning covers the whole selection before anything is saved
const errText = (e) => String((e && e.message) || e || "Something went wrong").replace(/^.*?:\s(?=[A-Z])/, "");

/** "Marathon PE 4 · Hub 2 6" from { loc: qty } (biggest first). Pure. */
export function locsLine(locs, names = {}) {
  return Object.entries(locs || {}).filter(([, q]) => Number(q) > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([loc, q]) => `${names[loc] || loc} ${q}`).join(" · ");
}
/** The sale dialog's check before anything is sent. → { price } | { error }. Pure. */
export function readPrice(text) {
  const n = Number(String(text || "").replace(/^\s*R\s*/i, "").replace(/\s+/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter the sale price in rands." };
  return { price: Math.round(n * 100) / 100 };
}

function Row({ r, names, thumb, selecting, ticked, onTick, onSale, onExtend, onEnd, onRemove, busy, making, onGenerate, onReplace, onUseCurrent }) {
  const chosen = r.photoChoice && r.photoChoice.use === "generated";
  const locs = locsLine(r.locs, names);
  return (
    <div data-pid={r.pid} style={{ ...GLASS, borderRadius: 16, padding: 12, display: "flex", gap: 12, alignItems: "flex-start", opacity: busy ? 0.55 : 1 }}>
      {selecting && (
        <input type="checkbox" aria-label={`Select ${r.name}`} checked={ticked} onChange={() => onTick(r.pid)} style={{ width: 22, height: 22, marginTop: 4, flex: "0 0 auto" }} />
      )}
      <div style={{ width: 76, height: 76, borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,.05)", flex: "0 0 auto" }}>
        {r.photo ? <img src={thumb(r.photo)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <div style={{ color: GRAY, fontSize: "0.7rem", padding: 8 }}>No photo: it won't post</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, color: "#fff", fontSize: "0.92rem", overflowWrap: "anywhere" }}>{r.name}</div>
        <div style={{ color: "#dfe7ff", fontSize: "0.82rem", marginTop: 3 }}>
          <b>{r.qty}</b> on hand · {r.since === "never sold" ? "never sold" : `last sale ${r.since} ago`}
        </div>
        <div style={{ color: GRAY, fontSize: "0.8rem", marginTop: 2 }}>
          Stock {r.stockPrice ? price(r.stockPrice) : "not set"} · Retail {r.retailPrice ? price(r.retailPrice) : "not set"}
        </div>
        {locs && <div style={{ color: GRAY, fontSize: "0.76rem", marginTop: 2, overflowWrap: "anywhere" }}>{locs}</div>}
        {r.sale && (
          <div style={{ marginTop: 6, color: AMBER, fontWeight: 700, fontSize: "0.84rem" }}>
            🔥 {price(r.sale.price)} · On sale until {r.sale.until}
            <span style={{ color: r.posted ? GREEN : GRAY, fontWeight: 600 }}> · {r.posted ? "Posted to the groups" : r.photo ? "Queued to post" : "No photo: not posting"}</span>
          </div>
        )}
        {!selecting && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>
            {r.sale ? (
              <>
                <button type="button" style={bBlue} disabled={busy} onClick={() => onSale([r])}>Change price</button>
                <button type="button" style={bGray} disabled={busy} onClick={() => onExtend([r.pid])}>Extend</button>
                <button type="button" style={bRed} disabled={busy} onClick={() => onEnd([r.pid])}>End sale</button>
              </>
            ) : (
              <button type="button" style={bGreen} disabled={busy} onClick={() => onSale([r])}>Put on sale</button>
            )}
            <button type="button" style={bGray} disabled={busy} onClick={() => onRemove([r.pid])}>Not for sale</button>
          </div>
        )}
        {!selecting && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
            {making ? <span role="status" style={{ color: BLUE_L, fontSize: "0.78rem" }}>{making}</span> : (
              <>
                {chosen && r.ownPhoto && <button type="button" style={{ ...bGray, padding: "6px 10px", fontSize: "0.76rem" }} onClick={() => onUseCurrent(r)}>Use current photo</button>}
                <button type="button" style={{ ...bBlue, padding: "6px 10px", fontSize: "0.76rem" }} onClick={() => onGenerate(r)}>{chosen ? "Regenerate" : "Generate"}</button>
                <button type="button" style={{ ...bGray, padding: "6px 10px", fontSize: "0.76rem" }} onClick={() => onReplace(r)}>Replace photo</button>
                {chosen && <span style={{ color: GRAY, fontSize: "0.72rem" }}>Posting with the photo shown</span>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Sheet({ title, children, onClose }) {
  return (
    <div role="dialog" aria-label={title} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.72)", zIndex: 50, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={onClose}>
      <div style={{ ...GLASS_SOLID, borderRadius: "20px 20px 0 0", padding: 18, width: "100%", maxWidth: 560, maxHeight: "86vh", overflowY: "auto", paddingBottom: "calc(18px + env(safe-area-inset-bottom))" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 800, color: "#fff", fontSize: "1.02rem", marginBottom: 10 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

export default function BfCandidatesScreen({ api, onExit }) {
  const [tab, setTab] = useState("clothing");
  const [windowDays, setWindowDays] = useState(30);
  const [view, setView] = useState(null);      // the server's answer for this tab + window
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [ticks, setTicks] = useState(() => new Set());
  const [busyPids, setBusyPids] = useState(() => new Set());
  const [dialog, setDialog] = useState(null);  // { type: "sale" | "confirm" | "extend" | "removed", … }
  const [working, setWorking] = useState(null); // progress text of a tap in flight
  const seq = useRef(0);
  const [making, setMaking] = useState({});    // { pid: progress text } while a photo is being made / uploaded
  const fileRef = useRef(null);
  const replaceFor = useRef(null);

  const load = useCallback(async (t = tab, w = windowDays, { quiet = false } = {}) => {
    const mine = ++seq.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const v = await api.list(t, w, 0);
      if (mine !== seq.current) return;
      setView(v); setRows(v.rows || []);
    } catch (e) { if (mine === seq.current) setError(errText(e)); }
    finally { if (mine === seq.current) setLoading(false); }
  }, [api, tab, windowDays]);
  useEffect(() => { setRows([]); setTicks(new Set()); load(tab, windowDays); }, [tab, windowDays]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = async () => {
    const mine = seq.current; // a page asked for under another tab or window is thrown away
    try {
      const v = await api.list(tab, windowDays, rows.length);
      if (mine !== seq.current) return;
      setRows((cur) => [...cur, ...(v.rows || []).filter((r) => !cur.some((c) => c.pid === r.pid))]);
      setView((cur) => ({ ...(cur || {}), more: v.more, total: v.total, counts: v.counts }));
    } catch (e) { setToast(errText(e)); }
  };

  const names = (view && view.locNames) || {};
  const say = (t) => { setToast(t); setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 6000); };
  const inFlight = useRef(false);
  const withBusy = async (pids, label, fn) => {
    if (inFlight.current) return null; // one tap at a time: a second tap never lands on a half-finished first
    inFlight.current = true;
    setBusyPids(new Set(pids)); setWorking(label);
    try { return await fn(); }
    catch (e) { say(errText(e)); return null; }
    finally { inFlight.current = false; setBusyPids(new Set()); setWorking(null); }
  };
  const done = () => { setTicks(new Set()); setSelecting(false); setDialog(null); load(tab, windowDays, { quiet: true }); };

  // ── Put on sale: ONE price; the warning (price ≥ stock price) comes before anything is saved ──
  const saveSale = async (pids, priceNum, endDay, confirmAbove) => {
    // ONE call for the whole selection: the server decides the warning before it saves anything.
    const r = await withBusy(pids, `Putting ${pids.length} on sale…`, async () => [await api.sale(pids, priceNum, endDay, { confirmAbove })]);
    if (!r) return;
    const need = r.flatMap((o) => o.needConfirm || []);
    // (Again, if a product came to need the warning since the first one: the confirmation is of the products shown.)
    if (need.length) { setDialog({ type: "confirm", pids, price: priceNum, endDay, need }); return; }
    const ok = r.flatMap((o) => o.done || []), refused = r.flatMap((o) => o.refused || []);
    const until = (r.find((o) => o.until) || {}).until;
    say(`${ok.length} on sale at ${price(priceNum)}${until ? ` until ${until}` : ""}. Stores alerted; queued for the groups.${refused.length ? ` ${refused.length} not saved: ${refused[0].refusal}.` : ""}`);
    done();
  };
  const doExtend = async (pids, endDay) => {
    const r = await withBusy(pids || [], "Extending…", async () => [pids ? await api.extend(pids, endDay) : await api.extendAll(endDay)]);
    if (!r) return;
    const n = r.reduce((t, o) => t + (o.done || []).length, 0), late = r.reduce((t, o) => t + (o.notLater || 0), 0);
    say(`${n} extended until ${(r[0] || {}).until || endDay}.${late ? ` ${late} already end${late === 1 ? "s" : ""} on or after that day: not changed.` : ""}`);
    done();
  };
  const doEnd = async (pids) => {
    const r = await withBusy(pids, "Ending the sale…", async () => [await api.end(pids)]);
    if (!r) return;
    say(`${r.reduce((t, o) => t + (o.done || []).length, 0)} back to normal prices. Stores alerted.`);
    done();
  };
  const doRemove = async (pids) => {
    const r = await withBusy(pids, "Removing…", async () => [await api.remove(pids)]);
    if (!r) return;
    setRows((cur) => cur.filter((x) => !pids.includes(x.pid)));
    say(`${pids.length} marked Not for sale. Undo under "Removed" at the bottom.`);
    done();
  };
  const openRemoved = async () => {
    setDialog({ type: "removed", list: null });
    // A late answer never replaces (or closes) a sheet opened since.
    const still = (d) => d && d.type === "removed" && d.list === null;
    try { const r = await api.removed(); setDialog((d) => (still(d) ? { type: "removed", list: r.removed || [] } : d)); }
    catch (e) { setDialog((d) => (still(d) ? null : d)); say(errText(e)); }
  };
  const undoRemove = async (pid) => {
    try {
      await api.restore([pid]);
      setDialog((d) => (d && d.type === "removed" ? { ...d, list: (d.list || []).filter((x) => x.pid !== pid) } : d));
      load(tab, windowDays, { quiet: true });
    } catch (e) { say(errText(e)); }
  };

  // ── Photos: the photo shown on the row is the one that posts ──
  const patchPhoto = (pid, photo, use) => setRows((cur) => cur.map((x) => (x.pid === pid ? { ...x, photo: photo || x.ownPhoto, photoChoice: use === "generated" ? { use } : null } : x)));
  const photoJob = async (r, label, fn) => {
    setMaking((m) => ({ ...m, [r.pid]: label }));
    try { await fn(); }
    catch (e) { say(`${r.name}: ${errText(e)}`); }
    setMaking((m) => { const n = { ...m }; delete n[r.pid]; return n; });
  };
  const generate = (r) => photoJob(r, "Starting…", async () => {
    const res = await api.generate(r.pid, { onEvent: (ev) => { if (ev && ev.text) setMaking((m) => (m[r.pid] ? { ...m, [r.pid]: String(ev.text).slice(0, 80) } : m)); } });
    const genId = res && (res.genId || (res.result && res.result.genId));
    if (!genId) throw new Error("no photo came back. Tap Generate to try again");
    const c = await api.photo(r.pid, "generated", genId);
    patchPhoto(r.pid, c.photo, "generated");
  });
  const replace = (r) => { replaceFor.current = r; if (fileRef.current) { fileRef.current.value = ""; fileRef.current.click(); } };
  const uploadPicked = (file) => {
    const r = replaceFor.current;
    replaceFor.current = null;
    if (!r || !file) return null;
    return photoJob(r, "Uploading your photo…", async () => {
      const res = await api.photoUpload(r.pid, await photoToBase64(file));
      const c = await api.photo(r.pid, "generated", res.id);
      patchPhoto(r.pid, c.photo, "generated");
    });
  };
  const useCurrent = (r) => photoJob(r, "Saving…", async () => { const c = await api.photo(r.pid, "current"); patchPhoto(r.pid, c.photo, "current"); });

  const tick = (pid) => setTicks((cur) => { const n = new Set(cur); if (n.has(pid)) n.delete(pid); else if (n.size < MAX_PICK) n.add(pid); return n; });
  const picked = useMemo(() => rows.filter((r) => ticks.has(r.pid)), [rows, ticks]);
  const counts = (view && view.counts) || { clothing: 0, sneakers: 0, onSale: 0, removed: 0 };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, paddingBottom: selecting ? 150 : 60 }}>
      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "rgba(0,0,0,.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", padding: "calc(10px + env(safe-area-inset-top)) 14px 10px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" style={{ ...bGray, padding: "8px 12px" }} onClick={onExit}>Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>BF Candidates</div>
            <div style={{ color: GRAY, fontSize: "0.74rem" }}>In stock, nothing sold in {windowDays} days · in-store sale only</div>
          </div>
          <button type="button" style={selecting ? bBlue : bGray} onClick={() => { setSelecting((s) => !s); setTicks(new Set()); }}>{selecting ? "Cancel" : "Select"}</button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          {Object.keys(TAB_LABEL).map((t) => (
            <button key={t} type="button" style={tab === t ? tabOn : tabOff} onClick={() => { setTab(t); setTicks(new Set()); }}>{TAB_LABEL[t]} ({counts[t] ?? 0})</button>
          ))}
          <label style={{ marginLeft: "auto", color: GRAY, fontSize: "0.78rem", display: "flex", alignItems: "center", gap: 6 }}>
            No sale in
            <select aria-label="Days without a sale" value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} style={{ ...input, padding: "6px 8px", fontSize: "0.8rem" }}>
              {((view && view.windows) || [14, 30, 60, 90]).map((w) => <option key={w} value={w}>{w} days</option>)}
            </select>
          </label>
        </div>
        {counts.onSale > 0 && (
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            <span style={{ color: AMBER, fontWeight: 700, fontSize: "0.82rem" }}>🔥 {counts.onSale} on sale</span>
            <button type="button" style={{ ...bGray, padding: "6px 10px", fontSize: "0.78rem" }} onClick={() => setDialog({ type: "extend", pids: null, n: counts.onSale })}>Extend all</button>
            <a href="#bf-sale-list" style={{ color: BLUE_L, fontSize: "0.78rem", fontWeight: 700 }}>Store re-tag lists</a>
          </div>
        )}
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, maxWidth: 760, margin: "0 auto" }}>
        {error && <div role="alert" style={{ color: RED, fontSize: "0.86rem" }}>{error} <button type="button" style={{ ...bGray, padding: "4px 10px" }} onClick={() => load()}>Try again</button></div>}
        {loading && !rows.length && <div style={{ color: GRAY }}>Loading…</div>}
        {!loading && !error && !rows.length && (
          <div style={{ color: GRAY, fontSize: "0.9rem" }}>
            {view && view.meta ? `Nothing in ${TAB_LABEL[tab]} has gone ${windowDays} days without a sale.` : "The list has not been built yet. It is built every night; the first one is on its way."}
          </div>
        )}
        {rows.map((r) => (
          <Row key={r.pid} r={r} names={names} thumb={api.thumb} selecting={selecting} ticked={ticks.has(r.pid)} onTick={tick} busy={busyPids.has(r.pid) || !!working} making={making[r.pid]} onGenerate={generate} onReplace={replace} onUseCurrent={useCurrent}
            onSale={(rs) => setDialog({ type: "sale", rows: rs })} onExtend={(pids) => setDialog({ type: "extend", pids, n: pids.length })} onEnd={doEnd} onRemove={doRemove} />
        ))}
        {view && view.more && <button type="button" style={bGray} onClick={more}>Show more ({(view.total || 0) - rows.length} more)</button>}
        {view && view.meta && view.meta.builtAt && <div style={{ color: GRAY, fontSize: "0.72rem", textAlign: "center", marginTop: 6 }}>List built {new Date(view.meta.builtAt).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</div>}
        <button type="button" onClick={openRemoved} style={{ background: "none", border: "none", color: GRAY, textDecoration: "underline", fontSize: "0.8rem", cursor: "pointer", fontFamily: FONT, padding: 10 }}>Removed ({counts.removed || 0})</button>
      </div>

      <input ref={fileRef} aria-label="Replace photo file" type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => uploadPicked(e.target.files && e.target.files[0])} />
      {selecting && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 30, background: "rgba(8,11,20,.97)", borderTop: "1px solid rgba(255,255,255,.12)", padding: "10px 14px calc(10px + env(safe-area-inset-bottom))" }}>
          <div style={{ color: GRAY, fontSize: "0.78rem", marginBottom: 8 }}>
            {picked.length} selected
            <button type="button" style={{ background: "none", border: "none", color: BLUE_L, fontWeight: 700, marginLeft: 10, cursor: "pointer", fontFamily: FONT }} onClick={() => setTicks(new Set(rows.slice(0, MAX_PICK).map((r) => r.pid)))}>Select all {Math.min(rows.length, MAX_PICK)}</button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={bGreen} disabled={!picked.length} onClick={() => setDialog({ type: "sale", rows: picked })}>Put on sale</button>
            <button type="button" style={bGray} disabled={!picked.some((r) => r.sale)} onClick={() => setDialog({ type: "extend", pids: picked.filter((r) => r.sale).map((r) => r.pid), n: picked.filter((r) => r.sale).length })}>Extend</button>
            <button type="button" style={bGray} disabled={!picked.length} onClick={() => doRemove(picked.map((r) => r.pid))}>Not for sale</button>
          </div>
        </div>
      )}

      {dialog && dialog.type === "sale" && <SaleSheet rows={dialog.rows} view={view} working={working} onClose={() => setDialog(null)} onSave={(p, d) => saveSale(dialog.rows.map((r) => r.pid), p, d, null)} />}
      {dialog && dialog.type === "confirm" && (
        <Sheet title="This price is not lower than the stock price" onClose={() => setDialog(null)}>
          <div style={{ color: "#dfe7ff", fontSize: "0.88rem", lineHeight: 1.45 }}>
            At {price(dialog.price)}, resellers would pay the same or MORE than they do now for:
            <ul style={{ margin: "8px 0", paddingLeft: 18 }}>
              {dialog.need.slice(0, 12).map((n) => <li key={n.pid}>{n.name} (stock price {price(n.stockPrice)})</li>)}
              {dialog.need.length > 12 && <li>and {dialog.need.length - 12} more</li>}
            </ul>
            Nothing has been saved yet.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" style={bGray} onClick={() => setDialog(null)}>Go back</button>
            <button type="button" style={bRed} disabled={!!working} onClick={() => saveSale(dialog.pids, dialog.price, dialog.endDay, dialog.need.map((n) => n.pid))}>{working || `Save at ${price(dialog.price)} anyway`}</button>
          </div>
        </Sheet>
      )}
      {dialog && dialog.type === "extend" && <ExtendSheet n={dialog.n} view={view} working={working} onClose={() => setDialog(null)} onSave={(d) => doExtend(dialog.pids, d)} />}
      {dialog && dialog.type === "removed" && (
        <Sheet title="Removed: Not for sale" onClose={() => setDialog(null)}>
          {!dialog.list ? <div style={{ color: GRAY }}>Loading…</div> : !dialog.list.length ? <div style={{ color: GRAY }}>Nothing removed.</div> : dialog.list.map((x) => (
            <div key={x.pid} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
              <div style={{ flex: 1, minWidth: 0, fontSize: "0.86rem", overflowWrap: "anywhere" }}>{x.name}</div>
              <button type="button" style={{ ...bBlue, padding: "6px 12px" }} onClick={() => undoRemove(x.pid)}>Undo</button>
            </div>
          ))}
          <button type="button" style={{ ...bGray, marginTop: 14 }} onClick={() => setDialog(null)}>Close</button>
        </Sheet>
      )}
      {toast && <div role="status" style={{ position: "fixed", left: 14, right: 14, bottom: selecting ? 130 : 20, zIndex: 60, ...GLASS_SOLID, borderRadius: 14, padding: "12px 14px", fontSize: "0.86rem", color: "#fff" }}>{toast}</div>}
    </div>
  );
}

function SaleSheet({ rows, view, working, onClose, onSave }) {
  const [text, setText] = useState("");
  const one = rows.length === 1 ? rows[0] : null;
  // Change price on a product already on sale keeps ITS end date (an extended sale is not cut back to 30 Nov).
  const ownEnd = one && one.sale && one.sale.end ? new Date(one.sale.end + 2 * 3600_000).toISOString().slice(0, 10) : null;
  const [endDay, setEndDay] = useState(ownEnd || (view && view.defaultEndDay) || "2026-11-30");
  const [err, setErr] = useState(null);
  const save = () => {
    const p = readPrice(text);
    if (p.error) { setErr(p.error); return; }
    if (!endDay) { setErr("Pick the day the sale ends."); return; }
    onSave(p.price, endDay);
  };
  return (
    <Sheet title={one ? `Put on sale: ${one.name}` : `Put ${rows.length} products on sale`} onClose={onClose}>
      <div style={{ color: GRAY, fontSize: "0.82rem", lineHeight: 1.45, marginBottom: 12 }}>
        ONE price for every customer at every till, starting now. The stock and retail prices are not changed and come back by themselves when the sale ends. The website keeps its normal price.
        {one && <div style={{ marginTop: 6, color: "#dfe7ff" }}>Now: stock {one.stockPrice ? price(one.stockPrice) : "not set"} · retail {one.retailPrice ? price(one.retailPrice) : "not set"}</div>}
      </div>
      <label style={{ display: "block", color: "#dfe7ff", fontSize: "0.8rem", fontWeight: 700 }}>Sale price (R)
        <input aria-label="Sale price" inputMode="decimal" autoFocus value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} placeholder="e.g. 250" style={{ ...input, display: "block", width: "100%", boxSizing: "border-box", marginTop: 6, fontSize: "1.1rem" }} />
      </label>
      <label style={{ display: "block", color: "#dfe7ff", fontSize: "0.8rem", fontWeight: 700, marginTop: 12 }}>Ends at 23:59 on
        <input aria-label="Sale end date" type="date" value={endDay} min={(view && view.today) || undefined} onChange={(e) => { setEndDay(e.target.value); setErr(null); }} style={{ ...input, display: "block", width: "100%", boxSizing: "border-box", marginTop: 6 }} />
      </label>
      {err && <div role="alert" style={{ color: RED, fontSize: "0.82rem", marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button type="button" style={bGray} onClick={onClose}>Cancel</button>
        <button type="button" style={bGreen} disabled={!!working} onClick={save}>{working || "Put on sale"}</button>
      </div>
    </Sheet>
  );
}

function ExtendSheet({ n, view, working, onClose, onSave }) {
  const [endDay, setEndDay] = useState("");
  return (
    <Sheet title={`Extend ${n === 1 ? "this sale" : `${n} sales`}`} onClose={onClose}>
      <label style={{ display: "block", color: "#dfe7ff", fontSize: "0.8rem", fontWeight: 700 }}>New end date (23:59 that day)
        <input aria-label="New end date" type="date" value={endDay} min={(view && view.today) || undefined} onChange={(e) => setEndDay(e.target.value)} style={{ ...input, display: "block", width: "100%", boxSizing: "border-box", marginTop: 6 }} />
      </label>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button type="button" style={bGray} onClick={onClose}>Cancel</button>
        <button type="button" style={bGreen} disabled={!endDay || !!working} onClick={() => onSave(endDay)}>{working || "Extend"}</button>
      </div>
    </Sheet>
  );
}
