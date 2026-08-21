// ─── ENGINE POLICY ────────────────────────────────────────────────────────────
// What each category keeps at every location, and when the engine asks for
// more. The owner-facing face of /config/refillEngine/categoryPolicy — the map
// that has, until now, only been editable by hand in the Firebase console.
//
// ── THE THREE THINGS THIS SCREEN IS TRYING TO PREVENT ────────────────────────
//
//   1. ARMING A STORE THAT DOES NOT CARRY THE CATEGORY. A mapped product is
//      managed at a mapped location UNCONDITIONALLY — refill-engine.cjs
//      managedPids has no carriage gate, deliberately, so a script-imported
//      perfume with no cell anywhere still resolves its buffer. The
//      consequence is that arming an uncarried store does not quietly do
//      nothing; it invents demand for EVERY product in the category at a shop
//      that has never stocked one. So "Not carried" is a refusal here, with its
//      own separate deliberate action, not a warning next to an editable box.
//
//   2. SAVING WITHOUT KNOWING WHAT THE NEXT SCAN WILL DO. Save stays disabled
//      until a preview has run against the values currently on screen, and any
//      edit invalidates it. A preview of numbers that are no longer displayed
//      is worse than none — it is a reassurance about something else.
//
//   3. NOT KNOWING THE EDIT WILL BE IGNORED. An explicit /stock_targets row
//      outranks the map. 79 fitted caps still carry introduce-existing letter
//      rows, and for those products these numbers do nothing at all. The row
//      says "N overridden" and the preview panel repeats it, because a map edit
//      that appears to do nothing is the most confusing thing this system does.
//
// ── ACCESS ───────────────────────────────────────────────────────────────────
// Super-admin only, through three independent gates: the home tile does not
// render (App.jsx), the route refuses to mount this component (App.jsx), and
// setCategoryPolicy re-checks the caller's email server-side. THE COMPONENT IS
// SPLIT so the default export holds ZERO hooks — a refused viewer must open no
// subscription and start no fetch, and a hook cannot live below a conditional
// return without changing the hook count between renders.
//
// NONE OF THAT IS A SECURITY BOUNDARY YET, and the precise reason matters
// because an earlier version of this comment
// asserted that the root RTDB rules were `auth !== null` for read AND write and
// that /config carried no tighter rule. That was never verified against
// anything: it was repeated from the brief this feature was built to, and BOTH
// the live rules AND the repo's own database.rules.json already said otherwise.
// Checked 2026-08-21 via /.settings/rules.json:
//
//   • no root ".read" and no root ".write" at all — unmatched paths DENY
//   • /config          ".read":  auth != null && sign_in_provider != 'anonymous'
//   • /config/refillEngine ".write": …the same, AND
//     root.child('users').child(auth.uid).child('stockRole').val() === 'admin'
//
// So the policy node is writable by any stockRole 'admin' account — four of
// them on the live /users node today (Ibrahim, Ahmed, Mike, 2POS) — not by
// every signed-in staff member, and not by nobody.
//
// So the policy node is writable today by four staff accounts, bypassing all
// three gates. The console rule printed by scripts/print-engine-policy-rule.mjs
// narrows those four to one; it is not live. Do not describe these gates as
// security until it is.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT, BG, CARD, BORDER, GLASS, RADIUS, GRAY, GREEN, RED, AMBER, BLUE, BLUE_L, bGreen, bGray, bGhost, bRed, input } from "./ui";
import {
  COLUMN_LABELS, FIELD_ORDER, armedLocations, editorRows, draftFromEntry, seedLocation,
  onTargetChanged, policyFromDraft, validateDraft, previewKey, canSave, changedFields,
  nextScanAt, previewVerdict, lastChange, defaultMinQty,
} from "./enginePolicyCore";
import { serverNowMs } from "../../utils/serverTime";
import { enginePolicyVisibleForViewer } from "../../config/enginePolicy";

const setCategoryPolicyFn = () => httpsCallable(functions, "setCategoryPolicy");

