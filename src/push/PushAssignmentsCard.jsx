// ─── ORDER ALERTS — WHO GETS TOLD, AND ABOUT WHICH HUB ───────────────────────
// The one screen where notification recipients are decided. Super-admin only,
// hash-routed at /#admin/notifications.
//
// ── WHAT IT HAS TO SHOW, AND WHY EACH IS DELIBERATE ─────────────────────────
//
//   EVERY ACCOUNT, not the ones with a stockRole. Of ~31 staff accounts, 7
//   carry no stockRole at all and several carry no destShop. Under the model
//   this replaces those people were invisible to the whole feature — they had
//   no role default, so nothing resolved for them, and nobody could tell.
//   They are exactly the accounts most likely to need an explicit decision, so
//   filtering the list by any field would hide the people the screen exists
//   for. Nothing is hidden; the missing fields are shown as missing.
//
//   WHETHER A DEVICE CAN ACTUALLY BE REACHED. An assignment to somebody with no
//   live push token is a decision that will never produce a notification —
//   silently, and indistinguishably from the feature being broken. That happens
//   for real reasons (the person has never granted the browser permission, or
//   is on an iPhone that is not installed to the Home Screen), and there is no
//   longer a switch for them to find, so the ONLY place it can surface is here.
//   A row therefore says "no device" and an assignment on such a row is flagged
//   rather than merely stored.
//
// ── GATING ──────────────────────────────────────────────────────────────────
// Three independent gates, and only the third one is enforcement:
//   1. the tile does not render (src/App.jsx, isSuperAdmin)
//   2. the route does not mount this component (src/App.jsx)
//   3. the RTDB rules refuse the write to /push_assignments and
//      /push_hub_audience for anybody but the super-admin email
//      (PUSH-ASSIGNMENT-RULES-DEPLOY.md)
// 1 and 2 are UI, and UI is bypassable — a hand-typed hash, a stale bundle.
// The component re-checks the same condition as the route (so deleting either
// still leaves a working client gate), but the answer to "can a non-admin write
// an assignment" is 3, and only 3.
//
// ── WHAT IT READS ───────────────────────────────────────────────────────────
// Three ONE-SHOT reads on open, never a subscription: /users (the roster —
// there is no other index of staff, and this is the same read UserManagement
// already does), /push_assignments and /push_tokens. All three are small, this
// screen is opened by one person occasionally, and a `get()` rather than an
// `onValue()` means closing the tab ends the cost. Saves reconcile optimistically
// against the local mirror, so nothing needs a live listener to stay honest.

import { useCallback, useEffect, useMemo, useState } from "react";
import { get, ref, update } from "firebase/database";
import { database } from "../firebase";
import { serverNowMs } from "../utils/serverTime";
import {
  PUSH_HUBS,
  PUSH_HUB_LABEL,
  PUSH_ASSIGNMENTS_PATH,
  assignedHubs,
  assignmentUpdates,
  isLegalKey,
} from "./pushAssignments";

// Same super-admin identity the rest of the admin surface uses
// (src/components/UserManagement.jsx, functions/index.js assertAdmin).
const ADMIN_EMAIL = "gunidmoh@gmail.com";

const FONT    = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const CARD    = "#1c1c1e";
const DIVIDER = "rgba(84,84,88,.5)";
const BLUE    = "#4A7FFF";
const GREEN   = "#34C759";
const AMBER   = "#F5A623";
const TEXT_2  = "#8e8e93";

