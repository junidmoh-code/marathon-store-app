// ─── OFFLINE MIRROR — the one place bootstrap.js's runtime is discoverable ───
//
// bootstrap.js is dynamically imported from main.jsx so its module graph — the
// firebase + IndexedDB code behind it — is never fetched or parsed when the
// flag is off.
// Anything that wants to READ the running mirror (the status dot, the setup screen, every local reader)
// needs a synchronous, always-present place to ask "has it started, and with
// what" that does not itself pull that graph in just to ask the question. This
// file is that place: zero imports, a promise, nothing else.
//
// main.jsx sets it, synchronously, in the same tick it kicks off the dynamic
// import — before React ever renders — so a consumer's effect (which runs
// after commit) never races an unset value: it is either a pending promise
// (flag on) or null (flag off), never "not yet decided".

let runtimePromise = null;

export function setOfflineMirrorRuntime(promise) {
  runtimePromise = promise;
}

// Resolves to { db, engine, connection } once bootstrap.js's async start
// completes, or null if the mirror never started (flag off, or
// the start failed — maybeStartOfflineMirror swallows its own errors).
export function getOfflineMirrorRuntime() {
  return runtimePromise;
}

// Test-only.
export function _resetOfflineMirrorRuntimeForTests() {
  runtimePromise = null;
}
