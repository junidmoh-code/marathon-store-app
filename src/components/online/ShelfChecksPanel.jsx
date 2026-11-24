// ─── SHELF CHECKS — a short daily list on the screens staff already use ──────
// Junid, 24 Nov 2026 (functions/webShelf has the rules). Mounted on the
// Warehouse queue (each hub — Hub 2 with its clothing as well as sneakers),
// Source (Central), and — since the evening brief — a shop's OWN "Shelf check"
// tab in Display Checks (mode "tab"), so it never covers the website strip or
// the display refills; a shop's tab shows only once Junid switches it on.
//
//   • Central only: the WEBSITE-ORDERS STRIP for lines that reached Central —
//     the same strip as a shop's, answered through the same completeDisplayCheck.
//   • The day's shelf checks: first the shelves whose count is wrong by more
//     than one (they rejected a website order while showing several), then the
//     single pieces untouched longest.
//
// NOTHING IS TYPED. A single piece: Found / Not found, or scan its barcode
// (a scan is Found). Several on the shelf: tap the real number.
// Everything goes through two callables (webShelfList / webShelfAnswer), so
// the panel needs no database rule; a person without the screen's permission
// simply sees nothing.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import WebsiteOrdersStrip from "../../pages/DisplayChecks/WebsiteOrdersStrip.jsx";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";

const webShelfList = httpsCallable(functions, "webShelfList");
const webShelfAnswer = httpsCallable(functions, "webShelfAnswer");
const REFRESH_MS = 60 * 1000;
const GREEN = "#4ACA7A";
const RED = "#FF453A";
const AMBER = "#E8A54A";
const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const daysAgo = (ms, now) => (Number.isFinite(Number(ms)) && ms ? Math.max(0, Math.floor((now - Number(ms)) / 864e5)) : null);

/** Why this shelf is on today's list, in the reader's words. PURE. */
export function whyText(check, now = Date.now()) {
  const ref = check.ref ? ` (${check.ref})` : "";
  if (check.why === "web_reject") {
    return check.confirm
      ? `A website order could not find it here${ref}, so the app took it off. Is it there after all?`
      : `A website order could not find it here${ref}. Is it there?`;
  }
  if (check.why === "store_reject") return `Someone said this was not here${ref}, but the app shows ${check.shown}. ${Number(check.shown) > 1 ? "Count the shelf." : "Is it there?"}`;
  if (check.why === "wrong_by_more") return `It could not be found for a website order, but the app shows ${check.shown}. Count the shelf.`;
  if (check.why === "not_selling") {
    const d = daysAgo(check.at, now);
    return `The app shows ${check.shown}, but nothing has sold or left here${d != null ? ` for ${d} days` : " for weeks"}. ${Number(check.shown) > 1 ? "Count the shelf." : "Is it there?"}`;
  }
  const d = daysAgo(check.lastMoved, now);
  return d != null ? `One piece, not touched for ${d} days. Is it there?` : "One piece. Is it there?";
}

/** The largest count the server takes (functions/webShelf/lib.cjs MAX_COUNT). */
export const MAX_COUNT = 30;
/** The numbers offered for a shelf showing several: 0 … shown + 2 (at least 0…4), or every number to 30 after "More". PURE. */
export const countChoices = (shown, all = false) => Array.from({ length: (all ? MAX_COUNT : Math.min(MAX_COUNT, Math.max(4, Number(shown) + 2))) + 1 }, (_, n) => n);

/** A keyboard-wedge scanner types the code fast and ends with Enter. → the code, or null while typing. */
export function scanBuffer() {
  let buf = "", last = 0;
  return (key, at) => {
    if (key === "Enter") { const code = buf; buf = ""; return code.length >= 6 ? code : null; }
    if (key.length !== 1) return null;
    if (at - last > 80) buf = ""; // a person typing, not a scanner
    last = at; buf += key;
    return null;
  };
}

