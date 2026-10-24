// ─── SALE-RAISED REQUESTS ARE OFF (Junid, 24 Oct 2026) ───────────────────────
// Junid's rule: "A refill request is raised ONLY by the scan comparing what is
// on hand against policy. Nothing else — not 'marked ready', not order
// placement, not duplicates — may create a request."
//
// The one place a SALE still raised pickable work was Hub 2's "replace what
// sold" lines in the Refill Queue (POS restock_log → pendingSaleRows). With
// this false, every such line is information only ("already covered — the
// scan raises requests"), and the hub tab badge counts none of them. The
// Clothing-Sold tabs, the other sale-driven list, have not been mounted since
// 12 Jul (#202).
//
// Before switching off, every product the sale lines were refilling was
// checked for a scan policy (24 Oct): 36 of 39 Hub 2 product/size pairs had
// one; the 3 without are reported in docs/POLICY-OVERREQUEST-2026-10-24.md.
//
// Flipping this back to true restores the 24 Oct behaviour (policy cells
// scan-only, others replaced from POS sales). Only with Junid's say-so — the
// junid-approved check guards this file's readers.
export const SALE_RAISED_REQUESTS = false;
