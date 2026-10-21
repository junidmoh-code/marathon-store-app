// ── The Shipping card's live quotes (Mac mini, launchd com.marathon.shippingquotes)
// The browser never holds the Courier Guy key, and this repo keeps third-party
// credentials on the mini rather than in a Cloud Function (the Shopify sync
// works the same way). So the card writes a request to
// /shipping_quotes/requests/{id}; this process — one long-lived listener on
// that small node — prices it with two POST /rates calls and writes
// /shipping_quotes/answers/{id}, then deletes the request.
//
// RATES ONLY. This file never imports or calls anything that books or
// cancels; quote-runner.test.mjs pins that by reading this source.
//
// Requests older than REQUEST_TTL_MS are dropped unanswered (the card has
// long since timed out); answers older than ANSWER_TTL_MS are pruned at start.
//
//   node scripts/shipping/quote-runner.mjs          (what launchd runs)
import { fileURLToPath } from "node:url";
import { createCourierClient, fileLogger } from "./courier-client.mjs";
import { quoteParcel } from "./quote.mjs";
import { chooseRate } from "../../src/shipping/chooseService.js";
import { mergeShippingConfig } from "../../src/shipping/shippingConfig.js";
import { chooseLocker } from "../../src/shipping/estimateParcel.js";
import { adminDb } from "./adminDb.mjs";

export const REQUESTS_PATH = "shipping_quotes/requests";
export const ANSWERS_PATH = "shipping_quotes/answers";
export const REQUEST_TTL_MS = 5 * 60_000;
export const ANSWER_TTL_MS = 24 * 3600_000;

/** Price one request and write its answer. Never throws; the answer carries the error. */
export async function answerQuoteRequest({ db, client, id, req, now = Date.now() }) {
  const answer = { answeredAt: now, ref: req?.ref ?? null };
  try {
    if (!req || typeof req !== "object") throw new Error("empty request");
    if (now - Number(req.requestedAt || 0) > REQUEST_TTL_MS) {
      await db.ref(`${REQUESTS_PATH}/${id}`).remove();
      return null;
    }
    const cfg = mergeShippingConfig((await db.ref("config/shipping").get()).val());
    const parcel = req.parcel ?? {};
    const quoted = await quoteParcel(client, {
      collectionAddress: req.collectionAddress ?? cfg.collectionAddress,
      deliveryAddress: req.deliveryAddress,
      parcel,
      dropBox: req.dropBox ?? { pickupPointId: cfg.dropBox.pickupPointId, pickupPointProvider: cfg.dropBox.pickupPointProvider },
    });
    answer.door = quoted.door;
    answer.locker = quoted.locker;
    const eligible = !!chooseLocker([parcel.lengthCm, parcel.widthCm, parcel.heightCm].map(Number), Number(parcel.actualKg), cfg.dropBox);
    const chosen = chooseRate({ door: quoted.door.rates, locker: quoted.locker.rates }, { dropBoxEligible: eligible }, cfg);
    answer.chosen = chosen ? { mode: chosen.mode, code: chosen.rate.code, name: chosen.rate.name, rate: chosen.rate.rate } : null;
  } catch (err) {
    answer.error = String(err?.message || err).slice(0, 300);
  }
  await db.ref(`${ANSWERS_PATH}/${id}`).set(answer);
  await db.ref(`${REQUESTS_PATH}/${id}`).remove();
  return answer;
}

async function main() {
  const log = fileLogger();
  const db = adminDb();
  const client = createCourierClient({ log });

  // Answers are only ever read for a minute: prune day-old ones at start and hourly.
  const prune = async () => {
    try {
      const old = await db.ref(ANSWERS_PATH).orderByChild("answeredAt").endAt(Date.now() - ANSWER_TTL_MS).get();
      if (old.exists()) await Promise.all(Object.keys(old.val()).map((k) => db.ref(`${ANSWERS_PATH}/${k}`).remove()));
    } catch (err) { log(`quote-runner prune failed: ${err?.message || err}`); }
  };
  await prune();
  setInterval(prune, 3600_000);

  const inFlight = new Set();
  db.ref(REQUESTS_PATH).on("child_added", async (snap) => {
    const id = snap.key;
    if (inFlight.has(id)) return;
    inFlight.add(id);
    try {
      const a = await answerQuoteRequest({ db, client, id, req: snap.val() });
      log(`quote-runner ${id} ${a ? (a.error ? `error ${a.error}` : `chosen ${a.chosen?.code ?? "none"}`) : "expired"}`);
    } catch (err) {
      // A failed answer/remove write must not kill the listener (KeepAlive
      // would restart it straight into the same request — a crash loop).
      log(`quote-runner ${id} write failed: ${err?.message || err}`);
    } finally {
      inFlight.delete(id);
    }
  });
  log("quote-runner listening");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err?.message || err); process.exit(1); });
}
