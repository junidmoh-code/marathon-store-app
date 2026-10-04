// ─── NEW ARRIVALS — the photo studio card ────────────────────────────────────
// Tap Generate → the photo appears beside the original → tap Approve → Done.
//
// TWO TABS: New and Done. New shows ONE group at a time — Sneakers (all
// footwear, slides too) or Clothing (everything else) — flipped with the
// switcher bar; the last group is remembered on the device.
//
// GENERATE is live: the card calls the photo studio function and shows, in the
// photo's own place, what Gemini is doing — its drafts as they arrive and its
// thought summary — then the finished photo. Several items can be generating
// at once. Nothing is generated unless Junid taps.
//
// EVERY OTHER TAP IS INSTANT. Save price, Approve, Skip (with an 8-second
// Undo), Use this one, ❤ and the method choice change the screen at once and
// write in the background. If a write fails the card goes back to how it was
// and a message says why. No tap reloads the list or locks the screen.
//
// EVERYTHING IS MANUAL: no checker text, no verdicts, no automatic moves.
// Approve is shown on every item with a photo; without a stock price it is
// disabled, with "add stock price first" by the price fields.
//
// PRICES are the product's REAL stock and retail price, saved through the
// admin price save (admin/productPriceSave.js). The stock price is what the
// WhatsApp groups are posted at; retail is for the shops and the website.
//
// PAGED: 30 at a time through the indexed list callable ("Load more"). Reads
// and writes ONLY through `api` (newArrivalsApi.js), so this file has no
// Firebase import and renders in tests with a fake api.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FONT, BG, GLASS, BLUE_L, GREEN, GRAY, bGreen, bGray, bBlue, tabOn, tabOff } from "../stock/ui";
import {
  TABS, REJECT_CHIPS, priceText, sizesText, statusLine, destinationLines, actionsFor, whenText,
  shopifyNameLine, needsStockPrice, PRICE_TABS, priceField, changedPrices, UNDO_MS, generationsOf, costText, totalCostText, spentText, canPick, currentGenId, stockText,
  isGroupTab, groupLabel, stepGroup, rememberedGroup, rememberGroup, genCode, canLove, isLoved,
  normalizeTab, canHow, THOUGHTS_LABEL, HOW_NONE_TEXT, methodMadeText, METHOD_TABS, effectiveMethod, methodToSet, METHOD_CHOICES,
  foldLive, liveStart, afterPick, afterPrices, afterLove, withoutItem, withItemBack,
} from "./newArrivalsView";

const REFRESH_MS = 60_000;
const PAGE = 30;
const TOAST_MS = 5000;
const INK = "#dfe7ff";

// ── small pieces ─────────────────────────────────────────────────────────────
function GenCode({ gen, small = false }) {
  const code = genCode(gen);
  return code ? <span data-testid="gen-code" style={{ color: INK, fontSize: small ? 10 : 12, fontWeight: 700, letterSpacing: 0.3 }}>{code}</span> : null;
}

function Tile({ url, label, children = null, testid = null }) {
  return (
    <figure data-testid={testid} style={{ margin: 0, flex: 1, minWidth: 0 }}>
      <div style={{ position: "relative", width: "100%", aspectRatio: "3 / 4", borderRadius: 14, overflow: "hidden", background: "#0b0d12" }}>
        {url
          ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={label} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} /></a>
          : children || <div style={{ position: "absolute", inset: 0, color: GRAY, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>No photo yet</div>}
        {url && children}
      </div>
      <figcaption style={{ color: GRAY, fontSize: 11, marginTop: 4, textAlign: "center" }}>{label}</figcaption>
    </figure>
  );
}

// Seconds since a generation started, ticking once a second.
function Elapsed({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  return <span data-testid="elapsed">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

// The photo's own place while Gemini works: its latest draft (or a quiet
// placeholder), the step it is on and the seconds so far.
function LiveTile({ live }) {
  const draft = live.drafts[live.drafts.length - 1] || null;
  return (
    <Tile testid="live-tile" url={draft} label={draft ? `Draft ${live.drafts.length} — Gemini is still working` : "Generating…"}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "18px 10px 8px", fontSize: 12, color: "#fff",
        background: draft ? "linear-gradient(transparent, rgba(0,0,0,.75))" : "none", display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span data-testid="live-status">{live.status}</span><Elapsed since={live.startedAt} />
      </div>
      {!draft && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: GRAY, fontSize: 12 }}>Working…</div>}
    </Tile>
  );
}

// Gemini's thought summary as it arrives (its own account — not proof).
function LiveThoughts({ live }) {
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [live.thoughts]);
  if (!live.thoughts) return null;
  return (
    <div data-testid="live-thoughts" style={{ marginTop: 8 }}>
      <div style={{ color: GRAY, fontSize: 11, marginBottom: 3 }}>{THOUGHTS_LABEL}</div>
      <div ref={box} style={{ whiteSpace: "pre-wrap", maxHeight: 132, overflowY: "auto", color: INK, fontSize: 12, lineHeight: 1.4, background: "rgba(255,255,255,.04)", borderRadius: 10, padding: 8 }}>{live.thoughts}</div>
    </div>
  );
}

