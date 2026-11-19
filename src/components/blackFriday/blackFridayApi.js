// The Black Friday card's only door to the data: the callables in
// functions/blackFriday/ (Junid only). Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions, auth, app } from "../../firebase";
import { streamCallable } from "../newArrivals/studioStream";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;
const set = call("bfCampaignSet");

export const blackFridayApi = {
  // One section: "main" (13+ on hand) or "under" (Show under 13).
  // → { review: [row], approved: [row], totals, rejected, styles, schedule, plan, postingPaused, meta }
  list: (section = "main") => call("bfCampaignList")({ section }),
  // sig: the photo the card showed ("current" or a genId) — a different photo now is refused.
  approve: (pid, section, sig) => set({ action: "approve", pid, section, ...(sig ? { sig } : {}) }),
  reject: (pid, section) => set({ action: "reject", pid, section }),
  // Back to To review: undo a rejection, or take back an approval.
  reset: (pid) => set({ action: "reset", pid }),
  use: (pid, use, genId = null, section) => set({ action: "use", pid, use, section, ...(genId ? { genId } : {}) }),
  // sigs: { pid: sig } of the 30+ rows the card shows in To review.
  approveBig: (sigs) => set({ action: "approveBig", sigs }),
  approveStyle: (kind) => set({ action: "approveStyle", kind }),
  // Multi-select: one transaction per product. → { ok, done: [pid], refused: [{ pid, refusal }] }
  approveMany: (sigs) => set({ action: "approveMany", sigs }),
  rejectMany: (pids) => set({ action: "rejectMany", pids }),
  resetMany: (pids) => set({ action: "resetMany", pids }),
  // Undo: { pid: { prev, expectAt } } from an action's answer — each pick back to exactly what it was.
  undo: (items) => set({ action: "undo", items }),
  schedule: (schedule, { confirm = false } = {}) => set({ action: "schedule", schedule, confirm: confirm === true }),
  clearSchedule: () => set({ action: "clearSchedule" }),
  // One AI photo (streams { type: "status" | "thought" } while it works).
  generate: (pid, section, { onEvent = null } = {}) => streamCallable({
    url: `https://europe-west1-${app.options.projectId}.cloudfunctions.net/bfGenerate`,
    data: { pid, section },
    getToken: () => auth.currentUser?.getIdToken(),
    onChunk: onEvent,
  }),
};
