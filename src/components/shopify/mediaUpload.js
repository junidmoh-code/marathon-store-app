// ─── SHOPIFY PUBLISHING — PHOTO AND VIDEO UPLOAD ─────────────────────────────
// Turns files Junid picks (camera or gallery, several at once) into media
// items for /shopify_publish/{pid}/media. One file → one item, or one plain
// refusal; an item only exists once its bytes are in Storage, so a failed
// upload never leaves a ghost entry in the list.
//
// PHOTOS follow the existing publishing path unchanged (photoTools.js): the
// app's decode → 1600 px / 800 KB JPEG → products/{pid}/shopify/upload_*.jpg.
//
// VIDEOS ARE NEVER RE-ENCODED, COMPRESSED, TRIMMED OR DOWNSCALED. The exact
// File the picker handed over is the upload body — uploadBytesResumable slices
// it into 256 KB-multiple chunks and sends them as they are — to its own new
// path, products/{pid}/media/{id}.{ext}. Resumable: a dropped connection
// retries chunk by chunk (window widened to 30 minutes while a video is in
// flight), and going offline PAUSES the upload so coming back online RESUMES
// it from the last byte the server confirmed, instead of starting again.
// Recorded with it: size, duration, picture size, mime type and the SHA-256
// of the bytes. A poster frame is drawn from the picked file on the phone
// (a ~640 px JPEG beside the video) so no list ever has to touch the video
// itself to show a thumbnail.
//
// THE WRONG-PHOTO GUARD. Every file is hashed and claimed through the
// mediaHashClaim function BEFORE its bytes are uploaded; an exact match owned
// by a different product is refused and that product named.
//
// Never overwrites, never deletes: every object is a new generated path, and
// filenames never carry user text (a brand word in a path would trip the
// compliance validator).
import { ref as storageRef, uploadBytes, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { storage, functions } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import { isAcceptedImageFile, describePickedFile } from "./imageDecode";
import { uploadFileProblem, compressImageFile, uploadPublishPhoto } from "./photoTools";
import { sha256OfBlob } from "./sha256";
import { probeVideoFile } from "./videoProbe";
import { storagePathOf } from "./publishShared";

// A sanity ceiling only — "this is not one clip of a product". Anything under
// it is kept whole; over 1 GB it is simply never pushed to Shopify.
export const MAX_VIDEO_BYTES = 10 * 1024 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|m4v|mov|qt|webm|3gp|3g2|mkv|avi)$/i;
const EXT_BY_MIME = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/x-m4v": "m4v", "video/3gpp": "3gp" };
const MIME_BY_EXT = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", qt: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp" };

const PID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// REJECT, never repair — and never an empty id: `products/${""}` would address
// the whole products folder.
function assertPid(pid) {
  if (!PID_RE.test(String(pid ?? ""))) throw new Error(`illegal product id: "${pid}"`);
  return pid;
}

/** "photo" | "video" | null for a picked file. */
export function pickedKind(file) {
  if (!file) return null;
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("video/") || VIDEO_EXT.test(String(file.name || ""))) return "video";
  if (isAcceptedImageFile(file)) return "photo";
  return null;
}

/** Why a picked file can't be added, or null. */
export function pickedFileProblem(file) {
  const kind = pickedKind(file);
  if (!kind) return `That isn't a photo or a video (${describePickedFile(file)}).`;
  if (kind === "photo") return uploadFileProblem(file);
  if (!file.size) return "That video is empty.";
  if (file.size > MAX_VIDEO_BYTES) return `That video is ${Math.ceil(file.size / 1024 ** 3)} GB — too big to be one clip of a product.`;
  return null;
}