// One generation's record, loaded ONCE when opened: the label first — it is
// Gemini's own account, not proof — then its summary verbatim, then its drafts.
function HowPanel({ pid, gen, loadHow }) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let on = true;
    loadHow(pid, gen.genId).then((data) => { if (on) setState({ data, error: null }); }, (e) => { if (on) setState({ data: null, error: e?.message || String(e) }); });
    return () => { on = false; };
  }, [pid, gen.genId, loadHow]);
  const { data, error } = state;
  const drafts = data && Array.isArray(data.drafts) ? data.drafts.filter((d) => d?.url) : [];
  return (
    <div data-testid="how-panel" style={{ background: "rgba(255,255,255,.04)", borderRadius: 12, padding: 10, marginTop: 8, fontSize: 12 }}>
      <div style={{ color: GRAY, fontSize: 11, marginBottom: 4 }}>How Gemini did it · {genCode(gen)}</div>
      {!data && !error && <div style={{ color: GRAY }}>Loading…</div>}
      {error && <div style={{ color: INK }}>Couldn't load: {error}</div>}
      {data?.none && <div data-testid="how-none" style={{ color: GRAY }}>{HOW_NONE_TEXT}</div>}
      {data && !data.none && (
        <>
          <div data-testid="how-label" style={{ color: "#fff", fontWeight: 800, fontSize: 13, marginBottom: 6 }}>{data.thoughtsLabel || THOUGHTS_LABEL}</div>
          {data.thoughts
            ? <div data-testid="how-thoughts" style={{ whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto", color: INK, lineHeight: 1.4 }}>{data.thoughts}</div>
            : <div style={{ color: GRAY }}>No summary was recorded.</div>}
          {drafts.length > 0 && (
            <div data-testid="how-drafts" style={{ display: "flex", gap: 6, overflowX: "auto", marginTop: 8 }}>
              {drafts.map((d, i) => (
                <a key={d.url} href={d.url} target="_blank" rel="noreferrer">
                  <img src={d.url} alt={`Draft ${i + 1}`} loading="lazy" style={{ width: 66, height: 88, objectFit: "cover", borderRadius: 8, display: "block", background: "#111" }} />
                </a>
              ))}
            </div>
          )}
          {(data.method || data.model) && <div style={{ color: GRAY, fontSize: 10, marginTop: 6 }}>{[methodMadeText(data), data.model].filter(Boolean).join(" · ")}</div>}
        </>
      )}
    </div>
  );
}

const mini = { ...bGray, padding: "5px 8px", fontSize: 11, borderRadius: 9 };

function LoveButton({ item, gen, onLove, small = false }) {
  const loved = isLoved(gen);
  return (
    <button data-testid="love" aria-label={loved ? "Unlove" : "Love"} aria-pressed={loved} onClick={() => onLove(item, gen.genId, !loved)}
      style={{ ...mini, fontSize: small ? 13 : 14, color: loved ? "#ff7a9c" : "#fff", borderColor: loved ? "rgba(255,122,156,.5)" : mini.border }}>{loved ? "❤" : "♡"}</button>
  );
}

// The two price fields, pre-filled with the product's prices, one Save. Only
// the fields changed are sent; the card shows the new price at once.
function PriceFields({ item, onSavePrices, needNote }) {
  const p = item.product || {};
  const [stock, setStock] = useState(priceField(p.stockPrice));
  const [retail, setRetail] = useState(priceField(p.retailPrice));
  useEffect(() => { setStock(priceField(p.stockPrice)); }, [p.stockPrice]);
  useEffect(() => { setRetail(priceField(p.retailPrice)); }, [p.retailPrice]);
  const drafts = changedPrices(p, stock, retail);
  const changed = Object.keys(drafts).length > 0;
  const field = { width: "100%", padding: "10px 10px", borderRadius: 11, border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 16, boxSizing: "border-box", marginTop: 3, fontFamily: FONT };
  return (
    <div data-testid="price-fields" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <label style={{ flex: 1, color: GRAY, fontSize: 11 }}>Stock price (R)
          <input aria-label="Stock price (R)" inputMode="decimal" value={stock} onChange={(e) => setStock(e.target.value)} style={field} /></label>
        <label style={{ flex: 1, color: GRAY, fontSize: 11 }}>Retail price (R)
          <input aria-label="Retail price (R)" inputMode="decimal" value={retail} onChange={(e) => setRetail(e.target.value)} style={field} /></label>
        <button disabled={!changed} onClick={() => onSavePrices(item, drafts)} style={{ ...bBlue, padding: "12px 16px", opacity: changed ? 1 : 0.4 }}>Save</button>
      </div>
      <div style={{ color: GRAY, fontSize: 10, marginTop: 4 }}>Stock price posts to the WhatsApp groups · retail is for the shops and the website</div>
      {needNote && <div data-testid="approve-note" style={{ color: INK, fontSize: 12, marginTop: 4 }}>add stock price first</div>}
    </div>
  );
}

// The original beside the current photo (or the live generation), then a strip
// of every earlier generation: its G-code, ❤, "Use this one", "How Gemini did it".
function Photos({ item, tab, stats, live, h }) {
  const gens = generationsOf(item);
  const [howOpen, setHowOpen] = useState(null);
  const toggleHow = (genId) => setHowOpen((cur) => (cur === genId ? null : genId));
  const mainId = currentGenId(item);
  const main = gens.find((g) => g.genId === mainId) || null;
  const mainUrl = main?.url || item.generatedUrl || (tab === "done" ? item.product?.photoUrl : null);
  const earlier = gens.filter((g) => g !== main);
  const howGen = howOpen ? gens.find((g) => g.genId === howOpen) : null;
  const total = totalCostText(item, stats);
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        <Tile url={item.originalUrl || item.product?.photoUrlOriginal || item.product?.photoUrl} label="Original" />
        {live ? <LiveTile live={live} /> : <Tile testid="main-photo" url={mainUrl} label={main ? "Current photo" : mainUrl ? "Photo" : "No photo yet"} />}
      </div>
      {live && <LiveThoughts live={live} />}
      {!live && main && (
        <div data-testid="main-meta" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <GenCode gen={main} />
          <span style={{ color: GRAY, fontSize: 11 }}>{costText(main, stats)}</span>
          <span style={{ flex: 1 }} />
          {h.loadHow && canHow(main) && <button data-testid="how-toggle" aria-expanded={howOpen === main.genId} onClick={() => toggleHow(main.genId)} style={mini}>{howOpen === main.genId ? "Hide how Gemini did it" : "How Gemini did it"}</button>}
          {h.onLove && canLove(tab, main) && <LoveButton item={item} gen={main} onLove={h.onLove} />}
        </div>
      )}
      {howGen && howGen === main && <HowPanel pid={item.pid} gen={howGen} loadHow={h.loadHow} />}
      {earlier.length > 0 && (
        <div data-testid="earlier-generations" style={{ display: "flex", gap: 8, overflowX: "auto", marginTop: 10, paddingBottom: 2 }}>
          {earlier.map((g) => (
            <div key={g.genId} data-gen={g.genId} style={{ flex: "0 0 96px" }}>
              <a href={g.url} target="_blank" rel="noreferrer">
                <img src={g.url} alt={`Earlier photo ${genCode(g) || whenText(g.at)}`} loading="lazy" style={{ width: 96, height: 128, objectFit: "cover", borderRadius: 10, display: "block", background: "#111" }} />
              </a>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 3 }}>
                <GenCode gen={g} small />
                {h.onLove && canLove(tab, g) && <LoveButton item={item} gen={g} onLove={h.onLove} small />}
              </div>
              {tab === "new" && h.onPick && canPick(item, g) && (
                <button disabled={!!live} onClick={() => h.onPick(item, g.genId)} style={{ ...bBlue, width: "100%", padding: "6px 4px", fontSize: 11, marginTop: 3, opacity: live ? 0.4 : 1 }}>Use this one</button>
              )}
              {h.loadHow && canHow(g) && <button data-testid="how-toggle" aria-expanded={howOpen === g.genId} onClick={() => toggleHow(g.genId)} style={{ ...mini, width: "100%", marginTop: 3, fontSize: 10 }}>{howOpen === g.genId ? "Hide" : "How Gemini did it"}</button>}
            </div>
          ))}
        </div>
      )}
      {howGen && howGen !== main && <HowPanel pid={item.pid} gen={howGen} loadHow={h.loadHow} />}
      {gens.length > 1 && total && <div data-testid="gen-total" style={{ color: GRAY, fontSize: 11, marginTop: 6 }}>{gens.length} photos · {total}</div>}
    </>
  );
}