const LOC_LABELS = { hub2: "Hub 2", hub1: "Hub 1", hub3: "Hub 3", central: "Central", "marathon-pe": "Marathon PE", "marathon-pine": "Marathon Pine", trophy: "Trophy" };
const locLabel = (l) => LOC_LABELS[l] || l;

// A glyph per category, chosen from the taxonomy key. Deliberately a lookup
// with a plain fallback rather than anything clever — a wrong-but-confident
// icon is worse than a neutral one.
const ICONS = {
  "caps-beanies": "🧢", "fitted-caps": "🧢", visors: "🧢", perfumes: "🌸", bags: "👜", belts: "🎗️",
  "t-shirts": "👕", hoodies: "🧥", jackets: "🧥", pants: "👖", shorts: "🩳", sneakers: "👟",
  slides: "🩴", "soccer-boots": "⚽", "soccer-jerseys": "👕", tracksuits: "🎽", "ladies-tracksuits": "🎽",
  watches: "⌚", sunglasses: "🕶️", "chains-bracelets": "📿", underwear: "🩲", dresses: "👗",
  suits: "🤵", shirts: "👔", "golf-t-shirts": "👕", "baseball-shirts": "👕", "basketball-vests": "🎽",
  gloves: "🧤", "designer-shoes": "👞", boots: "🥾", "cargo-pants": "👖",
};
const iconFor = (k) => ICONS[k] || "📦";

const fmtWhen = (ms) => {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return d.toLocaleString("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
};

// ═════════════════════════════════════════════════════════════════════════════
// GATE 2b — THE COMPONENT'S OWN CHECK, AND WHY IT HOLDS NO HOOKS
// ═════════════════════════════════════════════════════════════════════════════
// This is the whole default export. It has no useState, no useEffect and opens
// nothing, so a viewer who is refused causes not one read, not one callable
// invocation, and no listener. That is the point of the split: an early
// `return` placed after the hooks would still have run them, and a hook cannot
// be moved below a conditional return without changing the hook count between
// renders and crashing React.
//
// The route mount in App.jsx checks the same condition independently and never
// renders this component for a non-super-admin. Both layers are real; neither
// relies on the other. Deleting either one must fail tests — see
// scripts/mutation-proof-engine-policy.mjs (M-TILE, M-ROUTE, M-COMPONENT).
export default function EnginePolicyCard({ viewer, onExit }) {
  if (!enginePolicyVisibleForViewer(viewer)) return <Refused onExit={onExit} />;
  return <EnginePolicyAuthed viewer={viewer} onExit={onExit} />;
}

function Refused({ onExit }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "2rem 1rem" }}>
      <div style={{ ...GLASS, maxWidth: 420, margin: "12vh auto", padding: "1.5rem" }}>
        <div style={{ fontSize: "1.05rem", fontWeight: 700 }}>Engine Policy is owner-only</div>
        <div style={{ marginTop: ".6rem", color: GRAY, fontSize: ".9rem", lineHeight: 1.5 }}>
          These settings decide what every shop keeps on its shelves. They are not
          part of any staff role.
        </div>
        <button onClick={onExit} style={{ ...bGhost, marginTop: "1.2rem" }}>Back</button>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Everything below runs ONLY for a verified super-admin.
