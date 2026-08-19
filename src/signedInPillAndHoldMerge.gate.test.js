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
//   3. THE HOLD NOTIFICATION MOVED — REVISED 2026-08-19. The owner reinstated
//      the customer message, but NOT where it was: order_tomorrow (fired at
//      hold-PLACED time, promising stock that did not exist yet) stays deleted,
//      and the send now happens SERVER-SIDE at FULFIL. What this block pins is
//      unchanged in spirit — the refill surface still messages nobody, and the
//      raise + withdraw-on-release links still survive.
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

describe("3 · the hold notification fires at FULFIL, server-side; the raise/withdraw links live on", () => {
  it("the hold-PLACED message stays deleted — nothing is promised before stock exists", () => {
    expect(SRC).not.toContain("order_tomorrow");
  });

  it("the queue itself messages nobody — this is what keeps the list untouchable", () => {
    // The reinstated send hangs off the WRITE the Fulfil action already makes,
    // not off the button, precisely so this file stays empty of customer
    // vocabulary. A hold line is an ordinary request row: no badge, no order
    // number, no customer name, no second button.
    for (const banned of ["sendWhatsApp", "order_ready", "customerPhone", "holdLink", "notify"]) {
      expect(Q, `${banned} must not appear in RefillQueue.jsx`).not.toContain(banned);
    }
  });

  it("no CLIENT fires the availability message — the send is the server's", () => {
    // A client-side fire-and-forget is how the same message reached real
    // customers 2-5 times and got the gateway number banned. The only
    // sendWhatsAppTemplate calls left in App.jsx are the three long-standing
    // order-status ones (placed / ready / out of stock).
    expect(SRC.match(/sendWhatsAppTemplate\(/g)).toHaveLength(4);   // 1 declaration + 3 call sites
    expect(SRC).not.toMatch(/refill_requests[^\n]*fulfilled[^\n]*sendWhatsApp/);
  });

  it("the hold RAISES the re-link the server send needs — stored, rendered nowhere", () => {
    const PLAN = readFileSync(join(HERE, "components/stock/onHoldRefill.js"), "utf8");
    expect(PLAN).toContain("export function holdCustomerLink");
    expect(PLAN).toContain("holdLink: holdCustomerLink(order, saDate)");
    expect(PLAN).toContain("notifyOnFulfil: !!phone");
    // Nothing on the refill surface reads it.
    expect(Q).not.toContain("holdLink");
  });

  it("the server trigger is the ONE producer, keyed on the fulfil transition", () => {
    const FN = readFileSync(join(HERE, "../functions/index.js"), "utf8");
    const LIB = readFileSync(join(HERE, "../functions/lib/hold-availability-notify.cjs"), "utf8");
    expect(FN).toContain('ref:            "/refill_requests/{requestId}/status"');
    expect(FN).toContain("exports.holdAvailabilityNotify = onValueWritten(");
    // No new send path: the existing outbox producer, injected.
    expect(FN).toMatch(/notifyHoldAvailability\(\{[\s\S]*?enqueueWhatsApp,/);
    expect(LIB).toContain('const TEMPLATE = "order_ready";');
    expect(LIB).toContain('if (after !== "fulfilled") return { sent: false, skipped: "not_fulfilled" };');
    expect(LIB).toContain('if (before === "fulfilled") return { sent: false, skipped: "no_transition" };');
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
    // Tranche-safe idempotency: the FIRST send keeps the historic bare rrf_ id
    // (byte-identical to every movement written before partials existed);
    // later tranches suffix the units already sent. Both applyMovement calls
    // and the fulfilledBy audit record share the ONE computed id.
    expect(Q).toContain("const mvId = already === 0 ? `rrf_${r.id}` : `rrf_${r.id}_${already}`;");
    const reqBlock = Q.slice(Q.indexOf("const fulfilRequest"), Q.indexOf("const rejectRequest"));
    expect(reqBlock.match(/movementId: mvId,/g)).toHaveLength(3);   // both applyMovement branches + the fulfilledBy audit record
    // appliedQty, not the raw pick: a retry credits what the recorded movement
    // actually carried (the sourceMovementDedupe idiom).
    expect(reqBlock).toContain("fulfilledBy`]: { movementId: mvId, qty: appliedQty,");
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
    expect(SRC).toContain("saleRows={activeSaleRows}");
    expect(SRC).toContain("completedSale={activeCompletedSale}");
  });

  it("the divergent action wording is dead: nothing says 'Transfer to Hub' as a row action", () => {
    expect(Q).not.toMatch(/Transfer \$\{totalPick\}|Transfer to \$/);
    expect(SRC).not.toContain("Transfer ${totalPick}");
  });
});
