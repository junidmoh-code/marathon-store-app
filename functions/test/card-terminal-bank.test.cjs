// Concrete's Standard Bank machines (31 Oct 2026): the `bank` on a registry
// row, and the forgiving TID match it — and only it — gets. Every FNB row is
// matched exactly as it always was; these tests pin that as hard as they pin
// the new behaviour.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { terminalBank, canonicalTid, resolveRegisteredTid, STANDARD_BANK } = require("../lib/card-terminals.cjs");
const { planAdd, planEdit, planReplace, readBank } = require("../lib/card-terminal-admin.cjs");
const { routeEmailSlip } = require("../lib/card-recon-email.cjs");
const { posStores } = require("../lib/pos-tills.cjs");

const stores = posStores({});
const NOW = 1793400000000;
const SB = { storeId: "concrete", tillId: "till-2", label: "Concrete Till 2", mid: "0005377331", capture: "typed", bank: STANDARD_BANK };
const SB1 = { ...SB, tillId: "till-1", label: "Concrete Till 1" };
const FNB = { storeId: "pe", tillId: "till-2", label: "Marathon Till 2", mid: "000000004977890" };
const ESTATE = { "00000F1Y": SB, "00000F2Y": SB1, "0000HP1X": FNB, 67325636: { storeId: "pe", tillId: "till-1", label: "PE 1", mid: "100000002453164" } };

test("absent is FNB; only the exact value is Standard Bank", () => {
  assert.equal(terminalBank(FNB), "fnb");
  assert.equal(terminalBank(SB), STANDARD_BANK);
  for (const bank of ["Standard Bank", "STANDARD-BANK", "sb", "", null, 1]) assert.equal(terminalBank({ bank }), "fnb");
  assert.equal(terminalBank(null), "fnb");
});

test("canonical TID: O→0, I→1, leading zeros off — the photo's O and the report's padding", () => {
  assert.equal(canonicalTid("0000OF1Y"), "F1Y");
  assert.equal(canonicalTid("00000F1Y"), "F1Y");
  assert.equal(canonicalTid("0F1Y"), "F1Y");
  assert.equal(canonicalTid("0000 0F2Y"), "F2Y");
  assert.notEqual(canonicalTid("00000F1Y"), canonicalTid("00000F2Y"));
  assert.equal(canonicalTid("0000"), "0");
  assert.equal(canonicalTid("bad!"), null);
});

test("resolveRegisteredTid: exact first; Standard Bank rows by canonical form; FNB rows never", () => {
  assert.equal(resolveRegisteredTid("00000F1Y", ESTATE), "00000F1Y");
  assert.equal(resolveRegisteredTid("0000OF1Y", ESTATE), "00000F1Y");
  assert.equal(resolveRegisteredTid("F1Y", ESTATE), "00000F1Y");
  assert.equal(resolveRegisteredTid("0F2Y", ESTATE), "00000F2Y");
  // FNB is exact: a padded / O-for-0 spelling of an FNB TID resolves to nothing.
  assert.equal(resolveRegisteredTid("0000HP1X", ESTATE), "0000HP1X");
  assert.equal(resolveRegisteredTid("HP1X", ESTATE), null);
  assert.equal(resolveRegisteredTid("OOOOHP1X", ESTATE), null);
  assert.equal(resolveRegisteredTid("67325636", ESTATE), "67325636");
  // Two Standard Bank rows with one canonical form: no guess.
  assert.equal(resolveRegisteredTid("F1Y", { ...ESTATE, "0F1Y": SB }), null);
  assert.equal(resolveRegisteredTid("0F1Y", { ...ESTATE, "0F1Y": SB }), "0F1Y");
  assert.equal(resolveRegisteredTid("00F1Y", { ...ESTATE, "0F1Y": SB }), null);
  assert.equal(resolveRegisteredTid("NOPE", ESTATE), null);
});

