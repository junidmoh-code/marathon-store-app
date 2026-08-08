// ─── OWNER DIRECTIVES 2026-08-08 (second pass), PINNED AGAINST THE SOURCE ────
// Run: npx vitest run src/signedInPillAndHoldMerge.gate.test.js
//
// House pattern (UserManagement.gate.test.jsx): App.jsx is a 17k-line monolith
// whose components are not exported, so the artefact under test is the source
// itself. The first pass of these directives kept On Hold alive as exception
// rows inside the queue — the owner ruled that shape WRONG on 2026-08-08:
// On Hold is ABOLISHED from the refill surface, not relocated. Each block pins
// one directive of the corrected spec:
//
//   1. THE PILL IS GONE — unchanged from the first pass.
//   2. ON HOLD IS ABOLISHED — no exception rows, no held cards, no hold badge,
//      no customer name or order number anywhere on the refill surface; the
//      hold's request is an ordinary row.
//   3. THE HOLD NOTIFICATION IS DEAD — no order_tomorrow WhatsApp anywhere;
//      the raise + withdraw-on-release links survive; the rest of the
//      customer-facing coming_tomorrow path (status, TV, status page) stays.
//   4. THE GATE IS PRESENTATION-ONLY — stock writes never consult the release
//      windows, and the engine sources know nothing of them.
//   5. ONE LIST, ONE DESIGN — the per-origin row components are gone; every
//      request renders through RefillQueue.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "App.jsx"), "utf8");
const Q = readFileSync(join(HERE, "components/stock/RefillQueue.jsx"), "utf8");

describe("1 · the Signed-in pill is gone from every screen", () => {
  it("no component renders the 'Signed in:' wrapper", () => {
    expect(SRC).not.toMatch(/Signed in:\s*</);
  });

  it("the UserIndicator component and its shell wiring are deleted", () => {
    expect(SRC).not.toContain("function UserIndicator");
    expect(SRC).not.toContain("showIndicator");
    expect(SRC).not.toContain("indicatorLabel");
  });

  it("the home hero shows the bare name — hoisted ABOVE the desktop/mobile split", () => {
    const roleSelector = SRC.slice(SRC.indexOf("function RoleSelector"), SRC.indexOf("function HomeSignOutRow"));
    const nameDecl = roleSelector.indexOf('const name = homePerm?.displayName || homePerm?.username || homeUser?.email?.split("@")[0] || "there"');
    const split = roleSelector.indexOf("if (isDesktop)");
    expect(nameDecl).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(-1);
    expect(nameDecl).toBeLessThan(split);
    expect(roleSelector.match(/const name = homePerm/g)).toHaveLength(1);
  });

  it("the MOBILE hero renders the name (it used to rely on the floating pill)", () => {
    const hero = SRC.slice(SRC.indexOf("{/* MARATHON HERO */}"), SRC.indexOf("{/* ROLE GROUPS"));
    expect(hero).toContain(">{name}</div>");
  });

  it("the ONE sign-out is still the red row at the bottom of home — nowhere else", () => {
    expect(SRC.match(/<HomeSignOutRow name=\{name\} onSignOut=\{homeSignOut\} \/>/g)).toHaveLength(2); // desktop + mobile
    expect(SRC).toContain("function HomeSignOutRow");
  });
});

describe("2 · On Hold is ABOLISHED from the refill surface — not relocated", () => {
  it("the exception rows, held cards and their response node are gone from App.jsx", () => {
    for (const dead of ["OnHoldExceptionRows", "heldCardVisible", "holdInfoByRequestId", "holdRows",
                        "source_onhold_responses", "onHoldEventsFromLog", "heldItemsFor", "onHoldMerged"]) {
      expect(SRC, `${dead} must not survive anywhere in App.jsx`).not.toContain(dead);
    }
  });

  it("the queue renders NOTHING that marks a hold — no badge, no order id, no customer name", () => {
    for (const dead of ["CUSTOMER HOLD", "Customer waiting", "customerName", "orderNumber", "orderId", "holdInfo"]) {
      expect(Q, `${dead} must not appear in RefillQueue.jsx`).not.toContain(dead);
    }
  });

  it("the Held/On-hold counters are gone from the SOURCE chrome and the home badge", () => {
    // Scoped to SourceView: the WAREHOUSE orders surface keeps its On Hold
    // status tab and counter — that is the customer-facing coming_tomorrow
    // path, deliberately outside the refill surface.
    const sourceView = SRC.slice(SRC.indexOf("function SourceView"), SRC.indexOf("// ─── RETURNS VIEW"));
    expect(sourceView.length).toBeGreaterThan(1000);
    expect(sourceView).not.toContain(">On hold</div>");
    expect(sourceView).not.toContain(">Held</span>");
    expect(SRC).not.toContain("onHoldCount");
    // the home Source badge counts sales only
    expect(SRC).toContain("const sourceBadge = (restockToday || []).length;");
  });
});

