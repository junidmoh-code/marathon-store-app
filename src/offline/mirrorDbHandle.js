// ─── OFFLINE MIRROR — shared read-side db handle ─────────────────────────────
//
// Every mirror READER needs the same open IndexedDB connection. This lazily
// opens ONE and caches the promise so N callers share it instead of each
// opening their own — cheap either way (IDB allows many connections), but there
// is no reason for more than one.
//
// Callers must check offlineMirrorEnabled() themselves before calling get() —
// this file does not gate on the flag, so importing it is free but calling it
// with the flag off would still open a connection.

import { openMirrorDb } from "./db";

let handlePromise = null;

export function getMirrorDbHandle() {
  if (!handlePromise) {
    handlePromise = openMirrorDb().catch((err) => {
      handlePromise = null; // let the next caller retry instead of caching a failure forever
      throw err;
    });
  }
  return handlePromise;
}

// Test-only: drop the cached connection so each test starts clean.
export function _resetMirrorDbHandleForTests() {
  handlePromise = null;
}
