// ─── LAYBY EXPIRY NOTIFY — the proofs ────────────────────────────────────────
// Run: cd functions && npm test -- test/layby-expiry-notify.test.cjs
const { test } = require("node:test");
const assert = require("node:assert");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const L = require("../lib/layby-expiry-notify.cjs");

// 31 Oct 2026, 09:00 SAST → target dueDate 2026-11-03.
const NOW = Date.parse("2026-10-31T07:00:00.000Z");
const TARGET = "2026-11-03";
const APPROVED = async () => ({ data: [{ name: "layby_expiry_3d", language: "en", status: "APPROVED", category: "UTILITY" }] });

// ── Fake RTDB ────────────────────────────────────────────────────────────────
// get / update / remove / transaction (Cloud Function COLD-CACHE semantics: the
// fn runs first against null, then against the server value) and the one query
// used: orderByChild(k).equalTo(v).get(). Like the real thing, writing null or
// an emptied object removes the key.
function fakeDb(initial, { failTransactionFor = null } = {}) {
  const state = structuredClone(initial);
  const at = (path) => path.split("/").filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), state);
  const prune = (v) => (v && typeof v === "object" && Object.keys(v).length === 0 ? null : v);
  const setAt = (path, value) => {
    const parts = path.split("/").filter(Boolean);
    const last = parts.pop();
    const chain = [state];
    let n = state;
    for (const k of parts) { n[k] = n[k] ?? {}; n = n[k]; chain.push(n); }
    const v = prune(value);
    if (v == null) delete n[last]; else n[last] = structuredClone(v);
    // An emptied parent goes too — real RTDB never stores an empty node.
    for (let i = chain.length - 1; i > 0; i--) if (Object.keys(chain[i]).length === 0) delete chain[i - 1][parts[i - 1]];
  };
  const reads = [];
  const api = {
    state, reads,
    ref(path) {
      return {
        async get() { reads.push(path); const v = at(path); return { val: () => (v === undefined ? null : structuredClone(v)) }; },
        async update(patch) { for (const [k, v] of Object.entries(patch)) setAt(`${path}/${k}`, v); },
        async remove() { setAt(path, null); },
        async transaction(fn) {
          if (failTransactionFor && failTransactionFor(path)) throw new Error("transaction refused");
          const cold = fn(null);
          if (cold === undefined) return { committed: false, snapshot: { val: () => at(path) ?? null } };
          const cur = at(path) ?? null;
          const next = fn(cur == null ? null : structuredClone(cur));
          if (next === undefined) return { committed: false, snapshot: { val: () => structuredClone(cur) } };
          setAt(path, next);
          return { committed: true, snapshot: { val: () => structuredClone(at(path)) } };
        },
        orderByChild(k) {
          return { equalTo(v) {
            return { async get() {
              reads.push(`${path}?orderBy=${k}&equalTo=${v}`);
              const kids = Object.entries(at(path) || {}).filter(([, c]) => c && c[k] === v);
              return { forEach: (cb) => kids.forEach(([key]) => cb({ key })) };
            } };
          } };
        },
      };
    },
  };
  return api;
}

const layby = (over = {}) => ({ invoiceNo: "L-00628", status: "storedAtHub", balanceRemaining: 34950, dueDate: TARGET, customerPhone: "0782877389", originStore: "trophy", ...over });

function producer({ fail = null } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    if (fail) { const e = fail(req, calls.length); if (e) throw e; }
    return { success: true, outboxId: `ob${calls.length}` };
  };
  fn.calls = calls;
  return fn;
}

const run = (db, enqueueWhatsApp, extra = {}) =>
  L.runLaybyExpiryNotify({ db, enqueueWhatsApp, fetchTemplates: APPROVED, nowMs: NOW, ...extra });

