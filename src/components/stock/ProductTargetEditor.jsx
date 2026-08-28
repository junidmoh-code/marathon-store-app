// ─── ONE PRODUCT, ONE LOCATION, EVERY SIZE ───────────────────────────────────
//
// "Keep 4 of size M at Trophy." The Seating tab could say where a product sits
// and switch a shop off; it could not say that, and neither could anything else
// on this card. This is the editor that says it.
//
// ── WHAT IS ON SCREEN, AND WHY EACH THING IS THERE ──────────────────────────
//   one row per size the ENGINE would arm here (seatingSizes — declared sizes,
//     cells and existing rows, plus the "_" cell a one-size policy speaks for)
//   on hand              what is actually on the shelf, per size
//   the ghost number     what the size resolves to with NO row of its own —
//                        the category policy, the footwear rule, the size run.
//                        It is the PLACEHOLDER, so a blank field visibly means
//                        "that number", not "nothing".
//   the input            blank = inherit, a number = an explicit row, 0 = off
//   Every size           one number into the whole run at once
//   Ask at               the location's, with the inherited value as its ghost
//
// ── SAVE WAITS FOR A PREVIEW, EXACTLY AS THE CATEGORY EDITOR DOES ───────────
// The preview is the server's dry run — the ENGINE's own resolveTarget, per
// size, before and after, against live data — and it is keyed on the numbers it
// was computed from. Any edit invalidates it. A preview of numbers no longer on
// screen is worse than no preview: it is a reassurance about something else.
//
// ── THE STANDING RULE OF THIS CARD APPLIES: NO PARAGRAPH ────────────────────
// Numbers, labels, chips and controls. The explanations live here.

import React, { useCallback, useMemo, useState } from "react";
import { saveProductTargets } from "./seatingStore";
import {
  overrideDraft, clearDraft, applyToAll, validateOverrideDraft, overridePlan,
  inheritedAt, whyLabel, numOrNull,
} from "./targetOverride";
import { GLASS, GRAY, GREEN, RED, AMBER, BLUE_L, bGreen, bGray, bGhost, input } from "./ui";

// The identity of the numbers a preview was computed from — AND OF THE WORLD IT
// WAS COMPUTED AGAINST. Save is enabled only while the preview in hand carries
// the key of what is currently on screen.
//
// The context is in the key because the preview's answer depends on it: the
// inherited numbers, the cells and the existing rows all come from the ctx, and
// Refresh replaces the whole thing. Without it, a preview taken before a
// refresh stayed "current" while the world underneath it had moved — a
// reassurance about a state that no longer exists, which is the one thing this
// key exists to prevent. (CodeRabbit, PR #497.)
export function ctxSig(ctx, loc, pid) {
  return JSON.stringify([ctx?.targets?.[loc]?.[pid] ?? null, ctx?.stock?.[loc]?.[pid] ?? null]);
}

export function draftKey(draft, sig = "") {
  const sizes = Object.keys(draft?.sizes || {}).sort()
    .map((k) => `${k}=${String(draft.sizes[k]?.target ?? "").trim()}`).join(",");
  return `${draft?.loc}::${draft?.pid}::${sizes}::rp=${String(draft?.reorderPoint ?? "").trim()}::${sig}`;
}

