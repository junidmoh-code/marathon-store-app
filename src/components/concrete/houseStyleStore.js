// ─── Browser half of the Concrete house style ───────────────────────────────
// Reference library (Storage concrete_style_refs/ + /config/concrete_house_style/refs),
// the editable prompt, the generation queue and the approval gate. The Mac
// mini worker (scripts/concrete/house-style-worker.mjs) does the generating;
// the browser never calls Gemini and never spends money without the batch
// confirm in HouseStylePanel.
import { useEffect, useState } from "react";
import { ref, onValue, update, get, child, runTransaction } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import {
  HOUSE_STYLE_CONFIG_PATH, HOUSE_STYLE_JOBS_PATH, HOUSE_STYLE_REFS_STORAGE, STATUS, buildQueueUpdate, canQueue,
} from "../../utils/concreteHouseStyle";
import { CONCRETE_PUBLISH_PATH } from "../../utils/concreteListing";
import { lazyPhotoItem, resolveMediaList } from "../shopify/publishShared";
import { commitPublishMedia } from "../shopify/publishMediaCommit";
import { publishTarget, holdTarget } from "../shopify/publishTarget";

const uid = () => auth.currentUser?.uid || null;
const plain = (err) => {
  const m = String(err?.message || err);
  return /permission|unauthori[sz]ed/i.test(m) ? "Permission denied — the Concrete house-style rules have not been pasted yet (docs/CONCRETE-STORE.md)." : m;
};

/** Live config + jobs. Both nodes are small (one config, one row per Concrete product). */
export function useHouseStyle(enabled = true) {
  const [cfg, setCfg] = useState(null);
  const [jobs, setJobs] = useState({});
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const a = onValue(ref(database, HOUSE_STYLE_CONFIG_PATH), (s) => setCfg(s.val() || {}), (e) => setError(plain(e)));
    const b = onValue(ref(database, HOUSE_STYLE_JOBS_PATH), (s) => setJobs(s.val() || {}), (e) => setError(plain(e)));
    return () => { a(); b(); };
  }, [enabled]);
  return { cfg, jobs, error };
}

