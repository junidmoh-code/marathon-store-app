// The fixtures have the portal's REAL shapes (Metabase dashboard 47 and its
// "Card POS Transactions" card, read 2 Nov 2026); every value is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  readDashboard, tidsFromValues, cardRows, embedTokenFromSrc, embedClaims, parseStoreItems, classifyPage,
  shouldAlert, loginAlert, daysToPull, dateFilter, sastYmd, portalLib,
} from "../core.mjs";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const SAST = (s) => Date.parse(`${s}+02:00`);

test("the dashboard is read by NAME: the transactions card and the two filters", () => {
  assert.deepEqual(readDashboard(fx("dashboard-47.json")), { dateSlug: "date_filter", tidParamId: "719fa873", dashcardId: 343, cardId: 362 });
  assert.equal(readDashboard({ parameters: [], dashcards: [] }), null);
});

test("the Terminal ID list and the card's rows", () => {
  assert.deepEqual(tidsFromValues({ values: [["0000OF1Y"], ["0000OF2Y"], ["Unknown"]] }), ["0000OF1Y", "0000OF2Y", "Unknown"]);
  const r = cardRows(fx("card-362.json"));
  assert.equal(r.rows.length, 3);
  assert.equal(r.cols[7], "TerminalId");
  assert.match(cardRows({ error: "boom" }).error, /refused/);
});

test("the rows the callable will get: successful only, the O-spelled TIDs map to the registry", () => {
  const r = cardRows(fx("card-362.json"));
  const p = portalLib.parsePortalRows(r);
  assert.equal(p.ok, true);
  assert.deepEqual(p.txns.map((t) => [t.tid, t.amountCents]), [["0000OF2Y", 93000], ["0000OF1Y", 75000]]);
  const reg = { "00000F2Y": { bank: "standard-bank", storeId: "concrete", tillId: "till-1" }, "00000F1Y": { bank: "standard-bank", storeId: "concrete", tillId: "till-2" } };
  assert.deepEqual(portalLib.mapPortalTids(["0000OF1Y", "0000OF2Y", "Unknown"], reg).mapped, { "0000OF1Y": "00000F1Y", "0000OF2Y": "00000F2Y" });
});

test("the embed link: only Metabase's, and what it says about the store", () => {
  const tok = ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify({ resource: { dashboard: 47 }, params: { businessid: "b-1" }, exp: 1793643666 })).toString("base64url"), "sig"].join(".");
  assert.equal(embedTokenFromSrc(`https://metabasesbsaprod.littlefish.mobi/embed/dashboard/${tok}?date_filter=x#bordered=false`), tok);
  assert.equal(embedTokenFromSrc(`https://evil.example/embed/dashboard/${tok}`), null);
  assert.deepEqual(embedClaims(tok), { businessId: "b-1", dashboard: 47, expMs: 1793643666000 });
});

test("the store switcher's items → stores by merchant number", () => {
  assert.deepEqual(parseStoreItems(["CONCRETE\n0005377331\nRole: Administrator", "THE MARATHON\n\n0004977890\nRole: Administrator", "Link Store"]),
    [{ name: "CONCRETE", merchantNo: "0005377331" }, { name: "THE MARATHON", merchantNo: "0004977890" }]);
});

test("which page: the report, the sign-in form, or a PIN prompt", () => {
  assert.equal(classifyPage({ hasEmbed: true }), "report");
  assert.equal(classifyPage({ hasEmail: true, hasPassword: true }), "login");
  assert.equal(classifyPage({ otpText: true, hasCodeInput: true }), "otp");
  assert.equal(classifyPage({}), "unknown");
});

test("the login alert goes ONCE per outage", () => {
  assert.equal(shouldAlert({}), true);
  assert.equal(shouldAlert({ loginAlertAt: 10 }), false);
  assert.equal(shouldAlert({ loginAlertAt: 10, lastOkAt: 5 }), false);
  assert.equal(shouldAlert({ loginAlertAt: 10, lastOkAt: 20 }), true);
  const m = loginAlert({ kind: "otp" });
  assert.equal(m.to, "gunidmoh@gmail.com");
  assert.equal(m.subject, "SimplyBLU needs a fresh login on the Mac mini");
});

test("days: the SAST calendar day, today and two before, never before the 30 Oct 2026 floor", () => {
  assert.equal(sastYmd(SAST("2026-11-03T23:30:00")), "2026-11-03");
  assert.deepEqual(daysToPull(SAST("2026-10-30T18:00:00")), ["2026-10-30"]);
  assert.deepEqual(daysToPull(SAST("2026-11-06T18:00:00")), ["2026-11-04", "2026-11-05", "2026-11-06"]);
  assert.equal(dateFilter("2026-11-03"), "2026-11-03~2026-11-03");
});

test("only the columns the record reads leave the machine — a card-number column never does", async () => {
  const { projectColumns } = await import("../core.mjs");
  const cols = ["DateCreated: Minute", "ID", "Masked PAN", "TransactionType", "TransactionStatus", "TerminalId", "Transaction Amount", "User"];
  const out = projectColumns({ cols, rows: [["2026-11-03T10:00:00+02:00", "x", "4111********1111", "Purchase", "Success", "0000HP1X", 930, "Guest User"]] });
  assert.deepEqual(out.cols, ["DateCreated: Minute", "ID", "TransactionType", "TransactionStatus", "TerminalId", "Transaction Amount"]);
  assert.equal(JSON.stringify(out.rows).includes("4111"), false);
});

test("the failure email goes once per outage", async () => {
  const { shouldAlertFailure, failureAlert } = await import("../core.mjs");
  assert.equal(shouldAlertFailure({}), true);
  assert.equal(shouldAlertFailure({ failAlertAt: 5 }), false);
  assert.equal(shouldAlertFailure({ failAlertAt: 5, lastOkAt: 9 }), true);
  assert.equal(failureAlert("x").to, "gunidmoh@gmail.com");
});