// ═════════════════════════════════════════════════════════════════════════════
function EnginePolicyAuthed({ viewer, onExit }) {
  const [census, setCensus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState("");     // expanded category
  const [draft, setDraft] = useState({});
  const [preview, setPreview] = useState(null);   // { key, model, changes }
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState(null);         // { kind, text }

  // The timer is held and cleared, rather than fired and forgotten. Two real
  // consequences of the naive version: a second message inside the window
  // inherited the first one's timer and vanished early, and an unmount left a
  // pending setNote to run against a dead tree.
  const flashTimer = useRef(null);
  const flash = useCallback((kind, text) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setNote({ kind, text });
    flashTimer.current = setTimeout(() => { flashTimer.current = null; setNote(null); }, 7000);
  }, []);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // ONE call, on mount, for the whole list. The counts it returns are derived
  // from /products and /stock, and a browser that read those would download the
  // catalogue and the stock tree onto a phone on a shop network at the owner's
  // expense — so the server pages them and sends back a few kilobytes.
  //
  // A warm function instance reuses its last answer for two minutes. `refresh`
  // is the owner asking for the truth right now; a save drops the cache
  // server-side, so this is never needed to see one's own change.
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError("");
    try {
      const res = await setCategoryPolicyFn()(refresh ? { action: "census", refresh: true } : { action: "census" });
      setCensus(res.data);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const categories = useMemo(() => {
    const list = census?.categories || [];
    // Armed first (they are what somebody came to change), then anything with
    // products, then the empty rest — alphabetical inside each band.
    return [...list].sort((a, b) => {
      const band = (c) => (c.armed?.length ? 0 : c.products > 0 ? 1 : 2);
      return band(a) - band(b) || String(a.label).localeCompare(String(b.label));
    });
  }, [census]);

  const open = categories.find((c) => c.key === openKey) || null;
  const destinations = census?.destinations || [];
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const keyNow = useMemo(() => previewKey(openKey, draft, { perSize: open?.perSize }), [openKey, draft, open]);
  const proposed = useMemo(() => policyFromDraft(draft, { perSize: open?.perSize }), [draft, open]);
  const banner = useMemo(() => changedFields(open?.entry || null, proposed), [open, proposed]);
  const saveable = canSave({ preview, previewKeyNow: keyNow, errors, busy: !!busy });
  const scan = nextScanAt(serverNowMs());
  const stamp = lastChange(census?.history);

  const expand = (c) => {
    if (openKey === c.key) { setOpenKey(""); setPreview(null); return; }
    setOpenKey(c.key);
    setPreview(null);
    setDraft(draftFromEntry({ entry: c.entry, carriage: c.carriage, destinations }));
  };

  const setField = (loc, field, value) => {
    setPreview(null);   // belt to the previewKey's braces: any edit invalidates
    setDraft((d) => {
      const row = d[loc] || seedLocation(null);
      return { ...d, [loc]: field === "target" ? onTargetChanged(row, value) : { ...row, [field]: value } };
    });
  };

  // Arming a store that does not carry the category is its own deliberate act,
  // with its own confirmation, because it invents demand rather than adjusting
  // it. See the header note.
  const armStore = (loc, carries) => {
    if (!carries) {
      const ok = window.confirm(
        `${locLabel(loc)} does not stock ${open?.label} today.\n\n` +
        `Arming it tells the engine to keep this category there — it will start asking ` +
        `for every product in the category at ${locLabel(loc)}, not only ones it has sold.\n\n` +
        `Arm it anyway?`);
      if (!ok) return;
    }
    setPreview(null);
    setDraft((d) => ({ ...d, [loc]: seedLocation(open?.entry?.[loc]?.target ?? null) }));
  };

  const dropStore = (loc) => {
    setPreview(null);
    setDraft((d) => { const n = { ...d }; delete n[loc]; return n; });
  };

  const runPreview = async () => {
    if (busy || Object.keys(errors).length) return;
    setBusy("preview");
    const forKey = keyNow;
    try {
      const res = await setCategoryPolicyFn()({ categoryKey: openKey, policy: proposed, dryRun: true });
      // The preview is stamped with the key of the values it was computed FROM.
      // If the owner edited a field while it was in flight, this preview is
      // about numbers that are no longer on screen and must not enable Save.
      setPreview({ key: forKey, model: res.data.preview.after, before: res.data.preview.before, changes: res.data.changes });
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!saveable) return;
    setBusy("save");
    try {
      const res = await setCategoryPolicyFn()({
        categoryKey: openKey,
        policy: proposed,
        // The exact entry this editor was opened on. The server refuses the
        // write if live no longer matches it, so a change somebody else made
        // while this was open is never silently discarded.
        expectedBefore: open?.entry ?? null,
      });
      if (res.data.noChange) { flash("ok", "Nothing to save — these are the numbers already live."); }
      else flash("ok", `Saved. The next scan (${scan.label}) uses these numbers.`);
      setPreview(null);
      setOpenKey("");
      await load();
    } catch (e) {
      flash("bad", e?.message || String(e));
      if (/changed while/i.test(e?.message || "")) await load();
    } finally {
      setBusy("");
    }
  };

  const revert = async (h) => {
    if (busy) return;
    const ok = window.confirm(
      `Put ${h.categoryKey} back to how it was before this change?\n\n` +
      (h.changes || []).map((c) => `  ${c.loc || ""} ${c.field}: ${c.to ?? "not set"} -> ${c.from ?? "not set"}`).join("\n"));
    if (!ok) return;
    setBusy("revert");
    try {
      // The live value is re-read by the server; passing it here as
      // expectedBefore would be asserting something this list may no longer
      // know. `h.after` is what THIS change produced — if live has moved on
      // since, the server's own drift check refuses, which is the right answer.
      await setCategoryPolicyFn()({ categoryKey: h.categoryKey, policy: h.before ?? null, expectedBefore: h.after ?? null });
      flash("ok", `${h.categoryKey} put back to how it was on ${fmtWhen(h.at)}.`);
      // Close the editor, exactly as save does. Leaving it open kept the
      // PRE-revert draft on screen against the refreshed entry, so the
      // changed-fields banner reported edits the owner never made and the row
      // values no longer matched live.
      setOpenKey("");
      setDraft({});
      setPreview(null);
      await load();
    } catch (e) {
      flash("bad", e?.message || String(e));
    } finally {
      setBusy("");
    }
  };

  // ── RENDER ────────────────────────────────────────────────────────────────
  const armedCount = categories.filter((c) => armedLocations(c.entry).length).length;

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: FONT, color: "#fff", padding: "1rem 1rem 4rem" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: "1rem" }}>
          <div style={{ flex: 1 }}>
            <h1 style={{ margin: 0, fontSize: "1.35rem", fontWeight: 700 }}>Engine Policy</h1>
            <div style={{ marginTop: 6, color: GRAY, fontSize: ".92rem", lineHeight: 1.45 }}>
              What each category keeps at every location, and when the engine asks for more
            </div>
            <div style={{ marginTop: 6, color: "#6b7280", fontSize: ".8rem" }}>
              {stamp
                ? `Last changed ${fmtWhen(stamp.at)} by ${stamp.by} — ${stamp.categoryKey}`
                : "No changes recorded yet"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => load(true)} disabled={loading} style={{ ...bGhost, opacity: loading ? .5 : 1 }}>
              {loading ? "…" : "Refresh"}
            </button>
            <button onClick={onExit} style={bGhost}>Back</button>
          </div>
        </div>

        {note && (
          <div style={{ ...GLASS, padding: ".8rem 1rem", marginBottom: "1rem",
            border: `1px solid ${note.kind === "ok" ? "rgba(74,222,128,.45)" : "rgba(248,113,113,.45)"}`,
            color: note.kind === "ok" ? GREEN : RED, fontSize: ".9rem" }}>{note.text}</div>
        )}

        {/* Three summary tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10, marginBottom: "1.2rem" }}>
          <Tile label="Armed categories" value={loading ? "…" : `${armedCount} of ${categories.length}`}
            sub="the rest fall through to the engine's own rules" />
          <Tile label="Next scan" value={scan.at ? scan.label : "—"}
            sub={scan.at ? "every 15 min, 07:00–19:00" : scan.label} />
          <Tile label="Refills per scan" value={census?.cap ?? "…"}
            sub="shared across every clothing category" />
        </div>

        {loading && <div style={{ color: GRAY, padding: "2rem 0" }}>Reading the policy…</div>}
        {error && (
          // A failed read used to hide the entire list with no way back except
          // leaving the screen and returning — on a shop network, where a
          // dropped call is the common case, not the rare one.
          <div style={{ ...GLASS, padding: "1rem", border: "1px solid rgba(248,113,113,.45)" }}>
            <div style={{ color: RED, fontSize: ".9rem" }}>Could not read the policy: {error}</div>
            <button onClick={() => load(true)} style={{ ...bGray, marginTop: ".8rem" }}>Try again</button>
          </div>
        )}

        {!loading && !error && categories.map((c) => {
          const armed = armedLocations(c.entry);
          const isOpen = openKey === c.key;
          return (
            <div key={c.key} style={{ ...GLASS, marginBottom: 10, overflow: "hidden" }}>
              {/* The expand control is a REAL BUTTON — it is the only way into
                  the editor, and as a div with onClick the entire feature was
                  unreachable without a pointer.
                  It is a sibling of StateChip rather than wrapping it, because
                  an unarmed row's chip contains its own "Set policy" button and
                  a button inside a button is invalid. Styled back down to look
                  like the row it replaced. */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: ".9rem 1rem" }}>
              <button type="button" onClick={() => expand(c)}
                aria-expanded={isOpen} aria-label={`${c.label} — ${isOpen ? "collapse" : "expand"} policy`}
                style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer",
                  flex: 1, minWidth: 0, textAlign: "left", background: "transparent", border: "none",
                  color: "inherit", font: "inherit", padding: 0 }}>
                <div style={{ fontSize: "1.4rem" }}>{iconFor(c.key)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: "1rem" }}>{c.label}</div>
                  <div style={{ color: GRAY, fontSize: ".8rem", marginTop: 2 }}>
                    {c.products} {c.products === 1 ? "product" : "products"} · {c.units} on hand · {c.perSize ? "per size" : "one size"}
                    {c.legacyRowProducts > 0 && (
                      // NOT the override chip. A legacy row sits on a size this
                      // map does not speak for, so it contradicts nothing here —
                      // but the engine still walks it and it still produces
                      // refills. Saying "overridden" would have read as "your
                      // numbers are ignored", which is false.
                      <span style={{ color: "#6b7280" }}> · {c.legacyRowProducts} with old sized rows</span>
                    )}
                  </div>
                </div>
              </button>
                <StateChip category={c} armed={armed} onSetPolicy={() => expand(c)} />
              </div>

              {isOpen && (
                <div style={{ borderTop: BORDER, padding: "1rem", background: "rgba(0,0,0,.25)" }}>
                  <Editor
                    category={c} destinations={destinations} draft={draft} errors={errors}
                    onField={setField} onArm={armStore} onDrop={dropStore}
                  />

                  {banner.length > 0 && (
                    <div style={{ marginTop: "1rem", padding: ".8rem 1rem", borderRadius: RADIUS,
                      background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.35)" }}>
                      <div style={{ color: AMBER, fontWeight: 700, fontSize: ".85rem", marginBottom: 6 }}>
                        {banner.length} {banner.length === 1 ? "change" : "changes"} not yet saved
                      </div>
                      {banner.map((ch, i) => (
                        <div key={i} style={{ fontSize: ".85rem", color: "#e5e7eb", lineHeight: 1.6 }}>
                          <b>{locLabel(ch.loc)}</b> — {ch.text || `${ch.label}: ${ch.from} -> ${ch.to}`}
                        </div>
                      ))}
                    </div>
                  )}

                  <PreviewPanel
                    preview={preview} keyNow={keyNow} cap={census?.cap}
                    busy={busy} category={c}
                  />

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: "1rem" }}>
                    <button onClick={save} disabled={!saveable}
                      style={{ ...bGreen, opacity: saveable ? 1 : .35, cursor: saveable ? "pointer" : "default" }}>
                      {busy === "save" ? "Saving…" : "Save policy"}
                    </button>
                    <button onClick={runPreview} disabled={!!busy || !!Object.keys(errors).length}
                      style={{ ...bGray, opacity: busy || Object.keys(errors).length ? .5 : 1 }}>
                      {busy === "preview" ? "Working…" : preview && preview.key === keyNow ? "Preview again" : "Preview"}
                    </button>
                    {c.overriddenProducts > 0 && (
                      <ClearRowsButton category={c} />
                    )}
                    <button onClick={() => { setOpenKey(""); setPreview(null); }} style={bGhost}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        <History entries={census?.history} onRevert={revert} busy={busy} />

        <div style={{ marginTop: "2rem", color: "#4b5563", fontSize: ".75rem", lineHeight: 1.6 }}>
          These numbers are read live by the refill engine — no deploy, no restart.
          Deleting a category's policy entirely puts it back on the engine's own rules.
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div style={{ ...GLASS, padding: ".85rem 1rem" }}>
      <div style={{ color: GRAY, fontSize: ".75rem", textTransform: "uppercase", letterSpacing: ".04em" }}>{label}</div>
      <div style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4 }}>{value}</div>
      <div style={{ color: "#6b7280", fontSize: ".75rem", marginTop: 2 }}>{sub}</div>
    </div>
  );
}

