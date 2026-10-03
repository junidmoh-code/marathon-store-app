// The card's only door to the data: the three callables in
// functions/newArrivals/newArrivals.js. Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions, database } from "../../firebase";
import { ref, get } from "firebase/database";
import { saveMissingPrice } from "../admin/missingPriceSave";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const newArrivalsApi = {
  list: (tab, limit = 60) => call("newArrivalsList")({ tab, limit }),
  approve: (pids) => call("newArrivalsApprove")({ pids }),
  approveAll: () => call("newArrivalsApprove")({ all: true }),
  retry: (pid) => call("newArrivalsRetry")({ pid }),
  // The Admin › Missing prices save — the same code path, no new write path.
  // The card's list can be up to 30s old: the prices are re-read first, so a
  // price set elsewhere meanwhile is seen as present and never overwritten.
  savePrice: async (pid, product, costDraft, retailDraft, opts = {}) => {
    const [stock, retail] = await Promise.all(["stockPrice", "retailPrice"].map((f) => get(ref(database, `products/${pid}/${f}`)).then((s) => s.val())));
    const fresh = { ...product, id: pid, stockPrice: stock, retailPrice: retail };
    return saveMissingPrice(fresh, costDraft, retailDraft, { label: `New Arrivals: ${product?.name || pid}`, ...opts });
  },
};
