// The card's only door to the data: the callables in
// functions/newArrivals/newArrivals.js. Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions, database } from "../../firebase";
import { ref, get } from "firebase/database";
import { saveProductPrices } from "../admin/productPriceSave";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const newArrivalsApi = {
  // One page of a tab (New or Done), within one group (Sneakers / Clothing)
  // on New — ordered photo ready → generating → no photo yet by the server:
  // { items, total, nextCursor, tabCounts, groupCounts, stats, modes, matchingPids? }.
  list: (tab, { cursor = null, limit = 30, group = null } = {}) =>
    call("newArrivalsList")({ tab, limit, ...(cursor ? { cursor } : {}), ...(group ? { group } : {}) }),
  // Approve the main / selected photo of each pid (any item with a photo; the
  // server logs approve-anyway when its verdict failed). `anyway` is legacy.
  approve: (pids, { anyway = false, genId = null } = {}) => call("newArrivalsApprove")({ pids, ...(anyway ? { anyway: true } : {}), ...(genId ? { genId } : {}) }),
  approveAll: () => call("newArrivalsApprove")({ all: true }),
  retry: (pid) => call("newArrivalsRetry")({ pid }),
  generate: (pids, { regenerate = false } = {}) => call("newArrivalsGenerate")({ pids, ...(regenerate ? { regenerate: true } : {}) }),
  skip: (pids) => call("newArrivalsSkip")({ pids }),
  restore: (pids) => call("newArrivalsRestore")({ pids }),
  reject: (pid, reason) => call("newArrivalsReject")({ pid, reason }),
  // "Use this one": make generation `genId` the item's main photo (lane kept).
  select: (pid, genId) => call("newArrivalsSelect")({ pid, genId }),
  // ❤ / un-❤ one generation (the learning log's strongest positive). Never
  // moves or approves the item.
  love: (pid, genId, loved) => call("newArrivalsLove")({ pid, genId, loved: loved === true }),
  // THE admin price save (admin/productPriceSave.saveProductPrices — the one
  // the product page, the Marketing card and Missing prices use): the product's
  // REAL stockPrice / retailPrice through applyPriceBatch "single_edit", so
  // price history, POS and the Shopify price sync behave as for an admin edit.
  // `drafts` holds only the fields Junid changed. The card's list can be up to
  // 30s old: the current prices are re-read (two keyed scalars) first, so the
  // audit's `from` is the live value and a field he did not touch is never
  // written. → { ok, count } | { ok: false, error, needsConfirm? }.
  savePrices: async (pid, product, rawDrafts, opts = {}) => {
    // On the card an EMPTY field means "leave it" — never "clear the real price".
    const drafts = Object.fromEntries(Object.entries(rawDrafts || {}).filter(([, v]) => String(v ?? "").trim() !== ""));
    const [stock, retail] = await Promise.all(["stockPrice", "retailPrice"].map((f) => get(ref(database, `products/${pid}/${f}`)).then((s) => s.val())));
    const live = { ...product, id: pid, name: product?.name || "", stockPrice: stock, retailPrice: retail };
    return saveProductPrices(live, drafts, { label: `New Arrivals: ${product?.name || pid}`, ...opts });
  },
};
