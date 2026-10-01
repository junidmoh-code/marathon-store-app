// ─── The daily "Written off after refusal" digest ────────────────────────────
// Run: cd functions && node --test test/writeoff-digest.test.cjs
// Pins: one digest of everything new; archived + queue cleared only when a
// channel delivered; nothing new → nothing sent; the emailed line stays inside
// the log-match label bound and names the product, size, location, units, days
// and refusers; a second channel (the future WhatsApp) plugs in by shape alone.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDb } = require("./helpers/fake-rtdb.cjs");
const { runDigest, buildDigest, emailViaAlertLog, MARKER, EMAIL_MAX_CHARS } = require("../lib/writeoff-digest.cjs");

const NOW = Date.parse("2026-09-23T17:40:00.000Z");
const rec = (id, over = {}) => ({
  id, loc: "hub2", pid: "p1780382141061", productName: "Nike Tech Fleece Tracksuit Brown 2", size: "M", qty: 3,
  days: ["2026-09-12", "2026-09-14", "2026-09-16", "2026-09-17"],
  refusals: [{ day: "2026-09-12", dest: "marathon-pe" }, { day: "2026-09-17", dest: "marathon-pe" }], ...over,
});

test("one digest of everything new; archived and dequeued once the email is logged", async () => {
  const db = makeFakeDb({ refill_engine: {
    refusalWriteoffs: { a: rec("a"), b: rec("b", { loc: "central", productName: "Diesel Slide", size: "8", qty: 18, refusals: [{ byName: "Mike" }] }) },
    refusalWriteoffDigestQueue: { a: NOW - 5, b: NOW - 4 },
  } });
  const lines = [];
  const res = await runDigest({ db, nowMs: NOW, channels: [emailViaAlertLog((l) => lines.push(l))] });
  assert.equal(res.sent, true);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`${MARKER} 2 sizes / 21 units written off`));
  assert.match(lines[0], /Nike Tech Fleece Tracksuit Brown 2 · M · Hub 2 · 3 units · refused 12 Sep, 14 Sep, 16 Sep, 17 Sep \(Hub 2 staff, no name recorded\)/);
  assert.match(lines[0], /Diesel Slide · 8 · Central · 18 units · .*\(by Mike\)/);
  assert.equal((await db.ref("refill_engine/refusalWriteoffDigestQueue").once("value")).val(), null);
  const arch = Object.values((await db.ref("refill_engine/refusalWriteoffDigests").once("value")).val());
  assert.equal(arch.length, 1);
  assert.equal(arch[0].count, 2);
  assert.equal(arch[0].channels.email.ok, true);
  // The records themselves stay — the Health card reads them.
  assert.ok((await db.ref("refill_engine/refusalWriteoffs/a").once("value")).val());
});

test("nothing new → nothing sent", async () => {
  const db = makeFakeDb({ refill_engine: { refusalWriteoffs: { a: rec("a") } } });
  const lines = [];
  const res = await runDigest({ db, nowMs: NOW, channels: [emailViaAlertLog((l) => lines.push(l))] });
  assert.equal(res.sent, false);
  assert.equal(lines.length, 0);
});

test("no channel delivered → the queue is kept for tomorrow", async () => {
  const db = makeFakeDb({ refill_engine: { refusalWriteoffs: { a: rec("a") }, refusalWriteoffDigestQueue: { a: NOW } } });
  const broken = { name: "email", deliver: async () => { throw new Error("down"); } };
  const res = await runDigest({ db, nowMs: NOW, channels: [broken] });
  assert.equal(res.sent, false);
  assert.deepEqual((await db.ref("refill_engine/refusalWriteoffDigestQueue").once("value")).val(), { a: NOW });
});

test("a second channel (the future WhatsApp) plugs in by shape alone and sees the same digest", async () => {
  const db = makeFakeDb({ refill_engine: { refusalWriteoffs: { a: rec("a") }, refusalWriteoffDigestQueue: { a: NOW } } });
  const got = [];
  const whatsapp = { name: "whatsapp", deliver: async (d) => { got.push(d); return { ok: true, detail: "queued" }; } };
  const res = await runDigest({ db, nowMs: NOW, channels: [emailViaAlertLog(() => {}), whatsapp] });
  assert.equal(res.sent, true);
  assert.equal(got.length, 1);
  assert.equal(got[0].count, 1);
  assert.ok(got[0].text.includes("Nike Tech Fleece Tracksuit Brown 2 · M · Hub 2 · 3 units"));
  const arch = Object.values((await db.ref("refill_engine/refusalWriteoffDigests").once("value")).val())[0];
  assert.equal(arch.channels.whatsapp.detail, "queued");
});

test("the emailed line stays inside the label bound however many there are, and points to the card", () => {
  const many = Array.from({ length: 136 }, (_, i) => rec(`r${i}`, { productName: `Product number ${i} with a long name`, qty: 1 }));
  const d = buildDigest(many, { nowMs: NOW });
  assert.ok(d.summary.length <= EMAIL_MAX_CHARS, `${d.summary.length}`);
  assert.match(d.summary, /\+\d+ more on Health → Written off after refusal$/);
  assert.equal(d.lines.length, 136);
  assert.ok(!/[\r\n]/.test(d.summary));
});