describe("3 · the hold notification is DEAD; the raise/withdraw links live on", () => {
  it("no order_tomorrow WhatsApp template fires anywhere any more", () => {
    expect(SRC).not.toContain("order_tomorrow");
  });

  it("the queue itself messages nobody", () => {
    for (const banned of ["sendWhatsApp", "order_ready", "customerPhone"]) {
      expect(Q).not.toContain(banned);
    }
  });

  it("a hold still RAISES an ordinary request, create-if-absent, fail-closed", () => {
    expect(SRC).toContain("const plan = onHoldRefillPlan(order, { nowIso: now, saDate: getSADateString() });");
    expect(SRC).toContain("patch.onHoldRefillRequestId = plan.requestId;");
  });

  it("releasing a hold still withdraws its still-open ask (holdReleaseUpdate)", () => {
    expect(SRC).toMatch(/holdReleaseUpdate\(order, status/);
    expect(SRC).toContain('if (live && live.status === "open") await update(reqRef, rel.patch);');
  });

  it("the rest of the customer-facing coming_tomorrow path is intact (status stamp, TV, insights)", () => {
    expect(SRC).toContain("if (status === STATUS.COMING_TOMORROW) patch.comingTomorrowAt = now;");
    expect(SRC).toContain("TV_COMING_TOMORROW_VISIBLE_MS");
    expect(SRC).toMatch(/refillRequestId: patch\.onHoldRefillRequestId/);
  });
});

describe("4 · the release gate changes VISIBILITY only — stock writes are untouched", () => {
  it("the request-row movement calls keep their exact shape (types, reasons, idempotency key)", () => {
    expect(Q).toContain('type: "transfer_out", productId: r.productId, size: r.size, qty: q,');
    expect(Q).toContain('type: "received", productId: r.productId, size: r.size, qty: q,');
    expect(Q).toContain("reason: `${DEST_LOC}_auto_refill`");
    expect(Q).toContain("reason: `${DEST_LOC}_refill_uncounted`");
    // two applyMovement calls + the fulfilledBy audit record share the key
    expect(Q.match(/movementId: `rrf_\$\{r\.id\}`/g)).toHaveLength(3);
  });

  it("the sale-row movement calls keep the Source contract byte-for-byte", () => {
    expect(Q).toContain('const SOURCE_REFILL_REASON = "source_refill";');
    expect(Q).toContain('const SOURCE_UNCOUNTED_REASON = "source_uncounted_send";');
    expect(Q).toContain("allowNegative: true,");
    expect(Q).toContain("checkSourceMovementDuplicate");
  });

  it("the fulfil/reject paths — the only stock writers here — never consult the window gate", () => {
    const writers = Q.slice(Q.indexOf("const fulfilRequest"), Q.indexOf("// URGENT OVERRIDE"));
    expect(writers).toContain("applyMovement");
    for (const gate of ["isReleased", "partitionReleased", "earlyRelease"]) {
      expect(writers, `${gate} must not appear in a write path`).not.toContain(gate);
    }
  });

  it("the engine sources know nothing of the gate — cadence and writes exactly as deployed", () => {
    for (const enginePath of ["../functions/lib/refill-engine.cjs", "../functions/refill-scan.cjs"]) {
      const ENGINE = readFileSync(join(HERE, enginePath), "utf8");
      expect(ENGINE).not.toMatch(/releaseWindows|earlyRelease|isReleased|partitionReleased/);
    }
  });
});

describe("5 · one list, one design — the per-origin row components are gone", () => {
  it("the old Source row components no longer exist", () => {
    for (const dead of ["function SourceTodayTab", "function SourceHistoryTab", "function SourceFulfilPanel",
                        "function PendingCard", "function CompletedCard"]) {
      expect(SRC).not.toContain(dead);
    }
  });

  it("both hub tabs mount the ONE queue with the sale rows folded in", () => {
    expect(SRC).toContain("<RefillQueue products={products} dest={h} lineFilter={lineFilter}");
    expect(SRC).toContain("saleRows={saleRowsFor(h, cellFilter)}");
    expect(SRC).toContain("completedSale={completedSaleFor(h, cellFilter)}");
  });

  it("the divergent action wording is dead: nothing says 'Transfer to Hub' as a row action", () => {
    expect(Q).not.toMatch(/Transfer \$\{totalPick\}|Transfer to \$/);
    expect(SRC).not.toContain("Transfer ${totalPick}");
  });
});