export async function savePrompt(prompt, model) {
  try {
    await update(ref(database, HOUSE_STYLE_CONFIG_PATH), { prompt: String(prompt || "").slice(0, 4000), model, updatedAt: serverNowMs(), updatedBy: uid() });
    return { ok: true };
  } catch (e) { return { ok: false, message: plain(e) }; }
}

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic" };
export async function addRefs(files, onEach = () => {}) {
  const results = [];
  for (const file of files) {
    const ext = EXT[file.type] || (file.name.split(".").pop() || "").toLowerCase();
    if (!["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) { results.push({ ok: false, message: `${file.name}: not a photo` }); continue; }
    if (file.size > 15 * 1048576) { results.push({ ok: false, message: `${file.name}: over 15 MB` }); continue; }
    const id = `r${serverNowMs()}_${Math.random().toString(36).slice(2, 7)}`;
    const path = `${HOUSE_STYLE_REFS_STORAGE}/${id}.${ext}`;
    try {
      const sRef = storageRef(storage, path);
      await uploadBytes(sRef, file, { contentType: file.type || "image/jpeg", cacheControl: "public, max-age=31536000, immutable" });
      const url = await getDownloadURL(sRef);
      await update(ref(database, `${HOUSE_STYLE_CONFIG_PATH}/refs/${id}`), { url, path, addedAt: serverNowMs(), by: uid(), name: String(file.name || "").slice(0, 120) });
      results.push({ ok: true, id });
    } catch (e) { results.push({ ok: false, message: `${file.name}: ${plain(e)}` }); }
    onEach(results.length);
  }
  return results;
}

export async function deleteRef(id, entry) {
  try {
    await update(ref(database, `${HOUSE_STYLE_CONFIG_PATH}/refs`), { [id]: null });
  } catch (e) { return { ok: false, message: plain(e) }; }
  if (entry?.path) deleteObject(storageRef(storage, entry.path)).catch(() => {});
  return { ok: true };
}

/**
 * Queue many products (after the batch confirm). Per product, by transaction:
 * a row already queued or generating is left alone (never re-billed, never
 * overwritten under the worker); anything else becomes a fresh queued row.
 */
export async function queueGeneration(pids, cfg) {
  if (!pids.length) return { ok: true, count: 0 };
  const rows = buildQueueUpdate({ pids, uid: uid(), nowMs: serverNowMs(), cfg });
  let count = 0;
  try {
    for (const [path, row] of Object.entries(rows)) {
      const res = await runTransaction(ref(database, path), (cur) => (canQueue(cur) ? row : undefined));
      if (res.committed && res.snapshot.val()?.requestedAt === row.requestedAt) count += 1;
    }
    return { ok: true, count };
  } catch (e) { return { ok: false, count, message: plain(e) }; }
}

export async function rejectImage(pid, shownUrl) {
  try {
    const res = await runTransaction(ref(database, `${HOUSE_STYLE_JOBS_PATH}/${pid}`), (cur) => {
      if (cur === null) return null;
      if (cur.status !== STATUS.AWAITING || cur.url !== shownUrl) return undefined;
      return { ...cur, status: STATUS.REJECTED, rejectedAt: serverNowMs(), rejectedBy: uid() };
    });
    return res.committed && res.snapshot.val()?.status === STATUS.REJECTED ? { ok: true } : { ok: false, message: "That image changed while you were looking — check it again." };
  } catch (e) { return { ok: false, message: plain(e) }; }
}

/**
 * Approve: the generated image becomes the product's CONCRETE publishing
 * photo (first in /shopify_publish_concrete/{pid}/media, the original kept
 * after it). With no publish row yet, the approval alone is recorded and the
 * reconciler uses the approved image when the product is first published.
 * Never touches /products or Marathon's node.
 */
export async function approveImage(pid, job, product) {
  // The store writes whichever node the Publishing tab targets; refuse unless
  // that is Concrete's, and hold it for the whole approval.
  if (publishTarget() !== "concrete") return { ok: false, message: "Open the Concrete tab to approve." };
  const release = holdTarget();
  try {
    // 1. Approve EXACTLY the image that was shown: the row must still be
    //    awaiting approval with this url (a regenerate or retry since the tap
    //    replaced it with an image nobody has seen).
    const res = await runTransaction(ref(database, `${HOUSE_STYLE_JOBS_PATH}/${pid}`), (cur) => {
      if (cur === null) return null;
      if (cur.status !== STATUS.AWAITING || cur.url !== job.url) return undefined;
      return { ...cur, status: STATUS.APPROVED, approvedAt: serverNowMs(), approvedBy: uid() };
    });
    if (!(res.committed && res.snapshot.val()?.status === STATUS.APPROVED && res.snapshot.val()?.url === job.url)) {
      return { ok: false, message: "That image changed while you were looking — check it again." };
    }
    // 2. Make it the Concrete publishing photo when the product has a
    //    Concrete row; otherwise the reconciler uses it at first publish.
    const node = (await get(child(ref(database), `${CONCRETE_PUBLISH_PATH}/${pid}`))).val();
    if (node) {
      const existing = resolveMediaList(node, product).items.filter((it) => it.url !== job.url);
      // Through the ONE media writer (publishMediaCommit). On the Concrete
      // target it never moves the app photo, so no app-photo deps are needed.
      const { res: r } = await commitPublishMedia(product, node, "set", [lazyPhotoItem(job.url, "concrete_house_style"), ...existing], null);
      if (!r?.ok) return { ok: false, message: `Approved, but the Concrete photo list could not be updated: ${r?.message || "not saved"}` };
    }
    return { ok: true };
  } catch (e) { return { ok: false, message: plain(e) }; }
  finally { release(); }
}
