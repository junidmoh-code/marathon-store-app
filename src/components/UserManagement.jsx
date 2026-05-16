// ─────────────────────────────────────────────────────────────────────────────
// User Management (super-admin only) — /#admin/users
// ─────────────────────────────────────────────────────────────────────────────
// Master-detail UI for staff account lifecycle. Gated on the super-admin email
// gunidmoh@gmail.com (matches the gate used by AdminSignInScreen in App.jsx and
// the assertAdmin helper in functions/index.js).
//
// Architecture:
//   • List view: subscribe to /users, render sorted by displayName.
//   • Detail view (hash-routed at /#admin/users/{uid}): inline-edit displayName,
//     segmented role, per-permission checkboxes — all auto-save via direct RTDB
//     updates. Reset PIN + Delete go through Cloud Functions.
//   • Add Staff modal: collects fields, calls createStaffUser, navigates to the
//     new user's detail page on success.
//
// Cloud Functions (europe-west1, mirrors analyzeReorderNeeds region):
//   createStaffUser, deleteStaffUser, updateStaffPassword.
// Permission toggles bypass the Cloud Function — RTDB rules already require
// auth on /users writes, and the UI is super-admin gated.

import { useState, useEffect, useMemo, useRef } from "react";
import { ref, onValue, update, remove } from "firebase/database";
import { httpsCallable } from "firebase/functions";
import { database, functions } from "../firebase";

const ADMIN_EMAIL = "gunidmoh@gmail.com";

// ─── Design tokens (iOS-Dark-Mode grouped-list aesthetic) ────────────────────
const FONT       = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif";
const BG         = "#000";
const CARD       = "#1c1c1e";              // iOS grouped-list bg
const CARD_HOVER = "#2c2c2e";
const DIVIDER    = "rgba(84,84,88,.6)";
const BLUE       = "#4A7FFF";
const BLUE_L     = "#6A9FFF";
const RED        = "#FF453A";
const TEXT_2     = "#8e8e93";
const TEXT_3     = "#3a3a3c";

// ─── Permissions catalog — the 10 editable permission flags ──────────────────
const ALL_PERMISSIONS = [
  { key: "store_assistant", label: "Store Assistant",     desc: "Place customer orders" },
  { key: "warehouse",       label: "Warehouse",           desc: "Manage order queue" },
  { key: "source",          label: "Source",              desc: "Restock requests" },
  { key: "display_refills", label: "Display Refills",     desc: "Refill display items" },
  { key: "place_orders",    label: "Place Orders & Returns", desc: "Take orders, log returns" },
  { key: "product_admin",   label: "Product Admin",       desc: "Products, TV display, customer view" },
  { key: "insights",        label: "Insights",            desc: "Business analytics" },
  { key: "broadcast",       label: "Group Broadcast",     desc: "Send WhatsApp broadcasts" },
  { key: "customer_data",   label: "Customer Database",   desc: "View customer records" },
  { key: "user_management", label: "User Management",     desc: "Create / edit / delete staff", warn: true },
];

const ROLES = [
  { key: "admin",           label: "Admin" },
  { key: "store_assistant", label: "Store Asst" },
  { key: "warehouse",       label: "Warehouse" },
];

// Defaults for the Add Staff form when role changes. Matches scripts/seedUsers.cjs.
const ROLE_DEFAULT_PERMS = {
  admin:           ["store_assistant", "warehouse", "display_refills", "place_orders", "product_admin", "source"],
  store_assistant: ["store_assistant", "display_refills", "place_orders"],
  warehouse:       ["warehouse", "display_refills", "source"],
};

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

export default function UserManagement({ authUser, onExit }) {
  const [users,     setUsers]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [route,     setRoute]     = useState(() => parseHash() || { view: "list", uid: null });
  const [showAdd,   setShowAdd]   = useState(false);
  const listScrollRef = useRef(0);

  // /users subscription
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

  // Gate (defense in depth — the route mount in App.jsx is already gated)
  if (!authUser || authUser.email !== ADMIN_EMAIL) {
    return <NotAuthorized onExit={onExit} />;
  }

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

  return (
    <div style={{ minHeight: "100vh", background: BG, color: "#fff", fontFamily: FONT, paddingBottom: 60 }}>
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
  // and a centred small "Staff" label — leaves the top-right corner free for the
  // globally-fixed UserIndicator pill (Signed in: gunidmoh · Sign Out, zIndex
  // 9998). The "+ Add staff" action lives in a dedicated large-title row below
  // the bar, where it can't be covered by that pill at any viewport width.
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
                  transition: "background 80ms",
                  width: "100%", textAlign: "left",
                  border: "none", color: "inherit", font: "inherit",
                  appearance: "none" }}>
      <AvatarCircle name={user.displayName} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {user.displayName || "(no name)"}
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

