// ─── DIAGNOSIS: "Couldn't create the transit record" (Junid, 26 Nov 2026) ──────
//
// Symptom: every manual transfer from Central to another building (Hub 1/2/3,
// Marathon PE, Trophy, Pine) fails with the red toast "Couldn't create the
// transit record — nothing was sent." Central → Concrete works only because
// Concrete is not in the building map (transitLanes.js), so it never takes
// the transit branch at all.
//
// Cause: the transit doc is created with ONE multi-path update() at the root
// that carries BOTH
//     transfers/{tId}                      ← the whole new doc
//     transfers/{tId}/stamps/{atMs_dev}    ← the device stamp (stampAt)
// The Firebase SDK refuses an update in which one path is an ancestor of
// another. It throws on the device, BEFORE anything reaches the server, so it
// is not PERMISSION_DENIED and not a rule validation — and Transfer.jsx's bare
// `catch {}` turned it into "check connection".
//
// The overlap came in with #647 (device enrolment, 25 Sep 2026), which added
// `...stampAt(\`transfers/${tId}\`, "dispatch")` beside the whole-doc write.
// It stayed dormant because transit lanes were switched off; /config/transit
// was switched ON at 2026-11-24 12:07 UTC (the In Transit screen's switch),
// and the last transit doc written before that is from 20 Jul 2026. From
// that moment every Central cross-building send hit the throw.
//
// The live console rules (fetched read-only 26 Nov) were checked: they accept
// the doc's fields for every destination; no rule change is involved.
//
// This file pins the diagnosis with the REAL SDK (not a fake), offline: the
// database is pointed at an unreachable local emulator port and taken
// offline, so nothing ever leaves this machine.
import { describe, it, expect } from "vitest";
import { initializeApp } from "firebase/app";
import { getDatabase, connectDatabaseEmulator, goOffline, ref, update } from "firebase/database";

const app = initializeApp(
  { projectId: "demo-transit-diagnose", databaseURL: "http://127.0.0.1:1?ns=demo-transit-diagnose" },
  "transit-diagnose",
);
const db = getDatabase(app);
connectDatabaseEmulator(db, "127.0.0.1", 1);
goOffline(db);

describe("the 26 Nov transit-record failure, reproduced with the real SDK", () => {
  it("the pre-fix patch shape (whole doc + its own stamp path) is refused on the device", () => {
    const tId = "-TEST_TRANSIT_1";
    const patch = {
      [`transfers/${tId}`]: {
        status: "dispatched", from: "central", to: "hub1", reason: "manual",
        createdAt: "2026-11-26T08:00:00.000Z", createdBy: "u1",
        lines: { p1: { S: 1 } },
      },
      [`transfers/${tId}/stamps/1764144000000_dev12345`]: { deviceId: "dev12345", personName: null, atMs: 1764144000000, action: "dispatch" },
    };
    expect(() => update(ref(db), patch)).toThrow(/ancestor of another path/);
  });

  it("the same doc with the stamp INSIDE it is accepted by the SDK", () => {
    const tId = "-TEST_TRANSIT_2";
    const patch = {
      [`transfers/${tId}`]: {
        status: "dispatched", from: "central", to: "hub1", reason: "manual",
        createdAt: "2026-11-26T08:00:00.000Z", createdBy: "u1",
        lines: { p1: { S: 1 } },
        stamps: { "1764144000000_dev12345": { deviceId: "dev12345", personName: null, atMs: 1764144000000, action: "dispatch" } },
      },
    };
    expect(() => update(ref(db), patch)).not.toThrow();
  });
});