function ItemCard({ item, tab, live, h, stats }) {
  const p = item.product || {};
  const acts = actionsFor(item);
  const [feedback, setFeedback] = useState(false);
  const big = { padding: "13px 10px", fontSize: 15, flex: 1 };
  const approveOn = acts.approveEnabled && !live;
  const hasPhotoNow = acts.approve;
  return (
    <div data-pid={item.pid} style={{ ...GLASS, padding: 12, marginBottom: 14 }}>
      <Photos item={item} tab={tab} stats={stats} live={live} h={h} />
      <div style={{ marginTop: 10, color: "#fff", fontWeight: 700, fontSize: 15 }}>{p.name || item.name}</div>
      {shopifyNameLine(item) && tab === "done" && <div style={{ color: BLUE_L, fontSize: 13, marginTop: 2 }}>{shopifyNameLine(item)}</div>}
      <div data-testid="stock" style={{ color: GRAY, fontSize: 12, marginTop: 3 }}>Sizes {sizesText(p.sizes)} · {stockText(item)}</div>
      {tab === "done" && (
        <>
          <div data-testid="status" style={{ color: item.status === "done" ? GREEN : INK, fontSize: 12, marginTop: 6 }}>{statusLine(item)}</div>
          <div style={{ color: GRAY, fontSize: 12, marginTop: 3 }}>{needsStockPrice(p) ? "No stock price" : `${priceText(p.stockPrice)} for the groups`}</div>
          {destinationLines(item).map((l) => <div key={l} style={{ color: GRAY, fontSize: 12, marginTop: 3 }}>{l}</div>)}
        </>
      )}
      {tab === "new" && item.lastAttempt?.failed === true && !live && !hasPhotoNow && (
        <div data-testid="status" style={{ color: INK, fontSize: 12, marginTop: 6 }}>{statusLine(item)}</div>
      )}
      {PRICE_TABS.includes(tab) && h.onSavePrices && <PriceFields item={item} onSavePrices={h.onSavePrices} needNote={hasPhotoNow && needsStockPrice(p)} />}
      {tab === "new" && (
        <div data-testid="actions" style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button disabled={!!live} onClick={() => h.onGenerate(item)} style={{ ...bBlue, ...big, opacity: live ? 0.5 : 1 }}>{live ? "Generating…" : hasPhotoNow ? "Regenerate" : "Generate"}</button>
          {hasPhotoNow && (
            <button disabled={!approveOn} onClick={() => h.onApprove(item)} title={live ? "generating…" : acts.approveWhy || undefined}
              style={{ ...bGreen, ...big, opacity: approveOn ? 1 : 0.4 }}>Approve</button>
          )}
          <button disabled={!!live} onClick={() => h.onSkip(item)} style={{ ...bGray, ...big, flex: "0 0 auto", opacity: live ? 0.5 : 1 }}>Skip</button>
        </div>
      )}
      {METHOD_TABS.includes(tab) && h.onMethod && (
        <div data-testid="method" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 10, fontSize: 11, color: GRAY }}>
          <span role="radiogroup" aria-label="Method for the next photo" style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {METHOD_CHOICES.map((m) => {
              const on = effectiveMethod(item, h.defaultMethod) === m.key;
              return (
                <button key={m.key} role="radio" aria-checked={on} disabled={!!live || on} onClick={() => h.onMethod(item, m.key)}
                  style={{ ...(on ? bBlue : bGray), padding: "5px 10px", fontSize: 11, borderRadius: 999, opacity: live ? 0.5 : 1 }}>{m.label}</button>
              );
            })}
          </span>
          <span style={{ flex: 1 }} />
          {hasPhotoNow && !live && h.onReject && (
            <button data-testid="feedback-toggle" aria-expanded={feedback} onClick={() => setFeedback((v) => !v)} style={{ ...mini, borderRadius: 999 }}>Not right?</button>
          )}
        </div>
      )}
      {feedback && hasPhotoNow && !live && (
        <div data-testid="reject-chips" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {REJECT_CHIPS.map((r) => <button key={r} onClick={() => { setFeedback(false); h.onReject(item, r); }} style={{ ...mini, borderRadius: 999, padding: "6px 10px", fontSize: 12 }}>{r}</button>)}
        </div>
      )}
    </div>
  );
}

