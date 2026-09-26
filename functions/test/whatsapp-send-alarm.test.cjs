// The WHATSAPP_SEND_ALARM line — the text Junid gets by email when a customer
// WhatsApp fails. Run: cd functions && node --test
const { test } = require("node:test");
const assert = require("node:assert");
const { MARKER, alarmLine, explainSendFailure, META_CODE_HINTS } = require("../lib/whatsapp-send-alarm.cjs");

test("131042 names the payment problem and where to fix it", () => {
  assert.match(explainSendFailure({ metaCode: 131042 }), /PAYMENT.*Meta Business billing/);
  assert.match(explainSendFailure({ metaCode: "131042" }), /PAYMENT/, "a string code resolves the same");
});

test("an unknown code and a missing code each say so plainly", () => {
  assert.equal(explainSendFailure({ metaCode: 999999 }), "Meta refused it with error 999999");
  assert.match(explainSendFailure({}), /could not be reached/);
  assert.match(explainSendFailure({ preflight: true, metaCode: 131042 }), /never left Google/, "preflight wins: nothing reached Meta");
  assert.match(explainSendFailure(), /could not be reached/);
  assert.match(explainSendFailure(null), /could not be reached/);
});

test("every hint is a non-empty sentence", () => {
  for (const [code, hint] of Object.entries(META_CODE_HINTS)) assert.ok(hint.length > 10, code);
});

test("the line starts with the marker, is ONE line, and is capped", () => {
  const line = alarmLine({
    docId: "d1", templateName: "order_placed", recipient: "***1234", outcome: "retry",
    attempts: 1, maxAttempts: 2, metaCode: 131000, error: "boom\nsecond line\r\n" + "x".repeat(2000),
  });
  assert.ok(line.startsWith(`${MARKER} order_placed to ***1234 was REFUSED (attempt 1 of 2, will retry)`));
  assert.ok(!/[\r\n]/.test(line));
  assert.ok(line.length <= 600);
});

test("never throws, whatever it is handed", () => {
  for (const input of [undefined, null, {}, { error: { toString() { throw new Error("x"); } } }]) {
    const line = alarmLine(input);
    assert.ok(line.startsWith(MARKER), String(line));
  }
});
