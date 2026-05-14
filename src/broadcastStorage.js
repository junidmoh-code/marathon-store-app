// src/broadcastStorage.js
//
// Uploads broadcast media (images, video) to Firebase Storage. The returned
// public URL is what gets sent to the broadcast service VM (via the
// sendBroadcast Cloud Function), which then passes it to WhatsApp. Paths are
// organized as:
//
//   broadcast-media/{YYYY-MM-DD}-UTC/{uuid}.{ext}
//
// Allowed types: JPG/PNG/WEBP for photos (max 16 MB each); MP4/MOV/3GP/WEBM
// for videos (max 200 MB each). Falls back to filename extension when the
// browser-supplied MIME is empty (e.g. files dragged from Drive/iCloud).
// Public read on broadcast-media/** is configured in storage.rules; write
// requires an authenticated Firebase user.

import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase";

const MAX_PHOTO_BYTES = 16  * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const ALLOWED_BY_MIME = {
  "image/jpeg":      "jpg",
  "image/png":       "png",
  "image/webp":      "webp",
  "video/mp4":       "mp4",
  "video/quicktime": "mov",   // iPhone camera default
  "video/3gpp":      "3gp",   // older Android
  "video/webm":      "webm",  // web-recorded
};
// Extension fallback for files with empty/unknown MIME (Drive/iCloud drag, etc.).
const ALLOWED_BY_EXT = {
  jpg: "jpg", jpeg: "jpg",
  png:  "png",
  webp: "webp",
  mp4:  "mp4",
  mov:  "mov",
  "3gp":"3gp",
  webm: "webm",
};
const VIDEO_EXTS = new Set(["mp4", "mov", "3gp", "webm"]);
// Reverse map so we can supply a sensible Content-Type to Storage when the
// browser handed us an empty MIME.
const EXT_TO_MIME = {
  jpg:  "image/jpeg",
  png:  "image/png",
  webp: "image/webp",
  mp4:  "video/mp4",
  mov:  "video/quicktime",
  "3gp":"video/3gpp",
  webm: "video/webm",
};

function resolveExt(file) {
  if (file.type && ALLOWED_BY_MIME[file.type]) return ALLOWED_BY_MIME[file.type];
  const m = (file.name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (m && ALLOWED_BY_EXT[m[1]]) return ALLOWED_BY_EXT[m[1]];
  return null;
}

export async function uploadBroadcastMedia(file) {
  const ext = resolveExt(file);
  if (!ext) {
    const got = file.type || file.name || "(unknown)";
    throw new Error(`Unsupported file: ${got}. Allowed: JPG, PNG, WEBP, MP4, MOV, 3GP, WEBM.`);
  }
  const isVideo  = VIDEO_EXTS.has(ext);
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
  if (file.size > maxBytes) {
    const mb    = (file.size / 1024 / 1024).toFixed(1);
    const maxMb = isVideo ? 200 : 16;
    const kind  = isVideo ? "Video" : "Photo";
    throw new Error(`${kind} too large: ${mb} MB. Max ${maxMb} MB.`);
  }

  const utcDate     = new Date().toISOString().slice(0, 10);
  const path        = `broadcast-media/${utcDate}-UTC/${crypto.randomUUID()}.${ext}`;
  const ref         = storageRef(storage, path);
  const contentType = file.type || EXT_TO_MIME[ext] || "application/octet-stream";
  await uploadBytes(ref, file, { contentType });
  const url         = await getDownloadURL(ref);
  return { url, path };
}