// ── Who gets a message ───────────────────────────────────────────────────────
test("an active layby due EXACTLY 3 days out gets one message with number, date and store", async () => {
  const db = fakeDb({ laybys: { A: layby() } });
  const enq = producer();
  const r = await run(db, enq);
  assert.equal(r.target, TARGET);
  assert.equal(enq.calls.length, 1);
  assert.deepEqual(enq.calls[0], { templateName: "layby_expiry_3d", recipientPhone: "0782877389", templateParams: ["L-00628", "3 November 2026", "Trophy"] });
  assert.equal(db.state.layby_notify.A_expiry_3d.notifiedAt, new Date(NOW).toISOString());
  assert.equal(db.state.layby_notify.A_expiry_3d.outboxId, "ob1");
});

test("a DATE, not a range: inside 3 days, past due, or further out on deploy day → nothing", async () => {
  const dues = ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-04", "2026-12-03"];
  const laybys = Object.fromEntries(dues.map((d, i) => [`D${i}`, layby({ dueDate: d })]));
  const db = fakeDb({ laybys });
  const enq = producer();
  await run(db, enq);
  assert.equal(enq.calls.length, 0);
  assert.equal(db.state.layby_notify, undefined);
});

test("the query is the indexed dueDate equality, and records are re-read by key only", async () => {
  const db = fakeDb({ laybys: { A: layby(), B: layby({ dueDate: "2026-11-09" }) } });
  await run(db, producer());
  assert.deepEqual(db.reads, [`laybys?orderBy=dueDate&equalTo=${TARGET}`, "laybys/A"]);
});

test("PR #228 active: terminal statuses and a paid-off balance are skipped; an unknown balance fails open", async () => {
  const db = fakeDb({ laybys: {
    C: layby({ status: "collected" }), R: layby({ status: "returned" }), X: layby({ status: "expiredReturnedToStock" }),
    Z: layby({ balanceRemaining: 0 }), U: layby({ balanceRemaining: undefined }), S: layby({ status: "sentToStore" }),
  } });
  const enq = producer();
  const r = await run(db, enq);
  assert.deepEqual(r.laybyIds.sort(), ["S", "U"]);
  assert.equal(r.skipped.not_active, 4);
});

test("no phone → no message; Concrete, Pine and PE map to their store names", async () => {
  const db = fakeDb({ laybys: {
    N: layby({ customerPhone: "" }),
    C: layby({ originStore: "concrete" }), P: layby({ issuingStore: "marathon-pine", originStore: "marathon-pine" }), E: layby({ originStore: "marathon-pe" }),
    Q: layby({ originStore: "somewhere" }),
  } });
  const enq = producer();
  const r = await run(db, enq);
  assert.deepEqual(enq.calls.map((c) => c.templateParams[2]).sort(), ["Concrete", "PE", "Pine"]);
  assert.equal(r.skipped.no_phone, 1);
  assert.equal(r.skipped.unknown_store, 1);
});

test("SAST calendar: 00:30 SAST on 1 Nov (22:30 UTC on 31 Oct) targets 4 Nov", () => {
  assert.equal(L.saDatePlus(Date.parse("2026-10-31T22:30:00Z"), 3), "2026-11-04");
  assert.equal(L.saDatePlus(Date.parse("2026-10-31T21:59:00Z"), 3), "2026-11-03");
});

// ── Never twice ──────────────────────────────────────────────────────────────
test("a second run (scheduler retry, manual re-run) sends nothing more", async () => {
  const db = fakeDb({ laybys: { A: layby() } });
  const enq = producer();
  await run(db, enq);
  const r2 = await run(db, enq);
  assert.equal(enq.calls.length, 1);
  assert.equal(r2.skipped.already_claimed, 1);
});

test("two concurrent runs: exactly one message", async () => {
  const db = fakeDb({ laybys: { A: layby() } });
  const enq = producer();
  await Promise.all([run(db, enq), run(db, enq)]);
  assert.equal(enq.calls.length, 1);
});

test("an unresolved claim from an earlier run is never taken over", async () => {
  const db = fakeDb({ laybys: { A: layby() }, layby_notify: { A_expiry_3d: { claimedAt: "2026-10-31T06:00:00.000Z" } } });
  const enq = producer();
  await run(db, enq);
  assert.equal(enq.calls.length, 0);
});

