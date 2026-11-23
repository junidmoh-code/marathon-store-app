// The BF Candidates card's only door to the data: the callables in
// functions/bfCandidates/ (Junid only, except storeList: any signed-in staff).
// Kept apart from the screens so they render in tests with a fake api.
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { blackFridayApi } from "../blackFriday/blackFridayApi";

const call = (name, opts) => async (data) => (await httpsCallable(functions, name, opts)(data)).data;
const set = call("bfSaleSet", { timeout: 300_000 });

export const bfCandidatesApi = {
  // The list's small photo: the Black Friday card's own 360 px thumbnails.
  thumb: blackFridayApi.thumb,
  // One tab, one page: { rows, counts, total, more, windowDays, defaultEndDay, defaultUntil, today, locNames, meta }
  list: (tab, windowDays, from = 0) => call("bfSaleList")({ tab, windowDays, from }),
  // ONE sale price for the chosen products. → { ok, done, refused, until } or { ok:false, needConfirm:[…] } when the
  // price is at or above a stock price (nothing saved until confirmAbove names exactly the products warned about).
  sale: (pids, price, endDay, { confirmAbove = null } = {}) => set({ action: "sale", pids, price, endDay, ...(confirmAbove ? { confirmAbove } : {}) }),
  extend: (pids, endDay) => set({ action: "extend", pids, endDay }),
  extendAll: (endDay) => set({ action: "extend", all: true, endDay }),
  end: (pids) => set({ action: "end", pids }),
  // "Not for sale": off the list for good; restore = the undo.
  remove: (pids) => set({ action: "remove", pids }),
  restore: (pids) => set({ action: "restore", pids }),
  removed: () => set({ action: "removed" }),
  // PHOTOS (the Black Friday card's own options, Junid 23 Nov): Generate / Regenerate = the shared New Arrivals
  // generator at full resolution; Replace photo = his own photo. Both keep the photo on the Black Friday card's
  // store; `photo` records which one THIS card posts ("current" = the product's own photo again).
  generate: (pid, opts) => blackFridayApi.generate(pid, undefined, opts),
  photoUpload: (pid, imageBase64) => blackFridayApi.photoUpload(pid, imageBase64),
  photo: (pid, use, genId = null) => set({ action: "photo", pid, use, ...(genId ? { genId } : {}) }),
  // The staff re-tag list: what is on sale at each location.
  storeList: () => call("bfSaleStoreList")({}),
};
