// scripts/test-broadcast-upload.mjs
//
// Verifies Phase 2 Storage setup:
//   (1) anonymous client-SDK write to /broadcast-media/** is denied
//   (2) authenticated upload (via gcloud OAuth token) lands at the expected
//       path and is publicly readable via the standard download URL
//
// No new dependencies — uses the already-installed firebase client SDK and
// shells out to gcloud for an access token. Requires `gcloud auth login` to
// have been completed previously (Junid already has this from Firebase CLI).
//
// Usage: node scripts/test-broadcast-upload.mjs

import { initializeApp } from "firebase/app";
import { getStorage, ref, uploadBytes } from "firebase/storage";
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname     = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT  = resolve(__dirname, "..");

const BUCKET    = "marathon-club.firebasestorage.app";
const FB_CONFIG = {
  apiKey:        "AIzaSyAA3r3arlTQvouidDWY0OE-Y2t5ZUF8kCo",
  authDomain:    "marathon-club.firebaseapp.com",
  projectId:     "marathon-club",
  storageBucket: BUCKET,
  appId:         "1:306270814317:web:470395933121de7dbdbf64",
};

let failures = 0;

// ── Test 1: anonymous client write should be denied ─────────────────────────
console.log("Test 1: anonymous client write to /broadcast-media/** — expect denial");
try {
  const app     = initializeApp(FB_CONFIG, "test-anon");
  const storage = getStorage(app);
  const r       = ref(storage, `broadcast-media/_deny-test-${Date.now()}.txt`);
  await uploadBytes(r, new Uint8Array([0x68, 0x69])); // "hi"
  console.error("  ✗ FAIL: upload succeeded — rule is NOT denying anonymous writes");
  failures++;
} catch (err) {
  if (err?.code === "storage/unauthorized") {
    console.log("  ✓ PASS: denied (storage/unauthorized)");
  } else {
    console.error("  ✗ UNEXPECTED ERROR:", err?.code || err?.message || err);
    failures++;
  }
}

// ── Test 2: authenticated upload + public read ──────────────────────────────
console.log("\nTest 2: gcloud-authenticated upload + public URL fetch");

let accessToken;
try {
  accessToken = execSync("gcloud auth print-access-token", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch (err) {
  console.error("  ✗ Could not get gcloud access token. Run: gcloud auth login");
  console.error("    Details:", err.message);
  process.exit(1);
}

const utcDate   = new Date().toISOString().slice(0, 10);
const path      = `broadcast-media/${utcDate}-UTC/test-${crypto.randomUUID()}.jpg`;
const testImage = await readFile(resolve(PROJECT_ROOT, "public/hero/marathon.jpg"));

const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(path)}`;
const uploadRes = await fetch(uploadUrl, {
  method:  "POST",
  headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" },
  body:    testImage,
});
if (!uploadRes.ok) {
  console.error("  ✗ FAIL: upload returned HTTP", uploadRes.status);
  console.error("    Body:", await uploadRes.text());
  process.exit(1);
}
console.log("  ✓ uploaded:", path);

// Fetch via the same Firebase download URL pattern the broadcast VM will use
const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
const fetchRes  = await fetch(publicUrl);
if (!fetchRes.ok) {
  console.error("  ✗ FAIL: public fetch returned HTTP", fetchRes.status);
  failures++;
} else {
  const got = await fetchRes.arrayBuffer();
  if (got.byteLength === testImage.byteLength) {
    console.log(`  ✓ PASS: public URL returned ${got.byteLength} bytes (matches uploaded)`);
    console.log("    URL:", publicUrl);
  } else {
    console.error(`  ✗ FAIL: fetched ${got.byteLength} bytes, expected ${testImage.byteLength}`);
    failures++;
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
const deleteUrl = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o/${encodeURIComponent(path)}`;
const deleteRes = await fetch(deleteUrl, {
  method:  "DELETE",
  headers: { Authorization: `Bearer ${accessToken}` },
});
if (deleteRes.ok || deleteRes.status === 204) {
  console.log("\nCleanup: test object deleted.");
} else {
  console.warn("\nCleanup warning: HTTP", deleteRes.status, "— remove manually:", path);
}

process.exit(failures === 0 ? 0 : 1);
