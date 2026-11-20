// ─── BLACK FRIDAY CARD — WHERE JUNID WAS (21 Nov 2026) ──────────────────────
// If iOS throws the card away while he is in another app, the reload must put
// him back exactly where he was: same tab, same row, Select mode and ticks, the
// photo or popup he had open. Kept on the device:
//   localStorage  "bf.card.ui"       { at, tab, scrollY, anchor: { pid, top }, selectMode, showUnder, onlySel,
//                                      selLabel, sel: { at, sigs }, viewer: { pid, id }, findPid, heights }
//   sessionStorage "bf.card.list"    the last list the server sent (the card draws it at once, then refreshes)
//   sessionStorage "bf.card.find"    the Find online results on screen
// The ticks are also saved on the server (selection/{uid}); the newer copy wins.
// Every read and write is guarded: a full or blocked storage never breaks the card.

const UI_KEY = "bf.card.ui";
const LIST_KEY = "bf.card.list";
const FIND_KEY = "bf.card.find";
export const STATE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const store = (kind) => { try { return kind === "local" ? globalThis.localStorage : globalThis.sessionStorage; } catch { return null; } };
const get = (kind, key) => { try { const v = store(kind)?.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; } };
const put = (kind, key, v) => { try { store(kind)?.setItem(key, JSON.stringify(v)); return true; } catch { return false; } };

/** The saved place, if recent enough. */
export function loadUi(nowMs = Date.now()) {
  const s = get("local", UI_KEY);
  return s && typeof s === "object" && nowMs - Number(s.at || 0) < STATE_MAX_AGE_MS ? s : null;
}
export function saveUi(state, nowMs = Date.now()) {
  return put("local", UI_KEY, { ...state, at: nowMs });
}
/** The last list the server sent (main section), for an instant first paint. */
export function loadList() { return get("session", LIST_KEY); }
export function saveList(d) {
  if (!d) return false;
  if (put("session", LIST_KEY, d)) return true;
  try { store("session")?.removeItem(LIST_KEY); } catch { /* nothing to free */ }
  return false;
}
export function loadFind(pid) { const f = get("session", FIND_KEY); return f && f.pid === pid ? f.result : null; }
export function saveFind(pid, result) { return result ? put("session", FIND_KEY, { pid, result }) : false; }

/**
 * The ticks to put back: the device's copy when it is newer than the server's (a tick made just before
 * iOS closed the tab may not have reached the server). → { sigs, label } | null. Pure.
 */
export function pickSelection(server, local) {
  const s = server && server.sigs ? { at: Number(server.at) || 0, sigs: server.sigs, label: server.label || null } : null;
  const l = local && local.sigs ? { at: Number(local.at) || 0, sigs: local.sigs, label: local.label || null } : null;
  if (!s) return l && Object.keys(l.sigs).length ? l : null;
  if (!l) return s;
  return l.at > s.at ? l : s;
}

/** The first row visible below the top of the screen: { pid, top } (for coming back to the same row). */
export function visibleAnchor(doc = globalThis.document, topMargin = 0) {
  if (!doc || !doc.querySelectorAll) return null;
  for (const el of doc.querySelectorAll("[data-row-pid]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > topMargin + 4) return { pid: el.getAttribute("data-row-pid"), top: Math.round(r.top) };
  }
  return null;
}
/** Scroll so that the anchored row sits where it was. → true when it was found. */
export function scrollToAnchor(anchor, win = globalThis.window, doc = globalThis.document) {
  if (!anchor || !doc || !doc.querySelector || !win) return false;
  const el = doc.querySelector(`[data-row-pid="${String(anchor.pid).replace(/"/g, "")}"]`);
  if (!el) return false;
  const dy = el.getBoundingClientRect().top - Number(anchor.top || 0);
  if (Math.abs(dy) > 1) win.scrollBy(0, dy);
  return true;
}
