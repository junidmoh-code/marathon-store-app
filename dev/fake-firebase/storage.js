// DEV ONLY — firebase/storage stand-in. Downloads answer a local placeholder;
// uploads/deletes are recorded on window.__fakeWrites and go nowhere.
const PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#dfe9f6"/></svg>');
const log = (op, path) => { if (typeof window !== "undefined") (window.__fakeWrites ||= []).push({ op, path }); };
export function getStorage() { return { __fake: true }; }
export function ref(_s, path = "") { return { fullPath: String(path), name: String(path).split("/").pop() }; }
export async function getDownloadURL() { return PLACEHOLDER; }
export async function getMetadata() { return { contentType: "image/png", size: 0, customMetadata: {} }; }
export async function getBlob() { return new Blob([]); }
export async function uploadBytes(r) { log("upload", r.fullPath); return { ref: r, metadata: {} }; }
export function uploadBytesResumable(r) {
  log("upload", r.fullPath);
  const task = { on: (_e, _p, _err, done) => { setTimeout(() => done && done(), 0); return () => {}; },
                 snapshot: { ref: r, bytesTransferred: 0, totalBytes: 0 }, then: (f) => Promise.resolve({ ref: r }).then(f), cancel() {} };
  return task;
}
export async function deleteObject(r) { log("delete", r.fullPath); }
