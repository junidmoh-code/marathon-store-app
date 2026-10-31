import { test, expect } from "vitest";
import { auditPullStatus, fixPatch, latestPullByLayby } from "./laybyPullAudit.mjs";

const T0 = Date.parse("2026-10-30T08:00:00Z");

test("sent pull + parcel still pullRequested = fix; the patch is status + sentToStoreAt", () => {
  const r = auditPullStatus(
    { p1: { laybyId: "L1", invoiceNo: "L-1", status: "sentToStore", sentAt: "2026-10-30T09:00:00Z", requestedAt: T0, disposition: "collect" } },
    { L1: { status: "pullRequested", invoiceNo: "L-1" } },
  );
  expect(r.fix).toHaveLength(1);
  expect(fixPatch(r.fix[0])).toEqual({ status: "sentToStore", sentToStoreAt: "2026-10-30T09:00:00Z" });
});

test("scanned in AFTER the send is ambiguous, never written (L-00413)", () => {
  const r = auditPullStatus(
    { p1: { laybyId: "L1", status: "sentToStore", sentAt: "2026-09-19T11:58:42Z", requestedAt: T0 } },
    { L1: { status: "storedAtHub", receivedAt: "2026-09-19T12:04:55Z" } },
  );
  expect(r.fix).toHaveLength(0);
  expect(r.ambiguous[0].reason).toMatch(/scanned in after/);
});

test("judged by the LATEST pull: an old sent pull under a newer pending one is not stale", () => {
  const pulls = {
    a: { laybyId: "L1", status: "sentToStore", sentAt: "2026-10-01T00:00:00Z", requestedAt: T0 - 1e9 },
    b: { laybyId: "L1", status: "pending", requestedAt: T0 },
  };
  expect(latestPullByLayby(pulls).get("L1").pullId).toBe("b");
  const r = auditPullStatus(pulls, { L1: { status: "pullRequested" } });
  expect(r.fix).toHaveLength(0);
  expect(r.agree).toBe(1);
});

test("pending pull vs a sent parcel is reported, not fixed", () => {
  const r = auditPullStatus({ a: { laybyId: "L1", status: "pending", requestedAt: T0 } }, { L1: { status: "sentToStore" } });
  expect(r.pendingVsSent).toHaveLength(1);
  expect(r.fix).toHaveLength(0);
});

test("a second run over fixed data finds nothing (idempotent)", () => {
  const pulls = { p1: { laybyId: "L1", status: "sentToStore", sentAt: "2026-10-30T09:00:00Z", requestedAt: T0 } };
  const laybys = { L1: { status: "pullRequested" } };
  const first = auditPullStatus(pulls, laybys);
  Object.assign(laybys.L1, fixPatch(first.fix[0]));
  expect(auditPullStatus(pulls, laybys).fix).toHaveLength(0);
});

test("an older parcel sentToStoreAt is replaced by this send; a later one is ambiguous", () => {
  const pulls = { p1: { laybyId: "L1", status: "sentToStore", sentAt: "2026-10-30T09:00:00Z", requestedAt: T0 } };
  const older = auditPullStatus(pulls, { L1: { status: "pullRequested", sentToStoreAt: "2026-09-01T00:00:00Z" } });
  expect(fixPatch(older.fix[0]).sentToStoreAt).toBe("2026-10-30T09:00:00Z");
  const later = auditPullStatus(pulls, { L1: { status: "pullRequested", sentToStoreAt: "2026-10-30T10:00:00Z" } });
  expect(later.fix).toHaveLength(0);
  expect(later.ambiguous[0].reason).toMatch(/later send stamp/);
});