export default function PushAssignmentsCard({ authUser, onExit }) {
  // GATE 2 of 3 — see the header. An independent check, not a re-read of the
  // route's decision: this component refuses to render for anyone else even if
  // it is mounted by mistake.
  if (!authUser || authUser.email !== ADMIN_EMAIL) {
    return (
      <div style={{ minHeight: "100vh", background: "#000", color: TEXT_2, fontFamily: FONT, display: "grid", placeItems: "center", padding: 24, textAlign: "center" }}>
        <div>
          <div style={{ fontSize: 15, color: "#fff", fontWeight: 700, marginBottom: 8 }}>Not authorised</div>
          <div style={{ fontSize: 13, lineHeight: 1.5 }}>Order alerts are assigned by the account owner.</div>
          <button onClick={onExit} style={{ marginTop: 18, background: "transparent", border: 0, color: BLUE, fontSize: 14, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" }}>Back</button>
        </div>
      </div>
    );
  }
  return <PushAssignmentsAuthed onExit={onExit} />;
}

function PushAssignmentsAuthed({ onExit }) {
  const [rows, setRows] = useState(null);       // null = still loading
  // ── TWO ERROR CHANNELS, NOT ONE STRING ───────────────────────────────────
  // A single shared message meant any successful save cleared it — so row A's
  // refusal was erased the moment row B saved, and the reason A had rolled back
  // was gone while A's switch sat off with no explanation. Rows save
  // concurrently (only the saving row is disabled), so this is reachable by two
  // ordinary taps (found by the second-opinion reviewer on PR #573).
  //
  // A failure is therefore remembered PER ROW and cleared only by THAT row's
  // own success. The load failure is its own channel because it is a different
  // fact about a different thing, and a row save must never be able to erase
  // "the staff list could not be read".
  const [loadError, setLoadError] = useState(null);
  const [failedUids, setFailedUids] = useState({});   // uid → true while its last save was refused
  const [saving, setSaving] = useState({});     // uid → true while a write is in flight
  const [savedAt, setSavedAt] = useState({});   // uid → ms, drives the "Saved ✓" pulse
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      // Three small nodes, read once. Deliberately sequential-free: they are
      // independent, and one slow read must not delay the other two.
      const [usersSnap, assignSnap, tokensSnap] = await Promise.all([
        get(ref(database, "users")),
        get(ref(database, PUSH_ASSIGNMENTS_PATH)),
        get(ref(database, "push_tokens")),
      ]);
      const users = usersSnap.val() || {};
      const assignments = assignSnap.val() || {};
      const tokens = tokensSnap.val() || {};

      const list = Object.entries(users)
        // A uid that could not be a path segment cannot be assigned, and must
        // not be offered as if it could — the save would throw at the SDK.
        .filter(([uid]) => isLegalKey(uid))
        .map(([uid, rec]) => {
          const devices = tokens[uid] && typeof tokens[uid] === "object"
            ? Object.values(tokens[uid]).filter((d) => d && typeof d.token === "string").length
            : 0;
          return {
            uid,
            name: String((rec && rec.displayName) || (rec && rec.username) || uid),
            email: (rec && rec.email) || null,
            // Shown, never consulted. They are on the row so Junid can tell one
            // Sipho from another — NOT because either one implies an
            // assignment. See src/push/pushAssignments.js.
            stockRole: (rec && rec.stockRole) || null,
            destShop: (rec && rec.destShop) || null,
            devices,
            hubs: assignedHubs(assignments[uid]),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      setRows(list);
    } catch (e) {
      console.error("[push] could not load assignments:", e);
      setLoadError(e && e.message ? e.message : "Could not load staff accounts.");
      setRows([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleHub = useCallback(async (uid, hub) => {
    const row = (rows || []).find((r) => r.uid === uid);
    if (!row || saving[uid]) return;
    const next = row.hubs.includes(hub) ? row.hubs.filter((h) => h !== hub) : [...row.hubs, hub];

    // Optimistic, then reconciled — the same feel as User Management. A failed
    // write puts the row BACK rather than leaving a tick that persisted
    // nothing: an assignment that looks made and was not is the one outcome
    // this screen must never produce.
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, hubs: next } : r)));
    setSaving((s) => ({ ...s, [uid]: true }));
    try {
      await update(ref(database), assignmentUpdates(uid, next, serverNowMs()));
      setSavedAt((s) => ({ ...s, [uid]: Date.now() }));
      // CLEARED ON SUCCESS, AND ONLY FOR THIS ROW. Leaving a warning up after a
      // save that DID land is the same lie as a tick that persisted nothing,
      // pointing the other way: Junid re-taps an assignment already stored, or
      // concludes the rules are unpublished when they are not. Clearing it for
      // EVERY row would be the opposite lie — see the note on failedUids.
      setFailedUids((f) => { if (!f[uid]) return f; const n = { ...f }; delete n[uid]; return n; });
    } catch (e) {
      console.error("[push] assignment save failed:", e);
      setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, hubs: row.hubs } : r)));
      setFailedUids((f) => ({ ...f, [uid]: true }));
    } finally {
      setSaving((s) => ({ ...s, [uid]: false }));
    }
  }, [rows, saving]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !rows) return rows || [];
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) || String(r.email || "").toLowerCase().includes(q));
  }, [rows, search]);

  // Named, so the banner points at the rows that actually failed instead of
  // saying "something did not save" over a screen of successful ones.
  const failedNames = (rows || []).filter((r) => failedUids[r.uid]).map((r) => r.name);
  const assignedCount = (rows || []).filter((r) => r.hubs.length > 0).length;
  const undeliverable = (rows || []).filter((r) => r.hubs.length > 0 && r.devices === 0).length;

  return (
    <div style={{ minHeight: "100vh", background: "#000", fontFamily: FONT, color: "#fff", paddingBottom: 60 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "44px 14px 0" }}>
        <button onClick={onExit} style={{ background: "transparent", border: 0, color: BLUE, fontSize: 15, fontWeight: 600, fontFamily: "inherit", cursor: "pointer", padding: "6px 0", marginBottom: 10 }}>
          ‹ Back
        </button>

        <h1 style={{ fontSize: 26, fontWeight: 800, margin: "0 0 6px", letterSpacing: "-.02em" }}>Order alerts</h1>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: TEXT_2, margin: "0 0 18px" }}>
          Choose who is alerted when a shop places an order, and for which hub.
          Nobody is alerted unless you switch a hub on here — staff have no
          setting of their own. Someone on both hubs hears about both.
        </p>

        {loadError && (
          <div style={{ margin: "0 0 14px", padding: "11px 13px", borderRadius: 11, background: "rgba(245,166,35,.1)", border: "1px solid rgba(245,166,35,.3)", color: AMBER, fontSize: 12.5, lineHeight: 1.5 }}>
            Could not read the staff list, so this screen may be showing nothing
            rather than nobody. {loadError}
          </div>
        )}

        {failedNames.length > 0 && (
          <div style={{ margin: "0 0 14px", padding: "11px 13px", borderRadius: 11, background: "rgba(245,166,35,.1)", border: "1px solid rgba(245,166,35,.3)", color: AMBER, fontSize: 12.5, lineHeight: 1.5 }}>
            {failedNames.join(", ")} did not save, and {failedNames.length > 1 ? "those rows have" : "that row has"} been
            put back. If this is the first time, the RTDB rules for
            /push_assignments and /push_hub_audience have not been published yet
            (PUSH-ASSIGNMENT-RULES-DEPLOY.md).
          </div>
        )}

        {rows !== null && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "0 0 14px", fontSize: 12, color: TEXT_2 }}>
            <span><strong style={{ color: "#fff" }}>{assignedCount}</strong> of {rows.length} assigned</span>
            {undeliverable > 0 && (
              <span style={{ color: AMBER }}>
                <strong>{undeliverable}</strong> assigned with no device — they will not receive anything
              </span>
            )}
          </div>
        )}

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search staff"
          style={{ width: "100%", boxSizing: "border-box", marginBottom: 14, padding: "11px 13px", borderRadius: 11, border: `1px solid ${DIVIDER}`, background: CARD, color: "#fff", fontSize: 14, fontFamily: "inherit", outline: "none" }}
        />

        {rows === null ? (
          <div style={{ color: TEXT_2, fontSize: 13, padding: "26px 4px" }}>Loading staff accounts…</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: TEXT_2, fontSize: 13, padding: "26px 4px" }}>No staff accounts match that.</div>
        ) : (
          <div style={{ borderRadius: 14, overflow: "hidden", background: CARD, border: `1px solid ${DIVIDER}` }}>
            {filtered.map((row, i) => (
              <StaffRow
                key={row.uid}
                row={row}
                last={i === filtered.length - 1}
                busy={!!saving[row.uid]}
                saved={savedAt[row.uid] && Date.now() - savedAt[row.uid] < 2200}
                onToggle={(hub) => toggleHub(row.uid, hub)}
              />
            ))}
          </div>
        )}

        <p style={{ fontSize: 11.5, lineHeight: 1.6, color: "rgba(233,238,255,.34)", margin: "18px 2px 0" }}>
          “No device” means that person’s browser has never been given permission
          to show alerts, so nothing can reach them yet — assigning them stores
          the decision but sends nothing until they open the app on a device that
          allows notifications. Pine (Hub&nbsp;3) orders are not covered: they are
          picked on Pine’s own floor.
        </p>
      </div>
    </div>
  );
}

