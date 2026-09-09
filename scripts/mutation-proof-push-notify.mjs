// ─── MUTATION PROOF HARNESS — order push notifications ───────────────────────
// For each guard: reintroduce the bug, prove the suite FAILS, restore the file,
// prove it PASSES. A test that cannot fail proves nothing, so this runs the
// whole cycle and refuses to report a pass it did not watch break first.
//
// Same discipline as scripts/mutation-proof-hold-notify.mjs — ERROR is not FAIL,
// unique anchors, signal-safe restore, clean-tree preflight — and the same two
// runners, because this feature spans both halves: the client resolves who is
// subscribed (vitest) and the server fans out (node --test).
//
// The guard the owner named specifically for this release is A1 (NO ASSIGNMENT
// MEANS NOTHING IS SENT — deleting it must go red), alongside M7/M8 (dead-token
// pruning), which predate it. The rest are here because
// each is a way this feature fails LOUDLY at a staff member and quietly in the
// logs: a sweep firing four hundred notifications, a redelivery double-sending,
// a RECYCLED order id swallowing tomorrow's real order as a replay, shadow
// orders notifying forever about work nobody will ever do.
//
// Run:  node scripts/mutation-proof-push-notify.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { requireCleanTree } from "./lib/mutationPreflight.mjs";

const PUSH = "functions/lib/order-push.cjs";
const ASSIGN = "src/push/pushAssignments.js";
const ASSIGN_TESTS = ["src/push/pushAssignments.test.js", "src/push/PushAssignmentsCard.gate.test.jsx"];
const RULES_TESTS = ["src/push/pushAssignmentRules.test.js"];
const SERVER_TESTS = ["test/order-push.test.cjs"];
const CHIME = "src/push/chime.js";
const FOREGROUND = "src/push/useForegroundPush.js";
const FOREGROUND_TESTS = ["src/push/foregroundBanner.test.jsx"];
const CHIME_TESTS = ["src/push/chime.test.js"];
const DEEPLINK = "src/push/deepLink.js";
const DEEPLINK_TESTS = ["src/push/deepLink.test.js"];
const FOCUS = "src/push/useFocusOrder.js";
const FOCUS_TESTS = ["src/push/focusOrder.test.jsx"];
const MUTE = "src/push/pushMute.js";
const MUTE_TESTS = ["src/push/pushMute.test.js"];
const MUTE_RULES_TESTS = ["src/push/pushMuteRules.test.js"];
const HOOK = "src/push/usePush.js";
const HOOK_TESTS = ["src/push/pushPermission.test.jsx"];
const ROW = "src/push/NotificationSettingsRow.jsx";
const ROW_TESTS = ["src/push/muteToggle.test.jsx"];
const MUTE_HOOK_TESTS = ["src/push/useMute.test.jsx"];
const CARD = "src/push/PushAssignmentsCard.jsx";
const CARD_TESTS = ["src/push/PushAssignmentsCard.gate.test.jsx"];