// ─── Detail view ─────────────────────────────────────────────────────────────

function UserDetailView({ user, onBack }) {
  const [showResetPin,    setShowResetPin]    = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [error, setError] = useState(null);
  const [busy,  setBusy]  = useState(false);
  const [pendingWarnFor, setPendingWarnFor] = useState(null); // permission key awaiting warn-confirm

  // Save a single field directly to RTDB
  async function saveField(field, value) {
    try {
      await update(ref(database, `users/${user.uid}`), { [field]: value });
    } catch (err) {
      console.error("UserDetail: saveField failed:", err);
      setError(friendlyError(err));
    }
  }
  async function setRole(role) {
    if (role === user.role) return;
    await saveField("role", role);
  }
  async function setDisplayName(displayName) {
    if (displayName === user.displayName || displayName.trim().length === 0) return;
    await saveField("displayName", displayName.trim());
  }
  async function togglePermission(permKey, on) {
    const current = Array.isArray(user.permissions) ? user.permissions : [];
    const next = on ? Array.from(new Set([...current, permKey])) : current.filter((p) => p !== permKey);
    await saveField("permissions", next);
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

        <SectionLabel>Role</SectionLabel>
        <div style={{ background: CARD, borderRadius: 12, padding: 4, marginBottom: 22,
                      display: "flex", gap: 2 }}>
          {ROLES.map((r) => (
            <button key={r.key}
                    onClick={() => setRole(r.key)}
                    style={{ flex: 1, padding: "8px 6px", border: "none",
                             background: user.role === r.key ? "#48484a" : "transparent",
                             color: user.role === r.key ? "#fff" : TEXT_2,
                             borderRadius: 9, fontSize: 13, fontWeight: 500, cursor: "pointer",
                             transition: "all 120ms" }}>
              {r.label}
            </button>
          ))}
        </div>

        <SectionLabel>Permissions</SectionLabel>
        <div style={{ background: CARD, borderRadius: 12, overflow: "hidden", marginBottom: 22 }}>
          {ALL_PERMISSIONS.map((p, i) => {
            const on = (user.permissions || []).includes(p.key);
            return (
              <PermissionRow
                key={p.key}
                perm={p}
                checked={on}
                onToggle={(next) => {
                  if (p.warn && next) {
                    // Show inline warn-and-confirm in the row
                    setPendingWarnFor(p.key);
                  } else {
                    togglePermission(p.key, next);
                  }
                }}
                pendingWarn={pendingWarnFor === p.key}
                onWarnConfirm={() => { togglePermission(p.key, true); setPendingWarnFor(null); }}
                onWarnCancel={() => setPendingWarnFor(null)}
                divider={i < ALL_PERMISSIONS.length - 1}
              />
            );
          })}
        </div>

        <SectionLabel>Security</SectionLabel>
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

function SectionLabel({ children }) {
  return (
    <div style={{ fontSize: 11, color: TEXT_2, letterSpacing: "0.05em", textTransform: "uppercase",
                  padding: "0 4px 6px", marginTop: 6 }}>
      {children}
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

function PermissionRow({ perm, checked, onToggle, pendingWarn, onWarnConfirm, onWarnCancel, divider }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", padding: "12px 16px",
                    borderBottom: divider && !pendingWarn ? `1px solid ${DIVIDER}` : "none" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>
            {perm.label}
            {perm.warn && <span style={{ fontSize: 10, color: RED, border: `1px solid ${RED}`,
                                          padding: "1px 5px", borderRadius: 4 }}>SENSITIVE</span>}
          </div>
          <div style={{ fontSize: 12, color: TEXT_2, marginTop: 1 }}>{perm.desc}</div>
        </div>
        <Checkbox checked={checked} onChange={onToggle} />
      </div>
      {pendingWarn && (
        <div style={{ padding: "10px 16px 12px", background: "rgba(255,69,58,.08)",
                      borderBottom: divider ? `1px solid ${DIVIDER}` : "none" }}>
          <div style={{ fontSize: 12, color: RED, marginBottom: 8 }}>
            Granting User Management lets this account create, edit, and delete other staff accounts. Continue?
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onWarnCancel}
                    style={{ ...smallBtn, background: "transparent", border: `1px solid ${TEXT_3}`, color: "#fff" }}>
              Cancel
            </button>
            <button onClick={onWarnConfirm}
                    style={{ ...smallBtn, background: RED, color: "#fff", border: "none" }}>
              Grant anyway
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Checkbox({ checked, onChange }) {
  return (
    <button onClick={() => onChange(!checked)}
            style={{ width: 22, height: 22, borderRadius: 6,
                     background: checked ? BLUE : "transparent",
                     border: checked ? `1px solid ${BLUE}` : `1.5px solid ${TEXT_3}`,
                     display: "flex", alignItems: "center", justifyContent: "center",
                     cursor: "pointer", padding: 0, flexShrink: 0 }}>
      {checked && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"
             strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      )}
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
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState(null);
  const [fieldErr,    setFieldErr]    = useState({});

  function changeRole(next) {
    setRole(next);
    setPermissions(ROLE_DEFAULT_PERMS[next].slice());
  }
  function togglePerm(key) {
    setPermissions((prev) => prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]);
  }

  const usernameValid    = /^[a-z0-9_]{1,30}$/.test(username);
  const displayNameValid = displayName.trim().length >= 1 && displayName.length <= 50;
  const pinValid         = /^\d{4}$/.test(pin);
  const canSubmit        = !busy && usernameValid && displayNameValid && pinValid;

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

        <FormField label="Role">
          <div style={{ background: "#2c2c2e", borderRadius: 9, padding: 3, display: "flex", gap: 2 }}>
            {ROLES.map((r) => (
              <button key={r.key} type="button"
                      onClick={() => changeRole(r.key)}
                      style={{ flex: 1, padding: "6px 4px", border: "none",
                               background: role === r.key ? "#48484a" : "transparent",
                               color: role === r.key ? "#fff" : TEXT_2,
                               borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
                {r.label}
              </button>
            ))}
          </div>
        </FormField>

        <FormField label="Permissions" hint="Defaults are based on role. Adjust as needed.">
          <div style={{ background: "#2c2c2e", borderRadius: 9, overflow: "hidden" }}>
            {ALL_PERMISSIONS.map((p, i) => {
              const on = permissions.includes(p.key);
              return (
                <div key={p.key}
                     onClick={() => togglePerm(p.key)}
                     style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px",
                              borderBottom: i < ALL_PERMISSIONS.length - 1 ? `1px solid ${DIVIDER}` : "none",
                              cursor: "pointer" }}>
                  {/* Stop click bubbling so the row's onClick doesn't fire a
                      second time and net the toggle back to its old value. */}
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={on} onChange={() => togglePerm(p.key)} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: "#fff", display: "flex", alignItems: "center", gap: 6 }}>
                      {p.label}
                      {p.warn && <span style={{ fontSize: 9, color: RED, border: `1px solid ${RED}`,
                                                  padding: "0 4px", borderRadius: 3 }}>SENSITIVE</span>}
                    </div>
                    <div style={{ fontSize: 11, color: TEXT_2, marginTop: 1 }}>{p.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
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

// ─── Inline style presets ────────────────────────────────────────────────────

const linkBtn      = { background: "transparent", border: "none", color: BLUE, cursor: "pointer", fontSize: 15, padding: "4px 4px", fontFamily: FONT };
const primaryBtn   = { background: BLUE, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: FONT };
const secondaryBtn = { background: "transparent", border: `1px solid ${TEXT_3}`, color: "#fff", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 500, cursor: "pointer", fontFamily: FONT };
const dangerBtn    = { background: RED, color: "#fff", border: "none", borderRadius: 10, padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: FONT };
const smallBtn     = { borderRadius: 8, padding: "5px 10px", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: FONT };
const tappableRow  = { width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", background: "transparent", border: "none", color: "#fff", cursor: "pointer", fontSize: 15, fontFamily: FONT };
const textInput    = { width: "100%", boxSizing: "border-box", background: "#2c2c2e", border: "none", borderRadius: 9, padding: "10px 12px", color: "#fff", fontSize: 15, fontFamily: FONT, outline: "none" };
const modalTitle   = { fontSize: 17, fontWeight: 600, marginBottom: 6 };
