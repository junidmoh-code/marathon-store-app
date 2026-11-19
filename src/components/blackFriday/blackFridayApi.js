// The Black Friday card's only door to the data: the callables in
// functions/blackFriday/ (Junid only). Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions, auth, app } from "../../firebase";
import { streamCallable } from "../newArrivals/studioStream";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;
const set = call("bfCampaignSet");

export const blackFridayApi = {
  // { groups: [view], counts, totals, schedule, postingPaused, meta }
  list: () => call("bfCampaignList")({}),
  approve: (key) => set({ action: "approve", key }),
  approveItem: (key, pid) => set({ action: "approveItem", key, pid }),
  approveAll: (keys) => set({ action: "approve", keys }),
  unapprove: (key) => set({ action: "unapprove", key }),
  tick: (key, pid, include) => set({ action: include ? "include" : "exclude", key, pid }),
  // "Use current photo" / back to the generated one.
  use: (key, pid, use, genId = null) => set({ action: "use", key, pid, use, ...(genId ? { genId } : {}) }),
  // The schedule: confirm:false returns the plan only; confirm:true saves it (and posting can start).
  schedule: (schedule, { confirm = false } = {}) => set({ action: "schedule", schedule, confirm: confirm === true }),
  clearSchedule: () => set({ action: "clearSchedule" }),
  // GENERATE / REGENERATE one photo (Gemini, the New Arrivals house look). Streams
  // { type: "status" | "thought" | "draft" } while it works; resolves with { ok, pid, genId, costZar, width, height }.
  generate: (key, pid, { onEvent = null } = {}) => streamCallable({
    url: `https://europe-west1-${app.options.projectId}.cloudfunctions.net/bfGenerate`,
    data: { key, pid },
    getToken: () => auth.currentUser?.getIdToken(),
    onChunk: onEvent,
  }),
};
