// ─── ONE PHOTO, ONE BACKGROUND SWAP — SERVER SIDE ────────────────────────────
// The per-photo "clean background" action on the Shopify product page. The
// browser sends a productId and gets back ONE candidate image; the API key
// never leaves this process.
//
// ── WHY THIS FUNCTION EXISTS AT ALL ──────────────────────────────────────────
// The action shipped in PR #368 called Gemini FROM THE BROWSER with the key
// baked into the bundle by vite (`__GEMINI_API_KEY__`). That key is readable by
// anyone who opens the site and views the JavaScript — the file said so itself
// and asked for a hard quota cap as the containment. Junid's instruction is
// simpler and correct: the key is never exposed to the browser. So the call
// moves here, where a Cloud Functions secret can hold it, and the bundle keeps
// no key at all. The action shipped DISABLED for want of a build-time key; it
// is now enabled by a secret the build never sees.
//
// ── WHAT THIS FUNCTION DOES NOT DO ───────────────────────────────────────────
// It does NOT decide whether the result is acceptable. The subject-preservation
// gate — the pixel comparison that discards a candidate whose product changed —
// stays in the browser (src/components/shopify/geminiClean.js), where the
// original and the candidate are both already decoded onto a canvas. Moving it
// here would mean re-decoding both images server-side to reach the same verdict
// with the same code. The gate is the same gate; only the paid call moved.
//
// It does NOT write anything. No Storage object, no RTDB node. The candidate is
// returned to the caller and is discarded unless a human accepts it, and
// accepting is the existing photoTools upload path.
//
// It does NOT run in bulk. One photo per call, by design and by Junid's settled
// policy: his painted backdrop stays the default for ordinary catalogue photos
// and is never bulk-regenerated. White backgrounds are generated one at a time,
// on demand, for the photos he is advertising with.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const ADMIN_EMAIL = "gunidmoh@gmail.com";

// gemini-3.1-flash-image ("Nano Banana 2"), the same model the Studio's
// white-background pipeline uses. NOT gemini-2.5-flash-image, which the
// browser version asked for and which Google retires on 2026-10-02 — the
// action would have started failing on its own before the end of the year.
const MODEL = "gemini-3.1-flash-image";
const FETCH_TIMEOUT_MS = 120000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

// Background replacement ONLY. Carried over verbatim from the browser version
// (PR #368) — the wording is load-bearing and was written against the owner's
// truthfulness rule: the photo a customer sees must be a truthful depiction of
// the item they will receive. It is still NOT trusted; the pixel gate in the
// browser is what actually holds the line.
const PROMPT =
  "Replace the background of this product photo with a plain, neutral, evenly lit " +
  "studio background in soft light grey. This is a background replacement ONLY. " +
  "The product itself must be preserved exactly as photographed: identical position, " +
  "scale, angle, colours and every pixel of its surface. Do not redraw, regenerate, " +
  "restyle, enhance or improve the product in any way. Do not remove, soften or hide " +
  "any logo, brand mark, label, tag, scuff, scratch, stain, crease, wear or damage — " +
  "this photo is a truthful record of a real second-hand item and every mark on it " +
  "must remain exactly visible. Return only the edited image.";

// Who may spend on this. The SAME rule the publishing page's own writes run
// under (the live console rule on /shopify_publish/$pid): Junid, or a stored
// stockRole of "admin". Anyone who can publish a product can clean its photo;
// nobody else can make the call at all.
async function assertPublisher(request, db) {
  const token = (request.auth && request.auth.token) || {};
  const provider = token.firebase && token.firebase.sign_in_provider;
  if (!request.auth || provider === "anonymous") {
    throw new HttpsError("unauthenticated", "Sign-in required.");
  }
  if (token.email === ADMIN_EMAIL && token.email_verified) return;
  const rec = (await db.ref(`users/${request.auth.uid}`).get()).val() || {};
  if (rec.stockRole !== "admin") {
    throw new HttpsError("permission-denied", "Cleaning a product photo needs stock admin rights.");
  }
}

// SSRF guard, same shape as the Studio's fetchImageBuffer: https only, and only
// the Google Storage hosts our photoUrls live on, with redirects refused.
async function fetchImage(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new HttpsError("invalid-argument", "That photo URL is not a URL."); }
  if (u.protocol !== "https:" || !/\.googleapis\.com$/.test(u.hostname)) {
    throw new HttpsError("invalid-argument", "That photo is not hosted where this app stores photos.");
  }
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new HttpsError("not-found", `Could not fetch the original photo (HTTP ${res.status}).`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared && declared > MAX_IMAGE_BYTES) throw new HttpsError("invalid-argument", "That photo is too large.");
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new HttpsError("invalid-argument", "That photo is too large.");
  const ct = (res.headers.get("content-type") || "image/jpeg").toLowerCase();
  return { buffer, contentType: ct.startsWith("image/") ? ct : "image/jpeg" };
}