test("email routing: a Standard Bank report printing another spelling files under the registry key", () => {
  const routed = routeEmailSlip({ extraction: { tid: "0000OF1Y", mid: "5377331", bank: "standard-bank" }, terminals: ESTATE });
  assert.equal(routed.ok, true);
  assert.equal(routed.tid, "00000F1Y");
  assert.equal(routed.terminal, SB);
  // The MID with or without its zero padding is the same merchant.
  assert.deepEqual(routed.warnings, []);
  // A file that is not a Standard Bank report is routed exactly — never by
  // canonical form, even onto a Standard Bank row.
  const exact = routeEmailSlip({ extraction: { tid: "0000OF1Y", mid: "5377331" }, terminals: ESTATE });
  assert.equal(exact.ok, false);
  assert.equal(exact.unmapped, true);
});

test("email routing: FNB is unchanged — exact key, same refusal for a near miss", () => {
  const ok = routeEmailSlip({ extraction: { tid: "0000HP1X", mid: "4977890" }, terminals: ESTATE });
  assert.equal(ok.ok, true);
  assert.equal(ok.tid, "0000HP1X");
  const miss = routeEmailSlip({ extraction: { tid: "HP1X", mid: "4977890" }, terminals: ESTATE });
  assert.equal(miss.ok, false);
  assert.equal(miss.unmapped, true);
  assert.equal(miss.tid, "HP1X");
});

test("settings sheet: bank is optional, FNB rows never carry it, junk is refused", () => {
  assert.equal(readBank(undefined), "fnb");
  assert.equal(readBank("standard-bank"), STANDARD_BANK);
  assert.equal(readBank("absa"), null);
  const fnb = planAdd({ tid: "0000ZZ9Z", storeId: "pe", tillId: "till-2", label: "X", capture: "both" }, null, { stores, now: NOW });
  assert.equal(fnb.ok, true);
  assert.equal("bank" in fnb.row, false);
  const fnbSaid = planAdd({ tid: "0000ZZ9Z", storeId: "pe", tillId: "till-2", label: "X", capture: "both", bank: "fnb" }, null, { stores, now: NOW });
  assert.deepEqual(fnbSaid.row, fnb.row);
  const sb = planAdd({ tid: "00000f1y", ...SB }, null, { stores, now: NOW });
  assert.equal(sb.ok, true);
  assert.equal(sb.tid, "00000F1Y");
  assert.equal(sb.row.bank, STANDARD_BANK);
  assert.equal(sb.row.storeId, "concrete");
  const junk = planAdd({ tid: "0000ZZ9Z", storeId: "pe", tillId: "till-2", label: "X", capture: "both", bank: "absa" }, null, { stores, now: NOW });
  assert.equal(junk.ok, false);
});

test("edit: an older form that sends no bank keeps the row's; switching bank is a change", () => {
  const keep = planEdit({ tid: "00000F1Y", ...SB, bank: undefined, label: "Concrete T2" }, SB, { stores, now: NOW, nowMs: NOW });
  assert.equal(keep.ok, true);
  assert.equal(keep.row.bank, STANDARD_BANK);
  const toFnb = planEdit({ tid: "00000F1Y", ...SB, bank: "fnb" }, SB, { stores, now: NOW, nowMs: NOW });
  assert.equal(toFnb.ok, true);
  assert.equal("bank" in toFnb.row, false);
  const same = planEdit({ tid: "00000F1Y", ...SB }, SB, { stores, now: NOW, nowMs: NOW });
  assert.equal(same.ok, false);
  // An FNB row saved unchanged still writes nothing, bank sent or not.
  for (const bank of [undefined, "fnb"]) {
    const r = planEdit({ tid: "0000HP1X", ...FNB, capture: "both", bank }, FNB, { stores, now: NOW, nowMs: NOW });
    assert.equal(r.ok, false, String(bank));
  }
});

test("replace: a swapped machine keeps its bank unless the form says otherwise", () => {
  const r = planReplace({ oldTid: "00000F1Y", newTid: "00000F9Y" }, SB, null, { stores, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.newRow.bank, STANDARD_BANK);
  const f = planReplace({ oldTid: "0000HP1X", newTid: "0000HP9X", capture: "both" }, FNB, null, { stores, now: NOW });
  assert.equal(f.ok, true);
  assert.equal("bank" in f.newRow, false);
});
