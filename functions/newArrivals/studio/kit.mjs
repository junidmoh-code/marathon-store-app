// ─── THE STYLE KIT IN THE SHARED GENERATOR (Junid, 20 Nov 2026) ─────────────
// New Arrivals' and Black Friday's Generate both call studio.generate. These
// are the two extra deps it takes so that every Generate follows the Style Kit
// Catalogue exactly as the Shopify publisher does:
//   styleKitFor(product, pid) → the kit the Catalogue routes this product to
//     (lib/style-kit-catalogue.mjs resolveKit) with its first 6 enabled
//     reference photos as buffers. A product that falls through to the
//     house-style default (Sneakers / Clothing) keeps the restored last-good
//     request on Junid's plates, unchanged — `dedicated:false`, no refs.
//   driftCheck(original, generated, { garment }) → { checked, drift, issues, faults? }
// Both callers spread studioKitDeps(...) into the deps they already pass.
import sharp from "sharp";
import { resolveKit, MAX_REFS_SENT } from "../../lib/style-kit-catalogue.mjs";
import { checkDrift } from "../../lib/style-kit-drift.mjs";

export const STYLE_KIT_PATH = "aiAssistant/styleKit";

export function studioKitDeps({ db, apiKey, fetchBytes, log = () => {} }) {
  return {
    styleKitFor: async (product, pid) => {
      const node = (await db.ref(STYLE_KIT_PATH).once("value")).val() || {};
      const r = resolveKit(product, pid, node);
      if (!r.dedicated) return { ...r, refs: [], refIds: [] };
      const picked = r.refs.slice(0, MAX_REFS_SENT);
      const got = await Promise.all(picked.map((x) => fetchBytes(x.url).then((b) => b.buffer).catch((e) => { log(`style kit ${r.kit} ref ${x.id} could not be read (${String(e.message).slice(0, 60)})`); return null; })));
      return { ...r, refs: got.filter(Boolean), refIds: picked.filter((_, i) => got[i]).map((x) => x.id) };
    },
    // { garment: true } — a clothing item: the same call also checks lines, wrinkles, tilt and colour (21 Nov 2026).
    driftCheck: (original, generated, { garment = false } = {}) => checkDrift({ original, generated }, { apiKey, sharp, garment }),
  };
}