const MUTATIONS = [
  // ── THE PERSONAL TOGGLE IS GONE (2026-09-07) ──────────────────────────────
  // M1–M5 guarded src/push/notificationPrefs.js: the default-on role rule, the
  // explicit-off override, the dirty-account fallback. That module was deleted
  // with the switch it drove — notifications are ADMIN-ASSIGNED and HUB-SCOPED
  // now, and the default for everyone is OFF. The guards that replaced them are
  // A1–A6 below (src/push/pushAssignments.js) and S1–S4 (the scoped fan-out):
  // an absent record means nothing is sent, and no other field may be read as
  // consent.

  // ── ADMIN-ASSIGNED, HUB-SCOPED (2026-09-07) ───────────────────────────────
  // A1 is the guard the owner named: absence of an assignment MUST mean nothing
  // is sent. The rest are the ways that sentence quietly stops being true.
  {
    id: "A1",
    guard: "ABSENCE IS OFF — no assignment record means no hubs, whatever else the record carries",
    file: ASSIGN,
    from: `  return PUSH_HUBS.filter((hub) => record[hub] === true);`,
    to: `  return PUSH_HUBS.filter((hub) => record[hub] === true || record.stockRole === "warehouse");`,
    tests: ASSIGN_TESTS,
  },
  {
    id: "A2",
    guard: "Only a REAL boolean counts — a stray string must degrade to silence, not to consent",
    file: ASSIGN,
    from: `  return PUSH_HUBS.filter((hub) => record[hub] === true);`,
    to: `  return PUSH_HUBS.filter((hub) => !!record[hub]);`,
    tests: ASSIGN_TESTS,
  },
  {
    id: "A3",
    guard: "EVERY hub is written on every save — the ones being turned OFF must be nulled",
    file: ASSIGN,
    from: `    upd[pushHubAudienceEntryPath(hub, uid)] = want.has(hub) ? { at: nowMs } : null;`,
    to: `    if (want.has(hub)) upd[pushHubAudienceEntryPath(hub, uid)] = { at: nowMs };`,
    tests: ASSIGN_TESTS,
  },
  {
    id: "A4",
    guard: "Clearing DELETES the record — off is absence, never a stored row of falses",
    file: ASSIGN,
    // ANCHOR REPAIRED 2026-09-09. It still named the two-hub object literal
    // that #583 replaced with a PUSH_HUBS.reduce, so it had been reporting
    // ANCHOR NOT FOUND — a guard silently not run, in a harness whose whole
    // purpose is to refuse a pass it did not watch break.
    from: `  upd[pushAssignmentPath(uid)] = want.size
    ? PUSH_HUBS.reduce((rec, hub) => { rec[hub] = want.has(hub); return rec; },
                       { updatedAt: nowMs })
    : null;`,
    to: `  upd[pushAssignmentPath(uid)] = PUSH_HUBS.reduce((rec, hub) => { rec[hub] = want.has(hub); return rec; },
                       { updatedAt: nowMs });`,
    tests: ASSIGN_TESTS,
  },
  {
    id: "A5",
    guard: "A uid RTDB could not store is REFUSED, not handed to the SDK to throw on",
    file: ASSIGN,
    from: `  if (!isLegalKey(uid)) throw new Error(\`push assignment: unusable uid "\${uid}"\`);`,
    to: ``,
    tests: ASSIGN_TESTS,
  },
  {
    id: "A6",
    guard: "The assignment paths are ADMIN-WRITE — a client-writable index is the whole feature undone",
    file: "PUSH-ASSIGNMENT-RULES-DEPLOY.md",
    from: `"push_hub_audience": {
  ".read":  "auth != null && auth.token.email === 'gunidmoh@gmail.com'",
  ".write": "auth != null && auth.token.email === 'gunidmoh@gmail.com'",`,
    to: `"push_hub_audience": {
  ".read":  "auth != null",
  ".write": "auth != null",`,
    tests: RULES_TESTS,
  },

  // ── THE ENTRANCE (2026-09-09) ─────────────────────────────────────────────
  // P1 and P2 are the two halves of the outage this release fixes, and they
  // pull in OPPOSITE directions — which is why both are here. Deleting the
  // prompt is what left the app with no way to ask for permission for two days;
  // firing it from an effect is what got the toggle deleted in the first place.
  {
    id: "P1",
    guard: "THE GESTURE PATH PROMPTS — deleting this is the two-day outage again",
    file: HOOK,
    from: `      const r = await ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: true });`,
    to: `      const r = await ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: false });`,
    tests: HOOK_TESTS,
  },
  {
    id: "P2",
    guard: "THE PASSIVE PATH NEVER PROMPTS — a prompt outside a gesture is ignored, and penalised",
    file: HOOK,
    from: `    ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: false })`,
    to: `    ensurePushRegistration({ uid, wanted: true, buckets: [], promptIfNeeded: true })`,
    tests: HOOK_TESTS,
  },

  {
    id: "P3",
    guard: "ONLY THE NEWEST REGISTRATION WRITES THE STATE — an older passive result must not clobber a granted ON",
    file: HOOK,
    // The PASSIVE side is the one that carries the stale pre-permission answer
    // and therefore the one the race damages. `cancelled` alone was what this
    // effect had before the ticket, so dropping the ticket from `live()` is
    // exactly the pre-fix code.
    from: `    const live = () => !cancelled && attempt.current === mine;`,
    to: `    const live = () => !cancelled;`,
    tests: HOOK_TESTS,
  },
  {
    id: "P4",
    guard: "THE APP ACTUALLY MOUNTS THE ENTRANCE — hook tests stay green while nothing renders the switch",
    file: "src/App.jsx",
    from: `          <NotificationSettingsRow push={push} mute={mute} />`,
    to: ``,
    tests: HOOK_TESTS,
  },

  // ── THE MUTE IS A VETO (2026-09-09) ───────────────────────────────────────
  // U1-U4 are the pure module; S6-S8 are the fan-out that honours it; T1-T4 are
  // the switch; C1-C3 are the admin card that has to show it. The sentence they
  // collectively defend: recipients are ASSIGNED AND NOT MUTED, absence is
  // audible, and the switch grants nothing.
  {
    id: "U1",
    guard: "ONLY A REAL BOOLEAN MUTES — corruption here must degrade towards DELIVERY",
    file: MUTE,
    from: `  return record.muted === true;`,
    to: `  return !!record.muted;`,
    tests: MUTE_TESTS,
  },
  {
    id: "U2",
    guard: "UNMUTING DELETES — off is absence, never a stored muted:false",
    file: MUTE,
    from: `  return { [pushMutePath(uid)]: muted ? { muted: true, updatedAt: nowMs } : null };`,
    to: `  return { [pushMutePath(uid)]: { muted, updatedAt: nowMs } };`,
    tests: MUTE_TESTS,
  },
  {
    id: "U3",
    guard: "A uid RTDB could not store is REFUSED, not handed to the SDK to throw on",
    file: MUTE,
    from: `  if (!isLegalKey(uid)) throw new Error(\`push mute: unusable uid "\${uid}"\`);`,
    to: ``,
    tests: MUTE_TESTS,
  },
  {
    id: "U4",
    guard: "THE FAN-OUT READS A LEAF — the record path is not the leaf path",
    file: MUTE,
    from: `export const pushMuteFlagPath = (uid) => \`\${PUSH_MUTES_PATH}/\${uid}/muted\`;`,
    to: `export const pushMuteFlagPath = (uid) => \`\${PUSH_MUTES_PATH}/\${uid}\`;`,
    tests: MUTE_TESTS,
  },
  {
    id: "U5",
    guard: "THE MUTE RULE IS SELF-WRITE — a blanket auth != null lets anyone silence a colleague",
    file: "PUSH-MUTE-RULE-DEPLOY.md",
    from: `    ".write": "auth != null && auth.uid === $uid",`,
    to: `    ".write": "auth != null",`,
    tests: MUTE_RULES_TESTS,
  },

  // ── THE SCOPED FAN-OUT ────────────────────────────────────────────────────
  {
    id: "S1",
    guard: "Recipients come from the ASSIGNED index and NOWHERE else — no wildcard, no fallback",
    file: PUSH,
    from: `  const snap = await db.ref(\`push_hub_audience/\${hub}\`).get();`,
    to: `  const snap = await db.ref("push_audience/all").get();`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S2",
    guard: "The BURST is keyed by the hub — keyed by anything else it swallows another hub's order",
    file: PUSH,
    from: `  const hub = hubForOrder(record);
  const seenKey = replayKey(orderId, record.createdAt);`,
    to: `  const hub = record.destShop.trim();
  const seenKey = replayKey(orderId, record.createdAt);`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S3",
    guard: "An order with NO hub is refused, never defaulted onto a hub that would then be told",
    file: PUSH,
    from: `  if (!hub) return "no_hub";`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S4",
    guard: "A hub that is not a legal RTDB key is refused before db.ref() throws on it",
    file: PUSH,
    from: `  if (/[.#$/[\\]]/.test(hub)) return "bad_hub";`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S5",
    guard: "The lock-screen tag is PER HUB — one tag lets Hub 2 replace Hub 1 for a both-hubs assignee",
    file: PUSH,
    from: `      tag: \`order-\${hub}\`,`,
    to: `      tag: "order",`,
    nodeTests: SERVER_TESTS,
  },

  {
    id: "S6",
    guard: "THE MUTE IS APPLIED — an assigned person who silenced their phone must not be sent to",
    file: PUSH,
    from: `  const recipients = await dropMuted(db, assigned);`,
    to: `  const recipients = assigned;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S7",
    guard: "A MUTE THAT CANNOT BE READ IS AUDIBLE — one blip must not silence a whole hub",
    file: PUSH,
    from: `      audible.push(uids[i]);
      return;
    }`,
    to: `      return;
    }`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S8",
    guard: "ONLY A REAL BOOLEAN MUTES SERVER-SIDE TOO — the two ends must agree",
    file: PUSH,
    from: `    if (res.value && res.value.val() === true) return;`,
    to: `    if (res.value && res.value.val()) return;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "S9",
    guard: "THE MUTE FILTER RUNS BEFORE THE TOKEN READ — a muted token must never enter the multicast",
    file: PUSH,
    from: `  const rows = await collectTokens(db, recipients);`,
    to: `  const rows = await collectTokens(db, assigned);`,
    nodeTests: SERVER_TESTS,
  },

  {
    id: "U6",
    guard: "A REFUSED WRITE ROLLS BACK TO THE SERVER, not to what this tab last believed",
    file: "src/push/useMute.js",
    from: `      setMutedState(serverMuted.current);`,
    to: `      setMutedState(false);`,
    tests: MUTE_HOOK_TESTS,
  },

  // ── THE STAFF SWITCH ──────────────────────────────────────────────────────
  {
    id: "T1",
    guard: "THE SWITCH SHOWS THE OUTCOME — it must not look on over a device that receives nothing",
    file: ROW,
    from: `  const on = !muted && state === PUSH_STATE.ON;`,
    to: `  const on = !muted;`,
    tests: ROW_TESTS,
  },
  {
    id: "T2",
    guard: "A DENIED PROMPT STILL CLEARS THE MUTE — a standing mute is a second, invisible reason",
    file: ROW,
    from: `      await enablePush();
      await setMuted(false);`,
    to: `      if ((await enablePush()) === PUSH_STATE.ON) await setMuted(false);`,
    tests: ROW_TESTS,
  },
  {
    id: "T3",
    guard: "BLOCKED IS EXPLAINED — the browser will never prompt again and only site settings can undo it",
    file: ROW,
    from: `    + "On Android Chrome: tap the ⋮ menu → Site settings → Notifications → Allow. "
    + "This switch cannot undo it.",`,
    to: `    + "",`,
    tests: ROW_TESTS,
  },
  {
    // T4 REPLACED 2026-09-09 (review round). It used to mutate
    // `disabled={busy || !known}` — a guard that was itself the defect: gating
    // the whole control on the mute read put the app one refused /push_mutes
    // read away from the original outage, with no permission prompt reachable
    // from a node that has nothing to do with prompting. The switch is no
    // longer disabled by `known`; what `known` gates is the mute WRITE.
    id: "T4",
    guard: "AN UNREADABLE SETTING STILL ASKS FOR PERMISSION, but WRITES NO MUTE from an unknown baseline",
    file: ROW,
    from: `    if (!known) { await enablePush(); return; }`,
    to: ``,
    tests: ROW_TESTS,
  },
  {
    id: "T5",
    guard: "THE ACCOUNT MUTE IS REACHABLE FROM A DEVICE THAT CANNOT RECEIVE — the switch alone cannot reach it",
    file: ROW,
    from: `  const showSilenceLink = known && !muted && !!trouble && !error;`,
    to: `  const showSilenceLink = false;`,
    tests: ROW_TESTS,
  },
  {
    id: "T6",
    guard: "A MUTED PERSON IS TOLD SO even when the device is ALSO blocked — else the next tap silently unmutes",
    file: ROW,
    from: `      ? (trouble ? \`\${MUTED_LINE} Also: \${trouble}\` : MUTED_LINE)`,
    to: `      ? MUTED_LINE`,
    tests: ROW_TESTS,
  },
  {
    id: "T7",
    guard: "A REFUSED READ IS NOT CALLED A FAILED SAVE — they saved nothing",
    file: ROW,
    from: `    ? (error.kind === "read"`,
    to: `    ? (false`,
    tests: ROW_TESTS,
  },

  // ── THE ADMIN CARD SHOWS THE MUTE ─────────────────────────────────────────
  {
    id: "C1",
    guard: "A MUTED ROW SAYS SO — an assignment ignored at the other end must be visible",
    file: CARD,
    from: `        if (r.uid in mutes) next.muted = mutes[r.uid];`,
    to: ``,
    tests: CARD_TESTS,
  },
  {
    id: "C2",
    guard: "THE WARNING COUNTS THE ASSIGNED ONES — a mute on an unassigned row is not a warning",
    file: CARD,
    from: `  const silenced = (rows || []).filter((r) => r.hubs.length > 0 && r.muted === true).length;`,
    to: `  const silenced = (rows || []).filter((r) => r.muted === true).length;`,
    tests: CARD_TESTS,
  },
  {
    id: "C3",
    guard: "A REFUSED MUTE READ RAISES ITS OWN BANNER — a shared channel names the wrong rule",
    file: CARD,
    from: `      setMutesError(firstMuteRefusal && firstMuteRefusal.message`,
    to: `      setTokensError(firstMuteRefusal && firstMuteRefusal.message`,
    tests: CARD_TESTS,
  },
  {
    id: "C4",
    guard: "THE MUTE IS READ PER-UID AT ITS LEAF — never the node, which grows with headcount",
    file: CARD,
    from: `        Promise.allSettled(slice.map((r) => get(ref(database, pushMuteFlagPath(r.uid))))),`,
    to: `        Promise.allSettled(slice.map(() => get(ref(database, "push_mutes")))),`,
    tests: CARD_TESTS,
  },

  // ── DEAD TOKEN PRUNING ────────────────────────────────────────────────────
  {
    id: "M6",
    guard: "A dead token is DELETED — the server must stop writing to an address nobody is at",
    file: PUSH,
    from: `    if (code && DEAD_TOKEN_CODES.has(code)) dead.push(rows[i]);`,
    to: `    if (false) dead.push(rows[i]);`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M7",
    guard: "The prune actually runs — collecting dead tokens and never deleting them is the same bug",
    file: PUSH,
    from: `  await pruneDeadTokens(db, dead);`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M8",
    guard: "ONLY a dead address is pruned — a quota or transport blip must not cost a registration",
    file: PUSH,
    from: `const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);`,
    to: `const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
  "messaging/server-unavailable",
]);`,
    nodeTests: SERVER_TESTS,
  },

  // ── BURST COLLAPSE ────────────────────────────────────────────────────────
  {
    id: "M9",
    guard: "THE COLLAPSE — only the invocation that OPENED the window sends; 40 orders are one notification",
    file: PUSH,
    from: `  if (claim.snapshot.val() && claim.snapshot.val().windowId !== windowId) {
    return { sent: false, skipped: "joined_window" };
  }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M10",
    guard: "An order that joins an open window is COUNTED, not treated as a fresh one",
    file: PUSH,
    from: `    const open = !!(cur && cur.windowId && !cur.closedAt && nowMs - beat < STALE_CLAIM_MS);`,
    to: `    const open = false;`,
    nodeTests: SERVER_TESTS,
  },

  // ── IDEMPOTENCY ───────────────────────────────────────────────────────────
  {
    id: "M11",
    guard: "IDEMPOTENCY — a redelivered creation is recognised and sends nothing",
    file: PUSH,
    from: `    if (seen[seenKey]) { replay = true; return undefined; }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M12",
    guard: "The replay memory SURVIVES the window closing — a retry a minute later is still a replay",
    file: PUSH,
    from: `  return { windowId: null, startedAt: 0, count: 0, sample: null, closedAt: nowMs, seen: pruneSeen(cur && cur.seen, nowMs) };`,
    to: `  return { windowId: null, startedAt: 0, count: 0, sample: null, closedAt: nowMs, seen: {} };`,
    nodeTests: SERVER_TESTS,
  },

  // ── THE TWO FAILURES THE FIRST DRAFT HAD ──────────────────────────────────
  {
    id: "M15",
    guard: "A dead claimer's count is CARRIED FORWARD — its orders are already in `seen` and can never be re-counted",
    file: PUSH,
    from: `    const orphaned = cur && cur.windowId && !cur.closedAt ? Number(cur.count || 0) : 0;`,
    to: `    const orphaned = 0;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M16",
    guard: "The replay memory is CAPPED — uncapped, one store's burst costs O(n^2) bytes on a single node",
    file: PUSH,
    from: `  if (fresh.length > MAX_SEEN) {
    fresh.sort((a, b) => b[1] - a[1]);
    fresh.length = MAX_SEEN;
  }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },

  {
    id: "M17",
    guard: "A FAILED SEND puts the count back — otherwise the burst vanishes with no notification and no signal",
    file: PUSH,
    from: `    await restoreBurst({ burstRef, count, captured, closedAt }).catch(() => {});`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M18",
    guard: "A restore folds into a LIVE window instead of clobbering another claim",
    file: PUSH,
    from: `    if (cur && cur.windowId && !cur.closedAt) {
      return { ...cur, count: Number(cur.count || 0) + count, sample: cur.sample || captured.sample, seen };
    }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M19",
    guard: "A restored window is expired against EVERY clock — otherwise the next order joins a window with no claimer",
    file: PUSH,
    from: `      startedAt: 0,`,
    to: `      startedAt: closedAt,`,
    nodeTests: SERVER_TESTS,
  },

  {
    id: "M20",
    guard: "THE CLAIMER WAITS FOR QUIET — a fixed delay only collapses the first seconds of a sweep",
    file: PUSH,
    from: `    if (seenCount === lastCount) break;                            // quiet — the burst is over
    lastCount = seenCount;`,
    to: `    break;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M21",
    guard: "The wait has a CEILING — a burst that never goes quiet must still produce a notification",
    file: PUSH,
    from: `    if (now() - waitStart >= MAX_FLUSH_WAIT_MS) break;             // still going: send an instalment`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M22",
    guard: "Timestamps come from the INJECTED clock — mixing epochs silently evaporates the replay memory",
    file: PUSH,
    from: `  const closedAt = nowMs + (now() - waitStart);`,
    to: `  const closedAt = Date.now();`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M23",
    guard: "An order with no usable hub opens the app, never a queue that would not list it",
    file: PUSH,
    from: '  if (!hub || !WAREHOUSE_HUBS.has(hub)) return "/";',
    to: "",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M23b",
    guard: "A SINGLE order links to the card itself; a burst opens the queue",
    file: PUSH,
    from: `  if (count > 1 || !sample.orderId) return base;`,
    to: `  if (!sample.orderId) return base;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M23c",
    guard: "The focus identity carries createdAt — the bare id would ring a card from a previous day",
    file: PUSH,
    from: `    + \`&at=\${encodeURIComponent(sample.createdAt || "")}\`;`,
    to: `    ;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M24",
    guard: "A burst names its first PRODUCT, not only a count",
    file: PUSH,
    from: "    const rest = count - 1;",
    to: "    const rest = count - 1; productName = \"\";",
    nodeTests: SERVER_TESTS,
  },

  {
    id: "M26",
    guard: "THE HEARTBEAT — without it a LIVE claimer is judged dead and its burst is stolen every threshold",
    file: PUSH,
    from: "    try { await burstRef.update({ heartbeatAt: tickNow }); } catch { /* a missed beat only risks an early handoff */ }",
    to: "",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M27",
    guard: "Liveness is judged by the BEAT, not by how long the burst has been running",
    file: PUSH,
    from: "    const beat = Number((cur && (cur.heartbeatAt || cur.startedAt)) || 0);",
    to: "    const beat = Number((cur && cur.startedAt) || 0);",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M28",
    guard: "A SINGLE failed tick read does not end the wait — otherwise a read blip fragments a sweep",
    file: PUSH,
    from: "      if (readFailures >= MAX_TICK_READ_FAILURES) break;",
    to: "      break;",
    nodeTests: SERVER_TESTS,
  },

  // ── CODERABBIT ROUND (PR #569) ────────────────────────────────────────────
  {
    id: "M29",
    guard: "A destination that is not a legal RTDB key is REFUSED before it becomes a path",
    file: PUSH,
    from: '  if (/[.#$/[\\]]/.test(dest)) return "bad_destination";',
    to: "",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M30",
    guard: "A lone order is quiet at the FIRST tick — seeded from the claimed count, not -1",
    file: PUSH,
    from: "  let lastCount = Number((claim.snapshot.val() || {}).count) || 0;",
    to: "  let lastCount = -1;",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M31",
    guard: "The recipient CAP holds — the old test could not fail because only one uid had a token",
    file: PUSH,
    from: "  return Object.keys(val).slice(0, MAX_RECIPIENTS);",
    to: "  return Object.keys(val);",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M32",
    guard: "Switching push off clears a banner already on screen",
    file: FOREGROUND,
    from: "    if (!enabled) { setBanner(null); return undefined; }",
    to: "    if (!enabled) return undefined;",
    tests: FOREGROUND_TESTS,
  },
  {
    id: "M33",
    guard: "The same message never fires twice — a reconnect is not a second alert",
    file: FOREGROUND,
    from: "      if (shownRef.current.has(key)) return;",
    to: "",
    tests: FOREGROUND_TESTS,
  },

  // ── THE CHIME MUST NOT PAINT THE FATAL BANNER ─────────────────────────────
  {
    id: "M25",
    guard: "The unlock listener is removed with the SAME capture flag it was added with, or it is never removed",
    file: CHIME,
    from: `      window.removeEventListener(ev, unlock, { capture: true });`,
    to: `      window.removeEventListener(ev, unlock);`,
    tests: CHIME_TESTS,
  },

  // ── SHADOW ROWS ───────────────────────────────────────────────────────────
  {
    id: "M13",
    guard: "Shadow orders notify NOBODY — they are a preview the sweep rewrites every 15 minutes",
    file: PUSH,
    from: `  if (typeof orderId === "string" && orderId.startsWith("SHDW-")) return "shadow_key";`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M14",
    guard: "Only an INCOMING order is new work — a restore or a status rewrite is not",
    file: PUSH,
    from: `  if (rec.status !== "incoming") return "not_incoming";`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },

  // ── THE RECYCLED ORDER ID (this release) ──────────────────────────────────
  // Both counters reset daily and cycle 001-999 while the nodes persist, so the
  // same key is written again and again. Every guard below is a way that fact
  // turns into a real order nobody is ever told about.
  {
    id: "M34",
    guard: "THE REPLAY KEY CARRIES createdAt — on the bare id, tomorrow's 005 is a replay of today's",
    file: PUSH,
    from: "  return `${orderId}::${stamp}`;",
    to: "  return orderId;",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M35",
    guard: "A SUPERSEDED record is left to its own event — the id was recycled while this one was in flight",
    file: PUSH,
    from: `  if (expectedCreatedAt != null && String(rec.createdAt) !== String(expectedCreatedAt)) {
    return "superseded";
  }`,
    to: ``,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M36",
    guard: "A shop refill is NAMED as one, so a lock screen tells it from a customer's order",
    file: PUSH,
    from: '  const kind = sample && sample.refill ? "Shop refill: " : "";',
    to: '  const kind = "";',
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M37",
    guard: "The order NUMBER leads the body — it is what is on the box and on the slip",
    file: PUSH,
    from: '  const num = sample && sample.orderId ? `#${sample.orderId} · ` : "";',
    to: '  const num = "";',
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M38",
    guard: "A CR refill links to the clothing tab, not to a queue that does not list it",
    file: PUSH,
    from: '  return isRefillOrder(rec) && CR_HUBS.has(hub) ? "clothing" : "queue";',
    to: '  return "queue";',
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M39",
    guard: "A FOCUS MARKER EXPIRES — an untapped one must not ring a card on a later, unrelated visit",
    file: DEEPLINK,
    from: "  if (!writtenAt || nowMs - writtenAt > FOCUS_ORDER_TTL_MS) return null;",
    to: "  if (!writtenAt) return null;",
    tests: DEEPLINK_TESTS,
  },
  {
    id: "M40",
    guard: "The focus marker is CONSUMED on read — one tap rings one card, not every later mount",
    file: DEEPLINK,
    from: "  try { store.removeItem(FOCUS_ORDER_KEY); } catch { /* nothing more to do */ }",
    to: "",
    tests: DEEPLINK_TESTS,
  },
  {
    id: "M44",
    guard: "THE REPLAY KEY IS A LEGAL RTDB KEY — an ISO stamp's dot throws on every claim (#269 again)",
    file: PUSH,
    from: "  const stamp = Number.isFinite(ms) ? String(ms) : raw.replace(/[.#$/[\\]]/g, \"-\");",
    to: "  const stamp = raw;",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M45",
    guard: "A delivery of ZERO is not a send — every token failing must put the burst back",
    file: PUSH,
    from: "  if (!delivered && rows.length) {",
    to: "  if (false) {",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M46",
    guard: "A failed token prune cannot undo a delivery that already happened",
    file: PUSH,
    from: `  try {
    await pruneDeadTokens(db, dead);
  } catch (err) {`,
    to: `  {
    await pruneDeadTokens(db, dead);
  }
  if (false) { const err = null;`,
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M47",
    guard: "An aborted close transaction sends NOTHING — captured can survive a re-run that changed nothing",
    file: PUSH,
    from: "  if (!closeRes.committed || !captured) return { sent: false, skipped: \"window_taken\" };",
    to: "  if (!captured) return { sent: false, skipped: \"window_taken\" };",
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M42",
    guard: "A link may only carry a hub the WAREHOUSE selector can render, not every labelled destination",
    file: PUSH,
    from: '  if (!hub || !WAREHOUSE_HUBS.has(hub)) return "/";',
    to: '  if (!hub || !HUB_LABEL[hub]) return "/";',
    nodeTests: SERVER_TESTS,
  },
  {
    id: "M43",
    guard: "The focus ring is cleared on EVERY way out of the effect, not only by its timer",
    file: FOCUS,
    from: "      setFocusKey(null);\n    };",
    to: "    };",
    tests: FOCUS_TESTS,
  },
  {
    id: "M41",
    guard: "A hub the warehouse selector cannot render is REFUSED, not persisted as a blank screen",
    file: DEEPLINK,
    from: "  const hub = VALID_HUBS.has(hubParam) ? hubParam : null;",
    to: "  const hub = hubParam;",
    tests: DEEPLINK_TESTS,
  },
];

