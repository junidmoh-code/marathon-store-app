// ─── BF CANDIDATES — Junid's card (23 Nov 2026) ──────────────────────────────
// Old stock that isn't selling (Junid, 15:44: "new stock is not dead stock"): the
// product first arrived in the network on or before the cut-off ("In store since":
// May, June, July (default) or August), still has stock on hand, and has sold
// under 10% of the units received. Tabs: Clothing, Sneakers (by quantity on hand,
// the most first; every row shows its arrival date) and On sale (everything on sale).
// FAST: the last answer for each tab is kept (memory + this device) and shown at
// once while the fresh one is fetched; the other tabs are fetched ahead.
//   Put on sale   every row has a PRICE BOX: type the sale price, tap Put on sale
//                 (disabled until a price is typed). ONE price for every customer
//                 at every till until the sale's end, shown at the top with Extend.
//                 The stock and retail prices are never changed and come back by
//                 themselves at the end. A price at or above the stock price warns
//                 before saving. Select: one price for every ticked item.
//                 The tap also alerts the stores and queues the product for the
//                 WhatsApp groups (Black Friday sale).
//   Photos        Use current photo, Generate / Regenerate (the shared New Arrivals
//                 generator, full resolution), Replace photo: the Black Friday
//                 card's own options. The photo shown is the one that posts.
//   Not for sale  off this list for good; "Removed (n)" at the bottom undoes it.
// IN-STORE ONLY: the website keeps its normal price.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { photoToBase64 } from "../blackFriday/BlackFridayScreen";
import { FONT, BG, GLASS, GLASS_SOLID, GREEN, GRAY, AMBER, RED, BLUE_L, bGreen, bGray, bBlue, bRed, tabOn, tabOff, input } from "../stock/ui";

const price = (p) => (Number.isInteger(Number(p)) ? `R${Number(p)}` : `R${Number(p).toFixed(2)}`);
const TAB_LABEL = { clothing: "Clothing", sneakers: "Sneakers", onsale: "On sale" };
const CUTOFFS = [{ key: "may", label: "May" }, { key: "june", label: "June" }, { key: "july", label: "July" }, { key: "august", label: "August" }];
const MAX_PICK = 500; // one tap = one call, so the warning covers the whole selection before anything is saved
/** A refusal from the shared photo callables, in this card's words. Pure. */
export function photoError(e) {
  const t = String((e && e.message) || e || "");
  if (/not in the campaign|not on the Black Friday card/i.test(t)) return "it is not on the Black Friday list yet, so a photo can't be made for it here. It joins that list at the 05:00 build if it has a stock price and a photo";
  return t.replace(/^.*?:\s(?=[A-Z])/, "") || "something went wrong";
}
// The last answer per tab + cut-off, kept on this device FOR THE SIGNED-IN ACCOUNT (the key carries its uid: another
// account on the same device never sees it): the card opens with it at once and then refreshes. `gen` moves on every
// tap that changes what is on sale; an answer asked for before that tap is never kept.
const KEEP = "bfCandidates.v2.";
const kept = new Map();
let gen = 0;
function recall(key) {
  if (kept.has(key)) return kept.get(key);
  try { const v = JSON.parse(window.localStorage.getItem(KEEP + key) || "null"); if (v && Array.isArray(v.rows)) { kept.set(key, v); return v; } } catch { /* no storage: memory only */ }
  return null;
}
function keep(key, v, asked = gen) {
  if (asked !== gen) return;
  kept.set(key, v);
  try { window.localStorage.setItem(KEEP + key, JSON.stringify(v)); } catch { /* full or blocked: memory only */ }
}
/** Forget every kept answer (after a tap that changed what is on sale; and for tests). */
export function forgetKept() { gen += 1; kept.clear(); try { Object.keys(window.localStorage).filter((k) => k.startsWith(KEEP)).forEach((k) => window.localStorage.removeItem(k)); } catch { /* none */ } }
/**
 * What happened to the store alert, said apart from the sale itself (the sale is saved either way). stores: the
 * server's { loc: { n, tokens, delivered } | { error } } or { error }. Pure.
 */