// `canWrite` is a belt to SeatingActions' braces: the tab does not render this
// editor at all for a viewer who may not write a target row (an editor whose
// every field is dead is worse than no editor). The prop keeps the refusal true
// of this component on its own, so a second mount site cannot lose it.
export default function ProductTargetEditor({ seat, ctx, label, onDone, onFail, canWrite = false }) {
  const { loc, pid } = seat;
  const [draft, setDraft] = useState(() => overrideDraft(ctx, loc, pid));
  const [everySize, setEverySize] = useState("");
  const [preview, setPreview] = useState(null);      // { key, model }
  const [busy, setBusy] = useState("");

  const errors = useMemo(() => validateOverrideDraft(draft), [draft]);
  const plan = useMemo(() => overridePlan(ctx, loc, pid, draft), [ctx, loc, pid, draft]);
  const keyNow = draftKey(draft, ctxSig(ctx, loc, pid));
  const stale = preview && preview.key !== keyNow;
  const saveable = canWrite && !busy && !Object.keys(errors).length && plan.dirty && preview && !stale;

  // What each size falls back to with no row of its own — the ghost number and
  // the "why". Computed once per render from the engine's own precedence.
  const inherited = useMemo(() => {
    const out = {};
    for (const k of Object.keys(draft.sizes)) out[k] = inheritedAt(ctx, loc, pid, k);
    return out;
  }, [ctx, loc, pid, draft.sizes]);

  const setSize = useCallback((k, v) => {
    setPreview(null);
    setDraft((d) => ({ ...d, sizes: { ...d.sizes, [k]: { ...d.sizes[k], target: v } } }));
  }, []);
  const setAll = useCallback((v) => {
    setPreview(null); setEverySize(v);
    setDraft((d) => applyToAll(d, v));
  }, []);
  const setRp = useCallback((v) => {
    setPreview(null);
    setDraft((d) => ({ ...d, reorderPoint: v }));
  }, []);

  const runPreview = async () => {
    if (busy || Object.keys(errors).length) return;
    const forKey = keyNow;
    setBusy("preview");
    try {
      // allowRemoveForeign on a DRY RUN only. A preview is a question, and
      // refusing to answer it until the owner has confirmed a removal would
      // mean asking for the confirmation before showing what it does. The SAVE
      // asks for itself, with the numbers named. (The server treats the flag as
      // permission to proceed, never as a decision that was made.)
      const res = await saveProductTargets({ ctx, loc, pid, draft, dryRun: true, allowRemoveForeign: true });
      if (!res.ok && res.reason === "no_change") { setPreview({ key: forKey, model: null, noChange: true }); return; }
      if (!res.ok) { onFail(res.message || res.reason); return; }
      setPreview({ key: forKey, model: res.preview });
    } catch (e) { onFail(e?.message || String(e)); }
    finally { setBusy(""); }
  };

  const save = async () => {
    if (!saveable) return;
    // ── A ROW THIS CARD DID NOT WRITE IS NAMED BEFORE IT GOES ────────────────
    // Somebody typed those numbers deliberately. Removing one is legal — that
    // is what an owner-facing editor is for — but never quietly, and never
    // without the numbers being on screen at the moment of the decision. The
    // server refuses it outright without this flag.
    let allowRemoveForeign = false;
    if (plan.foreign.length) {
      const lines = plan.foreign.map((f) => `  ${f.sizeKey === "_" ? "One size" : f.sizeKey}: keep ${f.prev?.target ?? "—"}`).join("\n");
      const ok = typeof window !== "undefined" && window.confirm
        ? window.confirm(`${plan.foreign.length} of these rows were not written from this screen:\n\n${lines}\n\n`
          + `Clearing them lets ${label} follow the category policy again. The numbers are kept in the policy history.\n\nGo ahead?`)
        : false;
      if (!ok) return;
      allowRemoveForeign = true;
    }
    setBusy("save");
    try {
      const res = await saveProductTargets({ ctx, loc, pid, draft, allowRemoveForeign });
      if (!res.ok) { onFail(res.message || FAILURES[res.reason] || res.reason); return; }
      const n = (res.changes || plan.changes).length;
      onDone(`${label} — ${n} ${n === 1 ? "size" : "sizes"} updated.`);
    } catch (e) { onFail(e?.message || String(e)); }
    finally { setBusy(""); }
  };

  const clear = async () => {
    if (busy || !canWrite) return;
    const cleared = clearDraft(ctx, loc, pid);
    const p = overridePlan(ctx, loc, pid, cleared);
    if (!p.dirty) {
      // A CLEAR WITH NOTHING TO DO AND A CLEAR THAT CANNOT ACT ARE DIFFERENT
      // THINGS. When every overridden size carries a captured row the live rule
      // would refuse, the plan is empty — and saying "nothing here is
      // overridden" while the rows sit there sends the owner looking for a
      // screen that does not exist. Name the rows instead. (CodeRabbit, #497.)
      onFail(p.stuck.length
        ? `${p.stuck.length} ${p.stuck.length === 1 ? "size has" : "sizes have"} a record this screen cannot restore — clear ${p.stuck.length === 1 ? "it" : "them"} size by size above, or leave ${p.stuck.length === 1 ? "it" : "them"} as ${p.stuck.length === 1 ? "it is" : "they are"}.`
        : "Nothing here is overridden — every size already follows the category.");
      return;
    }
    const foreign = p.foreign.length;
    const ok = typeof window !== "undefined" && window.confirm
      ? window.confirm(`${label} goes back to following the category policy on `
        + `${p.remove.length + p.restore.length} ${p.remove.length + p.restore.length === 1 ? "size" : "sizes"}.`
        + (foreign ? `\n\n${foreign} of those rows were not written from this screen.` : "")
        + `\n\nGo ahead?`)
      : false;
    if (!ok) return;
    setBusy("clear");
    try {
      const res = await saveProductTargets({ ctx, loc, pid, draft: cleared, allowRemoveForeign: foreign > 0 });
      if (!res.ok) { onFail(res.message || FAILURES[res.reason] || res.reason); return; }
      onDone(`${label} — override cleared.`);
    } catch (e) { onFail(e?.message || String(e)); }
    finally { setBusy(""); }
  };

  const keys = Object.keys(draft.sizes);
  const oneSize = keys.length === 1 && keys[0] === "_";
  const rpInherited = Object.values(inherited).find((i) => i && typeof i.reorderPoint === "number");

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,.08)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: ".85rem" }}>Targets here</div>
        {!oneSize && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: ".73rem", color: GRAY }}>
            Every size
            <input inputMode="numeric" value={everySize} onChange={(e) => setAll(e.target.value)}
              aria-label={`${label} — set every size`} disabled={!canWrite}
              style={{ ...input, width: 58, textAlign: "center", padding: "5px 4px", fontSize: ".8rem" }} />
          </label>
        )}
      </div>

      {/* ── the grid ── */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(48px,auto) 1fr 1fr 1fr", gap: 6, alignItems: "center" }}>
        <div style={HEAD}>Size</div>
        <div style={{ ...HEAD, color: BLUE_L }}>On hand</div>
        <div style={{ ...HEAD, color: GREEN }}>Keep</div>
        <div style={{ ...HEAD, color: GRAY }}>Now</div>
        {keys.map((k) => {
          const row = draft.sizes[k];
          const inh = inherited[k];
          return (
            <React.Fragment key={k}>
              <div style={{ fontSize: ".8rem", fontWeight: 600, color: GRAY }}>{row.label}</div>
              <div style={{ fontSize: ".82rem", textAlign: "center", color: row.onHand < 0 ? RED : row.onHand ? BLUE_L : GRAY }}>
                {row.onHand}
              </div>
              <input inputMode="numeric" value={row.target} onChange={(e) => setSize(k, e.target.value)}
                // THE GHOST IS THE INHERITED NUMBER. A blank field then reads as
                // "that number", which is what blank actually means — not as
                // nothing, and never as zero.
                placeholder={inh ? String(inh.target) : "—"}
                aria-label={`${label} ${row.label} keep`} disabled={!canWrite}
                style={{ ...input, textAlign: "center", padding: "6px 4px", minWidth: 0, width: "100%", fontSize: ".85rem",
                  border: errors[k] ? "1px solid rgba(248,113,113,.6)" : input.border }} />
              <div style={{ fontSize: ".72rem", color: GRAY, textAlign: "center" }}>
                {numOrNull(row.target) !== null ? "own row" : whyLabel(inh?.source)}
              </div>
              {errors[k] && <div style={{ gridColumn: "1 / -1", color: RED, fontSize: ".72rem" }}>{errors[k]}</div>}
            </React.Fragment>
          );
        })}
      </div>

      {/* ── the location's Ask at ── */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: ".78rem", color: GRAY }}>
        Ask at
        <input inputMode="numeric" value={draft.reorderPoint} onChange={(e) => setRp(e.target.value)}
          placeholder={rpInherited ? String(rpInherited.reorderPoint) : "—"}
          aria-label={`${label} ask at`} disabled={!canWrite}
          style={{ ...input, width: 64, textAlign: "center", padding: "6px 4px", fontSize: ".82rem" }} />
        <span style={{ fontSize: ".72rem" }}>blank follows the category</span>
      </label>
      {errors.reorderPoint && <div style={{ color: RED, fontSize: ".72rem", marginTop: 4 }}>{errors.reorderPoint}</div>}

      {/* ── the preview ── */}
      <div style={{ ...GLASS, padding: ".7rem .85rem", marginTop: 10 }}>
        <div style={{ fontWeight: 700, fontSize: ".8rem" }}>Next scan</div>
        {!preview || stale ? (
          <div style={{ color: GRAY, fontSize: ".78rem", marginTop: 4 }}>
            {stale ? "Numbers changed — preview again before saving."
              : plan.dirty ? "Preview before saving." : "Nothing changed yet."}
          </div>
        ) : preview.noChange ? (
          <div style={{ color: GRAY, fontSize: ".78rem", marginTop: 4 }}>These are the numbers already on the rows.</div>
        ) : (
          <>
            <div style={{ fontSize: ".78rem", color: "#e5e7eb", marginTop: 4 }}>
              {preview.model.changedSizes} {preview.model.changedSizes === 1 ? "size changes" : "sizes change"}
              {preview.model.retracts > 0 && ` · ${preview.model.retracts} open ${preview.model.retracts === 1 ? "refill retracts" : "refills retract"}`}
              {` · ${preview.model.unitsWanted} ${preview.model.unitsWanted === 1 ? "unit" : "units"} short after`}
            </div>
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {preview.model.sizes.filter((s) => s.changed).map((s) => (
                <span key={s.sizeKey} style={CHIP}>
                  {s.sizeKey === "_" ? "One size" : s.sizeKey.replace("_", ".")}{" "}
                  <b style={{ color: GRAY }}>{s.before === null ? "—" : s.before}</b>
                  {" → "}
                  <b style={{ color: s.after === null ? GRAY : s.after === 0 ? AMBER : GREEN }}>{s.after === null ? "—" : s.after}</b>
                </span>
              ))}
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <button onClick={runPreview} disabled={!!busy || !!Object.keys(errors).length || !plan.dirty}
            style={{ ...bGray, opacity: (busy || Object.keys(errors).length || !plan.dirty) ? .45 : 1 }}>
            {busy === "preview" ? "Working…" : preview && !stale ? "Preview again" : "Preview"}
          </button>
          <button onClick={save} disabled={!saveable} style={{ ...bGreen, opacity: saveable ? 1 : .35 }}>
            {busy === "save" ? "Saving…" : "Save targets"}
          </button>
          <button onClick={clear} disabled={!!busy || !canWrite} style={{ ...bGhost, opacity: busy ? .5 : 1 }}>
            {busy === "clear" ? "…" : "Clear override"}
          </button>
        </div>
      </div>

      {plan.stuck.length > 0 && (
        <div style={{ fontSize: ".72rem", color: AMBER, marginTop: 6 }}>
          {plan.stuck.length} {plan.stuck.length === 1 ? "row has" : "rows have"} a record this screen cannot restore — left as they are.
        </div>
      )}
    </div>
  );
}

const HEAD = { fontSize: ".66rem", textTransform: "uppercase", letterSpacing: ".05em", fontWeight: 700,
  color: GRAY, textAlign: "center" };
const CHIP = { fontSize: ".72rem", padding: "3px 8px", borderRadius: 999, background: "rgba(255,255,255,.05)",
  border: "1px solid rgba(255,255,255,.08)", whiteSpace: "nowrap" };

const FAILURES = {
  no_change: "nothing changed",
  drift: "these numbers changed while the screen was open — refresh and try again",
  confirm_foreign: "one of these rows was written elsewhere — confirm before clearing it",
  unsafe_key: "a size key could not be written safely",
  error: "the targets could not be written",
};
