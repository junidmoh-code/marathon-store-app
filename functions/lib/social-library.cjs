// ── THE PERMANENT ALBUM OF EVERY GENERATED PICTURE ───────────────────────────
// /social_posts is a QUEUE. Things leave it: a post is discarded, a draft is
// cleared, a record is edited until it no longer describes the picture that was
// made. That is correct for a queue and useless as an archive — and every one
// of those pictures cost real money to generate and can be used again in an ad,
// an email, a catalogue page or a print.
//
// So the album is its OWN node, /social_library, and the contract is one
// sentence: an entry is written when a picture is made and is never removed by
// anything this program does. Discarding a post does not touch it. Editing a
// caption does not touch it. The queue can be emptied to zero and the album is
// still there.
//
// ── ONE ENTRY PER PICTURE, NOT PER POST ──────────────────────────────────────
// A story and its feed twin are two queue records sharing ONE image, by
// design (see social-twin.cjs). An album keyed by post id would show that
// picture twice, and a person clearing duplicates out of a photo library is
// exactly the manual work this is supposed to remove. The twin therefore never
// writes an entry; the record that owns the upload does.
//
// ── WHAT IS STORED AND WHAT IS DELIBERATELY NOT ──────────────────────────────
// STORED: the picture, when it was made, what it cost, the engine that made
// it, the kind (single / outfit / flatlay / pairing), and the PRODUCTS in the
// frame — pid and slot, which is what makes an outfit page possible later.
//
// NOT STORED: status, schedule, caption, platform results. All of those belong
// to a post's life in the queue and go stale the moment it moves on. The album
// answers "what pictures do we have and what is in them", and a copy of a
// status from three weeks ago answers nothing.
//
// NOT STORED: prices or product names. Those are resolved LIVE when the album
// is read. A price frozen at generation time is a price that will be wrong,
// and an album that quietly shows last month's R850 is worse than one that
// shows nothing.
const LIBRARY_PATH = "social_library";

// A product as the album keeps it: the two fields that identify it and place
// it in an outfit. Everything else about a product is looked up when needed.
function libraryProduct(p) {
  const pid = p && typeof p.pid === "string" ? p.pid.trim() : "";
  if (!pid) return null;
  const slot = p && typeof p.slot === "string" && p.slot.trim() ? p.slot.trim() : null;
  return slot ? { pid, slot } : { pid };
}

function libraryProducts(products) {
  if (!Array.isArray(products)) return [];
  const seen = new Set();
  const out = [];
  for (const p of products) {
    const lp = libraryProduct(p);
    // The same pid twice in one frame is a generator slip, not two garments;
    // deduping here keeps an outfit's item count honest.
    if (!lp || seen.has(lp.pid)) continue;
    seen.add(lp.pid);
    out.push(lp);
  }
  return out;
}

// ── A REEL IS A PICTURE TOO ──────────────────────────────────────────────────
// The first pass here kept only `type: "image"` entries and quietly dropped
// every reel — seven of the first fifty-three posts, all of them stills the
// generator had paid to make. A reel's media is the encoded .mp4, but it
// carries `posterUrl`: the still it was built from. That still is a generated
// photograph like any other and belongs in the album.
//
// So a video contributes its POSTER as the archived picture. The mp4 itself is
// kept separately (see videoPath below) rather than as album media — an album
// tile is something you can drop into an ad or an email, and a video is not
// interchangeable with a photograph at that point of use.
function libraryMedia(media) {
  if (!Array.isArray(media)) return [];
  const out = [];
  for (const m of media) {
    if (!m) continue;
    if (m.type === "image" && typeof m.url === "string" && m.url) {
      out.push({ type: "image", url: m.url });
    } else if (typeof m.posterUrl === "string" && m.posterUrl) {
      out.push({ type: "image", url: m.posterUrl });
    }
  }
  return out;
}

// The encoded video behind a reel, so the album knows the mp4 exists without
// pretending it is a still.
function libraryVideoPath(media) {
  if (!Array.isArray(media)) return null;
  for (const m of media) {
    if (m && typeof m.path === "string" && /\.mp4$/i.test(m.path)) return m.path;
  }
  return null;
}

/**
 * The album entry for a generated record, or null when there is nothing worth
 * keeping. Pure: it reads the record it is handed and nothing else.
 */
function buildLibraryEntry(postId, record, { isTwin = false } = {}) {
  if (isTwin) return null;                       // the twin shares the picture
  if (!postId || typeof postId !== "string") return null;
  const media = libraryMedia(record && record.media);
  if (!media.length) return null;

  const entry = {
    postId,
    media,
    kind: typeof record.kind === "string" && record.kind ? record.kind : "single",
    products: libraryProducts(record.products),
    createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null,
  };
  // Optional provenance. Omitted rather than nulled where absent — an RTDB
  // node full of explicit nulls reads as "we tried and failed to find this",
  // which is a different claim from "this record never carried it".
  if (typeof record.format === "string" && record.format) entry.format = record.format;
  if (typeof record.engine === "string" && record.engine) entry.engine = record.engine;
  if (typeof record.style === "string" && record.style) entry.style = record.style;
  if (typeof record.link === "string" && record.link) entry.link = record.link;
  if (Number.isFinite(record.costUSD)) entry.costUSD = record.costUSD;
  const videoPath = libraryVideoPath(record && record.media);
  if (videoPath) entry.videoPath = videoPath;
  return entry;
}

/**
 * The album's slice of an atomic update map. Returned as a fragment to be
 * merged into the SAME update() the post is written by, so a picture can never
 * exist in the queue without existing in the album — the two either both land
 * or neither does.
 */
function libraryWriteUpdates(postId, record, opts) {
  const entry = buildLibraryEntry(postId, record, opts);
  if (!entry) return {};
  return { [`${LIBRARY_PATH}/${postId}`]: entry };
}

// An outfit is a picture with more than one product in it. That is the whole
// definition, and it is deliberately not a separate `kind`: the generator
// already makes outfits, flatlays and pairings, and any of them can turn out
// to hold one product after a pick fails. What makes a picture shoppable as a
// FIT is how many things are in the frame, not what the generator called it.
function isOutfitEntry(entry) {
  return !!entry && Array.isArray(entry.products) && entry.products.length > 1;
}

module.exports = {
  LIBRARY_PATH,
  buildLibraryEntry,
  libraryWriteUpdates,
  libraryProducts,
  libraryMedia,
  libraryVideoPath,
  isOutfitEntry,
};
