// The Black Friday card's only door to the data: the two callables in
// functions/blackFriday/blackFriday.js (Junid only). Kept apart from the
// screen so the screen renders in tests with a fake api and no Firebase.
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";

const call = (name) => async (data) => (await httpsCallable(functions, name)(data)).data;

export const blackFridayApi = {
  // { groups: [view], counts: { waiting, approved, … }, meta: { builtAt, eligible, groupCount, noPhotoCount, noPhoto } }
  list: () => call("bfCampaignList")({}),
  approve: (key) => call("bfCampaignSet")({ action: "approve", key }),
  approveAll: (keys) => call("bfCampaignSet")({ action: "approve", keys }),
  unapprove: (key) => call("bfCampaignSet")({ action: "unapprove", key }),
  tick: (key, pid, include) => call("bfCampaignSet")({ action: include ? "include" : "exclude", key, pid }),
};