export function alertLine(stores) {
  if (!stores || typeof stores !== "object") return "";
  if (typeof stores.error === "string") return " The store alert could NOT be sent: tell the stores yourself (they still see it on the re-tag list).";
  const all = Object.values(stores);
  if (!all.length) return " No store holds it, so no alert was needed.";
  const got = all.reduce((t, x) => t + (Number(x && x.delivered) || 0), 0), failed = all.filter((x) => x && x.error).length;
  const silent = all.filter((x) => x && !x.error && !(Number(x.delivered) > 0)).length;
  if (!got) return ` No phone got the store alert (${failed ? "it failed" : "nobody is assigned to those stores"}): staff see it on the re-tag list.`;
  return ` Alert sent to ${got} phone${got === 1 ? "" : "s"}${silent + failed ? `; ${silent + failed} store${silent + failed === 1 ? "" : "s"} got none (re-tag list only)` : ""}.`;
}
const errText = (e) => String((e && e.message) || e || "Something went wrong").replace(/^.*?:\s(?=[A-Z])/, "");

/** "Marathon PE 4 · Hub 2 6" from { loc: qty } (biggest first). Pure. */
export function locsLine(locs, names = {}) {
  return Object.entries(locs || {}).filter(([, q]) => Number(q) > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([loc, q]) => `${names[loc] || loc} ${q}`).join(" · ");
}
/** The sale dialog's check before anything is sent. → { price } | { error }. Pure. */
export function readPrice(text) {
  // "1,500" is R1500 (a comma before exactly three digits is a thousands comma); "99,50" is R99.50. As the server reads it.
  const t = String(text || "").replace(/^\s*R\s*/i, "").replace(/\s+/g, "");
  const n = Number(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return { error: "Enter the sale price in rands." };
  return { price: Math.round(n * 100) / 100 };
}

function Row({ r, names, thumb, waiting, selecting, ticked, onTick, onSale, onExtend, onEnd, onRemove, busy, making, onGenerate, onReplace, onUseCurrent }) {
  const chosen = r.photoChoice && r.photoChoice.use === "generated";
  const locs = locsLine(r.locs, names);
  const [text, setText] = useState("");
  const typed = readPrice(text);
  const put = () => { if (typed.price) onSale([r], typed.price, () => setText("")); };
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
          {r.qty === null ? "Not on the candidates list any more" : <><b>{r.qty}</b> on hand</>}{r.arrivedOn ? <> · arrived {r.arrivedOn} · received {r.received} · sold {r.sold}</> : null}
        </div>
        <div style={{ color: GRAY, fontSize: "0.8rem", marginTop: 2 }}>
          Stock {r.stockPrice ? price(r.stockPrice) : "not set"} · Retail {r.retailPrice ? price(r.retailPrice) : "not set"}
        </div>
        {locs && <div style={{ color: GRAY, fontSize: "0.76rem", marginTop: 2, overflowWrap: "anywhere" }}>{locs}</div>}
        {r.sale && (
          <div style={{ marginTop: 6, color: AMBER, fontWeight: 700, fontSize: "0.84rem" }}>
            🔥 {price(r.sale.price)} · On sale until {r.sale.until}
            <span style={{ color: r.posted ? GREEN : GRAY, fontWeight: 600 }}> · {r.posted ? "Posted to the groups" : !r.photo ? "No photo: not posting" : waiting || "Queued to post"}</span>
          </div>
        )}
        {!selecting && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9, alignItems: "center" }}>
            <input aria-label={`Sale price for ${r.name}`} inputMode="decimal" value={text} disabled={busy} placeholder={r.sale ? "New price" : "Sale price"}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") put(); }}
              style={{ ...input, width: 104, padding: "8px 10px", fontSize: "0.95rem" }} />
            <button type="button" style={{ ...(r.sale ? bBlue : bGreen), opacity: typed.price ? 1 : 0.45 }} disabled={busy || !typed.price} onClick={put}>{r.sale ? "Edit price" : "Put on sale"}</button>
            {r.sale && <button type="button" style={bGray} disabled={busy} onClick={() => onExtend([r.pid])}>Extend</button>}
            {r.sale && <button type="button" style={bRed} disabled={busy} onClick={() => onEnd([r.pid])}>Remove from sale</button>}
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
                {chosen && <span style={{ color: GRAY, fontSize: "0.72rem" }}>{r.posted ? "Already posted; this photo goes with the next post" : "Posting with the photo shown"}</span>}
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
  const [cutoff, setCutoff] = useState("july");   // "In store since": arrived by the end of that month
  const [newEnd, setNewEnd] = useState("");       // only once the default end has passed: the end Junid picks for new sales
  const [bulkText, setBulkText] = useState("");   // the Select bar's one price for every ticked item
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

  const who = (api.uid && api.uid()) || "anon";  // whose kept answers these are
  const [stale, setStale] = useState(false);     // showing a kept answer while the fresh one is on its way
  const load = useCallback(async (t = tab, w = cutoff, { quiet = false } = {}) => {
    const mine = ++seq.current;
    const key = `${who}.${t}.${w}`;
    const asked = gen;
    // The kept answer first, at once; the fresh one replaces it when it lands.
    const old = quiet ? null : recall(key);
    if (old) { setView(old); setRows(old.rows || []); setStale(true); }
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const v = await api.list(t, w, 0);
      keep(key, v, asked);
      if (mine !== seq.current) return;
      setView(v); setRows(v.rows || []); setStale(false);
    } catch (e) { if (mine === seq.current) setError(errText(e)); }
    finally { if (mine === seq.current) setLoading(false); }
  }, [api, tab, cutoff, who]);
  useEffect(() => { setRows([]); setTicks(new Set()); load(tab, cutoff); }, [tab, cutoff]); // eslint-disable-line react-hooks/exhaustive-deps
  // The other tabs are fetched ahead, once the first answer is in: a tab switch shows its list at once.
  useEffect(() => {
    let live = true;
    const ahead = setTimeout(() => {
      const asked = gen;
      for (const t of Object.keys(TAB_LABEL)) if (t !== tab && !kept.has(`${who}.${t}.${cutoff}`)) api.list(t, cutoff, 0).then((v) => { if (live) keep(`${who}.${t}.${cutoff}`, v, asked); }).catch(() => {});
    }, 1200);
    return () => { live = false; clearTimeout(ahead); };
  }, [api, cutoff]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = async () => {
    const mine = seq.current; // a page asked for under another tab or window is thrown away
    try {
      const v = await api.list(tab, cutoff, rows.length);
      if (mine !== seq.current) return;
      setRows((cur) => [...cur, ...(v.rows || []).filter((r) => !cur.some((c) => c.pid === r.pid))]);
      setView((cur) => ({ ...(cur || {}), more: v.more, total: v.total, counts: v.counts }));
    } catch (e) { setToast(errText(e)); }
  };

  const names = (view && view.locNames) || {};
  const say = (t) => { setToast(t); setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 6000); };
  const inFlight = useRef(false);
  // The tab and cut-off on screen NOW (a refresh after a tap never reloads the tab the tap started on).
  const shown = useRef({ tab, cutoff });
  shown.current = { tab, cutoff };
  const refresh = () => load(shown.current.tab, shown.current.cutoff, { quiet: true });
  const withBusy = async (pids, label, fn) => {
    if (inFlight.current) return null; // one tap at a time: a second tap never lands on a half-finished first
    if (pids.some((p) => making[p])) { say("A photo is still being made for that product. Wait for it, then try again."); return null; }
    inFlight.current = true;
    setBusyPids(new Set(pids)); setWorking(label);
    try { return await fn(); }
    catch (e) {
      // A call that failed may still have saved (a timeout tells nothing): the card is read again so it shows what IS,
      // and a second tap never repeats work that was done.
      say(`${errText(e)} The list was read again: check what is on sale before trying again.`);
      refresh();
      return null;
    }
    finally { inFlight.current = false; setBusyPids(new Set()); setWorking(null); }
  };
  // A tap changed what is on sale: the answers kept for the other tabs are no longer true.
  const leaveList = (pids) => {
    if (!pids.length) return;
    const t = shown.current.tab;
    setRows((cur) => cur.filter((x) => !pids.includes(x.pid)));
    setView((v) => (v && v.counts ? { ...v, counts: { ...v.counts, [t]: Math.max(0, (v.counts[t] || 0) - pids.length), onSale: (v.counts.onSale || 0) + pids.length } } : v));
  };
  const done = () => { forgetKept(); setTicks(new Set()); setSelecting(false); setDialog(null); refresh(); };

  // ── Put on sale: ONE price; the warning (price ≥ stock price) comes before anything is saved ──
  const saveSale = async (pids, priceNum, confirmAbove, after) => {
    // ONE call for the whole selection: the server decides the warning before it saves anything.
    if (view && view.endPassed && !newEnd) { say(`The sale ended on ${view.defaultUntil}. Pick a new end date at the top of the card first.`); return; }
    const r = await withBusy(pids, `Putting ${pids.length} on sale…`, async () => [await api.sale(pids, priceNum, { confirmAbove, ...(view && view.endPassed && newEnd ? { endDay: newEnd } : {}) })]);
    if (!r) return;
    const need = r.flatMap((o) => o.needConfirm || []);
    // (Again, if a product came to need the warning since the first one: the confirmation is of the products shown.)
    if (need.length) { setDialog({ type: "confirm", pids, price: priceNum, need, after }); return; }
    const ok = r.flatMap((o) => o.done || []), refused = r.flatMap((o) => o.refused || []);
    const o0 = r.find((o) => o.until) || {};
    const until = o0.untilFrom ? `${o0.untilFrom} to ${o0.until} (each keeps its own end)` : o0.until;
    // Nothing saved (every product refused): the typed price stays in its box.
    if (!ok.length) { say(`Nothing was put on sale: ${refused.length ? refused[0].refusal : "try again"}.`); done(); return; }
    if (after) after();
    // Right away (the fresh list follows): what went on sale leaves this list and the tab counts move.
    if (shown.current.tab !== "onsale") leaveList(ok.filter((p) => !rows.find((x) => x.pid === p && x.sale)));
    say(`${ok.length} on sale at ${price(priceNum)}${until ? ` until ${until}` : ""}; queued for the groups.${alertLine((r[0] || {}).stores)}${refused.length ? ` ${refused.length} not saved: ${refused[0].refusal}.` : ""}`);
    done();
  };
  const doExtend = async (pids, endDay) => {
    const r = await withBusy(pids || [], "Extending…", async () => [pids ? await api.extend(pids, endDay) : await api.extendAll(endDay)]);
    if (!r) return;
    const n = r.reduce((t, o) => t + (o.done || []).length, 0), late = r.reduce((t, o) => t + (o.notLater || 0), 0);
    say(`${n} extended until ${(r[0] || {}).until || endDay}.${n ? alertLine((r[0] || {}).stores) : ""}${late ? ` ${late} already end${late === 1 ? "s" : ""} on or after that day: not changed.` : ""}`);
    done();
  };
  const doEnd = async (pids) => {
    const r = await withBusy(pids, "Ending the sale…", async () => [await api.end(pids)]);
    if (!r) return;
    const n = r.reduce((t, o) => t + (o.done || []).length, 0);
    // Right away: it leaves the On sale tab (and is back in its own list on the fresh read).
    const gone = r.flatMap((o) => o.done || []);
    if (shown.current.tab === "onsale") { setRows((cur) => cur.filter((x) => !gone.includes(x.pid))); setView((v) => (v && v.counts ? { ...v, counts: { ...v.counts, onSale: Math.max(0, (v.counts.onSale || 0) - gone.length) } } : v)); }
    say(`${n} removed from the sale: back to normal prices.${n ? alertLine((r[0] || {}).stores) : ""}`);
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
      refresh();
    } catch (e) { say(errText(e)); }
  };

  // ── Photos: the photo shown on the row is the one that posts ──
  const patchPhoto = (pid, photo, use) => setRows((cur) => cur.map((x) => (x.pid === pid ? { ...x, photo: photo || x.ownPhoto, photoChoice: use === "generated" ? { use } : null } : x)));
  // A photo job and a sale tap never overlap on a product: a sale saved while its photo is changing would post the
  // old photo under the new one's picture. So no photo job starts while a tap is in flight, and (withBusy) no tap
  // lands on a product whose photo is being made.
  const photoJob = async (r, label, fn) => {
    if (inFlight.current) { say("Wait for the sale to finish saving, then choose the photo."); return; }
    setMaking((m) => ({ ...m, [r.pid]: label }));
    try { await fn(); }
    catch (e) { say(`${r.name}: ${photoError(e)}`); }
    finally { setMaking((m) => { const n = { ...m }; delete n[r.pid]; return n; }); }
  };
  // A photo that was made (and paid for) is never lost to a dropped connection: choosing it is tried twice, and if
  // that still fails the photo is kept on the Black Friday card and the message says so.
  const choose = async (r, genId) => {
    let c;
    try { c = await api.photo(r.pid, "generated", genId); }
    catch { try { c = await api.photo(r.pid, "generated", genId); } catch (e) { throw new Error(`the photo was made and is kept on the Black Friday card, but could not be chosen here (${errText(e)}). Open that card to use it; no need to generate again`); } }
    patchPhoto(r.pid, c.photo, "generated");
  };
  const generate = (r) => photoJob(r, "Starting…", async () => {
    const res = await api.generate(r.pid, { onEvent: (ev) => { if (ev && ev.text) setMaking((m) => (m[r.pid] ? { ...m, [r.pid]: String(ev.text).slice(0, 80) } : m)); } });
    const genId = res && (res.genId || (res.result && res.result.genId));
    if (!genId) throw new Error("no photo came back. Tap Generate to try again");
    await choose(r, genId);
  });
  const replace = (r) => { replaceFor.current = r; if (fileRef.current) { fileRef.current.value = ""; fileRef.current.click(); } };
  const uploadPicked = (file) => {
    const r = replaceFor.current;
    replaceFor.current = null;
    if (!r || !file) return null;
    return photoJob(r, "Uploading your photo…", async () => {
      const res = await api.photoUpload(r.pid, await photoToBase64(file));
      await choose(r, res.id);
    });
  };
  const useCurrent = (r) => photoJob(r, "Saving…", async () => { const c = await api.photo(r.pid, "current"); patchPhoto(r.pid, c.photo, "current"); });

  const tick = (pid) => setTicks((cur) => { const n = new Set(cur); if (n.has(pid)) n.delete(pid); else if (n.size < MAX_PICK) n.add(pid); return n; });
  const picked = useMemo(() => rows.filter((r) => ticks.has(r.pid)), [rows, ticks]);
  const counts = (view && view.counts) || { clothing: 0, sneakers: 0, onSale: 0, removed: 0 };
  const bulk = readPrice(bulkText);
  const cutoffLabel = (((view && view.cutoffs) || CUTOFFS).find((c) => c.key === cutoff) || { label: "July" }).label;
  // The sale's end, always in sight: the date the running sales end (or the date a sale put on now will get).
  const ends = view && view.saleEnds;
  const endsLine = !view ? "Sale ends…"
    : !ends ? `Sale ends ${view.defaultUntil} 23:59`
      : ends.same ? `Sale ends ${ends.lastLabel} 23:59` : `Sales end ${ends.firstLabel} to ${ends.lastLabel} 23:59 · new ones ${view.defaultUntil}`;

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, paddingBottom: selecting ? 150 : 60 }}>
      <div style={{ position: "sticky", top: "env(safe-area-inset-top, 0px)", zIndex: 20, background: "rgba(0,0,0,.92)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", padding: "10px 14px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button type="button" style={{ ...bGray, padding: "8px 12px" }} onClick={onExit}>Back</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: "1.05rem" }}>BF Candidates</div>
            <div style={{ color: GRAY, fontSize: "0.74rem" }}>Old stock that isn't selling · in-store sale only</div>
          </div>
          <button type="button" style={selecting ? bBlue : bGray} onClick={() => { setSelecting((s) => !s); setTicks(new Set()); }}>{selecting ? "Cancel" : "Select"}</button>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <span style={{ color: AMBER, fontWeight: 800, fontSize: "0.86rem" }}>🔥 {endsLine}</span>
          <button type="button" style={{ ...bBlue, padding: "6px 12px", fontSize: "0.8rem", opacity: counts.onSale > 0 ? 1 : 0.45 }} disabled={!(counts.onSale > 0)} onClick={() => setDialog({ type: "extend", pids: null, n: counts.onSale })}>Extend</button>
          <span style={{ color: GRAY, fontSize: "0.76rem" }}>{counts.onSale > 0 ? `${counts.onSale} on sale` : "nothing on sale yet"}</span>
          <a href="#bf-sale-list" style={{ color: BLUE_L, fontSize: "0.78rem", fontWeight: 700, marginLeft: "auto" }}>Store re-tag lists</a>
        </div>
        {view && view.posting && view.posting.banner && (
          <div role="status" style={{ color: "#dfe7ff", fontSize: "0.8rem", marginTop: 8 }}>{view.posting.banner}</div>
        )}
        {view && view.endPassed && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, color: "#dfe7ff", fontSize: "0.8rem", flexWrap: "wrap" }}>
            That date has passed. New sales end at 23:59 on
            <input aria-label="End date for new sales" type="date" value={newEnd} min={view.today || undefined} onChange={(e) => setNewEnd(e.target.value)} style={{ ...input, padding: "6px 8px", fontSize: "0.8rem" }} />
          </label>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
          {Object.keys(TAB_LABEL).map((t) => (
            <button key={t} type="button" style={tab === t ? tabOn : tabOff} onClick={() => { setTab(t); setTicks(new Set()); }}>{TAB_LABEL[t]} ({(t === "onsale" ? counts.onSale : counts[t]) ?? 0})</button>
          ))}
          {tab !== "onsale" && (
            <label style={{ marginLeft: "auto", color: GRAY, fontSize: "0.78rem", display: "flex", alignItems: "center", gap: 6 }}>
              In store since
              <select aria-label="In store since" value={cutoff} onChange={(e) => setCutoff(e.target.value)} style={{ ...input, padding: "6px 8px", fontSize: "0.8rem" }}>
                {((view && view.cutoffs) || CUTOFFS).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
          )}
        </div>
      </div>

      <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, maxWidth: 760, margin: "0 auto" }}>
        {error && <div role="alert" style={{ color: RED, fontSize: "0.86rem" }}>{error} <button type="button" style={{ ...bGray, padding: "4px 10px" }} onClick={() => load()}>Try again</button></div>}
        {loading && !rows.length && <div style={{ color: GRAY }}>Loading…</div>}
        {stale && loading && rows.length > 0 && <div role="status" style={{ color: GRAY, fontSize: "0.74rem" }}>Showing the last list; checking for changes…</div>}
        {!loading && !error && !rows.length && (
          <div style={{ color: GRAY, fontSize: "0.9rem" }}>
            {tab === "onsale" ? "Nothing is on sale. Type a price on a row and tap Put on sale."
              : view && view.meta ? `Nothing in ${TAB_LABEL[tab]} arrived by the end of ${cutoffLabel}, is still in stock and has sold under 10% of what was received.${view.meta.ledgerFirst ? ` The stock records start on ${new Date(view.meta.ledgerFirst).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", day: "numeric", month: "short", year: "numeric" })}.` : ""}`
                : "The list has not been built yet. It is built every night; the first one is on its way."}
          </div>
        )}
        {rows.map((r) => (
          <Row key={r.pid} r={r} names={names} thumb={api.thumb} waiting={view && view.posting && view.posting.waiting} selecting={selecting} ticked={ticks.has(r.pid)} onTick={tick} busy={busyPids.has(r.pid) || !!working} making={making[r.pid]} onGenerate={generate} onReplace={replace} onUseCurrent={useCurrent}
            onSale={(rs, p, after) => saveSale(rs.map((x) => x.pid), p, null, after)} onExtend={(pids) => setDialog({ type: "extend", pids, n: pids.length })} onEnd={doEnd} onRemove={doRemove} />
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
            <input aria-label="Sale price for every ticked item" inputMode="decimal" value={bulkText} placeholder="One price for all" onChange={(e) => setBulkText(e.target.value)} style={{ ...input, width: 140, padding: "8px 10px", fontSize: "0.95rem" }} />
            <button type="button" style={{ ...bGreen, opacity: picked.length && bulk.price ? 1 : 0.45 }} disabled={!picked.length || !bulk.price || !!working} onClick={() => saveSale(picked.map((r) => r.pid), bulk.price, null, () => setBulkText(""))}>Put {picked.length || ""} on sale</button>
            <button type="button" style={bGray} disabled={!picked.some((r) => r.sale)} onClick={() => setDialog({ type: "extend", pids: picked.filter((r) => r.sale).map((r) => r.pid), n: picked.filter((r) => r.sale).length })}>Extend</button>
            <button type="button" style={bGray} disabled={!picked.length} onClick={() => doRemove(picked.map((r) => r.pid))}>Not for sale</button>
          </div>
        </div>
      )}

      {dialog && dialog.type === "confirm" && (
        <Sheet title="This price is not lower than the stock price" onClose={() => setDialog(null)}>
          <div style={{ color: "#dfe7ff", fontSize: "0.88rem", lineHeight: 1.45 }}>
            At {price(dialog.price)}, resellers would pay the same or MORE than they do now for:
            <ul style={{ margin: "8px 0", paddingLeft: 18 }}>
              {dialog.need.slice(0, 12).map((n) => <li key={n.pid}>{n.name} ({n.stockPrice ? `stock price ${price(n.stockPrice)}` : `no stock price set; retail ${price(n.retailPrice)}`})</li>)}
              {dialog.need.length > 12 && <li>and {dialog.need.length - 12} more</li>}
            </ul>
            {dialog.pids.length > dialog.need.length && <div>Saving puts all {dialog.pids.length} selected products on sale at this price, these included.</div>}
            Nothing has been saved yet.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button type="button" style={bGray} onClick={() => setDialog(null)}>Go back</button>
            <button type="button" style={bRed} disabled={!!working} onClick={() => saveSale(dialog.pids, dialog.price, dialog.need.map((n) => n.pid), dialog.after)}>{working || `Save at ${price(dialog.price)} anyway`}</button>
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

function ExtendSheet({ n, view, working, onClose, onSave }) {
  const [endDay, setEndDay] = useState("");
  return (
    <Sheet title={`Extend ${n === 1 ? "this sale" : `all ${n} sales`}`} onClose={onClose}>
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
