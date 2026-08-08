// ─────────────────────────────────────────────────────────────────────────────
// User Management (super-admin only) — /#admin/users
// ─────────────────────────────────────────────────────────────────────────────
// Master-detail UI for staff account lifecycle. Gated on the super-admin email
// gunidmoh@gmail.com (matches the gate used by AdminSignInScreen in App.jsx and
// the assertAdmin helper in functions/index.js).
//
// ── 2026-07 permissions redesign — read this before touching gating ──────────
// The old editor had three traps that made grants feel dead / not work:
//   1. Stock was a TWO-key lock: the "Stock" checkbox opened the screen, but a
//      SEPARATE `stockRole` field is what actually authorises inventory writes
//      (enforced in database.rules.json). Grant the checkbox, forget the role,
//      and the user could open Stock but do nothing. We now AUTO-LINK them:
//      switching a stock permission on sets a sensible stockRole if none exists.
//   2. The `role` selector (Admin/Store Asst/Warehouse) changed a label and
//      nothing else. Tapping a role now APPLIES that role's preset (permissions
//      + stockRole) — so "make them Warehouse" produces a working warehouse user.
//   3. Dead / mislabelled permissions: `display_refills` gated nothing (removed
//      from the catalog); `place_orders` only unlocks Returns (relabelled);
//      `user_management` is super-admin-only and a trap if granted to staff (no
//      longer a toggle — shown as a locked note).
//
// Feel: every control updates OPTIMISTICALLY (instant), then persists. A short
// "Saved ✓" pulse confirms the write landed, and toggles give a light haptic tap.
//
// Architecture:
//   • List view: subscribe to /users, render sorted by displayName.
//   • Detail view (hash-routed at /#admin/users/{uid}): inline-edit displayName,
//     role preset, per-permission toggles, stock role, store access — all
//     auto-save via direct RTDB updates (optimistic local mirror + reconcile).
//   • Add Staff modal: collects fields, calls createStaffUser, navigates to the
//     new user's detail page on success.
//
// Cloud Functions (europe-west1, mirrors analyzeReorderNeeds region):
//   createStaffUser, deleteStaffUser, updateStaffPassword.
// Permission toggles bypass the Cloud Function — RTDB rules already require the
// super-admin email on /users writes, and the UI is super-admin gated.

import { useState, useEffect, useRef, useMemo } from "react";
import { ref, onValue, update } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions } from "../firebase";
import { SHOP_IDS, SHOP_LABELS } from "../utils/stores";
import { PERMISSION_GROUPS, ALL_PERMISSIONS, STOCK_PERM_KEYS, ROLE_DEFAULT_PERMS } from "./permissionCatalog";

const ADMIN_EMAIL = "gunidmoh@gmail.com";

// ─── Design tokens (iOS-Dark-Mode grouped-list aesthetic) ────────────────────
const FONT       = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const BG         = "#000";
const CARD       = "#1c1c1e";              // iOS grouped-list bg
const CARD_HOVER = "#2c2c2e";
const DIVIDER    = "rgba(84,84,88,.6)";
const BLUE       = "#4A7FFF";
const BLUE_L     = "#6A9FFF";
const GREEN      = "#34C759";              // iOS switch-on / "Saved"
const RED        = "#FF453A";
const TEXT_2     = "#8e8e93";
const TEXT_3     = "#3a3a3c";

// Permission catalog + derivations (PERMISSION_GROUPS / ALL_PERMISSIONS /
// STOCK_PERM_KEYS) and ROLE_DEFAULT_PERMS live in ./permissionCatalog — pure data
// so the grant-shape invariants are unit-testable without this component's
// firebase deps (see permissionCatalog.test.js).

const ROLES = [
  { key: "admin",           label: "Admin" },
  { key: "store_assistant", label: "Store Asst" },
  { key: "warehouse",       label: "Warehouse" },
];

// Quick-setup shortcuts. These grant NOTHING on their own — tapping one just
// fills the toggles + stock work below with a typical set for that job. Ordered
// simplest → broadest.
const PRESETS = [
  { key: "store_assistant", label: "Store Asst" },
  { key: "warehouse",       label: "Warehouse" },
  { key: "admin",           label: "Admin" },
];

// Stock work (/users/{uid}/stockRole) — gates inventory WRITES in the RTDB rules.
// This is a SINGLE choice (pick one), because the database stores one value and
// the capabilities overlap in a way that doesn't split into independent flags
// (e.g. there's no "receive + sell but not transfer" level). So it's shown as a
// radio list — the honest visual grammar: toggles for independent on/off grants,
// radios for pick-one. "Admin" writes as stockRole:"admin" but reads as "Full".
// "None" clears the field (no stock-write access).
const STOCK_WORK = [
  { key: "",          label: "None",      desc: "Can’t change stock" },
  { key: "store",     label: "Store",     desc: "Transfers & till sales" },
  { key: "warehouse", label: "Warehouse", desc: "Receiving & transfers" },
  { key: "pos",       label: "POS",       desc: "Till sales only" },
  { key: "admin",     label: "Full",      desc: "Everything, incl. count fixes" },
];

// ROLE_DEFAULT_PERMS (role presets / Add-Staff defaults) lives in ./permissionCatalog.
// stockRole applied alongside each role preset ("" = none).
const ROLE_STOCK_ROLE = {
  admin:           "admin",
  warehouse:       "warehouse",
  store_assistant: "",
};
// When a stock permission is switched on and the user has no stockRole yet,
// pick one from their role so the grant actually works. Falls back to warehouse
// (the least-privileged role that can both receive and transfer).
function stockRoleForRole(role) {
  return ROLE_STOCK_ROLE[role] || "warehouse";
}
function haptic(ms = 8) {
  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(ms);
}

// ─── Cloud Function refs (region = europe-west1 via firebase.js `functions`) ─
const createStaffUserFn   = httpsCallable(functions, "createStaffUser");
const deleteStaffUserFn   = httpsCallable(functions, "deleteStaffUser");
const updateStaffPasswordFn = httpsCallable(functions, "updateStaffPassword");

// ─── Hash routing helpers ────────────────────────────────────────────────────
function parseHash() {
  const h = typeof window === "undefined" ? "" : window.location.hash;
  if (h === "#admin/users" || h === "#admin/users/") return { view: "list", uid: null };
  const m = h.match(/^#admin\/users\/(.+)$/);
  if (m) return { view: "detail", uid: decodeURIComponent(m[1]) };
  return null;
}

function initialsFromName(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || "?").slice(0, 2).toUpperCase();
}