// The right-hand state. Three, and the middle one is the reason this screen
// exists: an armed category whose products still carry their own rows is armed
// in name only for those products.
function StateChip({ category, armed, onSetPolicy }) {
  if (!armed.length) {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
        <span style={{ color: "#4b5563", fontSize: ".8rem" }}>No policy</span>
        {/* A real button, not a styled span: this is the primary action on an
            unarmed row, and it has to be reachable by keyboard and announced as
            an action. The row is click-to-expand too, so the button stops the
            event rather than firing the same handler twice. */}
        <button type="button" onClick={(e) => { e.stopPropagation(); onSetPolicy(); }}
          style={{ ...bGray, padding: "6px 12px", fontSize: ".75rem" }}>Set policy</button>
      </span>
    );
  }
  if (category.overriddenProducts > 0) {
    return (
      <span style={{ color: AMBER, fontSize: ".8rem", fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" }}>
        {category.overriddenProducts} overridden
        <div style={{ color: "#6b7280", fontWeight: 500, fontSize: ".72rem" }}>
          {armed.map((l) => `${locLabel(l)} ${category.entry[l].target}`).join(" · ")}
        </div>
      </span>
    );
  }
  return (
    <span style={{ color: GREEN, fontSize: ".8rem", fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" }}>
      Armed
      <div style={{ color: "#6b7280", fontWeight: 500, fontSize: ".72rem" }}>
        {armed.map((l) => `${locLabel(l)} ${category.entry[l].target}`).join(" · ")}
      </div>
    </span>
  );
}

function Editor({ category, destinations, draft, errors, onField, onArm, onDrop }) {
  const rows = editorRows({ entry: category.entry, carriage: category.carriage, destinations });
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(3, 80px) 80px", gap: 8, alignItems: "center",
        color: GRAY, fontSize: ".72rem", textTransform: "uppercase", letterSpacing: ".04em", marginBottom: 6 }}>
        <div>Location</div>
        {FIELD_ORDER.map((f) => <div key={f} style={{ textAlign: "center" }}>{COLUMN_LABELS[f]}</div>)}
        <div />
      </div>
      {rows.map((r) => {
        const inDraft = !!draft[r.loc];
        return (
          <div key={r.loc}>
            <div style={{ display: "grid", gridTemplateColumns: "1.4fr repeat(3, 80px) 80px", gap: 8, alignItems: "center", padding: "5px 0" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: ".92rem" }}>{locLabel(r.loc)}</div>
                <div style={{ color: r.carries ? "#6b7280" : AMBER, fontSize: ".72rem" }}>
                  {r.carries ? `${r.productsCarried} carried · ${r.unitsHeld} units` : "Not carried"}
                </div>
              </div>
              {inDraft ? FIELD_ORDER.map((f) => (
                <input key={f} inputMode="numeric" value={draft[r.loc]?.[f] ?? ""}
                  onChange={(e) => onField(r.loc, f, e.target.value)}
                  placeholder={f === "reorderPoint" ? "—" : ""}
                  aria-label={`${locLabel(r.loc)} ${COLUMN_LABELS[f]}`}
                  style={{ ...input, textAlign: "center", padding: "8px 6px",
                    border: errors[r.loc] ? "1px solid rgba(248,113,113,.6)" : input.border }} />
              )) : <div style={{ gridColumn: "span 3", color: "#4b5563", fontSize: ".82rem", textAlign: "center" }}>
                {r.carries ? "not stocked by the engine here" : "this store does not stock this category"}
              </div>}
              <div style={{ textAlign: "right" }}>
                {inDraft
                  ? <button onClick={() => onDrop(r.loc)} style={{ ...bGhost, padding: "6px 10px", fontSize: ".75rem" }}>Remove</button>
                  : <button onClick={() => onArm(r.loc, r.carries)}
                      style={{ ...(r.carries ? bGray : bRed), padding: "6px 10px", fontSize: ".75rem" }}>
                      {r.carries ? "Stock here" : "Arm this store"}
                    </button>}
              </div>
            </div>
            {errors[r.loc] && <div style={{ color: RED, fontSize: ".78rem", padding: "0 0 6px" }}>{errors[r.loc]}</div>}
          </div>
        );
      })}
      <div style={{ marginTop: 10, color: "#4b5563", fontSize: ".75rem", lineHeight: 1.5 }}>
        <b>Keep</b> is the shelf target. <b>Minimum</b> only decides which refill cards
        show as urgent. <b>Ask at</b> holds the request back until the shelf drops to
        that number — leave it blank to top up as soon as anything sells.
      </div>
    </div>
  );
}

