// The card's only door to the data: the callables in
// functions/newArrivals/newArrivals.js. Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions, database } from "../../firebase";
import { ref, get } from "firebase/database";
import { saveMissingPrice } from "../admin/missingPriceSave";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const newArrivalsApi = {
  // One page of a tab: { items, total, nextCursor, tabCounts, stats, modes, matchingPids? }.
  list: (tab, { cursor = null, limit = 30, filter = null } = {}) =>
    call("newArrivalsList")({ tab, limit, ...(cursor ? { cursor } : {}), ...(filter ? { filter } : {}) }),
  approve: (pids, { anyway = false } = {}) => call("newArrivalsApprove")({ pids, ...(anyway ? { anyway: true } : {}) }),
  approveAll: () => call("newArrivalsApprove")({ all: true }),
  retry: (pid) => call("newArrivalsRetry")({ pid }),
  generate: (pids, { regenerate = false } = {}) => call("newArrivalsGenerate")({ pids, ...(regenerate ? { regenerate: true } : {}) }),
  skip: (pids) => call("newArrivalsSkip")({ pids }),
  restore: (pids) => call("newArrivalsRestore")({ pids }),
  reject: (pid, reason) => call("newArrivalsReject")({ pid, reason }),
  // The Admin › Missing prices save — the same code path, no new write path.
  // The card's list can be up to 30s old: the prices are re-read first, so a
  // price set elsewhere meanwhile is seen as present and never overwritten.
  // Stock price ONLY (the groups' price); retail stays Shopify's business.
  savePrice: async (pid, product, costDraft, opts = {}) => {
    const [stock, retail] = await Promise.all(["stockPrice", "retailPrice"].map((f) => get(ref(database, `products/${pid}/${f}`)).then((s) => s.val())));
    const fresh = { ...product, id: pid, stockPrice: stock, retailPrice: retail };
    return saveMissingPrice(fresh, costDraft, "", { label: `New Arrivals: ${product?.name || pid}`, costOnly: true, ...opts });
  },
};