function CheckRow({ check, busy, onAnswer, now }) {
  const [confirmNo, setConfirmNo] = useState(false);
  const [allCounts, setAllCounts] = useState(false);
  // A website write-down on the list: only "is it there after all?" (Found puts it back; Not found confirms it).
  const several = !check.confirm && Number(check.shown) > 1;
  const btn = { fontFamily: FONT, fontWeight: 800, borderRadius: 12, border: "none", cursor: busy ? "default" : "pointer", minHeight: 44 };
  return (
    <div data-testid="shelf-row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "10px 0", borderTop: "1px solid rgba(255,255,255,.07)", flexWrap: "wrap", opacity: busy ? 0.5 : 1 }}>
      {check.photoUrl
        ? <PrimaryPhoto product={{ id: check.pid, photoUrl: check.photoUrl }} alt="" style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 10, flex: "0 0 52px" }} />
        : <div style={{ width: 52, height: 52, borderRadius: 10, background: "rgba(255,255,255,.05)", flex: "0 0 52px" }} />}
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontFamily: FONT, fontSize: 15, fontWeight: 700, color: "#f3f6ff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{check.name}</div>
        <div style={{ fontFamily: MONO, fontSize: 12, color: "rgba(233,238,255,.7)", marginTop: 2 }}>{check.size ? `SIZE ${check.size} · ` : ""}APP SHOWS {check.shown}</div>
        <div style={{ fontFamily: FONT, fontSize: 13, color: check.why === "wrong_by_more" || check.why === "web_reject" || check.why === "store_reject" ? AMBER : "rgba(233,238,255,.8)", marginTop: 3 }}>{whyText(check, now)}</div>
      </div>
      {several ? (
        <div data-testid="shelf-count" style={{ display: "flex", gap: 6, flexWrap: "wrap", flex: "1 1 220px", justifyContent: "flex-end" }}>
          {countChoices(check.shown, allCounts).map((n) => (
            <button key={n} type="button" disabled={busy} onClick={() => onAnswer(check, "count", n)} data-testid={`shelf-count-${n}`}
                    style={{ ...btn, minWidth: 44, padding: "0 12px", fontSize: 16, background: n === Number(check.shown) ? "rgba(74,202,122,.2)" : "rgba(255,255,255,.08)", color: n === Number(check.shown) ? GREEN : "#fff", border: n === Number(check.shown) ? `1px solid ${GREEN}` : "1px solid rgba(255,255,255,.12)" }}>
              {n}
            </button>
          ))}
          {!allCounts && <button type="button" disabled={busy} onClick={() => setAllCounts(true)} data-testid="shelf-count-more" style={{ ...btn, padding: "0 12px", fontSize: 13, background: "none", color: "rgba(233,238,255,.7)", border: "1px dashed rgba(255,255,255,.25)" }}>More</button>}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flex: "0 0 auto" }}>
          <button type="button" disabled={busy} onClick={() => onAnswer(check, "found")} data-testid="shelf-found"
                  style={{ ...btn, background: GREEN, color: "#04140a", fontSize: 15, padding: "0 18px" }}>Found</button>
          <button type="button" disabled={busy} data-testid="shelf-notfound"
                  onClick={() => (confirmNo ? onAnswer(check, "not_found") : setConfirmNo(true))}
                  style={{ ...btn, background: "rgba(255,255,255,.07)", color: confirmNo ? RED : "rgba(233,238,255,.8)", fontSize: 13, padding: "0 12px", border: confirmNo ? `1px solid ${RED}` : "1px solid transparent" }}>
            {confirmNo ? "Tap again: not found" : "Not found"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 *   mode      "inline" (a hub's queue, Central's Source: nothing at all when there is nothing to do) or "tab" (a shop's
 *             own Shelf check tab in Display Checks: always says where the list stands)
 *   onStatus  told { on } each time the list is read — Display Checks shows a shop's tab only once it is switched on
 */
export default function ShelfChecksPanel({ loc, style = null, active = true, mode = "inline", onStatus = null }) {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false); // no permission / not a place with a list
  const [busyId, setBusyId] = useState(null);
  const [note, setNote] = useState(null);
  const [open, setOpen] = useState(true);
  const live = useRef(true);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // The place the panel is showing NOW: an answer for a place the screen has left is ignored.
  const locNow = useRef(loc);
  locNow.current = loc;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onRef = useRef(true);
  onRef.current = data ? data.on !== false : true;
  const now = Date.now();

  const load = useCallback(async () => {
    if (!loc) return;
    try {
      const res = await webShelfList({ loc });
      if (live.current && locNow.current === loc) { setData(res.data); setHidden(false); if (onStatusRef.current) onStatusRef.current({ on: res.data?.on !== false }); }
    } catch (err) {
      if (!live.current || locNow.current !== loc) return;
      if (err?.code === "functions/permission-denied" || err?.code === "functions/unauthenticated") setHidden(true);
      // Any other failure: keep what is on screen; the next refresh tries again.
    }
  }, [loc]);

  useEffect(() => {
    live.current = true;
    setData(null); setHidden(false);
    load();
    // Refreshed while the screen is in front (a hidden tab or a switched-off shop is not polled).
    const id = setInterval(() => { if ((typeof document === "undefined" || !document.hidden) && activeRef.current && onRef.current) load(); }, REFRESH_MS);
    return () => { live.current = false; clearInterval(id); };
  }, [load]);

  const answer = useCallback(async (check, result, count) => {
    setBusyId(check.id); setNote(null);
    try {
      const res = await webShelfAnswer({ loc, id: check.id, result, ...(result === "count" ? { count } : {}) });
      if (!live.current || locNow.current !== loc) return;
      setData(res.data);
      if (res.data?.ok === false) setNote(res.data.reason === "stale" || res.data.reason === "gone" ? "That shelf has changed since this morning, so it is off the list." : "That did not save. Try again.");
    } catch {
      if (live.current) setNote("That did not save. Try again.");
    } finally {
      if (live.current) setBusyId(null);
    }
  }, [loc]);

  // A scan of a listed single piece is "Found". Nothing is typed.
  const checks = useMemo(() => data?.checks || [], [data]);
  useEffect(() => {
    // Only while this screen is the one in front (a hidden tab must not answer a scan made on another).
    if (!checks.length || !active) return undefined;
    const feed = scanBuffer();
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      const code = feed(e.key, e.timeStamp);
      if (!code) return;
      const hit = checks.find((c) => c.barcode && String(c.barcode) === code);
      if (!hit) return;
      if (hit.confirm || Number(hit.shown) === 1) answer(hit, "found");
      else setNote(`${hit.name}: tap how many are on the shelf.`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checks, answer, active]);

  if (!loc || hidden || !data) return null;
  const done = (data.today?.found || 0) + (data.today?.notFound || 0) + (data.today?.counted || 0) + (data.today?.corrected || 0);
  const webRows = loc === "central" ? data.webRows || [] : [];
  if (mode === "tab" && data.on === false) {
    return (
      <div data-testid="shelf-off" style={{ fontFamily: FONT, fontSize: 14, color: "rgba(233,238,255,.6)", padding: "28px 8px", textAlign: "center" }}>
        The shelf check is not switched on for this shop yet.
      </div>
    );
  }
  if (mode === "tab" && !checks.length && !done) {
    return <div data-testid="shelf-empty" style={{ fontFamily: FONT, fontSize: 14, color: "rgba(233,238,255,.6)", padding: "28px 8px", textAlign: "center" }}>Nothing to check today. The next list comes tomorrow morning.</div>;
  }
  if (!webRows.length && !checks.length && !done) return null;
  return (
    <div data-testid="shelf-panel" style={style || undefined}>
      {webRows.length > 0 && <WebsiteOrdersStrip store="central" rows={webRows} central onDone={load} />}
      {(checks.length > 0 || done > 0) && (
        <div style={{ background: "rgba(255,255,255,.03)", border: "1px solid rgba(232,165,74,.35)", borderRadius: 16, padding: "12px 16px", marginBottom: 18 }}>
          <button type="button" onClick={() => setOpen((v) => !v)} data-testid="shelf-toggle"
                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
            <span style={{ fontFamily: MONO, textTransform: "uppercase", letterSpacing: "0.12em", fontSize: 12, fontWeight: 800, color: "#f3f6ff" }}>Shelf check — today</span>
            <span data-testid="shelf-left" style={{ background: checks.length ? AMBER : GREEN, color: "#1a1204", fontFamily: MONO, fontWeight: 800, fontSize: 12, borderRadius: 999, padding: "2px 8px" }}>{checks.length ? `${checks.length} to check` : "all done"}</span>
            <span style={{ fontFamily: FONT, fontSize: 12, color: "rgba(233,238,255,.6)" }}>{done} done today</span>
            <span style={{ marginLeft: "auto", color: "rgba(233,238,255,.5)", fontSize: 12 }}>{open ? "Hide" : "Show"}</span>
          </button>
          {note && <div role="status" style={{ fontFamily: FONT, fontSize: 13, color: AMBER, marginTop: 8 }}>{note}</div>}
          {open && checks.map((c) => <CheckRow key={c.id} check={c} busy={busyId === c.id} onAnswer={answer} now={now} />)}
          {open && checks.length > 0 && <div style={{ fontFamily: FONT, fontSize: 12, color: "rgba(233,238,255,.45)", marginTop: 8 }}>Tap, or scan the piece. Anything left rolls over to tomorrow.</div>}
        </div>
      )}
    </div>
  );
}
