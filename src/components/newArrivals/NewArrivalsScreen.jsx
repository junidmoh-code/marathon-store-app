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
// write in the background. If a write fails, that tap's change — and only
// that — is undone and a message says why. An answer that never arrives is
// never reported as a failure: the list is re-read instead. No tap reloads
// the list or locks the screen.
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
  normalizeTab, canHow, THOUGHTS_LABEL, HOW_NONE_TEXT, methodMadeText, METHOD_TABS, METHOD_CHOICES, effectiveChoice, choiceToSet, afterChoice, madeTag, howLabel,
  foldLive, liveStart, afterPick, afterPrices, afterLove, withoutItem, withItemBack, isGenerating,
  revertPick, revertLove, revertPrices, revertMethod, afterGenerated, named, sourceUrlOf,
} from "./newArrivalsView";

const REFRESH_MS = 60_000;   // the quiet refresh of everything on screen
const RELOAD_CHUNK = 100;    // the list callable's page ceiling
const LONG_LIST_EVERY = 5;   // a list longer than one page: re-read every 5th minute
const PAGE = 30;
const TOAST_MS = 6000;
const TOASTS_MAX = 3;
const WRITES_WAIT_MS = 10_000;
const FULL_LOAD_ROUNDS = 4;
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
    <Tile testid="live-tile" url={draft} label={draft ? `Draft ${live.drafts.length} — ${live.engine || "Gemini"} is still working` : "Generating…"}>
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
    loadHow(pid, gen.genId).then((data) => { if (on) setState({ data: data || { none: true }, error: null }); }, (e) => { if (on) setState({ data: null, error: e?.message || String(e) }); });
    return () => { on = false; };
  }, [pid, gen.genId, loadHow]);
  const { data, error } = state;
  const drafts = data && Array.isArray(data.drafts) ? data.drafts.filter((d) => d?.url) : [];
  return (
    <div data-testid="how-panel" style={{ background: "rgba(255,255,255,.04)", borderRadius: 12, padding: 10, marginTop: 8, fontSize: 12 }}>
      <div style={{ color: GRAY, fontSize: 11, marginBottom: 4 }}>{howLabel(gen)} · {genCode(gen)}</div>
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

// Small buttons are still finger-sized: 40 px tall at least.
const mini = { ...bGray, padding: "0 10px", minHeight: 40, fontSize: 12, borderRadius: 10 };

function LoveButton({ item, gen, onLove, disabled = false }) {
  const loved = isLoved(gen);
  return (
    <button data-testid="love" aria-label={loved ? "Unlove" : "Love"} aria-pressed={loved} disabled={disabled} onClick={() => onLove(item, gen.genId, !loved)}
      style={{ ...mini, minWidth: 40, fontSize: 16, color: loved ? "#ff7a9c" : "#fff", borderColor: loved ? "rgba(255,122,156,.5)" : undefined, opacity: disabled ? 0.4 : 1 }}>{loved ? "❤" : "♡"}</button>
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
function Photos({ item, tab, stats, live, busy, h }) {
  const gens = generationsOf(item);
  const [howOpen, setHowOpen] = useState(null);
  const toggleHow = (genId) => setHowOpen((cur) => (cur === genId ? null : genId));
  const mainId = currentGenId(item);
  const main = gens.find((g) => g.genId === mainId) || null;
  const mainUrl = main?.url || item.generatedUrl || (tab === "done" ? item.product?.photoUrl : null);
  // While a new photo is being made its place shows Gemini at work, so the
  // current photo joins the strip — it stays in sight to compare.
  const strip = live ? gens : gens.filter((g) => g !== main);
  const howGen = howOpen ? gens.find((g) => g.genId === howOpen) : null;
  const total = totalCostText(item, stats);
  const how = (g, wide) => h.loadHow && canHow(g) && (
    <button data-testid="how-toggle" aria-expanded={howOpen === g.genId} onClick={() => toggleHow(g.genId)} style={{ ...mini, ...(wide ? { width: "100%", marginTop: 4, fontSize: 11 } : {}) }}>
      {howOpen === g.genId ? "Hide" : howLabel(g)}
    </button>
  );
  return (
    <>
      <div style={{ display: "flex", gap: 8 }}>
        {/* The product's CURRENT photo, as the server read it just now (sourceUrl) — never a copy kept on the item. */}
        <Tile testid="original-photo" url={sourceUrlOf(item)} label="Original" />
        {live ? <LiveTile live={live} /> : <Tile testid="main-photo" url={mainUrl} label={main ? (tab === "done" ? "Approved photo" : "Current photo") : mainUrl ? "Photo" : "No photo yet"} />}
      </div>
      {live && <LiveThoughts live={live} />}
      {!live && main && (
        <div data-testid="main-meta" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
          <GenCode gen={main} />
          <span style={{ color: GRAY, fontSize: 11 }}>{[madeTag(main), costText(main, stats)].filter(Boolean).join(" · ")}</span>
          <span style={{ flex: 1 }} />
          {how(main, false)}
          {h.onLove && canLove(tab, main) && <LoveButton item={item} gen={main} onLove={h.onLove} disabled={busy} />}
        </div>
      )}
      {!live && main && item.sourceChanged && tab === "new" && (
        <div data-testid="source-changed" style={{ color: "#fff", fontSize: 12, marginTop: 6, padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,.08)" }}>
          The product's photo was changed after this photo was made. It cannot be approved — tap Regenerate to make one from the new photo.
        </div>
      )}
      {/* Footwear placed on the fixed backdrop by code: Gemini's own photo, before that, as a thumbnail. */}
      {!live && main?.uncorrected?.url && (
        <a data-testid="uncorrected" href={main.uncorrected.url} target="_blank" rel="noreferrer" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, color: GRAY, fontSize: 11, textDecoration: "none" }}>
          <img src={main.uncorrected.url} alt="Before it was placed on your backdrop" loading="lazy" style={{ width: 54, height: 72, objectFit: "cover", borderRadius: 8, background: "#1c1c1e" }} />
          <span>Shoe and box placed on your fixed backdrop. This is {main.provider === "openai" ? "OpenAI" : "Gemini"}'s photo before that.</span>
        </a>
      )}
      {/* What Junid must know about this photo (e.g. Split could not place it): it stays on the card, not only in a passing message. */}
      {!live && main?.note && <div data-testid="gen-note" style={{ color: "#fff", fontSize: 12, marginTop: 6, padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,.08)" }}>{main.note}</div>}
      {howGen && howGen === main && !live && <HowPanel pid={item.pid} gen={howGen} loadHow={h.loadHow} />}
      {strip.length > 0 && (
        <div data-testid="earlier-generations" style={{ display: "flex", gap: 10, overflowX: "auto", marginTop: 10, paddingBottom: 2 }}>
          {strip.map((g) => (
            <div key={g.genId} data-gen={g.genId} style={{ flex: "0 0 112px" }}>
              <a href={g.url} target="_blank" rel="noreferrer">
                <img src={g.url} alt={`Earlier photo ${genCode(g) || whenText(g.at)}`} loading="lazy" style={{ width: 112, height: 149, objectFit: "cover", borderRadius: 10, display: "block", background: "#111" }} />
              </a>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4, minHeight: 40 }}>
                <GenCode gen={g} small />
                {h.onLove && canLove(tab, g) && <LoveButton item={item} gen={g} onLove={h.onLove} disabled={busy} />}
              </div>
              {tab === "new" && h.onPick && canPick(item, g) && (
                // A photo made from a product photo that has since been replaced cannot become the main one (it could not be approved).
                (item.staleGens || []).includes(g.genId)
                  ? <div data-testid="stale-gen" style={{ color: GRAY, fontSize: 10, marginTop: 4, minHeight: 40 }}>made from the old product photo</div>
                  : <button disabled={busy} onClick={() => h.onPick(item, g.genId)} style={{ ...bBlue, width: "100%", minHeight: 40, padding: "0 4px", fontSize: 12, marginTop: 4, opacity: busy ? 0.4 : 1 }}>Use this one</button>
              )}
              {how(g, true)}
            </div>
          ))}
        </div>
      )}
      {howGen && (howGen !== main || live) && <HowPanel pid={item.pid} gen={howGen} loadHow={h.loadHow} />}
      {gens.length > 1 && total && <div data-testid="gen-total" style={{ color: GRAY, fontSize: 11, marginTop: 6 }}>{gens.length} photos · {total}</div>}
    </>
  );
}

function ItemCard({ item, tab, live, h, stats }) {
  const p = item.product || {};
  const acts = actionsFor(item);
  const [feedback, setFeedback] = useState(false);
  const big = { minHeight: 48, padding: "0 10px", fontSize: 15, flex: 1 };
  const hasPhotoNow = acts.approve;
  // A photo is being made for it but not from this screen (the page was
  // reloaded mid-way, or it was started on another device): said in words.
  const elsewhere = tab === "new" && !live && isGenerating(item);
  const working = !!live || elsewhere;
  const approveOn = acts.approveEnabled && !working;
  return (
    <div data-pid={item.pid} style={{ ...GLASS, padding: 12, marginBottom: 14 }}>
      <Photos item={item} tab={tab} stats={stats} live={live} busy={working} h={h} />
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
      {elsewhere && <div data-testid="status" style={{ color: INK, fontSize: 12, marginTop: 6 }}>A photo is being made for this item — it will appear here in a minute.</div>}
      {tab === "new" && item.lastAttempt?.failed === true && !working && !hasPhotoNow && (
        <div data-testid="status" style={{ color: INK, fontSize: 12, marginTop: 6 }}>{statusLine(item)}</div>
      )}
      {PRICE_TABS.includes(tab) && h.onSavePrices && <PriceFields item={item} onSavePrices={h.onSavePrices} needNote={hasPhotoNow && needsStockPrice(p)} />}
      {tab === "new" && (
        <div data-testid="actions" style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "stretch" }}>
          <button disabled={working} onClick={() => h.onGenerate(item)} style={{ ...bBlue, ...big, opacity: working ? 0.5 : 1 }}>{working ? "Generating…" : hasPhotoNow ? "Regenerate" : "Generate"}</button>
          {hasPhotoNow && (
            <button disabled={!approveOn} onClick={() => h.onApprove(item)} style={{ ...bGreen, ...big, opacity: approveOn ? 1 : 0.4 }}>Approve</button>
          )}
          {/* Skip sits apart and smaller: it must never be hit for Approve. */}
          <button disabled={working} onClick={() => h.onSkip(item)} style={{ ...bGray, ...big, flex: "0 0 auto", marginLeft: 10, padding: "0 14px", fontSize: 13, fontWeight: 600, background: "transparent", opacity: working ? 0.5 : 1 }}>Skip</button>
        </div>
      )}
      {METHOD_TABS.includes(tab) && h.onMethod && (
        <div data-testid="method" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 10, fontSize: 11, color: GRAY }}>
          {/* NEXT PHOTO: four explicit choices — engine and method together; the one in use is highlighted. */}
          <span role="radiogroup" aria-label="Next photo: engine and method" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, flex: "1 1 100%" }}>
            {METHOD_CHOICES.map((m) => {
              const on = effectiveChoice(item, h.defaultMethod) === m.key;
              return (
                <button key={m.key} role="radio" aria-checked={on} aria-disabled={working} onClick={() => { if (!working && !on) h.onMethod(item, m.key); }}
                  style={{ ...(on ? bBlue : bGray), minHeight: 40, padding: "0 8px", fontSize: 12, borderRadius: 999, opacity: working ? 0.5 : 1 }}>{m.label}</button>
              );
            })}
          </span>
          <span style={{ flex: 1 }} />
          {hasPhotoNow && !working && h.onReject && (
            <button data-testid="feedback-toggle" aria-expanded={feedback} onClick={() => setFeedback((v) => !v)} style={{ ...mini, borderRadius: 999 }}>Not right?</button>
          )}
        </div>
      )}
      {feedback && hasPhotoNow && !working && (
        <div data-testid="reject-chips" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {REJECT_CHIPS.map((r) => <button key={r} onClick={() => { setFeedback(false); h.onReject(item, r); }} style={{ ...mini, borderRadius: 999, padding: "0 14px", fontSize: 13 }}>{r}</button>)}
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

const EMPTY = { items: null, total: null, nextCursor: null, tabCounts: {}, groupCounts: null, stats: null, defaultMethod: null };
const deviceStorage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const ask = (text) => (typeof window !== "undefined" && window.confirm ? window.confirm(text) : true);

// The method assumed before the list has answered: Full Gemini.
const DEFAULT_METHOD = "full";
const reason = (e) => String(e?.message || e || "not saved").replace(/\.$/, "");
// A refusal the server actually gave (its own words are true) — as against a
// reply that never arrived, where the write may or may not have landed.
const DEFINITE = /failed[-_]precondition|invalid[-_]argument|permission[-_]denied|not[-_]found|unauthenticated/i;
const definite = (e) => DEFINITE.test(String(e?.code || ""));

/**
 * Run one write and say how it ended:
 *   { ok } — it landed · { refused: why } — the server said no · { unknown } — no answer (it may have landed).
 * `refusalOf(result)` reads a refusal out of a normal answer (or null).
 */
async function attempt(send, refusalOf = () => null) {
  try {
    const res = await send();
    const why = refusalOf(res);
    return why ? { refused: String(why).replace(/\.$/, "") } : { ok: true, res };
  } catch (e) {
    return definite(e) ? { refused: reason(e) } : { unknown: reason(e) };
  }
}

export default function NewArrivalsScreen({ api, onExit, initialTab = "new", storage = deviceStorage() }) {
  const [tab, setTab] = useState(() => normalizeTab(initialTab));
  const [group, setGroup] = useState(() => rememberedGroup(storage));
  const [data, setData] = useState(EMPTY);
  const [live, setLive] = useState({});       // pid → { status, thoughts, drafts, startedAt }
  const [toasts, setToasts] = useState([]);   // [{ id, text }] — newest last
  const [undo, setUndo] = useState(null);     // { entries: [entry], text }

  const onStepGroup = (dir) => {
    const next = stepGroup(group, dir);
    if (!next) return;
    setGroup(next);
    rememberGroup(storage, next);
  };

  const groupFor = (t, g) => (isGroupTab(t) ? g : null);
  const viewKey = (t, g) => `${t}|${groupFor(t, g) || ""}`;
  const loadSeq = useRef(0);
  const taps = useRef(0);                      // bumped by every local change AND every write that finishes
  const writes = useRef(new Map());            // pid → the tail of its write chain
  const gone = useRef(new Map());              // pid → the entry of a card that has left the list (Approve, Skip)
  const undoPids = useRef(new Set());          // the skipped cards the Undo bar can still bring back
  const clock = useRef(0);                     // ticks each time a write finishes
  const fullLoads = useRef(0);                 // full list loads on their way
  const alive = useRef(true);
  const activeView = useRef(viewKey(tab, group));
  const viewRef = useRef({ tab, group });
  const dataRef = useRef(data);
  const liveRef = useRef(live);
  useLayoutEffect(() => { activeView.current = viewKey(tab, group); viewRef.current = { tab, group }; }, [tab, group]);
  useLayoutEffect(() => { dataRef.current = data; }, [data]);
  useLayoutEffect(() => { liveRef.current = live; }, [live]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Messages stack (up to three) and each names its item: several can be at work at once.
  const toastId = useRef(0);
  const say = useCallback((item, text) => {
    if (!alive.current) return;
    const id = ++toastId.current;
    setToasts((ts) => [...ts, { id, text: named(item, text) }].slice(-TOASTS_MAX));
    setTimeout(() => { if (alive.current) setToasts((ts) => ts.filter((t) => t.id !== id)); }, TOAST_MS);
  }, []);

  const load = useCallback(async (which, g, { quiet = false } = {}) => {
    const key = viewKey(which, g);
    // The quiet refresh never competes with a full load.
    if (quiet && fullLoads.current > 0) return;
    if (!quiet) fullLoads.current += 1;
    try {
      for (let round = 0; round < (quiet ? 1 : FULL_LOAD_ROUNDS); round++) {
        // A full load waits (up to 10 s) for the writes still on their way: the list it reads must include them.
        if (!quiet && writes.current.size > 0) {
          let timer;
          await Promise.race([Promise.allSettled([...writes.current.values()]), new Promise((r) => { timer = setTimeout(r, WRITES_WAIT_MS); })]);
          clearTimeout(timer);
        }
        const seq = ++loadSeq.current;
        const tapsAtStart = taps.current, clockAtStart = clock.current;
        // Everything on screen is re-read (a quiet refresh covers the pages "Load more" added, too),
        // so a photo or price changed elsewhere shows within a minute however long the list is.
        const wanted = quiet ? Math.max(PAGE, (dataRef.current.items || []).length) : PAGE;
        let res, cursor = null;
        const all = [];
        try {
          do {
            res = await api.list(which, { ...(cursor ? { cursor } : {}), limit: Math.min(RELOAD_CHUNK, Math.max(PAGE, wanted - all.length)), group: groupFor(which, g) });
            if (!alive.current || seq !== loadSeq.current || key !== activeView.current) return;
            const have = new Set(all.map((i) => i.pid));
            all.push(...(res.items || []).filter((i) => !have.has(i.pid)));
            cursor = res.nextCursor || null;
          } while (cursor && all.length < wanted);
          res = { ...res, items: all, nextCursor: cursor };
        } catch (e) {
          if (!alive.current || seq !== loadSeq.current || key !== activeView.current) return;
          if (!quiet) { say(null, `Couldn't load: ${e?.message || e}`); setData((d) => ({ ...d, items: d.items || [] })); }
          return;
        }
        if (!alive.current || seq !== loadSeq.current || key !== activeView.current) return;
        // The list was read BEFORE a tap or a finished write: it must not paint over it.
        const overtaken = taps.current !== tapsAtStart || writes.current.size > 0;
        // …nor replace pages that "Load more" added while it was on its way.
        if (quiet && (overtaken || Object.keys(liveRef.current).length > 0 || (dataRef.current.items || []).length > wanted)) return;
        // With a list already on screen, an overtaken read is read again, and after
        // a few tries given up on (the screen is newer than it). With nothing on
        // screen yet — a list just opened — it is shown at once.
        if (!quiet && overtaken && dataRef.current.items) {
          if (round < FULL_LOAD_ROUNDS - 1) continue;
          return;
        }
        // A card that left is forgotten only once a list read AFTER its write finished is in hand
        // (and the Undo bar no longer holds it); until then it stays off the list, counts and all.
        for (const [pid, e] of [...gone.current]) if (e.settledAt != null && e.settledAt <= clockAtStart && !undoPids.current.has(pid)) gone.current.delete(pid);
        let next = {
          items: res.items || [], total: Number.isFinite(res.total) ? res.total : (res.items || []).length, nextCursor: res.nextCursor || null,
          tabCounts: res.tabCounts || {}, groupCounts: res.groupCounts || null, stats: res.stats || null,
          defaultMethod: res.defaultMethod === "split" ? "split" : res.defaultMethod === "full" ? "full" : dataRef.current.defaultMethod || null,
        };
        for (const [pid, e] of gone.current) next = withoutItem(next, pid, { group: e.group, toTab: e.toTab });
        setData(next);
        return;
      }
    } finally { if (!quiet) fullLoads.current -= 1; }
  }, [api, say]);
  /** Show what the server has now (after an answer that never arrived). */
  const reload = () => load(viewRef.current.tab, viewRef.current.group);

  const [loadingMore, setLoadingMore] = useState(false);
  const loadMore = async () => {
    if (!data.nextCursor || loadingMore) return;
    const key = viewKey(tab, group);
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const res = await api.list(tab, { cursor: data.nextCursor, limit: PAGE, group: groupFor(tab, group) });
      // Dropped if the view changed or the list was reloaded meanwhile (its cursor belongs to the old list).
      if (!alive.current || key !== activeView.current || seq !== loadSeq.current) return;
      setData((d) => {
        const have = new Set((d.items || []).map((i) => i.pid));
        return { ...d, items: [...(d.items || []), ...(res.items || []).filter((i) => !have.has(i.pid) && !gone.current.has(i.pid))], nextCursor: res.nextCursor || null };
      });
    } catch (e) {
      say(null, `Couldn't load more: ${e?.message || e}`);
    } finally { if (alive.current) setLoadingMore(false); }
  };

  useEffect(() => {
    setData((d) => ({ ...d, items: null, total: null, nextCursor: null, groupCounts: null }));
    // An Undo belongs to the list it was offered on.
    undoPids.current.clear();
    setUndo(null);
    load(tab, group);
    // The quiet refresh: every minute for a short list; a list longer than one page is re-read whole
    // only every LONG_LIST_EVERY minutes (each re-read costs the server a read per item) — and never
    // while the screen is not being looked at.
    let tick = 0;
    const t = setInterval(() => {
      tick += 1;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if ((dataRef.current.items || []).length > PAGE && tick % LONG_LIST_EVERY !== 0) return;
      load(tab, group, { quiet: true });
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [tab, group, load]);

  // ── instant taps ───────────────────────────────────────────────────────────
  // One item's writes run one after another (an Undo waits for its Skip). A
  // generation is NOT in this chain: a price saved while a photo is being made
  // is written at once.
  const write = (pid, fn) => {
    const prev = writes.current.get(pid) || Promise.resolve();
    const next = prev.then(fn, fn);
    writes.current.set(pid, next);
    const settled = () => {
      taps.current += 1;
      clock.current += 1;
      if (writes.current.get(pid) !== next) return;
      writes.current.delete(pid);
      const g = gone.current.get(pid);
      if (g) g.settledAt = clock.current;
    };
    next.then(settled, settled);
    return next;
  };
  /** Change one item — on the list, or (if its card has left) on the copy kept for its return. */
  const patch = (pid, fn) => {
    taps.current += 1;
    const g = gone.current.get(pid);
    if (g) g.item = fn(g.item);
    setData((d) => ({ ...d, items: (d.items || []).map((i) => (i.pid === pid ? fn(i) : i)) }));
  };

  /** Change the card now; write behind it; if the write fails, undo ONLY this tap's change and say why. */
  const instant = (item, change, revert, send, failed) => {
    patch(item.pid, change);
    write(item.pid, async () => {
      const out = await attempt(send, (r) => (r && r.ok === false ? r.error || "not saved" : null));
      if (out.ok || !alive.current) return;
      patch(item.pid, revert);
      if (out.refused) { say(item, `${failed} — ${out.refused}.`); return; }
      // No answer: it may have landed. The card is re-read rather than left guessing.
      say(item, `${failed}? No answer — the list is being refreshed to show what was saved.`);
      reload();
    });
  };

  // The function's own default (it comes with the list); Full Gemini until the list has said.
  const defaultMethod = data.defaultMethod || DEFAULT_METHOD;
  const h = { defaultMethod };

  // PRICES — the admin price save. "Retail below stock price" asks first, as the admin editor does.
  h.onSavePrices = api.savePrices ? (item, drafts) => {
    patch(item.pid, (i) => afterPrices(i, drafts));
    write(item.pid, async () => {
      let res;
      try {
        res = await api.savePrices(item.pid, item.product || {}, drafts);
        if (!res.ok && res.needsConfirm) {
          if (!ask(res.error)) { patch(item.pid, revertPrices(item, drafts)); return; }
          res = await api.savePrices(item.pid, item.product || {}, drafts, { confirmed: true });
        }
      } catch (e) {
        if (!alive.current) return;
        if (definite(e)) res = { ok: false, error: reason(e) };
        else {
          // No answer: the price may be saved. The card goes back and the list is re-read to show what the server has.
          patch(item.pid, revertPrices(item, drafts));
          say(item, "No answer to the price save — the list is being refreshed to show what was saved.");
          reload();
          return;
        }
      }
      if (!alive.current) return;
      if (!res.ok) { patch(item.pid, revertPrices(item, drafts)); say(item, `Prices not saved — ${reason({ message: res.error })}.`); return; }
      say(item, !res.count ? "No price changed." : res.specialsCheckSkipped ? "Prices saved (the specials check could not run)." : "Prices saved.");
    });
  } : null;

  // USE THIS ONE — that generation becomes the main photo; Approve then approves exactly it.
  h.onPick = api.select ? (item, genId) => instant(item, (i) => afterPick(i, genId), revertPick(item, genId), () => api.select(item.pid, genId), "Main photo not changed") : null;
  // ❤ — never moves or approves the item.
  h.onLove = api.love ? (item, genId, loved) => instant(item, (i) => afterLove(i, genId, loved, Date.now()), revertLove(item, genId), () => api.love(item.pid, genId, loved), loved ? "Not loved" : "Love not removed") : null;
  // THE METHOD for this item's next photo: Full Gemini or Split.
  h.onMethod = api.method ? (item, key) => instant(item, (i) => afterChoice(i, key), revertMethod(item, key), () => { const c = choiceToSet(key, defaultMethod); return api.method(item.pid, c.method, c.provider); }, "Choice not changed") : null;
  // FEEDBACK — one chip, noted against the photo shown; the item stays.
  h.onReject = api.reject ? (item, why) => {
    say(item, `Noted: ${why}.`);
    write(item.pid, async () => {
      const out = await attempt(() => api.reject(item.pid, why));
      if (!out.ok) say(item, `Feedback not saved — ${out.refused || "the server did not answer"}.`);
    });
  } : null;

  // The card leaves the list at once (Approve, Skip). Its copy is kept — later
  // reverts still reach it — and it returns only to the list it left.
  const leave = (item, toTab) => {
    taps.current += 1;
    const index = (dataRef.current.items || []).findIndex((i) => i.pid === item.pid);
    const entry = { item, index, toTab, view: activeView.current, group: viewRef.current.group };
    gone.current.set(item.pid, entry);
    setData((d) => withoutItem(d, item.pid, { group: entry.group, toTab }));
    return entry;
  };
  const comeBack = (entry) => {
    gone.current.delete(entry.item.pid);
    taps.current += 1;
    if (entry.view !== activeView.current) return;   // another list is shown now: it is on its own list when that is opened
    setData((d) => withItemBack(d, entry, { group: entry.group }));
  };

  // APPROVE — Junid's Approve is final, and it approves exactly the photo on the card.
  h.onApprove = (item) => {
    if (!actionsFor(item).approveEnabled || liveRef.current[item.pid] || isGenerating(item)) return;
    const genId = item.generations?.[currentGenId(item)]?.url ? currentGenId(item) : null;
    const entry = leave(item, "done");
    say(item, "Approved — it is under Done.");
    write(item.pid, async () => {
      const out = await attempt(() => api.approve([item.pid], genId ? { genId } : {}),
        (r) => ((r?.approved || []).includes(item.pid) ? null : r?.skipped?.[0]?.why || "not approved"));
      // "it is approved" = an earlier tap already landed: that is the approval, not a failure.
      if (out.ok || /^it is (approved|chaining|done)\b/.test(out.refused || "")) return;
      if (!alive.current) return;
      if (out.refused) { comeBack(entry); say(entry.item, `Not approved — ${out.refused}. It is back on the list.`); return; }
      // No answer: it may well be approved. Never claim it is not — show what the server has.
      say(item, "No answer to the Approve — the list is being refreshed to show where it is.");
      reload();
    });
  };

  // SKIP — gone at once, with ONE bar for 8 seconds; Undo brings every skipped item back.
  useEffect(() => {
    if (!undo) return undefined;
    const t = setTimeout(() => { undoPids.current.clear(); setUndo(null); }, UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  const dropUndo = (pid) => setUndo((cur) => {
    undoPids.current.delete(pid);
    const entries = (cur?.entries || []).filter((x) => x.item.pid !== pid);
    return entries.length ? { entries, text: `${entries.length} skipped — not advertised.` } : null;
  });
  h.onSkip = (item) => {
    if (liveRef.current[item.pid] || isGenerating(item)) return;
    const entry = leave(item, null);
    entry.skip = "pending";
    undoPids.current.add(item.pid);
    setUndo((cur) => {
      const entries = [...(cur?.entries || []).filter((e) => e.item.pid !== item.pid), entry];
      return { entries, text: `${entries.length} skipped — not advertised.` };
    });
    write(item.pid, async () => {
      const out = await attempt(() => api.skip([item.pid]), (r) => ((r?.skippedPids || []).includes(item.pid) ? null : r?.skipped?.[0]?.why || "not skipped"));
      if (out.ok || /^it is skipped\b/.test(out.refused || "")) { entry.skip = "done"; return; }
      entry.skip = "failed";
      if (!alive.current) return;
      dropUndo(item.pid);
      if (out.refused) { if (gone.current.get(item.pid) === entry) comeBack(entry); say(entry.item, `Not skipped — ${out.refused}. It is back on the list.`); return; }
      say(item, "No answer to the Skip — the list is being refreshed to show where it is.");
      reload();
    });
  };
  const onUndo = () => {
    if (!undo) return;
    const { entries } = undo;
    undoPids.current.clear();
    setUndo(null);
    // Back in their places at once — last skipped first, so each position is the
    // one it was taken from — then restored on the server.
    for (const entry of [...entries].reverse()) {
      if (gone.current.get(entry.item.pid) === entry) comeBack(entry);
      write(entry.item.pid, async () => {
        // The skip never landed: there is nothing to restore, and the card is already back.
        if (entry.skip !== "done") return;
        const out = await attempt(() => api.restore([entry.item.pid]), (r) => ((r?.restored || []).includes(entry.item.pid) ? null : r?.skipped?.[0]?.why || "not restored"));
        // "it is new" = it is already back (restored from elsewhere): that is the Undo, done.
        if (out.ok || !alive.current || /^it is (new|ready|rejected)\b/.test(out.refused || "")) return;
        if (out.refused) {
          // It IS skipped on the server: the card must not pretend otherwise.
          setData((d) => withoutItem(d, entry.item.pid, { group: entry.group, toTab: null }));
          say(entry.item, `Skip not undone — ${out.refused}. It stays skipped.`);
          return;
        }
        say(entry.item, "No answer to the Undo — the list is being refreshed to show where it is.");
        reload();
      });
    }
  };

  // GENERATE / REGENERATE — live, on the card. Its own lane: nothing else waits for it.
  h.onGenerate = (item) => {
    const pid = item.pid;
    if (liveRef.current[pid] || isGenerating(item)) return;
    taps.current += 1;
    liveRef.current = { ...liveRef.current, [pid]: liveStart(Date.now(), item.provider === "openai" ? "OpenAI" : "Gemini") };
    setLive(liveRef.current);
    // The item's OWN choice is sent; with none the function uses its default (Full Gemini).
    const method = item.method === "full" || item.method === "split" ? item.method : null;
    // …and its own engine (none = the default, Gemini).
    const provider = item.provider === "openai" || item.provider === "gemini" ? item.provider : null;
    (async () => {
      // The list is re-read AFTER the card has left its "generating" state (never during).
      let reread = false;
      try {
        const res = await api.generate(pid, { method, provider, onEvent: (ev) => { if (alive.current) setLive((l) => (l[pid] ? { ...l, [pid]: foldLive(l[pid], ev) } : l)); } });
        if (!alive.current) return;
        if (res?.addedOnly) {
          // The item had moved on while its photo was made (skipped or approved elsewhere).
          say(item, "The photo was made, but this item had moved on — it is kept in its history.");
          reread = true;
        } else if (res?.item) {
          const zar = Number(res.costZar);
          setData((d) => ({
            ...d, items: (d.items || []).map((i) => (i.pid === pid ? afterGenerated(i, res.item) : i)),
            stats: Number.isFinite(zar) && d.stats && Number.isFinite(Number(d.stats.totalSpentZar)) ? { ...d.stats, totalSpentZar: Number(d.stats.totalSpentZar) + zar } : d.stats,
          }));
          say(item, `${res.item.generations?.[res.genId]?.note ? `${res.item.generations[res.genId].note} ` : ""}Photo ready in ${Math.round(Number(res.seconds) || 0)}s${Number.isFinite(zar) ? ` · ${res.costEstimated ? "~" : ""}R${zar.toFixed(2)}` : ""}.`);
        }
      } catch (e) {
        if (!alive.current) return;
        if (definite(e) || /^No photo/.test(reason(e))) {
          say(item, `${reason(e)}.`);
          // Anything but "busy — tap again" means the item is not as the card shows it.
          reread = !/busy — tap Generate again/.test(reason(e));
        } else {
          // The connection dropped: the photo may still land. Never invite a second paid tap blind.
          say(item, "The connection dropped while the photo was being made — it may still arrive. The list is being refreshed.");
          reread = true;
        }
      } finally {
        taps.current += 1;
        if (alive.current) {
          liveRef.current = (({ [pid]: over, ...rest }) => rest)(liveRef.current);
          setLive((l) => { const { [pid]: over, ...rest } = l; void over; return rest; });
        }
      }
      if (reread && alive.current) reload();
    })();
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
  const floating = toasts.length > 0 || !!undo;
  return (
    // Room at the bottom for the messages: they never cover the last card's buttons.
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, padding: `14px 14px ${floating ? 230 : 96}px` }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <button onClick={onExit} style={{ ...bGray, minHeight: 40, padding: "0 12px" }} aria-label="Back">←</button>
          <div style={{ fontSize: 20, fontWeight: 800, flex: 1 }}>New Arrivals</div>
          <div data-testid="spent" style={{ color: GRAY, fontSize: 11 }}>{spentText(stats)}</div>
        </div>
        <div role="tablist" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} style={{ ...(tab === t.key ? tabOn : tabOff), flex: 1, minHeight: 40, padding: "0 14px" }}>
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
          <button disabled={loadingMore} onClick={loadMore} style={{ ...bGray, width: "100%", minHeight: 44, opacity: loadingMore ? 0.5 : 1 }}>
            {loadingMore ? "Loading…" : `Load more (${items.length} of ${data.total ?? "?"} shown)`}
          </button>
        )}
      </div>
      {floating && (
        <div style={{ position: "fixed", left: 14, right: 14, bottom: 14, zIndex: 50, display: "flex", flexDirection: "column", gap: 8, alignItems: "center", pointerEvents: "none" }}>
          {toasts.map((t) => (
            <div key={t.id} data-testid="toast" role="status" style={{ ...GLASS, background: "#0a0e18", maxWidth: 532, width: "100%", boxSizing: "border-box", padding: "11px 12px", fontSize: 14, color: "#fff" }}>{t.text}</div>
          ))}
          {undo && (
            <div data-testid="undo-toast" role="status" style={{ ...GLASS, background: "#0a0e18", maxWidth: 532, width: "100%", boxSizing: "border-box", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, fontSize: 14, color: "#fff", pointerEvents: "auto" }}>
              <div style={{ flex: 1 }}>{undo.text}</div>
              <button onClick={onUndo} style={{ ...bBlue, minHeight: 44, padding: "0 18px" }}>Undo</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