exports.cleanProductPhoto = onCall(
  { region: "europe-west1", secrets: [geminiApiKey], memory: "512MiB", timeoutSeconds: 180 },
  async (request) => {
    const db = admin.database();
    await assertPublisher(request, db);

    const key = geminiApiKey.value();
    if (!key) {
      // The one honest failure mode, stated plainly rather than as a stack
      // trace. Nothing else in the publishing flow depends on this.
      throw new HttpsError("failed-precondition",
        "Background cleanup is not configured — the GEMINI_API_KEY secret is not set on the server.");
    }

    const data = request.data || {};
    const productId = String(data.productId || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId)) {
      throw new HttpsError("invalid-argument", "productId missing or malformed.");
    }
    // The photo URL comes from the RECORD, never from the caller. A caller-
    // supplied URL would make this function a fetch proxy for anything the
    // SSRF guard happens to admit, and the whole point of the action is to
    // clean a photo this shop already owns.
    const [product, publishNode] = await Promise.all([
      db.ref(`products/${productId}`).get().then((s) => s.val()),
      db.ref(`shopify_publish/${productId}/photos`).get().then((s) => s.val()),
    ]);
    if (!product) throw new HttpsError("not-found", "No such product.");
    // THE PUBLISHING SET COUNTS TOO. The photo strip on the product page works
    // on the EFFECTIVE set, which is a custom ordered list at
    // /shopify_publish/{pid}/photos when one exists — and uploadPublishPhoto
    // writes those files to Storage only, never to /products. Admitting just
    // the /products URLs meant that uploading a photo and clicking Clean
    // background always answered "that photo does not belong to this
    // product", and so did re-cleaning a candidate that had been accepted
    // (an accepted candidate IS a publishing-set URL). Reviewer finding.
    const known = [
      product.photoUrl,
      product.photoBoxUrl,
      ...(Array.isArray(product.gallery) ? product.gallery : []),
      ...(Array.isArray(publishNode) ? publishNode : []),
    ].map((u) => String(u || "")).filter(Boolean);
    const wanted = String(data.photoUrl || "");
    if (wanted && !known.includes(wanted)) {
      throw new HttpsError("invalid-argument", "That photo does not belong to this product.");
    }
    const photoUrl = wanted || String(product.photoUrl || "");
    if (!photoUrl) throw new HttpsError("failed-precondition", "That product has no photo to clean.");

    const { buffer, contentType } = await fetchImage(photoUrl);

    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: PROMPT },
              { inline_data: { mime_type: contentType, data: buffer.toString("base64") } },
            ] }],
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new HttpsError("deadline-exceeded", "The image service did not answer in time — try again.");
      }
      throw new HttpsError("unavailable", "Could not reach the image service.");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // The upstream body can echo request detail; log it, do not return it.
      console.error(`cleanProductPhoto: gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
      if (res.status === 429) throw new HttpsError("resource-exhausted", "Image credits are depleted or rate-limited — check the Google billing account.");
      throw new HttpsError("internal", `The image service refused the request (HTTP ${res.status}).`);
    }
    const json = await res.json();
    const parts = ((((json.candidates || [])[0] || {}).content) || {}).parts || [];
    let b64 = null, mimeType = "image/png";
    for (const part of parts) {
      const inl = part.inlineData || part.inline_data; // REST returns either casing
      if (inl && inl.data) { b64 = inl.data; mimeType = inl.mimeType || inl.mime_type || mimeType; break; }
    }
    if (!b64) {
      const why = (json.promptFeedback && json.promptFeedback.blockReason)
        || (((json.candidates || [])[0] || {}).finishReason) || "no image in the response";
      throw new HttpsError("internal", `The image service returned no image (${why}).`);
    }
    const um = json.usageMetadata || {};
    const outTok = um.candidatesTokenCount || 0;
    // Same rate the Studio's NB2 path prices at: $60/1M image-output tokens,
    // with the documented flat per-image as the fallback.
    const costUSD = outTok ? +((outTok / 1e6) * 60).toFixed(6) : 0.067;
    console.log(`cleanProductPhoto: ${productId} · ${MODEL} · $${costUSD}`);
    return { mimeType, data: b64, model: MODEL, costUSD };
  },
);
