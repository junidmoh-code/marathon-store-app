// Shared test helpers for the offline mirror.
//
// `fake-indexeddb/auto` is deliberately NOT used: it installs one global
// database that every test file then shares, and a test that purges a store
// would reach into another file's fixtures. Each test opens its own named
// database against a fresh factory instead.
import { IDBFactory, IDBKeyRange as FakeKeyRange } from "fake-indexeddb";
import { openMirrorDb } from "../db";

// db.js builds IDBKeyRange from the global, as the browser provides it. Node
// has no global one, so the fake's is installed here — for the RANGE only; the
// factory stays per-test (see above). Assigned rather than defaulted so a test
// file's import order cannot leave it undefined.
if (!globalThis.IDBKeyRange) globalThis.IDBKeyRange = FakeKeyRange;

let n = 0;

export async function freshMirrorDb() {
  n += 1;
  const factory = new IDBFactory();
  const db = await openMirrorDb({ indexedDBFactory: factory, dbName: `mirror-test-${n}` });
  await db.ensureSchema({ buildVersion: "test" });
  return db;
}

export const rec = (key, value) => ({ key, value });