/** A fresh item id: "m" + server time + random. Matches publishShared's id rule. */
export function newMediaId() {
  return `m${serverNowMs().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The mime type a video file really is, from its type or, failing that, its extension. */
export function videoMime(file) {
  const t = String(file?.type || "").toLowerCase();
  if (t.startsWith("video/")) return t;
  const ext = (String(file?.name || "").match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return MIME_BY_EXT[ext] || "video/mp4";
}
const videoExt = (file, mime) =>
  EXT_BY_MIME[mime] || (String(file?.name || "").match(/\.([a-z0-9]{2,4})$/i) || [])[1]?.toLowerCase() || "mp4";

/** SHA-256 of the exact bytes picked. */
export function hashFile(file, onProgress) {
  return sha256OfBlob(file, { onProgress });
}

/** Ask the server to claim this hash for the product → { ok, ownerPid?, ownerName? }. */
export async function claimMediaHash(pid, sha256, kind) {
  assertPid(pid);
  const res = await httpsCallable(functions, "mediaHashClaim")({ productId: pid, sha256, kind });
  return res.data || { ok: false };
}

// ─── VIDEO FACTS + POSTER ────────────────────────────────────────────────────
function withTimeout(p, ms, what) {
  let t = null;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })])
    .finally(() => clearTimeout(t));
}

/**
 * Duration, picture size and a poster JPEG for a picked video. The element
 * is fed a LOCAL object URL (no network), muted + playsinline so iOS will
 * decode a frame. Falls back to the file's own header for the numbers when the
 * browser cannot decode it; the poster is then null and the strip shows a
 * plain ▶ tile.
 */
export async function readVideoFacts(file, { posterLongEdge = 640 } = {}) {
  let durationMs = null, width = null, height = null, poster = null;
  if (typeof document !== "undefined" && typeof URL !== "undefined" && URL.createObjectURL) {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    try {
      v.muted = true; v.playsInline = true; v.setAttribute("playsinline", ""); v.preload = "auto"; v.src = url;
      await withTimeout(new Promise((res, rej) => {
        v.onloadedmetadata = () => res();
        v.onerror = () => rej(new Error("this phone can't open the video"));
      }), 20000, "reading the video");
      if (Number.isFinite(v.duration) && v.duration > 0) durationMs = Math.round(v.duration * 1000);
      if (v.videoWidth > 0 && v.videoHeight > 0) { width = v.videoWidth; height = v.videoHeight; }
      // The frame a second in (or a tenth of a short clip): the very first
      // frame of a phone clip is often black or mid-focus.
      const at = durationMs ? Math.min(1, (durationMs / 1000) * 0.1) : 0;
      await withTimeout(new Promise((res, rej) => {
        v.onseeked = () => res();
        v.onerror = () => rej(new Error("seek failed"));
        v.currentTime = at || 0.001;
      }), 15000, "finding a frame");
      if (width && height) {
        const scale = Math.min(1, posterLongEdge / Math.max(width, height));
        const c = document.createElement("canvas");
        c.width = Math.round(width * scale); c.height = Math.round(height * scale);
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        poster = await new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.8));
      }
    } catch {
      // A phone that can't decode the clip still uploads it — just without a
      // drawn poster, and with numbers from the header below.
    } finally {
      v.removeAttribute("src"); try { v.load(); } catch { /* released */ }
      URL.revokeObjectURL(url);
    }
  }
  if (durationMs == null || width == null) {
    const p = await probeVideoFile(file);
    if (p) {
      durationMs = durationMs ?? p.durationMs;
      if (width == null && p.width && p.height) { width = p.width; height = p.height; }
    }
  }
  return { durationMs, width, height, poster };
}

// ─── RESUMABLE ORIGINAL-QUALITY UPLOAD ───────────────────────────────────────
// The retry window is a property of the shared Storage instance, read when
// each chunk request is made — so it is widened while any video is in flight
// and put back when the last one ends.
const VIDEO_RETRY_WINDOW_MS = 30 * 60 * 1000;
let inFlightVideos = 0;
let savedRetryWindow = null;
function widenRetryWindow() {
  if (inFlightVideos++ === 0) { savedRetryWindow = storage.maxUploadRetryTime; storage.maxUploadRetryTime = VIDEO_RETRY_WINDOW_MS; }
}
function restoreRetryWindow() {
  if (--inFlightVideos === 0 && savedRetryWindow != null) storage.maxUploadRetryTime = savedRetryWindow;
}

/**
 * Upload a video's exact bytes. → { url, path, bytes, mime, md5 }.
 * `onProgress(sentBytes, totalBytes, state)`; `registerCancel(fn)` hands the
 * caller a cancel. Never overwrites: the path is new.
 */
export function uploadVideoOriginal(pid, id, file, { sha256, onProgress, registerCancel } = {}) {
  assertPid(pid);
  const mime = videoMime(file);
  const path = `products/${pid}/media/${id}.${videoExt(file, mime)}`;
  const sRef = storageRef(storage, path);
  widenRetryWindow();
  const task = uploadBytesResumable(sRef, file, {
    contentType: mime,
    cacheControl: "public, max-age=31536000, immutable",
    customMetadata: { sha256: sha256 || "", kind: "publish-video-original" },
  });
  const pauseOffline = () => { try { task.pause(); } catch { /* not running */ } };
  const resumeOnline = () => { try { task.resume(); } catch { /* not paused */ } };
  if (typeof window !== "undefined") {
    window.addEventListener("offline", pauseOffline);
    window.addEventListener("online", resumeOnline);
  }
  registerCancel?.(() => task.cancel());
  const cleanup = () => {
    restoreRetryWindow();
    if (typeof window !== "undefined") {
      window.removeEventListener("offline", pauseOffline);
      window.removeEventListener("online", resumeOnline);
    }
  };
  return new Promise((resolve, reject) => {
    task.on("state_changed",
      (snap) => onProgress?.(snap.bytesTransferred, snap.totalBytes, snap.state),
      (err) => { cleanup(); reject(err); },
      async () => {
        cleanup();
        try {
          const meta = task.snapshot.metadata;
          // The bytes the server holds must be the bytes picked — size is the
          // cheap check here; the end-to-end proof compares hashes.
          if (Number(meta?.size) !== file.size) throw new Error(`upload size mismatch: sent ${file.size}, stored ${meta?.size}`);
          const url = await getDownloadURL(sRef);
          resolve({ url, path, bytes: file.size, mime, md5: meta?.md5Hash || null });
        } catch (e) { reject(e); }
      });
  });
}

/** Upload a poster JPEG beside its video. → { url, path } */
export async function uploadPoster(pid, id, blob) {
  assertPid(pid);
  const path = `products/${pid}/media/${id}_poster.jpg`;
  const sRef = storageRef(storage, path);
  await uploadBytes(sRef, blob, { contentType: "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
  return { url: await getDownloadURL(sRef), path };
}

/**
 * One picked file → one finished media item (bytes in Storage), or a thrown
 * Error whose message is the plain sentence to show. Steps report through
 * `onStep({ phase, done, total })` — phase: hashing | checking | uploading |
 * poster. `existing` = the product's current items (an exact file it already
 * holds is refused here, before any upload).
 */
export async function prepareMediaItem(pid, file, { existing = [], uid = null, onStep, registerCancel } = {}) {
  assertPid(pid);
  const problem = pickedFileProblem(file);
  if (problem) throw new Error(problem);
  const kind = pickedKind(file);
  onStep?.({ phase: "hashing", done: 0, total: file.size });
  const sha256 = await hashFile(file, (done, total) => onStep?.({ phase: "hashing", done, total }));
  if (existing.some((m) => m.sha256 === sha256)) throw new Error("This exact file is already in this product's photos and videos.");
  onStep?.({ phase: "checking" });
  const claim = await claimMediaHash(pid, sha256, kind);
  if (!claim.ok) {
    const who = claim.ownerName ? `“${claim.ownerName}” (${claim.ownerPid})` : claim.ownerPid || "another product";
    throw new Error(`Not added — this exact ${kind} is already on ${who}. Check the right ${kind} was picked.`);
  }
  const id = newMediaId();
  const base = { id, sha256, addedAt: serverNowMs(), source: "upload", ...(uid ? { addedBy: uid } : {}) };
  if (kind === "photo") {
    onStep?.({ phase: "uploading", done: 0, total: 1 });
    const blob = await compressImageFile(file);
    const url = await uploadPublishPhoto(pid, blob);
    onStep?.({ phase: "uploading", done: 1, total: 1 });
    return { ...base, type: "photo", url, path: storagePathOf(url) || undefined, mime: "image/jpeg", bytes: blob.size };
  }
  const facts = await readVideoFacts(file);
  const up = await uploadVideoOriginal(pid, id, file, {
    sha256, registerCancel,
    onProgress: (done, total, state) => onStep?.({ phase: state === "paused" ? "paused" : "uploading", done, total }),
  });
  let poster = null;
  if (facts.poster) {
    onStep?.({ phase: "poster" });
    // A poster that fails to save costs only the thumbnail, never the video.
    try { poster = await uploadPoster(pid, id, facts.poster); } catch { poster = null; }
  }
  const item = { ...base, type: "video", url: up.url, path: up.path, mime: up.mime, bytes: up.bytes };
  if (poster) { item.posterUrl = poster.url; item.posterPath = poster.path; }
  if (facts.durationMs) item.durationMs = facts.durationMs;
  if (facts.width && facts.height) { item.width = facts.width; item.height = facts.height; }
  return item;
}
