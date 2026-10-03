// The card's only door to the data: the three callables in
// functions/newArrivals/newArrivals.js. Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { saveMissingPrice } from "../admin/missingPriceSave";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const newArrivalsApi = {
  list: (tab, limit = 60) => call("newArrivalsList")({ tab, limit }),
  approve: (pids) => call("newArrivalsApprove")({ pids }),
  approveAll: () => call("newArrivalsApprove")({ all: true }),
  retry: (pid) => call("newArrivalsRetry")({ pid }),
  // The Admin › Missing prices save — the same code path, no new write path.
  savePrice: (pid, product, costDraft, retailDraft, opts = {}) =>
    saveMissingPrice({ ...product, id: pid }, costDraft, retailDraft, { label: `New Arrivals: ${product?.name || pid}`, ...opts }),
};