// ── A NON-ZERO EXIT IS NOT PROOF ─────────────────────────────────────────────
// Only a runner that EXECUTED tests and saw them fail counts as FAIL. A syntax
// error, a missing file, a reworded summary — all report ERROR, loudly, and
// never credit the guard.
function runVitest(files) {
  try {
    execFileSync("npx", ["vitest", "run", ...files, "--silent"], { stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/Tests\s+\d+\s+failed/.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

function runNodeTests(files) {
  try {
    // TAP is PINNED, not left to the default reporter: node 24 prints "ℹ fail 1"
    // where node 22 prints "# fail 1", and the parser below would read a real
    // failure as ERROR — silently crediting no guard at all.
    execFileSync("node", ["--test", "--test-reporter=tap", ...files], { stdio: "pipe", cwd: "functions", maxBuffer: 64 * 1024 * 1024 });
    return "PASS";
  } catch (err) {
    const out = `${err.stdout || ""}${err.stderr || ""}`;
    if (/SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/.test(out)) {
      return `ERROR(${(out.trim().split("\n").find((l) => /Error/.test(l)) || "load crash").slice(0, 120)})`;
    }
    if (/^# fail [1-9]/m.test(out)) return "FAIL";
    return `ERROR(${(out.trim().split("\n").pop() || "no output").slice(0, 120)})`;
  }
}

function runAll(m) {
  const verdicts = [];
  if (m.tests && m.tests.length) verdicts.push(runVitest(m.tests));
  if (m.nodeTests && m.nodeTests.length) verdicts.push(runNodeTests(m.nodeTests));
  const errored = verdicts.find((v) => String(v).startsWith("ERROR"));
  if (errored) return errored;
  if (verdicts.includes("FAIL")) return "FAIL";
  return "PASS";
}

// ── PREFLIGHT: NEVER MUTATE AN ALREADY-DIRTY FILE ────────────────────────────
// The SHARED one (scripts/lib/mutationPreflight.mjs), not a local copy. This
// harness had its own inline version, which was equivalent on the day it was
// written and is exactly the kind of thing that drifts — the shared module also
// refuses when git itself cannot be consulted, which a local `execFileSync`
// without a try would turn into a crash rather than a refusal.
requireCleanTree([...new Set(MUTATIONS.map((m) => m.file))]);

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits === 0) {
    results.push({ ...m, mutated: "ANCHOR-MISSING", restored: "-" });
    console.log(`${m.id}  ANCHOR NOT FOUND in ${m.file}`);
    continue;
  }
  if (hits > 1) {
    results.push({ ...m, mutated: "ANCHOR-AMBIGUOUS", restored: "-" });
    console.log(`${m.id}  ANCHOR FOUND ${hits}× in ${m.file} — widen it`);
    continue;
  }
  let mutated = "?";
  let restored = "?";
  const restore = () => { try { writeFileSync(m.file, original); } catch { /* nothing better available */ } };
  const onSignal = () => { restore(); process.exit(130); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    writeFileSync(m.file, original.replace(m.from, () => m.to));
    mutated = runAll(m);
    restore();
    restored = runAll(m);
  } finally {
    restore();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  const proven = mutated === "FAIL" && restored === "PASS";
  results.push({ ...m, mutated, restored, proven });
  console.log(`${m.id}  mutated:${mutated}  restored:${restored}  ${proven ? "✅ PROVEN" : "❌ NOT PROVEN"}  — ${m.guard}`);
}

const unproven = results.filter((r) => !r.proven);
console.log(`\n${results.length - unproven.length}/${results.length} guards proven`);
if (unproven.length) {
  console.log("NOT PROVEN:");
  for (const r of unproven) console.log(`  ${r.id}  mutated:${r.mutated} restored:${r.restored}  ${r.guard}`);
  process.exit(1);
}
