// ─── MARATHON TILL 2 (0000HP1X): THE MAPPING WAS NEVER THE FAULT ─────────────
// Diagnosis of 7 Oct 2026 (docs/CARD-RECON-TILL2-2026-10-07.md). The suspicion
// was a TID left unmapped or mis-mapped by the 17/18 Sep re-registration or the
// 5 Oct PE Till 1 ↔ Trophy Till 1 swap. These are the LIVE registry rows as read
// on 7 Oct 2026 (labels, TIDs and placements verbatim; no MIDs needed), and
// what they say at every moment that matters. Every Till 2 slip that reached a
// successful read was filed here; the missing days were reads that failed.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { placementAt, tillAt } = require("../lib/card-terminal-placements.cjs");
const { normaliseTid, readSlipTid } = require("../lib/card-recon.cjs");

const MOVE_18_SEP = 1789733243057;               // 2026-09-18T12:07:23Z, tillChangedAt
const SWAP_5_OCT = Date.parse("2026-10-05T10:46:00Z"); // 12:46 SAST

const LIVE = {
  "0000HP1X": {
    label: "Marathon Till 2", storeId: "pe", tillId: "till-2", tillChangedAt: MOVE_18_SEP,
    placements: { [`at-${MOVE_18_SEP}`]: { effectiveFrom: MOVE_18_SEP, label: "Marathon Till 2", storeId: "pe", tillId: "till-2" } },
  },
  "67325636": {
    activeFrom: MOVE_18_SEP, label: "Trophy Till 1", storeId: "pe", tillId: "till-1",
    placements: {
      [`at-${MOVE_18_SEP}`]: { effectiveFrom: MOVE_18_SEP, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
      [`at-${SWAP_5_OCT}`]: { effectiveFrom: SWAP_5_OCT, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
    },
  },
  "67377843": {
    label: "Marathon Till 1", storeId: "trophy", tillId: "till-1",
    placements: {
      "at-0": { effectiveFrom: 0, label: "Trophy Till 1", storeId: "trophy", tillId: "till-1" },
      [`at-${SWAP_5_OCT}`]: { effectiveFrom: SWAP_5_OCT, label: "Marathon Till 1", storeId: "pe", tillId: "till-1" },
    },
  },
};
const at = (iso) => Date.parse(iso);
const till = (row, ms) => { const t = tillAt(row, ms); return { storeId: t.storeId, tillId: t.tillId }; };

test("0000HP1X stands on PE till-2 from the 18 Sep move through today", () => {
  for (const iso of ["2026-09-18T12:07:24Z", "2026-09-24T15:00:00Z", "2026-10-05T10:45:59Z", "2026-10-05T10:46:00Z", "2026-10-07T15:03:42Z"]) {
    const p = placementAt(LIVE["0000HP1X"], at(iso));
    assert.deepEqual([p.storeId, p.tillId], ["pe", "till-2"], iso);
  }
});

test("before its first placement it reads from its record stamp (pe/till-1 then) — no placement claims it", () => {
  assert.equal(placementAt(LIVE["0000HP1X"], at("2026-09-15T12:00:00Z")), null);
});

test("the 5 Oct swap moved the two OTHER machines and left Till 2's alone", () => {
  const before = at("2026-10-05T10:45:00Z"), after = at("2026-10-05T10:47:00Z");
  assert.deepEqual(till(LIVE["67325636"], before), { storeId: "pe", tillId: "till-1" });
  assert.deepEqual(till(LIVE["67325636"], after), { storeId: "trophy", tillId: "till-1" });
  assert.deepEqual(till(LIVE["67377843"], before), { storeId: "trophy", tillId: "till-1" });
  assert.deepEqual(till(LIVE["67377843"], after), { storeId: "pe", tillId: "till-1" });
  assert.deepEqual(tillAt(LIVE["0000HP1X"], before), tillAt(LIVE["0000HP1X"], after));
  // No other machine is placed on PE till-2 at any point of the swap day.
  for (const tid of ["67325636", "67377843"]) {
    for (const iso of ["2026-10-05T06:00:00Z", "2026-10-05T10:46:00Z", "2026-10-05T16:00:00Z"]) {
      const t = tillAt(LIVE[tid], at(iso));
      assert.ok(!(t.storeId === "pe" && t.tillId === "till-2"), `${tid} ${iso}`);
    }
  }
});

test("the TID the reader returns for Till 2 resolves to its registry row exactly", () => {
  // What gemini returned on every successful Till 2 read, 25 Sep – 6 Oct.
  assert.equal(readSlipTid("0000HP1X"), "0000HP1X");
  assert.equal(normaliseTid("0000HP1X"), "0000HP1X");
  assert.ok(Object.hasOwn(LIVE, readSlipTid("0000HP1X")));
});
