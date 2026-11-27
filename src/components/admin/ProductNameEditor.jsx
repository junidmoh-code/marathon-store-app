// ─── THE PRODUCT NAME: READ-ONLY, THEN EDIT → SAVE / CANCEL (Junid, 27 Nov 2026)
//
// On the Admin product page the name used to be a bare input that saved on
// blur. On Junid's iPhone there was no visible way to save and an edit was
// easily lost. Now:
//   · the name shows read-only with an Edit button;
//   · Edit makes it editable with Save and Cancel; Save is disabled while the
//     name is unchanged, blank, or another product's name (that product named);
//   · Save shows "Saving…", then "Saved." or the reason it failed; Cancel puts
//     the old name back and writes nothing.
// The write goes through productSave.renameProduct → the setProductName
// callable: the same permission rule as Type, one multi-path write, and a log
// entry for every rename (functions/lib/product-rename.cjs).
import { useEffect, useState } from "react";
import { renameProduct, renameRefusal } from "./productSave";

// The search-identity seed runs before the rename (updateProductName's order).
// It is a database transaction that never settles while the line is down, so
// it gets this long; past it, the save stops with a message and nothing sent.
export const BEFORE_SAVE_LIMIT_MS = 8000;

export function ProductNameEditor({ product, allProducts, call, deviceId = null, buildExtras = null, beforeSave = null, beforeSaveLimitMs = BEFORE_SAVE_LIMIT_MS }) {
  const [editing, setEditing] = useState(false);
  // The name as it was when Edit was tapped: what the server compares against.
  const [baseName, setBaseName] = useState(product.name || "");
  const [draft, setDraft] = useState(product.name || "");
  const [status, setStatus] = useState(null); // { kind: "saving"|"saved"|"error", text }
  useEffect(() => { if (!editing) setDraft(product.name || ""); }, [product.name, editing]);

  const trimmed = draft.trim();
  const changed = trimmed !== "" && trimmed !== (product.name || "");
  const blocked = editing && trimmed !== (product.name || "") ? renameRefusal({ product, draft, allProducts }) : null;
  const saving = status?.kind === "saving";
  const canSave = changed && !blocked && !saving;

  const start = () => { setDraft(product.name || ""); setBaseName(product.name || ""); setStatus(null); setEditing(true); };
  const cancel = () => { setDraft(product.name || ""); setStatus(null); setEditing(false); };
  const save = async () => {
    if (!canSave) return;
    // Someone else renamed it while this was open: say so, never overwrite.
    if ((product.name || "") !== baseName) {
      setStatus({ kind: "error", text: `This product was renamed to “${product.name}” while you were editing. Cancel, then edit again.` });
      return;
    }
    setStatus({ kind: "saving", text: "Saving…" });
    if (beforeSave) {
      let timer;
      const outcome = await Promise.race([
        Promise.resolve().then(beforeSave).then(() => "done", () => "done"),   // a failure was always best effort
        new Promise((r) => { timer = setTimeout(() => r("timeout"), beforeSaveLimitMs); }),
      ]);
      clearTimeout(timer);
      if (outcome === "timeout") {
        setStatus({ kind: "error", text: "Could not reach the database, so nothing was renamed. Check the connection and tap Save again." });
        return;
      }
    }
    const extras = buildExtras ? buildExtras(trimmed) : null;
    const res = await renameProduct({
      product, draft, from: baseName, allProducts, extras: extras && Object.keys(extras).length ? extras : null, deviceId, call,
    });
    if (!res.ok) { setStatus({ kind: "error", text: res.message }); return; }
    const open = res.data?.openRefillRequests || 0;
    setStatus({ kind: "saved", text: open
      ? `Saved. ${open} open refill request${open === 1 ? "" : "s"} for this product stay attached (matched by product, not name).`
      : "Saved." });
    setEditing(false);
  };

  const message = blocked || status?.text || null;
  const bad = !!blocked || status?.kind === "error";
  return (
    <div>
      {editing ? (
        <>
          <input value={draft} autoFocus aria-label="Product name" data-testid="name-input"
                 onChange={(e) => { setDraft(e.target.value); if (status?.kind === "error") setStatus(null); }}
                 onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
                 disabled={saving}
                 style={{ width:"100%", boxSizing:"border-box", background:"rgba(255,255,255,.06)", border:"1px solid rgba(60,110,255,.45)", borderRadius:9, outline:"none", color:"#fff", fontSize:17, fontWeight:500, padding:"8px 10px", fontFamily:"inherit" }}/>
          <div style={{ display:"flex", gap:8, marginTop:10 }}>
            <button type="button" data-testid="name-save" onClick={save} disabled={!canSave}
                    style={{ flex:1, minHeight:40, borderRadius:10, border:"none", fontSize:14, fontWeight:700, cursor: canSave ? "pointer" : "default",
                             background: canSave || saving ? "#3C6EFF" : "rgba(255,255,255,.08)",
                             color: canSave || saving ? "#fff" : "rgba(255,255,255,.35)", opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" data-testid="name-cancel" onClick={cancel} disabled={saving}
                    style={{ flex:1, minHeight:40, borderRadius:10, border:"1px solid rgba(255,255,255,.15)", background:"transparent", color:"rgba(255,255,255,.75)", fontSize:14, fontWeight:600, cursor:"pointer" }}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <span data-testid="name-text" style={{ flex:1, minWidth:0, color:"#fff", fontSize:17, fontWeight:500, wordBreak:"break-word" }}>{product.name}</span>
          <button type="button" data-testid="name-edit" onClick={start}
                  style={{ background:"rgba(60,110,255,.12)", border:"1px solid rgba(60,110,255,.3)", color:"#4A7FFF", fontSize:13, fontWeight:600, padding:"8px 14px", borderRadius:9, cursor:"pointer", flexShrink:0, minHeight:36 }}>
            Edit
          </button>
        </div>
      )}
      {message && (
        <div data-testid="name-status" data-kind={bad ? "error" : status?.kind} role={bad ? "alert" : "status"}
             style={{ marginTop:8, fontSize:12, lineHeight:1.4, color: bad ? "#FF8888" : status?.kind === "saved" ? "#6EE7A0" : "rgba(255,255,255,.55)" }}>
          {message}
        </div>
      )}
      <div style={{ marginTop:6, fontSize:11.5, color:"rgba(255,255,255,.4)", lineHeight:1.4 }}>
        A product with stock or sales can only be renamed by Junid, Jafer or MC. Every rename is logged.
      </div>
    </div>
  );
}