function PreviewPanel({ preview, keyNow, cap, busy, category }) {
  const stale = preview && preview.key !== keyNow;
  if (!preview || stale) {
    return (
      <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS, background: "rgba(255,255,255,.02)", border: BORDER }}>
        <div style={{ fontWeight: 700, fontSize: ".9rem" }}>What happens on the next scan</div>
        <div style={{ color: GRAY, fontSize: ".85rem", marginTop: 6, lineHeight: 1.5 }}>
          {stale
            ? "These numbers changed since the last preview. Run it again before saving."
            : busy === "preview" ? "Working it out…" : "Run a preview to see what the next scan would do. Save stays off until you have."}
        </div>
      </div>
    );
  }
  const m = preview.model;
  return (
    <div style={{ marginTop: "1rem", padding: ".9rem 1rem", borderRadius: RADIUS,
      background: "rgba(74,127,255,.06)", border: "1px solid rgba(74,127,255,.3)" }}>
      <div style={{ fontWeight: 700, fontSize: ".9rem", color: BLUE_L }}>What happens on the next scan</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10, margin: ".8rem 0" }}>
        <Stat label="Refills asked for" value={m.totalRequests} of={cap != null ? `of ${cap} per scan` : ""} warn={cap != null && m.totalRequests > cap} />
        <Stat label="Units wanted" value={m.totalUnits} of={`Central holds ${m.centralOnHand}`} warn={m.totalUnits > m.centralOnHand} />
        <Stat label="On their own rows" value={m.overriddenProducts} of="ignore these numbers" warn={m.overriddenProducts > 0} />
      </div>
      <div style={{ fontSize: ".86rem", lineHeight: 1.55, color: "#e5e7eb" }}>
        {previewVerdict(m, { cap })}
      </div>
      <div style={{ marginTop: ".7rem", fontSize: ".75rem", color: "#4b5563", lineHeight: 1.5 }}>
        This is a ceiling. The scan holds back anything already on its way, anything a
        shop recently said no to, and anything over the per-scan limit — so it can ask
        for less than this, never more.
        {category.overriddenProducts > 0 && ` ${category.overriddenProducts} products in this category are governed by their own rows and are unaffected by any of these numbers.`}
        {category.legacyRowProducts > 0 && ` A further ${category.legacyRowProducts} carry old rows on sizes this policy does not cover — those keep refilling on their own numbers, and the counts above include them.`}
      </div>
    </div>
  );
}