function friendlyError(err) {
  // Firebase callable errors look like { code: "functions/invalid-argument", message: "...", details: {...} }
  const raw = err?.code || "";
  const msg = err?.message || String(err);
  if (raw.includes("already-exists"))    return msg;
  if (raw.includes("invalid-argument"))  return msg;
  if (raw.includes("failed-precondition")) return msg;
  if (raw.includes("permission-denied")) return "Not authorized.";
  if (raw.includes("not-found"))         return "User not found.";
  return msg || "Something went wrong. Try again.";
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level component
// ─────────────────────────────────────────────────────────────────────────────

// ── THE GATE (layer 2 of 2) ───────────────────────────────────────────────────
// This component is ONLY the authorization check. It holds no state and no
// effects, and it renders the real screen only for the super-admin.
//
// Why it is split in two rather than an early `return` inside one component:
// the check has to sit ABOVE the /users subscription so a refused viewer never
// opens it, and a hook cannot live below a conditional return — `authUser`
// arrives asynchronously, so the same instance would render first without a
// user and then with one, changing its hook count between renders and crashing
// React. Splitting puts every hook inside a component that only mounts once the
// answer is yes.
//
// Layer 1 is the route mount in App.jsx, which independently refuses to render
// this component at all for a non-super-admin. Both layers are real; neither
// relies on the other.
export default function UserManagement({ authUser, onExit }) {
  if (!authUser || authUser.email !== ADMIN_EMAIL) {
    return <NotAuthorized onExit={onExit} />;
  }
  return <UserManagementAuthed authUser={authUser} onExit={onExit} />;
}

// Everything below here runs ONLY for a verified super-admin.
function UserManagementAuthed({ authUser, onExit }) {
  const [users,     setUsers]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [route,     setRoute]     = useState(() => parseHash() || { view: "list", uid: null });
  const [showAdd,   setShowAdd]   = useState(false);
  const [granting,  setGranting]  = useState(false);
  const listScrollRef = useRef(0);

  // /users subscription. Reached only via the gate above, so a viewer who is
  // refused never opens it — the listener used to be registered during the same
  // render that returned NotAuthorized, because hooks run regardless of an early
  // return placed after them.
  useEffect(() => {
    if (!authUser) return;
    const unsub = onValue(ref(database, "users"), (snap) => {
      const data = snap.val() || {};
      const list = Object.entries(data)
        .map(([uid, v]) => ({ uid, ...(v || {}) }))
        .sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
      setUsers(list);
      setLoading(false);
    }, (err) => {
      console.error("UserManagement: /users subscription failed:", err);
      setLoading(false);
    });
    return () => unsub();
  }, [authUser]);

  // Hash-change listener so list→detail navigation + back/forward buttons drive
  // the UI. CRITICAL — DO NOT add anything to the dep array.
  //
  // Earlier this effect had [onExit] as its dep array. App.jsx passes a fresh
  // `onExit` function reference on every render, so the effect re-ran every
  // parent render — cleaning up and re-attaching the listener constantly. In
  // production that churn was wide enough that the listener was missing when
  // the asynchronously-dispatched hashchange event fired after a row tap. The
  // URL bar would update (proof the click + hash assignment worked) but the
  // component never re-rendered into the detail view; only a manual page
  // refresh fixed it because that re-ran the parseHash() initial-state
  // calculation. See PR #12 for the diagnosis chain.
  //
  // Fix: empty deps. Listener attaches ONCE on mount, persists for the
  // component lifetime, never churns. The `onExit?.()` branch was also
  // removed — App.jsx's wantUserMgmt detection already unmounts this
  // component when the hash leaves /admin/users, so calling onExit from
  // here is redundant.
  useEffect(() => {
    const onHashChange = () => {
      setRoute(parseHash() || { view: "list", uid: null });
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const goToDetail = (uid) => {
    listScrollRef.current = window.scrollY;
    window.location.hash = `#admin/users/${uid}`;
  };
  const goToList = () => {
    window.location.hash = "#admin/users";
    requestAnimationFrame(() => window.scrollTo(0, listScrollRef.current));
  };

  const isDetail = route.view === "detail";
  const selectedUser = isDetail ? users.find((u) => u.uid === route.uid) : null;

  // ── SELF-GRANT: shown when the VIEWER'S OWN record has no stock role ────────
  // The condition is exactly that and nothing more: this viewer has no /users
  // record at all, OR has one without a `stockRole` field. It does not test who
  // the viewer is — it does not need to, because only the super-admin reaches
  // this component (see the gate above), and the RTDB rules independently allow
  // `/users` writes for that one account only.
  //
  // Why it exists: AuthGate bypasses PERMISSIONS by email, but the stock rules
  // read stored data — `/stock` requires users/{uid}/stockRole to exist, and an
  // `adjustment` movement requires it to equal "admin". An account can therefore
  // pass every UI check and still be refused by RTDB on every receive, transfer
  // or correction. This offers a one-tap fix for that state.
  //
  // It is self-extinguishing: granting writes the field, the condition goes
  // false, the banner disappears. So finding it already hidden means it has
  // served its purpose — NOT that it was never needed.
  //
  // (An earlier version of this comment asserted that the super-admin has no
  // /users record. That was false when written, and it described a narrower
  // thing than the code checks. Do not reintroduce a claim about any specific
  // account's stored state here: `/users` is edited outside this file, so any
  // such claim rots silently.)
  const selfRecord = users.find((u) => u.uid === authUser.uid);
  const selfNeedsStock = !loading && (!selfRecord || !selfRecord.stockRole);
  const grantSelfStock = async () => {
    setGranting(true);
    try {
      const local = (authUser.email || "").split("@")[0] || "admin";
      const patch = selfRecord
        ? { stockRole: "admin" }
        : { displayName: authUser.displayName || "Super Admin", username: local, role: "admin", stockRole: "admin", permissions: [] };
      await update(ref(database, `users/${authUser.uid}`), patch);
    } catch (e) {
      console.warn("grant self stock failed:", e);
    } finally {
      setGranting(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, paddingBottom: 60 }}>
      {/* Global keyframes for the toggle busy-spinner. */}
      <style>{"@keyframes umSpin{to{transform:rotate(360deg)}}"}</style>
      {!isDetail && selfNeedsStock && (
        <div style={{ margin: "8px 16px 0", background: "rgba(60,110,255,.10)", border: "1px solid rgba(60,110,255,.35)",
                      borderRadius: 12, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: "#cfe0ff", lineHeight: 1.5 }}>
            You have no <b>stock role</b>, so receiving/transfers will be denied for your account. Grant yourself Admin stock access?
          </div>
          <button onClick={grantSelfStock} disabled={granting}
                  style={{ background: "rgba(60,110,255,.25)", border: "1px solid rgba(60,110,255,.5)", color: "#fff",
                           borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", opacity: granting ? 0.6 : 1 }}>
            {granting ? "Granting…" : "Grant Admin"}
          </button>
        </div>
      )}
      {!isDetail && (
        <UserListView
          users={users}
          loading={loading}
          onSelect={goToDetail}
          onAdd={() => setShowAdd(true)}
          onExit={onExit}
        />
      )}
      {isDetail && selectedUser && (
        <UserDetailView
          user={selectedUser}
          onBack={goToList}
        />
      )}
      {isDetail && !selectedUser && !loading && (
        <NotFoundView onBack={goToList} />
      )}
      {showAdd && (
        <AddStaffModal
          onClose={() => setShowAdd(false)}
          onCreated={(uid) => { setShowAdd(false); goToDetail(uid); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-views
// ─────────────────────────────────────────────────────────────────────────────

function NotAuthorized({ onExit }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT,
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "1rem", gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>Not authorized</div>
      <div style={{ color: TEXT_2, fontSize: 14, textAlign: "center", maxWidth: 320 }}>
        Only the super-admin (gunidmoh@gmail.com) can manage staff accounts.
      </div>
      <button onClick={onExit} style={primaryBtn}>Back to home</button>
    </div>
  );
}

function NotFoundView({ onBack }) {
  return (
    <div style={{ padding: "60px 16px 24px", maxWidth: 600, margin: "0 auto" }}>
      <TopBar title="Staff" onBack={onBack} />
      <div style={{ marginTop: 60, textAlign: "center", color: TEXT_2 }}>
        That user no longer exists.
      </div>
    </div>
  );
}

// ─── List view ───────────────────────────────────────────────────────────────

function UserListView({ users, loading, onSelect, onAdd, onExit }) {
  // iOS large-title pattern. The sticky nav bar only contains the back affordance
  // and a centred small "Staff" label. The "+ Add staff" action lives in a
  // dedicated large-title row below the bar.
  return (
    <>
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(0,0,0,.85)", backdropFilter: "blur(10px)",
                    borderBottom: `1px solid ${DIVIDER}`, padding: "12px 16px",
                    display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button onClick={onExit} style={{ ...linkBtn, display: "flex", alignItems: "center", gap: 4 }}>
          <ChevronLeft /> Exit
        </button>
        <div style={{ fontSize: 17, fontWeight: 600 }}>Staff</div>
        <div style={{ width: 50 }} aria-hidden />
      </div>

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "20px 16px" }}>
        {/* Large-title row: matches iOS "large title with primary action" pattern. */}
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between",
                      gap: 12, padding: "6px 4px 14px" }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 700, color: "#fff", letterSpacing: "-0.01em", lineHeight: 1.1 }}>
              Staff
            </div>
            <div style={{ fontSize: 12, color: TEXT_2, marginTop: 4 }}>
              {loading ? "Loading…" : `${users.length} ${users.length === 1 ? "member" : "members"}`}
            </div>
          </div>
          <button onClick={onAdd}
                  style={{ ...primaryBtn, padding: "8px 14px", fontSize: 13, whiteSpace: "nowrap", flexShrink: 0 }}>
            + Add staff
          </button>
        </div>

        <div style={{ background: CARD, borderRadius: 12, overflow: "hidden" }}>
          {users.map((u, i) => (
            <UserRow key={u.uid} user={u} onClick={() => onSelect(u.uid)} divider={i < users.length - 1} />
          ))}
          {!loading && users.length === 0 && (
            <div style={{ padding: 24, textAlign: "center", color: TEXT_2, fontSize: 14 }}>
              No staff yet. Tap "+ Add staff" to create the first account.
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function UserRow({ user, onClick, divider }) {
  const [hover,  setHover]  = useState(false);
  const [active, setActive] = useState(false);
  const permCount = Array.isArray(user.permissions) ? user.permissions.length : 0;
  // Semantic <button> instead of a clickable <div>: gets click + Enter + Space
  // handlers natively, focusable for keyboard nav, and the active state below
  // gives reliable tap feedback on mobile (cursor:pointer + :hover alone won't
  // visibly fire on touch). Reset default button chrome so it inherits the row
  // layout.
  return (
    <button type="button"
         onClick={onClick}
         onMouseEnter={() => setHover(true)}
         onMouseLeave={() => { setHover(false); setActive(false); }}
         onMouseDown={() => setActive(true)}
         onMouseUp={() => setActive(false)}
         onTouchStart={() => setActive(true)}
         onTouchEnd={() => setActive(false)}
         onTouchCancel={() => setActive(false)}
         style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                  cursor: "pointer",
                  background: active ? "#3a3a3c" : hover ? CARD_HOVER : "transparent",
                  borderBottom: divider ? `1px solid ${DIVIDER}` : "none",
                  transform: active ? "scale(0.99)" : "scale(1)",
                  transition: "background 80ms, transform 80ms",
                  width: "100%", textAlign: "left",
                  border: "none", color: "inherit", font: "inherit",
                  appearance: "none" }}>
      <AvatarCircle name={user.displayName} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user.displayName || "(no name)"}
          </span>
          {user.destShop && SHOP_LABELS[user.destShop] && (
            <span title={`Restricted to ${SHOP_LABELS[user.destShop]}`}
                  style={{ flexShrink: 0, fontSize: 10, color: BLUE_L, border: `1px solid ${BLUE}`,
                           padding: "1px 5px", borderRadius: 4, fontWeight: 600 }}>
              {SHOP_LABELS[user.destShop]}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: TEXT_2, marginTop: 1, display: "flex", alignItems: "center", gap: 6 }}>
          <span>@{user.username || "?"}</span>
          <span>·</span>
          <RoleBadge role={user.role} />
          <span>·</span>
          <span>{permCount} {permCount === 1 ? "permission" : "permissions"}</span>
        </div>
      </div>
      <ChevronRight />
    </button>
  );
}

function AvatarCircle({ name }) {
  const initials = initialsFromName(name);
  return (
    <div style={{ width: 36, height: 36, borderRadius: 999, flexShrink: 0,
                  background: "linear-gradient(135deg, rgba(60,110,255,.4), rgba(106,159,255,.6))",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 600, color: "#fff", letterSpacing: "0.02em" }}>
      {initials}
    </div>
  );
}

function RoleBadge({ role }) {
  const label = ROLES.find((r) => r.key === role)?.label || role || "—";
  return (
    <span style={{ fontSize: 11, color: BLUE_L, fontWeight: 500 }}>{label}</span>
  );
}

// Unordered string-array equality (permissions lists).
function sameStringSet(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

// Optimistic field with an in-flight GUARD. Problem it solves: a Firebase
// snapshot rebuilds the whole `user` object, so an unrelated field changing
// (e.g. another admin edits destShop) hands us a fresh `permissions` array with
// the OLD contents while our own toggle write is still in flight — the naive
// "sync local from prop on every change" would momentarily revert the toggle
// (a visible flicker that reads like the old "it resets itself" bug).
//
// Fix: after an optimistic set we remember what we wrote (`pending`). Prop
// echoes that DON'T match `pending` are ignored (still waiting for our own echo,
// or an unrelated snapshot); once the prop matches what we wrote, the guard
// clears and normal syncing resumes. A write failure calls revert(), which also
// clears the guard. When idle (no pending) the field tracks the prop exactly, so
// genuine cross-device edits still win.
function useOptimisticField(propValue, isEqual = Object.is) {
  const [value, setValue] = useState(propValue);
  const pending = useRef(null);   // { v } while our write is unconfirmed, else null
  useEffect(() => {
    if (pending.current) {
      if (isEqual(propValue, pending.current.v)) { pending.current = null; setValue(propValue); }
      return;                     // hold the optimistic value until our echo lands
    }
    setValue(propValue);
    // isEqual is intentionally excluded — callers pass a stable module-level fn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propValue]);
  const setOptimistic = (v) => { pending.current = { v }; setValue(v); };
  const revert        = (v) => { pending.current = null; setValue(v); };
  return { value, setOptimistic, revert };
}

// ─── Detail view ─────────────────────────────────────────────────────────────

function UserDetailView({ user, onBack }) {
  const [showResetPin,    setShowResetPin]    = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [error, setError] = useState(null);
  const [busy,  setBusy]  = useState(false);
  const [pendingRole, setPendingRole] = useState(null);   // role key awaiting apply-preset confirm
  const [stockHint,   setStockHint]   = useState(null);   // "Stock role set to …" transient note

  // Optimistic local mirrors so every control responds INSTANTLY, before the
  // /users subscription echoes the committed value back. Each mirror re-syncs to
  // the record on prop change, but holds its optimistic value while our own write
  // is in flight (see useOptimisticField) so an unrelated snapshot rebuild can't
  // flicker a toggle back mid-save.
  const permProp = useMemo(() => (Array.isArray(user.permissions) ? user.permissions : []), [user.permissions]);
  const permsF = useOptimisticField(permProp, sameStringSet);
  const roleF  = useOptimisticField(user.role || "");
  const stockF = useOptimisticField(user.stockRole || "");
  const destF  = useOptimisticField(user.destShop || "");
  const localPerms     = permsF.value;
  const localRole      = roleF.value;
  const localStockRole = stockF.value;
  const localDestShop  = destF.value;

  // Per-control save status → drives the "Saved ✓" pulse and inline spinners.
  // savedKeys is a Set so more than one control can show "Saved" at once — needed
  // when a single write touches two controls (e.g. a Stock toggle that also
  // auto-links the Stock level).
  const [savingKey,  setSavingKey]  = useState(null);
  const [savedKeys,  setSavedKeys]  = useState(() => new Set());
  const savedTimers = useRef({});
  const hintTimer   = useRef(null);
  useEffect(() => {
    const timers = savedTimers.current;
    return () => { Object.values(timers).forEach(clearTimeout); clearTimeout(hintTimer.current); };
  }, []);
  function flashSaved(key) {
    setSavedKeys((prev) => { const n = new Set(prev); n.add(key); return n; });
    clearTimeout(savedTimers.current[key]);
    savedTimers.current[key] = setTimeout(() => {
      setSavedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }, 1500);
  }

  // Persist a patch to /users/{uid} with per-control status. Returns true on
  // success; on failure surfaces a friendly error and returns false so callers
  // can roll their optimistic mirror back.
  async function writePatch(patch, statusKey) {
    setSavingKey(statusKey);
    try {
      await update(ref(database, `users/${user.uid}`), patch);
      setSavingKey((k) => (k === statusKey ? null : k));
      flashSaved(statusKey);
      return true;
    } catch (err) {
      console.error("UserDetail: writePatch failed:", err);
      setSavingKey((k) => (k === statusKey ? null : k));
      setError(friendlyError(err));
      return false;
    }
  }

  async function setDisplayName(displayName) {
    const v = displayName.trim();
    if (v === user.displayName || v.length === 0) return;
    await writePatch({ displayName: v }, "displayName");
  }

  // Tapping a role no longer just sets a label — it applies that role's whole
  // preset (permissions + stockRole). Confirm first because it overwrites any
  // custom toggles the account already has.
  function onTapRole(roleKey) {
    // Always prompt — Quick setup can be re-applied to reset the toggles even
    // when the account already carries that role.
    setPendingRole(roleKey);
  }
  async function applyRolePreset(roleKey) {
    const perms = ROLE_DEFAULT_PERMS[roleKey] || [];
    const stockRole = ROLE_STOCK_ROLE[roleKey] || "";
    setPendingRole(null);
    // No-op guard: if the account ALREADY exactly matches this preset, the
    // update() would write identical data, which fires NO RTDB snapshot — the
    // optimistic guards would then stay pending forever and swallow later
    // cross-device edits. The other controls short-circuit on equality; this one
    // must too. Just confirm visually and skip the write.
    if (roleKey === localRole && stockRole === localStockRole && sameStringSet(perms, localPerms)) {
      haptic(8);
      flashSaved("permissions"); flashSaved("stockRole");
      return;
    }
    const prev = { role: localRole, perms: localPerms, stock: localStockRole };
    roleF.setOptimistic(roleKey);
    permsF.setOptimistic(perms);   // toggles cascade to the preset (animated)
    stockF.setOptimistic(stockRole);
    haptic(12);
    const ok = await writePatch(
      { role: roleKey, permissions: perms, stockRole: stockRole || null },
      "role",
    );
    if (ok) { flashSaved("permissions"); flashSaved("stockRole"); }   // light every section the preset touched
    else    { roleF.revert(prev.role); permsF.revert(prev.perms); stockF.revert(prev.stock); }
  }

  async function togglePermission(permKey, on) {
    const prevPerms = localPerms;
    const prevStock = localStockRole;
    const next = on ? Array.from(new Set([...prevPerms, permKey])) : prevPerms.filter((p) => p !== permKey);
    permsF.setOptimistic(next);    // optimistic — instant
    haptic();

    const patch = { permissions: next };
    // AUTO-LINK: granting a stock permission with no stockRole would open the
    // screen but silently block every write. Set a sensible role so it works.
    let autoStock = null;
    if (on && STOCK_PERM_KEYS.includes(permKey) && !prevStock) {
      autoStock = stockRoleForRole(localRole);
      patch.stockRole = autoStock;
      stockF.setOptimistic(autoStock);
      const label = STOCK_WORK.find((r) => r.key === autoStock)?.label || autoStock;
      setStockHint(`Stock set to ${label} so this works`);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setStockHint(null), 3200);
    }

    const ok = await writePatch(patch, permKey);
    if (ok) { if (autoStock) flashSaved("stockRole"); }   // also confirm the auto-linked Stock level
    else {
      permsF.revert(prevPerms);
      if (autoStock) {              // undo the optimistic auto-link + its now-wrong hint
        stockF.revert(prevStock);
        clearTimeout(hintTimer.current);
        setStockHint(null);
      }
    }
  }

  async function setStockRole(stockRole) {
    if (stockRole === localStockRole) return;
    const prev = localStockRole;
    stockF.setOptimistic(stockRole);  // optimistic
    haptic();
    // Empty selection clears the field entirely (RTDB drops null) → no stock access.
    const ok = await writePatch({ stockRole: stockRole === "" ? null : stockRole }, "stockRole");
    if (!ok) stockF.revert(prev);
  }

  // Per-user single-shop assignment. "" clears the field (RTDB drops null) → no
  // restriction (all stores). A real shop id locks the user to that store — reads
  // of other stores' orders are rejected by the /orders rule.
  async function chooseDestShop(shop) {
    if (shop === localDestShop) return;
    const prev = localDestShop;
    destF.setOptimistic(shop);     // optimistic
    haptic();
    const ok = await writePatch({ destShop: shop === "" ? null : shop }, "destShop");
    if (!ok) destF.revert(prev);
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteStaffUserFn({ uid: user.uid });
      setShowConfirmDelete(false);
      onBack();   // back to list; the /users subscription will drop this row
    } catch (err) {
      console.error("UserDetail: delete failed:", err);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }
  async function handleResetPin(pin) {
    setBusy(true);
    setError(null);
    try {
      await updateStaffPasswordFn({ uid: user.uid, pin });
      setShowResetPin(false);
    } catch (err) {
      console.error("UserDetail: reset PIN failed:", err);
      setError(friendlyError(err));
      throw err;   // let the modal know
    } finally {
      setBusy(false);
    }
  }

  const permSet = new Set(localPerms);

  return (
    <>
      <TopBar title="Staff" onBack={onBack} />

      <div style={{ maxWidth: 600, margin: "0 auto", padding: "8px 16px 24px" }}>
        {error && <ErrorBanner onDismiss={() => setError(null)}>{error}</ErrorBanner>}

        {/* Identity card */}
        <div style={{ background: CARD, borderRadius: 12, padding: "20px 16px",
                      display: "flex", alignItems: "center", gap: 14, marginBottom: 22 }}>
          <AvatarCircle name={user.displayName} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <InlineEditField
              value={user.displayName || ""}
              onSave={setDisplayName}
              placeholder="Display name"
              style={{ fontSize: 19, fontWeight: 600, color: "#fff" }}
            />
            <div style={{ fontSize: 13, color: TEXT_2, marginTop: 2 }}>@{user.username}</div>
          </div>
        </div>

        {/* Quick setup — a helper, not a control. It only fills the toggles +
            stock work below; it grants nothing by itself. Kept visually light
            (ghost pills, "Quick setup" label) so it doesn't read as a second
            role selector competing with the toggles. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 4px 8px", marginTop: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: TEXT_2, letterSpacing: "0.04em", textTransform: "uppercase" }}>Quick setup</span>
          <span style={{ fontSize: 11, color: TEXT_3 }}>fills the toggles below</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
          {PRESETS.map((r) => (
            <button key={r.key}
                    onClick={() => onTapRole(r.key)}
                    style={{ flex: 1, minWidth: 92, padding: "9px 10px",
                             background: "transparent", border: `1px solid ${localRole === r.key ? BLUE : TEXT_3}`,
                             color: localRole === r.key ? BLUE_L : "#fff",
                             borderRadius: 999, fontSize: 13, fontWeight: 600, cursor: "pointer",
                             fontFamily: FONT, transition: "all 160ms cubic-bezier(.2,.9,.3,1)" }}>
              {r.label}
            </button>
          ))}
        </div>

        <SectionRow label="Permissions" saved={savedKeys.has("permissions") || ALL_PERMISSIONS.some((p) => savedKeys.has(p.key))} />
        {PERMISSION_GROUPS.map((group) => (
          <div key={group.title} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: TEXT_2, padding: "0 4px 6px", fontWeight: 600 }}>{group.title}</div>
            <div style={{ background: CARD, borderRadius: 12, overflow: "hidden" }}>
              {group.perms.map((p, i) => (
                <PermissionRow
                  key={p.key}
                  perm={p}
                  checked={permSet.has(p.key)}
                  saving={savingKey === p.key}
                  saved={savedKeys.has(p.key)}
                  onToggle={(next) => togglePermission(p.key, next)}
                  divider={i < group.perms.length - 1}
                />
              ))}
            </div>
          </div>
        ))}
        <div style={{ fontSize: 11, color: TEXT_2, padding: "2px 4px 0", marginBottom: 22, lineHeight: 1.5,
                      display: "flex", alignItems: "center", gap: 6 }}>
          <LockIcon /> Staff management is Super-Admin only and can't be granted here.
        </div>

        <SectionRow label="Stock — what they can change" hint="pick one" saved={savedKeys.has("stockRole")} saving={savingKey === "stockRole"} />
        <RadioList
          options={STOCK_WORK}
          value={localStockRole}
          onChange={setStockRole}
        />
        <div style={{ fontSize: 11, padding: "6px 4px 0", marginBottom: 22, lineHeight: 1.5,
                      color: stockHint ? GREEN : TEXT_2, transition: "color 200ms" }}>
          {stockHint || "The one thing that isn’t a toggle — you pick a single level, because the till & database enforce it as one. Auto-set when you switch on a Stock permission above."}
        </div>

        <SectionRow label="Store Access" saved={savedKeys.has("destShop")} saving={savingKey === "destShop"} />
        <div style={{ background: CARD, borderRadius: 12, overflow: "hidden", marginBottom: 8 }}>
          {[{ id: "", label: "All stores (no restriction)" },
            ...SHOP_IDS.map((id) => ({ id, label: SHOP_LABELS[id] }))].map((opt, i, arr) => {
            const on = (localDestShop || "") === opt.id;
            return (
              <div key={opt.id || "none"} onClick={() => chooseDestShop(opt.id)}
                   style={{ display: "flex", alignItems: "center", padding: "12px 16px", cursor: "pointer",
                            borderBottom: i < arr.length - 1 ? `1px solid ${DIVIDER}` : "none" }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 15, color: "#fff" }}>{opt.label}</div>
                <div style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                              border: `2px solid ${on ? BLUE : DIVIDER}`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              transition: "border-color 160ms" }}>
                  {on && <div style={{ width: 10, height: 10, borderRadius: "50%", background: BLUE }} />}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: TEXT_2, padding: "0 4px", marginBottom: 22, lineHeight: 1.5 }}>
          {localDestShop
            ? <>Sees &amp; acts on <span style={{ color: BLUE_L }}>{SHOP_LABELS[localDestShop]}</span> orders only — enforced at the database. Keep warehouse &amp; admin on “All stores”.</>
            : "All stores — no restriction (correct for warehouse & admin). Pick a shop to lock a store assistant to one store."}
        </div>

        <SectionRow label="Security" />
        <div style={{ background: CARD, borderRadius: 12, overflow: "hidden", marginBottom: 32 }}>
          <button onClick={() => setShowResetPin(true)}
                  style={tappableRow}>
            <span style={{ color: BLUE }}>Reset PIN</span>
            <ChevronRight />
          </button>
        </div>

        {/* Danger zone */}
        <button onClick={() => setShowConfirmDelete(true)}
                style={{ ...tappableRow, background: CARD, borderRadius: 12, color: RED, fontWeight: 500 }}>
          Delete user
        </button>
      </div>

      {pendingRole && (
        <ConfirmDialog
          title={`Apply the ${ROLES.find((r) => r.key === pendingRole)?.label || pendingRole} preset?`}
          body="This replaces the current permissions and stock role with the ones for that role. You can still fine-tune afterwards."
          confirmLabel="Apply preset"
          onConfirm={() => applyRolePreset(pendingRole)}
          onCancel={() => setPendingRole(null)}
        />
      )}
      {showResetPin && (
        <ResetPinModal
          userName={user.displayName}
          busy={busy}
          onClose={() => setShowResetPin(false)}
          onSave={handleResetPin}
        />
      )}
      {showConfirmDelete && (
        <ConfirmDialog
          title={`Delete ${user.displayName}?`}
          body="This cannot be undone. They will lose access immediately."
          confirmLabel={busy ? "Deleting…" : "Delete"}
          danger
          busy={busy}
          onConfirm={handleDelete}
          onCancel={() => setShowConfirmDelete(false)}
        />
      )}
    </>
  );
}

function TopBar({ title, onBack }) {
  return (
    <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(0,0,0,.85)", backdropFilter: "blur(10px)",
                  borderBottom: `1px solid ${DIVIDER}`, padding: "12px 16px",
                  display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <button onClick={onBack} style={{ ...linkBtn, display: "flex", alignItems: "center", gap: 2 }}>
        <ChevronLeft /> Staff
      </button>
      <div style={{ fontSize: 17, fontWeight: 600 }}>{title}</div>
      <div style={{ width: 50 }} />
    </div>
  );
}

// Section header with an inline, self-clearing "Saved ✓" confirmation so every
// auto-save is visibly acknowledged (the old editor gave zero feedback, which is
// what made granting feel like nothing happened).
function SectionRow({ label, hint, saved, saving }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 4px 6px", marginTop: 6 }}>
      <div style={{ fontSize: 11, color: TEXT_2, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </div>
      {hint && <div style={{ fontSize: 11, color: TEXT_3 }}>{hint}</div>}
      <div style={{ flex: 1 }} />
      <SavedChip saved={saved} saving={saving} />
    </div>
  );
}

function SavedChip({ saved, saving }) {
  if (saving) {
    return <span style={{ fontSize: 10.5, color: TEXT_2, opacity: 0.9 }}>Saving…</span>;
  }
  return (
    <span style={{ fontSize: 10.5, color: GREEN, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 3,
                   opacity: saved ? 1 : 0, transform: saved ? "translateY(0)" : "translateY(-2px)",
                   transition: "opacity 220ms, transform 220ms" }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="3.5"
           strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
      Saved
    </span>
  );
}

// Single-choice list (radio). The visual counterpart to a group of Toggles:
// toggles = independent on/off, radios = pick exactly one. Used for the two
// pick-one settings (Stock work, Store access).
function RadioList({ options, value, onChange, bg = CARD }) {
  return (
    <div style={{ background: bg, borderRadius: 12, overflow: "hidden" }}>
      {options.map((opt, i) => {
        const on = (value || "") === (opt.key || "");
        return (
          <div key={opt.key || "none"} onClick={() => onChange(opt.key)}
               style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", cursor: "pointer",
                        borderBottom: i < options.length - 1 ? `1px solid ${DIVIDER}` : "none" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, color: "#fff" }}>{opt.label}</div>
              {opt.desc && <div style={{ fontSize: 12, color: TEXT_2, marginTop: 1 }}>{opt.desc}</div>}
            </div>
            <div style={{ width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                          border: `2px solid ${on ? BLUE : DIVIDER}`,
                          display: "flex", alignItems: "center", justifyContent: "center", transition: "border-color 160ms" }}>
              {on && <div style={{ width: 10, height: 10, borderRadius: "50%", background: BLUE }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function InlineEditField({ value, onSave, placeholder, style }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) {
    return (
      <div onClick={() => setEditing(true)} style={{ ...style, cursor: "text" }}>
        {value || <span style={{ color: TEXT_2 }}>{placeholder}</span>}
      </div>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value.slice(0, 50))}
      onBlur={async () => { setEditing(false); await onSave(draft); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
      style={{ ...style, background: "rgba(60,110,255,.08)", border: `1px solid ${BLUE}`,
               borderRadius: 6, padding: "2px 6px", outline: "none", width: "100%", boxSizing: "border-box",
               fontFamily: FONT }}
    />
  );
}

function PermissionRow({ perm, checked, onToggle, saving, saved, divider }) {
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "11px 16px", gap: 12,
                  borderBottom: divider ? `1px solid ${DIVIDER}` : "none" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: "#fff", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {perm.label}
          {perm.sensitive && <span style={{ fontSize: 9.5, color: RED, border: `1px solid ${RED}`,
                                            padding: "0 4px", borderRadius: 3, fontWeight: 600 }}>SENSITIVE</span>}
          <span style={{ fontSize: 10, color: GREEN, fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 2,
                         opacity: saved ? 1 : 0, transition: "opacity 200ms" }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={GREEN} strokeWidth="4"
                 strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </span>
        </div>
        <div style={{ fontSize: 12, color: TEXT_2, marginTop: 1 }}>{perm.desc}</div>
      </div>
      <Toggle on={checked} onChange={onToggle} busy={saving} />
    </div>
  );
}

// iOS-style switch. Springs on the thumb + colour-fades the track. This is the
// core "give it life" control — it flips the instant it's tapped (the parent
// mirror is optimistic), so there's no dead round-trip wait like the old checkbox.
function Toggle({ on, onChange, busy, disabled }) {
  const [press, setPress] = useState(false);
  return (
    <button type="button"
            role="switch"
            aria-checked={on}
            disabled={disabled}
            onMouseDown={() => setPress(true)}
            onMouseUp={() => setPress(false)}
            onMouseLeave={() => setPress(false)}
            onTouchStart={() => setPress(true)}
            onTouchEnd={() => setPress(false)}
            onClick={() => { if (!disabled) onChange(!on); }}
            style={{ width: 51, height: 31, borderRadius: 999, border: "none", padding: 0, position: "relative",
                     flexShrink: 0, cursor: disabled ? "default" : "pointer",
                     background: on ? GREEN : "#39393d",
                     opacity: disabled ? 0.5 : 1,
                     transition: "background 260ms cubic-bezier(.4,0,.2,1)" }}>
      <span style={{ position: "absolute", top: 2, left: 2, height: 27,
                     width: press ? 31 : 27,                         // squish on press
                     // keep the thumb pinned to the right edge when on + pressed
                     transform: on ? `translateX(${press ? 17 : 20}px)` : "translateX(0)",
                     borderRadius: 999, background: "#fff",
                     boxShadow: "0 2px 5px rgba(0,0,0,.35), 0 1px 1px rgba(0,0,0,.25)",
                     transition: "transform 300ms cubic-bezier(.2,1.2,.4,1), width 180ms ease",
                     display: "flex", alignItems: "center", justifyContent: "center" }}>
        {busy && <span style={{ width: 8, height: 8, borderRadius: "50%",
                                border: "2px solid rgba(0,0,0,.25)", borderTopColor: "rgba(0,0,0,.55)",
                                animation: "umSpin .6s linear infinite" }} />}
      </span>
    </button>
  );
}

// ─── Reset PIN modal ─────────────────────────────────────────────────────────

function ResetPinModal({ userName, busy, onClose, onSave }) {
  const [pin,    setPin]    = useState("");
  const [error,  setError]  = useState(null);
  const canSave = /^\d{4}$/.test(pin) && !busy;

  async function submit(e) {
    e?.preventDefault?.();
    if (!canSave) return;
    setError(null);
    try {
      await onSave(pin);
    } catch (err) {
      setError(friendlyError(err));
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <form onSubmit={submit}>
        <div style={modalTitle}>Reset PIN for {userName}</div>
        <div style={{ color: TEXT_2, fontSize: 13, marginBottom: 16 }}>
          Enter a new 4-digit PIN. They will sign in with this PIN immediately.
        </div>
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="••••"
          style={{ ...textInput, letterSpacing: "0.4em", textAlign: "center", fontSize: 22 }}
        />
        {error && <div style={{ marginTop: 10, color: RED, fontSize: 12 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
          <button type="submit" disabled={!canSave}
                  style={{ ...primaryBtn, flex: 1, opacity: canSave ? 1 : 0.45, cursor: canSave ? "pointer" : "default" }}>
            {busy ? "Saving…" : "Save PIN"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ─── Add Staff modal ─────────────────────────────────────────────────────────

function AddStaffModal({ onClose, onCreated }) {
  const [displayName, setDisplayName] = useState("");
  const [username,    setUsername]    = useState("");
  const [pin,         setPin]         = useState("");
  const [role,        setRole]        = useState("store_assistant");
  const [permissions, setPermissions] = useState(() => ROLE_DEFAULT_PERMS.store_assistant.slice());
  const [stockRole,   setStockRole]   = useState(ROLE_STOCK_ROLE.store_assistant || "");
  const [stockTouched, setStockTouched] = useState(false);   // once the admin picks a stock role, stop auto-following the role
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState(null);
  const [fieldErr,    setFieldErr]    = useState({});

  function changeRole(next) {
    setRole(next);
    setPermissions(ROLE_DEFAULT_PERMS[next].slice());
    if (!stockTouched) setStockRole(ROLE_STOCK_ROLE[next] || "");
  }
  function togglePerm(key) {
    const on = !permissions.includes(key);
    setPermissions((prev) => (on ? [...prev, key] : prev.filter((p) => p !== key)));
    // Auto-link stock role on first stock grant (mirrors the detail editor).
    if (on && STOCK_PERM_KEYS.includes(key) && !stockRole && !stockTouched) {
      setStockRole(stockRoleForRole(role));
    }
    haptic();
  }

  const usernameValid    = /^[a-z0-9_]{1,30}$/.test(username);
  const displayNameValid = displayName.trim().length >= 1 && displayName.length <= 50;
  const pinValid         = /^\d{4}$/.test(pin);
  const canSubmit        = !busy && usernameValid && displayNameValid && pinValid;
  const permSet          = new Set(permissions);

  async function submit(e) {
    e?.preventDefault?.();
    if (!canSubmit) return;
    setError(null);
    setFieldErr({});
    setBusy(true);
    try {
      const result = await createStaffUserFn({
        username,
        displayName: displayName.trim(),
        pin,
        role,
        permissions,
        stockRole,
      });
      onCreated(result.data?.uid);
    } catch (err) {
      console.error("AddStaff: createStaffUser failed:", err);
      const msg = friendlyError(err);
      if (err?.code?.includes("already-exists")) {
        setFieldErr({ username: "Username already taken." });
      } else {
        setError(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose}>
      <form onSubmit={submit}>
        <div style={modalTitle}>Add staff</div>

        <FormField label="Display name" hint="What others see in lists">
          <input
            autoFocus
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value.slice(0, 50))}
            style={textInput}
            placeholder="e.g. Sipho Ndlovu"
            maxLength={50}
          />
        </FormField>

        <FormField label="Username" hint="Lowercase, letters, numbers, underscores. Used for sign-in." error={fieldErr.username}>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30))}
            style={textInput}
            placeholder="e.g. sipho"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </FormField>

        <FormField label="PIN" hint="4 digits. They use this to sign in.">
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            placeholder="••••"
            style={{ ...textInput, letterSpacing: "0.4em" }}
          />
        </FormField>

        <FormField label="Quick setup" hint="Fills the permissions & stock below with a typical set — adjust anything after.">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {PRESETS.map((r) => (
              <button key={r.key} type="button"
                      onClick={() => changeRole(r.key)}
                      style={{ flex: 1, minWidth: 88, padding: "8px 10px",
                               background: "transparent", border: `1px solid ${role === r.key ? BLUE : TEXT_3}`,
                               color: role === r.key ? BLUE_L : "#fff",
                               borderRadius: 999, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
                               fontFamily: FONT, transition: "all 150ms" }}>
                {r.label}
              </button>
            ))}
          </div>
        </FormField>

        <FormField label="Stock — what they can change" hint="Pick one — lets them actually change inventory (auto-set from Quick setup & Stock permissions).">
          <RadioList
            options={STOCK_WORK}
            value={stockRole}
            onChange={(k) => { setStockRole(k); setStockTouched(true); }}
            bg="#2c2c2e"
          />
        </FormField>

        <FormField label="Permissions" hint="Defaults are based on role. Adjust as needed.">
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.title} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10.5, color: TEXT_2, padding: "2px 2px 4px", fontWeight: 600 }}>{group.title}</div>
              <div style={{ background: "#2c2c2e", borderRadius: 9, overflow: "hidden" }}>
                {group.perms.map((p, i) => (
                  <div key={p.key}
                       onClick={() => togglePerm(p.key)}
                       style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                                borderBottom: i < group.perms.length - 1 ? `1px solid ${DIVIDER}` : "none",
                                cursor: "pointer" }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>
                        {p.label}
                        {p.sensitive && <span style={{ fontSize: 9, color: RED, border: `1px solid ${RED}`,
                                                    padding: "0 4px", borderRadius: 3 }}>SENSITIVE</span>}
                      </div>
                      <div style={{ fontSize: 11, color: TEXT_2, marginTop: 1 }}>{p.desc}</div>
                    </div>
                    {/* Stop click bubbling so the row's onClick doesn't fire a
                        second time and net the toggle back to its old value. */}
                    <div onClick={(e) => e.stopPropagation()}>
                      <Toggle on={permSet.has(p.key)} onChange={() => togglePerm(p.key)} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </FormField>

        {error && <div style={{ marginTop: 4, padding: "8px 10px", background: "rgba(255,69,58,.1)",
                                 border: `1px solid ${RED}`, borderRadius: 8, color: RED, fontSize: 13 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={{ ...secondaryBtn, flex: 1 }}>Cancel</button>
          <button type="submit" disabled={!canSubmit}
                  style={{ ...primaryBtn, flex: 1.4, opacity: canSubmit ? 1 : 0.45, cursor: canSubmit ? "pointer" : "default" }}>
            {busy ? "Creating…" : "Create staff"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function FormField({ label, hint, error, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: TEXT_2, marginBottom: 4, letterSpacing: "0.05em", textTransform: "uppercase" }}>
        {label}
      </div>
      {children}
      {hint && !error && <div style={{ fontSize: 11, color: TEXT_2, marginTop: 4 }}>{hint}</div>}
      {error && <div style={{ fontSize: 12, color: RED, marginTop: 4 }}>{error}</div>}
    </div>
  );
}

// ─── Confirm dialog ──────────────────────────────────────────────────────────

function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onCancel }) {
  return (
    <ModalShell onClose={busy ? null : onCancel} narrow>
      <div style={{ ...modalTitle, marginBottom: 8 }}>{title}</div>
      <div style={{ color: TEXT_2, fontSize: 13, marginBottom: 18 }}>{body}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={onCancel} disabled={busy} style={{ ...secondaryBtn, flex: 1, opacity: busy ? 0.5 : 1 }}>
          Cancel
        </button>
        <button onClick={onConfirm} disabled={busy}
                style={{ ...(danger ? dangerBtn : primaryBtn), flex: 1, cursor: busy ? "default" : "pointer" }}>
          {confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// ─── Shared shell / banners ──────────────────────────────────────────────────

function ModalShell({ onClose, narrow, children }) {
  return (
    <div onClick={onClose || undefined}
         style={{ position: "fixed", inset: 0, zIndex: 10000,
                  background: "rgba(0,0,0,.65)", backdropFilter: "blur(6px)",
                  display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ width: "100%", maxWidth: narrow ? 340 : 420,
                    background: "#1c1c1e", border: `1px solid ${DIVIDER}`,
                    borderRadius: 16, padding: 20, fontFamily: FONT, color: "#fff",
                    maxHeight: "85vh", overflowY: "auto" }}>
        {children}
      </div>
    </div>
  );
}

function ErrorBanner({ children, onDismiss }) {
  return (
    <div style={{ background: "rgba(255,69,58,.1)", border: `1px solid ${RED}`,
                  borderRadius: 10, padding: "10px 12px", color: RED, fontSize: 13,
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                  marginBottom: 16 }}>
      <div style={{ flex: 1 }}>{children}</div>
      <button onClick={onDismiss} style={{ background: "transparent", border: "none", color: RED, cursor: "pointer", fontSize: 18, padding: "0 4px" }}>×</button>
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function ChevronRight() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke={TEXT_3} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="2 2 8 8 2 14"/>
    </svg>
  );
}
function ChevronLeft() {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="8 2 2 8 8 14"/>
    </svg>
  );
}
function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={TEXT_2} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

// ─── Inline style presets ────────────────────────────────────────────────────

const linkBtn      = { background: "transparent", border: "none", color: BLUE, cursor: "pointer", fontSize: 15, padding: "4px 4px", fontFamily: FONT };
const primaryBtn   = { background: BLUE, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: FONT };
const secondaryBtn = { background: "transparent", border: `1px solid ${TEXT_3}`, color: "#fff", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: FONT };
const dangerBtn    = { background: RED, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: FONT };
const tappableRow  = { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", background: "transparent", border: "none", color: "#fff", cursor: "pointer", fontSize: 15, fontFamily: FONT };
const textInput    = { width: "100%", boxSizing: "border-box", background: "#2c2c2e", border: "none", borderRadius: 9, padding: "10px 12px", color: "#fff", fontSize: 15, fontFamily: FONT, outline: "none" };
const modalTitle   = { fontSize: 17, fontWeight: 600, marginBottom: 6 };
