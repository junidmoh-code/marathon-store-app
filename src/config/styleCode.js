// ─── STYLE CODE — ENFORCEMENT SWITCH AND SCOPE ───────────────────────────────
// Two separate decisions live here, and conflating them is what broke Add
// Product twice:
//
//   1. STYLE_CODE_LOOKUP_ENABLED  — do we LOOK UP a code, or merely CAPTURE it?
//   2. the ENFORCED CATEGORY SET  — which products are asked for a code at all?
//
// ── IT IS ON. WHAT THAT MEANS, AND WHAT IT COST TO GET HERE ──────────────────
// ON:  scan a code → the catalogue is asked → the shoe's name and photo come
//      back for an explicit Confirm / Reject, and an already-known code routes
//      to add-stock instead of creating a second record.
// OFF: scan a code → straight to the form. The code is still captured.
//
// It was off because the adapter pointed at a KicksDB route our plan cannot
// call — 403 on every request — so the step could only ever fail, and combined
// with a gate that had no escape it locked staff out of Add Product entirely.
// Both halves are fixed: the adapter now uses /v3/stockx/products?sku= with
// GOAT as a fallback, and the gate has escapes on every failure path.
//
// ── THE ONE CONDITION THAT IS NOT MET, STATED PLAINLY ────────────────────────
// Almost no product carries a style code yet, so the "do we already have this
// shoe?" check has almost nothing to compare against and will mostly answer
// "no". Enabled anyway as a deliberate call: the value now is the AUTO-FILL —
// name, brand and photo off the label instead of typed by hand — and the
// catalogue only fills if the lookup is running. The duplicate-detection value
// arrives later, on its own, as codes accumulate.
//
// If this needs turning off in a hurry, flip it back and redeploy hosting. The
// capture-only path is still here and still tested; nothing else changes.
export const STYLE_CODE_LOOKUP_ENABLED = true;

// ── WHICH CATEGORIES ARE ASKED FOR A STYLE CODE ──────────────────────────────
// We sell far more than sneakers. Asking a belt or a perfume for a manufacturer
// style code is not a check, it is a wall — and for a while it was literally
// impossible to create a non-sneaker product because the gate ran before the
// operator had said what they were adding.
//
// So the gate is SCOPED, and the scope is DATA, not code. The live list is read
// from /config/styleCode/enforcedCategories, which is admin-writable in the
// rules (stockRole === 'admin') and readable by any signed-in staff member —
// so widening or narrowing the net is a console edit, not a deploy.
//
// THE DEFAULT IS DELIBERATELY THE NARROWEST THING THAT IS USEFUL: sneakers
// only. If the config node is absent, unreadable, or malformed, we enforce the
// least and let the most work — the failure mode of this list must be "people
// can add products", never "people cannot".
export const DEFAULT_ENFORCED_CATEGORIES = ["sneakers"];

// The live registry's footwear keys, for reference when editing the config.
// Taken from TAXONOMY_SEED, not invented:
//   sneakers · running-shoes · boots · soccer-boots · slides · loafers · kids-shoes
// Everything else is clothing, accessories or perfume and has no style code.
export const FOOTWEAR_CATEGORY_KEYS = [
  "sneakers", "running-shoes", "boots", "soccer-boots", "slides", "loafers", "kids-shoes",
];

// ── THE BYPASS, AND WHY IT ASKS A QUESTION ───────────────────────────────────
// Some footwear genuinely has no manufacturer style code — designer and
// unbranded stock especially. Those products can never satisfy the gate, so a
// bypass has to exist. But a bypass sitting as an equal third button next to
// "scan" and "type it" becomes the default path inside a week, and we are back
// to duplicates with extra steps.
//
// So it is deliberate and countable: subordinate in the UI, and it demands a
// REASON from this fixed list. The split matters because these are different
// problems with different fixes — a rising `no_code_exists` means our product
// mix is shifting, while a rising `label_*` means something is wrong with how
// stock reaches us, or with how people are looking.
export const EXEMPT_REASONS = [
  { key: "no_code_exists", label: "This shoe has no style code at all",
    hint: "Designer, unbranded, or handmade — nothing is printed on any label." },
  { key: "label_unreadable", label: "The label is there but I can't read it",
    hint: "Worn, faded, damaged or covered." },
  { key: "label_missing", label: "The label has been removed",
    hint: "Cut out, peeled off, or never attached." },
];

export const EXEMPT_REASON_KEYS = EXEMPT_REASONS.map((r) => r.key);