function StaffRow({ row, last, busy, saved, onToggle }) {
  // The sub-line is IDENTITY, not a rule: it exists so two people with similar
  // names are distinguishable. "No stock role" and "no shop" are printed rather
  // than hidden precisely because those accounts are the ones that used to be
  // invisible here.
  const bits = [
    row.stockRole ? `${row.stockRole}` : "no stock role",
    row.destShop ? row.destShop : "no shop",
  ];

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
      borderBottom: last ? "none" : `1px solid ${DIVIDER}`,
      opacity: busy ? 0.55 : 1, transition: "opacity .15s",
    }}>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 650, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.name}
          {saved && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, color: GREEN }}>Saved ✓</span>}
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: TEXT_2, marginTop: 2 }}>
          {bits.join(" · ")}
          {" · "}
          <span style={{ color: row.devices > 0 ? GREEN : (row.hubs.length ? AMBER : TEXT_2), fontWeight: row.devices > 0 ? 600 : 700 }}>
            {row.devices > 0
              ? `${row.devices} device${row.devices > 1 ? "s" : ""}`
              : "no device"}
          </span>
        </span>
      </span>

      <span style={{ display: "flex", gap: 7, flex: "0 0 auto" }}>
        {PUSH_HUBS.map((hub) => {
          const on = row.hubs.includes(hub);
          return (
            <button
              key={hub}
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={`${PUSH_HUB_LABEL[hub]} alerts for ${row.name}`}
              disabled={busy}
              onClick={() => onToggle(hub)}
              style={{
                minWidth: 62, padding: "8px 10px", borderRadius: 10, cursor: busy ? "wait" : "pointer",
                fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                color: on ? "#fff" : "rgba(233,238,255,.45)",
                background: on ? "rgba(74,127,255,.3)" : "rgba(255,255,255,.045)",
                border: `1px solid ${on ? "rgba(74,127,255,.62)" : "rgba(255,255,255,.1)"}`,
                transition: "background .15s, border-color .15s, color .15s",
              }}>
              {PUSH_HUB_LABEL[hub]}
            </button>
          );
        })}
      </span>
    </div>
  );
}
