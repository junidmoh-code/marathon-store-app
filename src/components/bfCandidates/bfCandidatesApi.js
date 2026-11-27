// The BF Candidates card's only door to the data: the callables in
// functions/bfCandidates/ (Junid only, except storeList: any signed-in staff).
// Kept apart from the screens so they render in tests with a fake api.
import { httpsCallable } from "firebase/functions";
import { functions, auth } from "../../firebase";
import { blackFridayApi } from "../blackFriday/blackFridayApi";

const call = (name, opts) => async (data) => (await httpsCallable(functions, name, opts)(data)).data;
const set = call("bfSaleSet", { timeout: 300_000 });

export const bfCandidatesApi = {
  // Whose card this is (the list kept on the device is kept per account).
  uid: () => (auth.currentUser && auth.currentUser.uid) || null,
  // The list's small photo: the Black Friday card's own 360 px thumbnails.
  thumb: blackFridayApi.thumb,
  // One tab ("clothing" | "sneakers" | "onsale"), one page:
  // { rows, counts, total, more, cutoff, cutoffs, saleEnds, defaultEndDay, defaultUntil, today, locNames, meta }
  list: (tab, cutoff, from = 0) => call("bfSaleList")({ tab, cutoff, from }),
  // ONE sale price for the chosen products. → { ok, done, refused, until } or { ok:false, needConfirm:[…] } when the
  // price is at or above a stock price (nothing saved until confirmAbove names exactly the products warned about).
  // No end date is sent: a new sale ends with the rest (Mon 30 Nov, or later once extended); Edit price keeps the sale's own end.
  // (endDay is only sent once the default end has passed and Junid picked a new one at the top of the card.)
  sale: (pids, price, { confirmAbove = null, endDay = null } = {}) => set({ action: "sale", pids, price, ...(endDay ? { endDay } : {}), ...(confirmAbove ? { confirmAbove } : {}) }),
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
  // Generate never depends on the open connection (it drops when the phone locks): the card takes a mark before it
  // starts, then asks what landed since. → { ok, photo, genId } | { ok:false, failed } | { ok:false, pending }
  photoMark: (pid) => set({ action: "photo", pid, use: "mark" }),
  photoLanded: (pid, since) => set({ action: "photo", pid, use: "landed", since }),
  // The staff re-tag list: what is on sale at each location.
  storeList: () => call("bfSaleStoreList")({}),
};
