// The Black Friday card's only door to the data: the callables in
// functions/blackFriday/ (Junid only). Kept apart from the screen so the
// screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions, auth, app } from "../../firebase";
import { streamCallable } from "../newArrivals/studioStream";

const call = (name, opts) => async (data) => (await httpsCallable(functions, name, opts)(data)).data;
// A full-resolution photo over a phone connection, or a web search: up to 3 minutes.
const source = call("bfPhotoSource", { timeout: 180_000 });
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
  // Choose the photo a product shows: "current" (app: true = the APP photo again, and Generate starts from it
  // again) or "generated" with a genId (an AI photo or one of his own). approve: true (Approved tab) approves it too.
  use: (pid, use, genId = null, section, { app = false, approve = false } = {}) => set({ action: "use", pid, use, section, ...(genId ? { genId } : {}), ...(app ? { app: true } : {}), ...(approve ? { approve: true } : {}) }),
  // JUNID'S OWN PHOTO (20 Nov 2026), only on his tap: Replace photo (a photo from his iPhone, full resolution,
  // base64) and Find online (up to 6 candidates; the one he taps is stored). Either becomes the product's source.
  photoUpload: (pid, imageBase64) => source({ action: "upload", pid, imageBase64 }),
  findOnline: (pid) => source({ action: "search", pid }),
  pickOnline: (pid, c) => source({ action: "pick", pid, imageUrl: c.imageUrl, pageUrl: c.pageUrl || null, site: c.site || null }),
  // sigs: { pid: sig } of the 30+ rows the card shows in To review.
  approveBig: (sigs) => set({ action: "approveBig", sigs }),
  approveStyle: (kind) => set({ action: "approveStyle", kind }),
  // Multi-select: one transaction per product. → { ok, done: [pid], refused: [{ pid, refusal }] }
  approveMany: (sigs) => set({ action: "approveMany", sigs }),
  rejectMany: (pids) => set({ action: "rejectMany", pids }),
  // The multi-select, saved as Junid ticks ({ pid: sig }; {} clears it). list("main") returns it as `selection`.
  selSave: (sigs, label = null) => set({ action: "selSave", sigs, ...(label ? { label } : {}) }),
  resetMany: (pids) => set({ action: "resetMany", pids }),
  // Undo: { pid: { prev, expectAt } } from an action's answer — each pick back to exactly what it was.
  undo: (items) => set({ action: "undo", items }),
  schedule: (schedule, { confirm = false } = {}) => set({ action: "schedule", schedule, confirm: confirm === true }),
  clearSchedule: () => set({ action: "clearSchedule" }),
  // The posting brain: Pause / resume, and a slot moved to another time (null = back to the brain's time).
  brainPause: (paused) => set({ action: "brainPause", paused: paused === true }),
  brainSlot: (day, i, at) => set({ action: "brainSlot", day, i, at: at || null }),
  // Repost: approved products go to the next slot again ({ pids }). Nothing reposts by itself.
  repost: (pids) => set({ action: "repost", pids }),
  // A New Arrival's photo is made by New Arrivals' own studio (the same generator, the same item the
  // New Arrivals card shows) — so its photo and its approval are one.
  generateNa: (pid, { onEvent = null } = {}) => streamCallable({
    url: `https://europe-west1-${app.options.projectId}.cloudfunctions.net/newArrivalsStudio`,
    data: { pid },
    getToken: () => auth.currentUser?.getIdToken(),
    onChunk: onEvent,
  }),
  // One AI photo (streams { type: "status" | "thought" } while it works).
  generate: (pid, section, { onEvent = null } = {}) => streamCallable({
    url: `https://europe-west1-${app.options.projectId}.cloudfunctions.net/bfGenerate`,
    data: { pid, section },
    getToken: () => auth.currentUser?.getIdToken(),
    onChunk: onEvent,
  }),
};