function Stat({ label, value, of, warn }) {
  return (
    <div>
      <div style={{ fontSize: "1.4rem", fontWeight: 700, color: warn ? AMBER : "#fff" }}>{value}</div>
      <div style={{ color: GRAY, fontSize: ".75rem" }}>{label}</div>
      {of && <div style={{ color: "#4b5563", fontSize: ".72rem" }}>{of}</div>}
    </div>
  );
}

// ── "Clear the N old rows" ───────────────────────────────────────────────────
// Explicit /stock_targets rows outrank the map, so clearing them is what makes
// a map edit actually reach those products. It is NOT built here: deleting
// hundreds of target rows is a stock-affecting bulk mutation of a different
// class from editing a config key, and it needs its own preview, its own batch
// id and its own rollback file — the same treatment every other bulk row change
// in this repo gets (scripts/targets, the headwear collapse, the bags collapse).
//
// Shipping the button with a stub would be worse than not shipping it: it looks
// like the safe path and is the most destructive action on the screen. So it
// says what it is and points at the evidence instead.
function ClearRowsButton({ category }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <button onClick={() => setShow((s) => !s)} style={{ ...bGray }}>
        Clear the {category.overriddenProducts} old rows
      </button>
      {show && (
        <div style={{ ...GLASS, padding: "1rem", marginTop: ".8rem", width: "100%",
          border: "1px solid rgba(251,191,36,.4)" }}>
          <div style={{ color: AMBER, fontWeight: 700, fontSize: ".88rem" }}>Not from this screen</div>
          <div style={{ color: "#d1d5db", fontSize: ".84rem", lineHeight: 1.55, marginTop: 6 }}>
            {category.overriddenCells} explicit rows on {category.overriddenProducts} products
            outrank this policy. Removing them is a bulk change to /stock_targets, not a
            config edit — it needs its own preview and its own rollback file, the same as
            every other bulk row change.
            <br /><br />
            Run <code style={{ color: BLUE_L }}>node scripts/model-category-policy.mjs CATEGORY={category.key}</code> to
            see exactly which rows they are, then clear them with a reviewed script.
          </div>
        </div>
      )}
    </>
  );
}