// The switcher bar: a full-width rounded pill, a circular ‹ on the left and ›
// on the right, the group's name and count centred. A swipe on the bar flips too.
const SWIPE_PX = 40;
function GroupSwitcher({ group, count, onStep }) {
  const startX = useRef(null);
  const canPrev = stepGroup(group, -1) !== null;
  const canNext = stepGroup(group, 1) !== null;
  const circle = (on) => ({
    width: 42, height: 42, flex: "0 0 42px", borderRadius: "50%", border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(255,255,255,.08)", color: "#fff", fontSize: 22, lineHeight: "38px", padding: 0, fontFamily: FONT,
    cursor: on ? "pointer" : "default", opacity: on ? 1 : 0.25,
  });
  return (
    <div data-testid="group-switcher"
      onTouchStart={(e) => { startX.current = e.touches?.[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        const x0 = startX.current; startX.current = null;
        const x1 = e.changedTouches?.[0]?.clientX;
        if (x0 == null || x1 == null) return;
        if (x1 - x0 <= -SWIPE_PX) onStep(1); else if (x1 - x0 >= SWIPE_PX) onStep(-1);
      }}
      style={{ ...GLASS, borderRadius: 999, display: "flex", alignItems: "center", gap: 8, width: "100%", boxSizing: "border-box",
        padding: 6, marginBottom: 14, touchAction: "pan-y", userSelect: "none" }}>
      <button aria-label="Previous group" disabled={!canPrev} onClick={() => onStep(-1)} style={circle(canPrev)}>‹</button>
      <div data-testid="group-name" aria-live="polite" style={{ flex: 1, textAlign: "center", color: "#fff", fontWeight: 800, fontSize: 16 }}>
        {`${groupLabel(group)} · ${Number.isFinite(count) ? count : "…"}`}
      </div>
      <button aria-label="Next group" disabled={!canNext} onClick={() => onStep(1)} style={circle(canNext)}>›</button>
    </div>
  );
}

const EMPTY = { items: null, total: null, nextCursor: null, tabCounts: {}, groupCounts: null, stats: null, defaultMethod: "full" };
const deviceStorage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const ask = (text) => (typeof window !== "undefined" && window.confirm ? window.confirm(text) : true);

export default function NewArrivalsScreen({ api, onExit, initialTab = "new", storage = deviceStorage() }) {
  const [tab, setTab] = useState(() => normalizeTab(initialTab));
  const [group, setGroup] = useState(() => rememberedGroup(storage));
  const [data, setData] = useState(EMPTY);
  const [live, setLive] = useState({});       // pid → { status, thoughts, drafts, startedAt }
  const [toast, setToast] = useState(null);   // { text }
  const [undo, setUndo] = useState(null);     // { entries: [{ item, index }], text }

  const onStepGroup = (dir) => {
    const next = stepGroup(group, dir);
    if (!next) return;
    setGroup(next);
    rememberGroup(storage, next);
  };

  // A response for a view (tab + group) no longer shown, or overtaken by a
  // newer request or by one of Junid's taps, is dropped.
  const groupFor = (t, g) => (isGroupTab(t) ? g : null);
  const viewKey = (t, g) => `${t}|${groupFor(t, g) || ""}`;
  const loadSeq = useRef(0);
  const taps = useRef(0);                      // bumped by every optimistic change
  const writes = useRef(new Map());            // pid → the tail of its write chain
  const activeView = useRef(viewKey(tab, group));
  const dataRef = useRef(data);
  const liveRef = useRef(live);
  useLayoutEffect(() => { activeView.current = viewKey(tab, group); }, [tab, group]);
  useLayoutEffect(() => { dataRef.current = data; }, [data]);
  useLayoutEffect(() => { liveRef.current = live; }, [live]);

  const say = useCallback((text) => setToast({ text, at: Date.now() }), []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const load = useCallback(async (which, g, { quiet = false } = {}) => {
    const seq = ++loadSeq.current;
    const key = viewKey(which, g);
    const tapsAtStart = taps.current;
    try {
      const res = await api.list(which, { limit: PAGE, group: groupFor(which, g) });
      if (seq !== loadSeq.current || key !== activeView.current) return;
      // A quiet refresh never paints over a tap made (or a write still running) since it started.
      if (quiet && (taps.current !== tapsAtStart || writes.current.size > 0 || Object.keys(liveRef.current).length > 0)) return;
      setData({
        items: res.items || [], total: Number.isFinite(res.total) ? res.total : (res.items || []).length, nextCursor: res.nextCursor || null,
        tabCounts: res.tabCounts || {}, groupCounts: res.groupCounts || null, stats: res.stats || null, defaultMethod: res.defaultMethod || "full",
      });
    } catch (e) {
      if (seq !== loadSeq.current || key !== activeView.current) return;
      if (!quiet) { say(`Couldn't load: ${e?.message || e}`); setData((d) => ({ ...d, items: d.items || [] })); }
    }
  }, [api, say]);

  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!data.nextCursor || loadingMore) return;
    const key = viewKey(tab, group);
    setLoadingMore(true);
    try {
      const res = await api.list(tab, { cursor: data.nextCursor, limit: PAGE, group: groupFor(tab, group) });
      if (key !== activeView.current) return;
      setData((d) => {
        const have = new Set((d.items || []).map((i) => i.pid));
        return { ...d, items: [...(d.items || []), ...(res.items || []).filter((i) => !have.has(i.pid))], nextCursor: res.nextCursor || null };
      });
    } catch (e) {
      say(`Couldn't load more: ${e?.message || e}`);
    } finally { setLoadingMore(false); }
  };

  useEffect(() => {
    setData((d) => ({ ...d, items: null, total: null, nextCursor: null, groupCounts: null }));
    load(tab, group);
    // A quiet refresh while only the first page is shown (it would otherwise drop loaded pages).
    const t = setInterval(() => { if ((dataRef.current.items || []).length <= PAGE) load(tab, group, { quiet: true }); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [tab, group, load]);

  // ── instant taps ───────────────────────────────────────────────────────────
  // One item's writes run one after another (an Undo waits for its Skip).
  const write = (pid, fn) => {
    const prev = writes.current.get(pid) || Promise.resolve();
    const next = prev.then(fn, fn);
    writes.current.set(pid, next);
    const clear = () => { if (writes.current.get(pid) === next) writes.current.delete(pid); };
    next.then(clear, clear);
    return next;
  };
  const patch = (pid, fn) => { taps.current += 1; setData((d) => ({ ...d, items: (d.items || []).map((i) => (i.pid === pid ? fn(i) : i)) })); };
  const putBack = (pid, was) => setData((d) => ({ ...d, items: (d.items || []).map((i) => (i.pid === pid ? was : i)) }));
  const reason = (e) => String(e?.message || e || "not saved").replace(/\.$/, "");

  /** Change the card now; write in the background; on failure put the card back and say why. */
  const instant = (item, change, send, failed) => {
    patch(item.pid, change);
    write(item.pid, async () => {
      try {
        const res = await send();
        if (res && res.ok === false) throw new Error(res.error || "not saved");
      } catch (e) {
        putBack(item.pid, item);
        say(`${failed} — ${reason(e)}. The card is back as it was.`);
      }
    });
  };

  const h = { defaultMethod: data.defaultMethod || "full" };

  // PRICES — the admin price save. "Retail below stock price" asks first, as the admin editor does.
  h.onSavePrices = api.savePrices ? (item, drafts) => {
    patch(item.pid, (i) => afterPrices(i, drafts));
    write(item.pid, async () => {
      try {
        let res = await api.savePrices(item.pid, item.product || {}, drafts);
        if (!res.ok && res.needsConfirm) {
          if (!ask(res.error)) { putBack(item.pid, item); return; }
          res = await api.savePrices(item.pid, item.product || {}, drafts, { confirmed: true });
        }
        if (!res.ok) throw new Error(res.error || "not saved");
        say("Prices saved.");
      } catch (e) {
        putBack(item.pid, item);
        say(`Prices not saved — ${reason(e)}. The card is back as it was.`);
      }
    });
  } : null;

  // USE THIS ONE — that generation becomes the main photo; Approve then uses it.
  h.onPick = api.select ? (item, genId) => instant(item, (i) => afterPick(i, genId), () => api.select(item.pid, genId), "Main photo not changed") : null;
  // ❤ — never moves or approves the item.
  h.onLove = api.love ? (item, genId, loved) => instant(item, (i) => afterLove(i, genId, loved, Date.now()), () => api.love(item.pid, genId, loved), loved ? "Not loved" : "Love not removed") : null;
  // THE METHOD for this item's next photo: Full Gemini or Split.
  h.onMethod = api.method ? (item, choice) => instant(item, (i) => ({ ...i, method: choice }), () => api.method(item.pid, methodToSet(choice, h.defaultMethod)), "Method not changed") : null;
  // FEEDBACK — one chip, noted against the photo shown; the item stays.
  h.onReject = api.reject ? (item, why) => {
    say(`Noted: ${why}.`);
    write(item.pid, async () => { try { await api.reject(item.pid, why); } catch (e) { say(`Feedback not saved — ${reason(e)}.`); } });
  } : null;

  // The item leaves the list at once (Approve, Skip); a refusal brings it back.
  const leave = (item, toTab) => {
    taps.current += 1;
    const index = (dataRef.current.items || []).findIndex((i) => i.pid === item.pid);
    setData((d) => withoutItem(d, item.pid, { group, toTab }));
    return { item, index, toTab };
  };
  const comeBack = (entry) => setData((d) => withItemBack(d, entry, { group }));

  // APPROVE — Junid's Approve is final. The card goes to Done at once.
  h.onApprove = (item) => {
    if (!actionsFor(item).approveEnabled || liveRef.current[item.pid]) return;
    const entry = leave(item, "done");
    write(item.pid, async () => {
      try {
        const res = await api.approve([item.pid]);
        if (!(res?.approved || []).includes(item.pid)) throw new Error(res?.skipped?.[0]?.why || "not approved");
      } catch (e) {
        comeBack(entry);
        say(`Not approved — ${reason(e)}. It is back on the list.`);
      }
    });
    say("Approved — publishing has started. It is under Done.");
  };

  // SKIP — gone at once, with ONE toast for 8 seconds; Undo brings every skipped item back.
  useEffect(() => {
    if (!undo) return undefined;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  h.onSkip = (item) => {
    if (liveRef.current[item.pid]) return;
    const entry = leave(item, null);
    setUndo((cur) => {
      const entries = [...(cur?.entries || []).filter((e) => e.item.pid !== item.pid), entry];
      return { entries, text: `${entries.length} skipped — not advertised.` };
    });
    write(item.pid, async () => {
      try {
        const res = await api.skip([item.pid]);
        if (!(res?.skippedPids || []).includes(item.pid)) throw new Error(res?.skipped?.[0]?.why || "not skipped");
      } catch (e) {
        comeBack(entry);
        setUndo((cur) => {
          const entries = (cur?.entries || []).filter((x) => x.item.pid !== item.pid);
          return entries.length ? { entries, text: `${entries.length} skipped — not advertised.` } : null;
        });
        say(`Not skipped — ${reason(e)}. It is back on the list.`);
      }
    });
  };
  const onUndo = () => {
    if (!undo) return;
    const { entries } = undo;
    setUndo(null);
    // Back in their places at once — last skipped first, so each position is the
    // one it was taken from — then restored on the server.
    for (const entry of [...entries].reverse()) {
      comeBack(entry);
      write(entry.item.pid, async () => {
        try {
          const res = await api.restore([entry.item.pid]);
          if (!(res?.restored || []).includes(entry.item.pid)) throw new Error(res?.skipped?.[0]?.why || "not restored");
        } catch (e) {
          setData((d) => withoutItem(d, entry.item.pid, { group, toTab: null }));
          say(`Skip not undone — ${reason(e)}.`);
        }
      });
    }
  };

  // GENERATE / REGENERATE — live, on the card.
  h.onGenerate = (item) => {
    const pid = item.pid;
    if (liveRef.current[pid]) return;
    taps.current += 1;
    setLive((l) => ({ ...l, [pid]: liveStart(Date.now()) }));
    const method = effectiveMethod(item, h.defaultMethod);
    write(pid, async () => {
      try {
        const res = await api.generate(pid, { method, onEvent: (ev) => setLive((l) => (l[pid] ? { ...l, [pid]: foldLive(l[pid], ev) } : l)) });
        // The server's item (no product or stock on it): those stay as the card has them.
        if (res?.item) setData((d) => ({ ...d, items: (d.items || []).map((i) => (i.pid === pid ? { ...res.item, product: i.product, availableSizes: i.availableSizes, totalUnits: i.totalUnits, stockKnown: i.stockKnown } : i)) }));
        say(`Photo ready in ${Math.round(Number(res?.seconds) || 0)}s${Number.isFinite(Number(res?.costZar)) ? ` · ${res.costEstimated ? "~" : ""}R${Number(res.costZar).toFixed(2)}` : ""}.`);
      } catch (e) {
        say(`${reason(e)}.`);
      } finally {
        taps.current += 1;
        setLive((l) => { const { [pid]: gone, ...rest } = l; void gone; return rest; });
      }
    });
  };

  // "How Gemini did it" — each generation's record is fetched at most once on this screen.
  const howCache = useRef(new Map());
  const loadHow = useCallback((pid, genId) => {
    const k = `${pid}/${genId}`;
    let p = howCache.current.get(k);
    if (!p) {
      p = api.how(pid, genId).catch((e) => { howCache.current.delete(k); throw e; });
      howCache.current.set(k, p);
    }
    return p;
  }, [api]);
  h.loadHow = api.how ? loadHow : null;

  const items = data.items;
  const stats = data.stats;
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: "14px 14px 96px" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <button onClick={onExit} style={{ ...bGray, padding: "8px 12px" }} aria-label="Back">←</button>
          <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>New Arrivals</div>
          <div data-testid="spent" style={{ color: GRAY, fontSize: 11 }}>{spentText(stats)}</div>
        </div>
        <div role="tablist" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={{ ...(tab === t.key ? tabOn : tabOff), flex: 1, padding: "9px 14px" }}>
              {t.label}{Number.isFinite(data.tabCounts[t.key]) ? ` ${data.tabCounts[t.key]}` : ""}
            </button>
          ))}
        </div>
        {isGroupTab(tab) && (
          <GroupSwitcher group={group} onStep={onStepGroup} count={data.groupCounts ? data.groupCounts[group] : (data.items ? data.total : null)} />
        )}
        {items === null && <div style={{ color: GRAY }}>Loading…</div>}
        {items && items.length === 0 && <div style={{ color: GRAY }}>Nothing here.</div>}
        {items && items.map((it) => <ItemCard key={it.pid} item={it} tab={tab} live={live[it.pid] || null} h={h} stats={stats} />)}
        {items && data.nextCursor && (
          <button disabled={loadingMore} onClick={loadMore} style={{ ...bGray, width: "100%", opacity: loadingMore ? 0.5 : 1 }}>
            {loadingMore ? "Loading…" : `Load more (${items.length} of ${data.total ?? "?"} shown)`}
          </button>
        )}
      </div>
      {(undo || toast) && (
        <div style={{ position: "fixed", left: 14, right: 14, bottom: 14, zIndex: 50, display: "flex", flexDirection: "column", gap: 8, alignItems: "center" }}>
          {toast && (
            <div data-testid="toast" role="status" style={{ ...GLASS, background: "#0a0e18", maxWidth: 532, width: "100%", boxSizing: "border-box", padding: "11px 12px", fontSize: 14, color: "#fff" }}>{toast.text}</div>
          )}
          {undo && (
            <div data-testid="undo-toast" role="status" style={{ ...GLASS, background: "#0a0e18", maxWidth: 532, width: "100%", boxSizing: "border-box", padding: "9px 12px", display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#fff" }}>
              <div style={{ flex: 1 }}>{undo.text}</div>
              <button onClick={onUndo} style={{ ...bBlue, padding: "8px 14px" }}>Undo</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
