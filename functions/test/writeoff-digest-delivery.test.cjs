// ─── THE DIGEST'S DELIVERY CHECK (2026-09-23) ────────────────────────────────
// Run: cd functions && node --test test/writeoff-digest-delivery.test.cjs
// The 23 Sep digest was logged as "sent" and never reached Junid. These pin
// the check that replaced that blind "sent": the verdict comes from what
// Google's Monitoring API says, and every way the email can fail to leave is
// named, never reported as sent.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { judgeDelivery, confirmDelivery, monitoringApi, runDigest, emailViaAlertLog, POLICY_NAME, RECIPIENT, STATUS } = require("../lib/writeoff-digest.cjs");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");

const SENT = Date.parse("2026-09-23T17:40:03.000Z");
const DIGEST = { summary: "133 sizes / 250 units written off after four refused days — Central: 98 (194u), Hub 2: 35 (56u). |  Kalr …" };
const POLICY = { name: "projects/marathon-club/alertPolicies/9711972293433345395", displayName: POLICY_NAME, enabled: true,
  notificationChannels: ["projects/marathon-club/notificationChannels/720969978464351212"] };
const CHANNEL = { name: POLICY.notificationChannels[0], type: "email", enabled: true, labels: { email_address: RECIPIENT } };
// The real 23 Sep alert, as the Alerts API returned it.
const ALERT = { name: "projects/marathon-club/alerts/0.ocz05h9j8e1a", state: "CLOSED", openTime: "2026-09-23T17:41:06Z",
  log: { extractedLabels: { digest: DIGEST.summary } }, policy: { name: POLICY.name } };

test("the real 23 Sep run: Google raised the alert → emailed, with when and to whom", () => {
  const v = judgeDelivery({ policy: POLICY, channel: CHANNEL, alerts: [ALERT], digest: DIGEST, sentAtMs: SENT });
  assert.deepEqual(v, { state: "emailed", to: RECIPIENT, alert: ALERT.name, emailedAt: "2026-09-23T17:41:06Z" });
});

test("every way the email fails to leave is NOT sent, with the reason", () => {
  const cases = [
    [{ policy: null }, /policy is missing/],
    [{ policy: { ...POLICY, enabled: false } }, /policy is switched off/],
    [{ channel: null }, /no email channel/],
    [{ channel: { ...CHANNEL, enabled: false } }, /channel is switched off/],
    [{ channel: { ...CHANNEL, labels: { email_address: "someone@else.com" } } }, /sends to someone@else\.com/],
    [{ alerts: [] }, /raised no alert/],
    // an OLD alert (yesterday's digest) is not this one
    [{ alerts: [{ ...ALERT, openTime: "2026-09-22T17:41:06Z" }] }, /raised no alert/],
    // an alert for a DIFFERENT digest text is not this one
    [{ alerts: [{ ...ALERT, log: { extractedLabels: { digest: "2 sizes / 3 units …" } } }] }, /raised no alert/],
  ];
  for (const [over, why] of cases) {
    const v = judgeDelivery({ policy: POLICY, channel: CHANNEL, alerts: [ALERT], digest: DIGEST, sentAtMs: SENT, ...over });
    assert.equal(v.state, "not_sent", JSON.stringify(over));
    assert.match(v.why, why);
  }
});

function fakeApi({ alertsAfter = 0, policy = POLICY, channel = CHANNEL, fail = null } = {}) {
  let calls = 0;
  return {
    calls: () => calls,
    policies: async () => { if (fail) throw new Error(fail); return policy ? [policy, { displayName: "Social engine alarm" }] : []; },
    channel: async () => channel,
    alerts: async () => (++calls > alertsAfter ? [ALERT] : []),
  };
}
const fakeClock = () => { let t = SENT; return { clock: () => t, sleep: async (ms) => { t += ms; } }; };

test("confirmDelivery waits for Google to raise the alert (it took 63 s on 23 Sep)", async () => {
  const api = fakeApi({ alertsAfter: 3 });
  const v = await confirmDelivery({ api, digest: DIGEST, sentAtMs: SENT, ...fakeClock() });
  assert.equal(v.state, "emailed");
  assert.equal(api.calls(), 4);
});

test("confirmDelivery gives up at the deadline and says NOT sent — never 'sent' by default", async () => {
  const api = fakeApi({ alertsAfter: 1e9 });
  const v = await confirmDelivery({ api, digest: DIGEST, sentAtMs: SENT, waitMs: 240e3, everyMs: 20e3, ...fakeClock() });
  assert.equal(v.state, "not_sent");
  assert.match(v.why, /raised no alert/);
  assert.ok(api.calls() >= 12 && api.calls() <= 14);
});

test("a switched-off channel is reported at once, without waiting out the deadline", async () => {
  const api = fakeApi({ alertsAfter: 1e9, channel: { ...CHANNEL, enabled: false } });
  const v = await confirmDelivery({ api, digest: DIGEST, sentAtMs: SENT, ...fakeClock() });
  assert.equal(v.state, "not_sent");
  assert.equal(api.calls(), 1);
});

test("if Google cannot be asked, the verdict is 'unchecked' — never 'emailed'", async () => {
  const v = await confirmDelivery({ api: fakeApi({ fail: "alertPolicies HTTP 403" }), digest: DIGEST, sentAtMs: SENT, ...fakeClock() });
  assert.equal(v.state, "unchecked");
  assert.match(v.why, /403/);
});

test("monitoringApi asks with the function's own token and filters alerts by policy", async () => {
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, h: opts?.headers });
    if (url.includes("metadata.google.internal")) return { ok: true, json: async () => ({ access_token: "tok" }) };
    return { ok: true, json: async () => ({ alerts: [ALERT], alertPolicies: [POLICY] }) };
  };
  const api = monitoringApi({ fetchImpl });
  assert.deepEqual(await api.alerts(POLICY.name), [ALERT]);
  assert.equal(seen[0].h["Metadata-Flavor"], "Google");
  assert.equal(seen[1].h.Authorization, "Bearer tok");
  assert.ok(decodeURIComponent(seen[1].url).includes(`filter=policy.name="${POLICY.name}"`));
  await api.policies();
  assert.equal(seen.filter((s) => s.url.includes("metadata")).length, 1);   // token reused
});

test("runDigest returns the archive key the verdict is written under", async () => {
  const db = makeFakeDb({ refill_engine: {
    refusalWriteoffDigestQueue: { w1: SENT },
    refusalWriteoffs: { w1: { loc: "hub2", pid: "p", productName: "Tee", size: "M", qty: 1, days: ["2026-09-12"], refusals: [] } },
  } });
  const res = await runDigest({ db, nowMs: SENT, channels: [emailViaAlertLog(() => {})] });
  assert.equal(res.archiveKey, `2026-09-23_${SENT}`);
  assert.ok((await db.ref(`refill_engine/refusalWriteoffDigests/${res.archiveKey}`).once("value")).val());
  assert.equal(STATUS, "refill_engine/refusalWriteoffDigestStatus");
});
