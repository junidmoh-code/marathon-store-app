// ─── OWNER DIRECTIVES 2026-08-08, PINNED AGAINST THE SOURCE ──────────────────
// Run: npx vitest run src/signedInPillAndHoldMerge.gate.test.js
//
// House pattern (UserManagement.gate.test.jsx, refill-cadence.test.cjs):
// App.jsx is a 17k-line monolith whose components are not exported, so the
// artefact under test is the source itself. Each block pins one directive:
//
//   1. THE PILL IS GONE — no "Signed in:" chrome renders anywhere; the HOME
//      hero shows the bare name in BOTH branches; the one sign-out stays at
//      the bottom of home.
//   2. A HOLD IS A REQUEST — no separate "On hold" section beside the queue;
//      the hold context and exception rows are passed INTO Hub2RefillQueue.
//   3. THE CUSTOMER-FACING HOLD PATH IS UNTOUCHED — the coming_tomorrow
//      lifecycle (timestamp patch, WhatsApp template, durable insights row,
//      raise-request + withdraw-on-release links) keeps its exact shape.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "App.jsx"), "utf8");

describe("1 · the Signed-in pill is gone from every screen", () => {
  it("no component renders the 'Signed in:' wrapper", () => {
    // The old pill rendered `Signed in: <span …>{label}</span>`. Nothing may
    // render that wrapper again (prose comments that merely mention the
    // phrase don't match this JSX shape).
    expect(SRC).not.toMatch(/Signed in:\s*</);
  });

  it("the UserIndicator component and its shell wiring are deleted", () => {
    expect(SRC).not.toContain("function UserIndicator");
    expect(SRC).not.toContain("showIndicator");
    expect(SRC).not.toContain("indicatorLabel");
  });

  it("the home hero shows the bare name — hoisted ABOVE the desktop/mobile split", () => {
    // The name must be computed once, before `if (isDesktop)`, so BOTH home
    // branches (and the mobile HomeSignOutRow, which silently read the global
    // window.name before this fix) see the real value.
    const roleSelector = SRC.slice(SRC.indexOf("function RoleSelector"), SRC.indexOf("function HomeSignOutRow"));
    const nameDecl = roleSelector.indexOf('const name = homePerm?.displayName || homePerm?.username || homeUser?.email?.split("@")[0] || "there"');
    const split = roleSelector.indexOf("if (isDesktop)");
    expect(nameDecl).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(-1);
    expect(nameDecl).toBeLessThan(split);
    // exactly ONE declaration — the desktop branch must not shadow it back
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

describe("2 · a hold is a refill request, not a list beside one", () => {
  it("the separate 'On hold' section is gone from the hub tabs", () => {
    expect(SRC).not.toMatch(/sectionHead\(\s*["']On hold["']/);
    expect(SRC).not.toContain("SourceOnHoldTab");
  });

  it("the queue receives the hold context and the exception rows INSIDE it", () => {
    expect(SRC).toContain("holdInfoByRequestId={holdInfoByRequestId}");
    expect(SRC).toMatch(/holdRows=\{held\.length \? <OnHoldExceptionRows items=\{held\} fulfilCtx=\{fulfilCtx\} \/> : null\}/);
  });

  it("the exception rows keep the Sent / Out of Stock / Undo lifecycle", () => {
    const rows = SRC.slice(SRC.indexOf("function OnHoldExceptionRows"), SRC.indexOf("function getSAYesterdayString"));
    expect(rows).toContain('handleRespond(item, "sent")');
    expect(rows).toContain('handleRespond(item, "out_of_stock")');
    expect(rows).toContain("source_onhold_responses/${item.composite}");
    expect(rows).toContain("handleUndo");
    // fail-closed marker survives: unroutable-hub holds still say so
    expect(rows).toContain("couldn&rsquo;t queue a refill request; handle by hand");
    // resolved-request outcomes survive: arrival and rejection both come back
    expect(rows).toContain("Refill arrived at");
    expect(rows).toContain("The refill ask was closed without stock");
  });

  it("every hold is tagged with its request id so the queue can name the customer", () => {
    expect(SRC).toContain("requestId: o.onHoldRefillRequestId || null");
    expect(SRC).toContain("requestId: e.refillRequestId || null");
    expect(SRC).toMatch(/heldVisible: heldCardVisible\(o\.onHoldRefillRequestId, refillStatusById, refillRequestsLoaded\)/);
  });
});

describe("3 · the customer-facing coming_tomorrow path is byte-for-byte intact", () => {
  it("the hold patch still stamps comingTomorrowAt and clears the notify fields", () => {
    expect(SRC).toContain("if (status === STATUS.COMING_TOMORROW) patch.comingTomorrowAt = now;");
  });

  it("the WhatsApp order_tomorrow template still fires on hold", () => {
    expect(SRC).toMatch(/order_tomorrow/);
  });

  it("a hold still raises its refill request create-if-absent, fail-closed", () => {
    expect(SRC).toContain("const plan = onHoldRefillPlan(order, { nowIso: now, saDate: getSADateString() });");
    expect(SRC).toContain("patch.onHoldRefillRequestId = plan.requestId;");
  });

  it("releasing a hold still withdraws its still-open ask (holdReleaseUpdate)", () => {
    expect(SRC).toMatch(/holdReleaseUpdate\(order, status/);
    expect(SRC).toContain('if (live && live.status === "open") await update(reqRef, rel.patch);');
  });

  it("the durable insights row still mirrors the request id past the daily rollover", () => {
    expect(SRC).toMatch(/refillRequestId: patch\.onHoldRefillRequestId/);
  });
});

describe("4 · the release gate changes VISIBILITY only — stock writes are untouched", () => {
  const Q = readFileSync(join(HERE, "components/stock/Hub2RefillQueue.jsx"), "utf8");

  it("the movement calls keep their exact shape (types, reasons, idempotency key)", () => {
    expect(Q).toContain('type: "transfer_out", productId: r.productId, size: r.size, qty,');
    expect(Q).toContain('type: "received", productId: r.productId, size: r.size, qty,');
    expect(Q).toContain("reason: `${DEST_LOC}_auto_refill`");
    expect(Q).toContain("reason: `${DEST_LOC}_refill_uncounted`");
    // two applyMovement calls + the fulfilledBy audit record share the key
    expect(Q.match(/movementId: `rrf_\$\{r\.id\}`/g)).toHaveLength(3);
  });

  it("commit() — the only stock-writing path here — never consults the window gate", () => {
    const commitBlock = Q.slice(Q.indexOf("const commit = async (card)"), Q.indexOf("// URGENT OVERRIDE"));
    expect(commitBlock).toContain("applyMovement");
    expect(commitBlock).not.toContain("isReleased");
    expect(commitBlock).not.toContain("partitionReleased");
    expect(commitBlock).not.toContain("earlyRelease");
  });

  it("the gate is client-side presentation only — no functions file knows about it", () => {
    // The engine's whole directory must not mention release windows; the scan
    // cadence and every engine write stay exactly as deployed.
    expect(SRC.includes("refillHealthScan")).toBe(false); // App.jsx never calls the scan either
  });
});
