// ─── Browser half of the Concrete house style ───────────────────────────────
// Reference library (Storage concrete_style_refs/ + /config/concrete_house_style/refs),
// the editable prompt, the generation queue and the approval gate. The Mac
// mini worker (scripts/concrete/house-style-worker.mjs) does the generating;
// the browser never calls Gemini and never spends money without the batch
// confirm in HouseStylePanel.
import { useEffect, useState } from "react";
import { ref, onValue, update, get, child } from "firebase/database";
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { database, storage, auth } from "../../firebase";
import { serverNowMs } from "../../utils/serverTime";
import {
  HOUSE_STYLE_CONFIG_PATH, HOUSE_STYLE_JOBS_PATH, HOUSE_STYLE_REFS_STORAGE, STATUS, buildQueueUpdate,
} from "../../utils/concreteHouseStyle";
import { CONCRETE_PUBLISH_PATH } from "../../utils/concreteListing";
import { lazyPhotoItem, resolveMediaList } from "../shopify/publishShared";
import { setPublishMedia } from "../shopify/shopifyPublishStore";
import { publishTarget } from "../shopify/publishTarget";

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

/** Queue many products (after the batch confirm). */
export async function queueGeneration(pids, cfg) {
  if (!pids.length) return { ok: true, count: 0 };
  try {
    await update(ref(database), buildQueueUpdate({ pids, uid: uid(), nowMs: serverNowMs(), cfg }));
    return { ok: true, count: pids.length };
  } catch (e) { return { ok: false, message: plain(e) }; }
}

export async function rejectImage(pid) {
  try {
    await update(ref(database, `${HOUSE_STYLE_JOBS_PATH}/${pid}`), { status: STATUS.REJECTED, rejectedAt: serverNowMs(), rejectedBy: uid() });
    return { ok: true };
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
  // that is Concrete's, so an approval can never land on Marathon's listing.
  if (publishTarget() !== "concrete") return { ok: false, message: "Open the Concrete tab to approve." };
  try {
    const nodeSnap = await get(child(ref(database), `${CONCRETE_PUBLISH_PATH}/${pid}`));
    const node = nodeSnap.val();
    if (node) {
      const existing = resolveMediaList(node, product).items.filter((it) => it.url !== job.url);
      const r = await setPublishMedia(pid, node, [lazyPhotoItem(job.url, "concrete_house_style"), ...existing]);
      if (!r?.ok) return { ok: false, message: r?.message || "Could not set the Concrete photo" };
    }
    await update(ref(database, `${HOUSE_STYLE_JOBS_PATH}/${pid}`), { status: STATUS.APPROVED, approvedAt: serverNowMs(), approvedBy: uid() });
    return { ok: true };
  } catch (e) { return { ok: false, message: plain(e) }; }
}