function History({ entries, onRevert, busy }) {
  const list = (entries || []).slice(0, 15);
  if (!list.length) return null;
  return (
    <div style={{ marginTop: "2rem" }}>
      <div style={{ color: GRAY, fontSize: ".78rem", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 8 }}>
        Change history
      </div>
      {list.map((h) => (
        <div key={h.id} style={{ ...GLASS, padding: ".7rem 1rem", marginBottom: 6, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: ".88rem", fontWeight: 600 }}>
              {h.categoryKey}
              {h.status !== "applied" && (
                <span style={{ color: h.status === "aborted_on_drift" ? AMBER : RED, fontWeight: 700, fontSize: ".72rem", marginLeft: 8 }}>
                  {h.status === "aborted_on_drift" ? "not applied — changed underneath" : h.status}
                </span>
              )}
            </div>
            <div style={{ color: "#6b7280", fontSize: ".75rem", marginTop: 2 }}>
              {fmtWhen(h.at)} · {h.by} · {(h.changes || []).map((c) =>
                `${c.loc || ""} ${c.field} ${c.from ?? "not set"} -> ${c.to ?? "not set"}`).join(", ") || "no field changes"}
            </div>
          </div>
          {h.status === "applied" && (
            <button onClick={() => onRevert(h)} disabled={!!busy}
              style={{ ...bGhost, padding: "6px 10px", fontSize: ".75rem", opacity: busy ? .5 : 1 }}>Revert</button>
          )}
        </div>
      ))}
    </div>
  );
}

export { defaultMinQty };