// ── Failures ─────────────────────────────────────────────────────────────────
test("a failed claim RETHROWS (#386) — after the other laybys are still sent", async () => {
  const db = fakeDb({ laybys: { A: layby(), B: layby({ invoiceNo: "L-2" }) } }, { failTransactionFor: (p) => p.includes("/A_") });
  const enq = producer();
  await assert.rejects(run(db, enq), /1 layby\(s\) failed/);
  assert.equal(enq.calls.length, 1);
  assert.equal(enq.calls[0].templateParams[0], "L-2");
  assert.equal(db.state.layby_notify.A_expiry_3d, undefined);
});

test("a transient enqueue failure releases the claim and throws; the retry sends exactly once", async () => {
  const db = fakeDb({ laybys: { A: layby() } });
  const enq = producer({ fail: (_r, n) => (n === 1 ? new Error("deadline") : null) });
  await assert.rejects(run(db, enq));
  assert.equal(db.state.layby_notify, undefined);
  await run(db, enq);
  await run(db, enq);
  assert.equal(enq.calls.length, 2); // the failed attempt + one success
  assert.ok(db.state.layby_notify.A_expiry_3d.notifiedAt);
});

test("an unusable phone is terminal: claim kept with failedAt, no throw, never retried", async () => {
  const db = fakeDb({ laybys: { A: layby({ customerPhone: "123" }) } });
  const err = Object.assign(new Error("recipientPhone is not a usable phone number"), { code: "invalid-argument", details: { unusableRecipient: true } });
  const enq = producer({ fail: () => err });
  const r = await run(db, enq);
  assert.equal(r.skipped.unusable_recipient, 1);
  assert.ok(db.state.layby_notify.A_expiry_3d.failedAt);
  await run(db, enq);
  assert.equal(enq.calls.length, 1);
});

// ── Template approval at run time ────────────────────────────────────────────
for (const [name, fetchTemplates] of [
  ["pending", async () => ({ data: [{ name: "layby_expiry_3d", language: "en", status: "PENDING" }] })],
  ["rejected", async () => ({ data: [{ name: "layby_expiry_3d", language: "en", status: "REJECTED" }] })],
  ["not registered", async () => ({ data: [] })],
  ["other language only", async () => ({ data: [{ name: "layby_expiry_3d", language: "en_US", status: "APPROVED" }] })],
  ["Graph error", async () => ({ error: { message: "(#100) Missing Permission" } })],
  ["network failure", async () => { throw new Error("fetch failed"); }],
]) {
  test(`template ${name} → skip with a logged reason: no claim, no send, no crash`, async () => {
    const db = fakeDb({ laybys: { A: layby() } });
    const enq = producer();
    const r = await run(db, enq, { fetchTemplates });
    assert.equal(r.approved, false);
    assert.ok(r.skipReason);
    assert.equal(enq.calls.length, 0);
    assert.equal(db.state.layby_notify, undefined);
    assert.deepEqual(db.reads, []);
  });
}

// ── The template contract stays in one piece ────────────────────────────────
test("the docs template JSON, the producer's TEMPLATE_BODIES entry and the module agree", () => {
  const json = JSON.parse(readFileSync(join(__dirname, "../../docs/meta-templates/layby_expiry_3d.json"), "utf8"));
  assert.equal(json.name, L.TEMPLATE);
  assert.equal(json.language, L.TEMPLATE_LANGUAGE);
  assert.equal(json.category, "UTILITY");
  const body = json.components.find((c) => c.type === "BODY");
  const index = readFileSync(join(__dirname, "../index.js"), "utf8");
  const m = /layby_expiry_3d:\s*\{\s*params:\s*3,\s*render:\s*\(p\)\s*=>\s*`([^`]*)`/.exec(index);
  assert.ok(m, "TEMPLATE_BODIES.layby_expiry_3d (3 params) is in functions/index.js");
  const rendered = m[1].replace(/\$\{p\[(\d)\]\}/g, (_x, i) => `{{${+i + 1}}}`);
  assert.equal(rendered, body.text);
  assert.equal(body.example.body_text[0].length, 3);
});
