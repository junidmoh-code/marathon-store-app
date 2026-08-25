// ─── SOCIAL SELECTION — THE TWO REFUSALS, AND THE DRIFT PINS ─────────────────
// The generator's job is to pick things worth posting. Its OBLIGATION is never
// to pick something that is off the storefront or out of stock. Those two are
// tested here as filters that cannot be tuned away, not as low scores.
"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  POST_KINDS, KIND_KEYS, OUTFIT_SLOTS, UNSELLABLE_LOCATIONS, REPOST_COOLDOWN_DAYS,
  availableUnits, productHandle, outfitSlot, buildCandidates, pickForKind,
} = require("../lib/social-select.cjs");

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 22, 12, 0);

// A minimal world: one product, live and on, in stock, with a photo and a name.
// NOTE ON THE DEFAULTS BELOW: they are applied with an explicit `in` check,
// NOT with destructuring defaults. `{ state: undefined }` is one of the cases
// that must be refused, and a destructuring default silently replaces it with
// "live" — so the four undefined cases passed while testing nothing. The `in`
// form is what makes "explicitly undefined" reach the code under test.
function world(over = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(over, k);
  const pick = (k, dflt) => (has(k) ? over[k] : dflt);
  const pid = pick("pid", "p1");
  const cleanName = pick("cleanName", "Black mesh daypack");
  const liveState = pick("liveState", "on");
  const state = pick("state", "live");
  const liveAt = pick("liveAt", NOW - 5 * DAY);
  const stock = pick("stock", { pine: { M: { qty: 3 } } });
  const product = pick("product", {});
  const units = pick("units", 0);
  const postedAt = pick("postedAt", null);
  const photos = pick("photos", undefined);
  return {
    liveNodes: { [pid]: { state, liveState, cleanName, liveAt, ...(photos ? { photos } : {}) } },
    products: { [pid]: { id: pid, photoUrl: "https://x/p1.jpg", category: "Accessories", categoryKey: "bags", retailPrice: 500, sizes: ["M"], ...product } },
    stockByPid: { [pid]: stock },
    salesByPid: { [pid]: units },
    postedAtByPid: postedAt ? { [pid]: postedAt } : {},
    nowMs: NOW,
  };
}

describe("availableUnits", () => {
  // NOTE: `sizes` is required. Cells whose key is not one of the product's own
  // sizes are not counted — the same filter the Shopify inventory push applies.
  // socialStockParity.diff.test.js is the differential that proves the two
  // agree; these are the unit-level properties.
  test("sums every location", () => {
    assert.equal(availableUnits({ pine: { M: { qty: 2 } }, hub2: { L: { qty: 5 } } }, ["M", "L"]), 7);
  });

  test("does NOT count a cell for a size the product does not have", () => {
    // The phantom-cell shape: a stray key holding units the storefront will
    // never sell. Counting it made the generator post links to sold-out pages.
    assert.equal(availableUnits({ pine: { M: { qty: 1 }, XL: { qty: 40 } } }, ["M"]), 1);
    assert.equal(availableUnits({ pine: { _: { qty: 0 }, Free_Size: { qty: 3 } } }, ["Free Size"]), 0);
  });

  test("no size list means no countable stock", () => {
    for (const sizes of [undefined, null, [], "M", {}]) {
      assert.equal(availableUnits({ pine: { M: { qty: 5 } } }, sizes), 0, String(sizes));
    }
  });

  // Matching scripts/shopify/inventory.mjs matters more than the number: if
  // this and the inventory push disagreed we would advertise stock the shop
  // refuses to sell.
  test("excludes in_transit — the same location the inventory push excludes", () => {
    assert.ok(UNSELLABLE_LOCATIONS.has("in_transit"));
    assert.equal(availableUnits({ in_transit: { M: { qty: 99 } } }, ["M"]), 0);
    assert.equal(availableUnits({ pine: { M: { qty: 1 } }, in_transit: { M: { qty: 99 } } }, ["M"]), 1);
  });

  test("clamps a negative cell to zero rather than subtracting it", () => {
    // A negative cell is a bookkeeping artefact, never sellable — and it must
    // not eat another location's real stock.
    assert.equal(availableUnits({ pine: { M: { qty: -5 } }, hub2: { M: { qty: 3 } } }, ["M"]), 3);
  });

  test("tolerates a bare number cell (old data) and rubbish", () => {
    assert.equal(availableUnits({ pine: { M: 4 } }, ["M"]), 4);
    assert.equal(availableUnits({ pine: { M: null, L: undefined, S: "x", XL: {} } }, ["M", "L", "S", "XL"]), 0);
    assert.equal(availableUnits(null, ["M"]), 0);
    assert.equal(availableUnits({ pine: null }, ["M"]), 0);
  });
});

describe("productHandle", () => {
  // ── THE DRIFT PIN THAT MATTERS MOST ────────────────────────────────────────
  // The reconciler sets Shopify's handle explicitly from the clean title, using
  // compliance.mjs buildHandle. This is a deliberate duplicate of that
  // function. If the two ever diverge, EVERY caption links to a 404 — and
  // nothing else fails, so nobody would notice until a customer said so.
  const CASES = [
    "Black mesh daypack",
    "V-neck short-sleeve athletic jersey in royal blue",
    "  leading and trailing  ",
    "Gum-sole mesh runner with reflective piping",
    "Two—em-dashes and  double  spaces",
    "Punctuation! Everywhere? Yes: it is.",
    "Numbers 123 in the middle",
    "UPPER CASE THROUGHOUT",
    "accented café naïve",
    "---already-hyphenated---",
    "a",
  ];
  // A local copy of buildHandle's body, minus the throw, so the comparison is
  // against the real transform rather than against this file's own idea of it.
  const buildHandleBody = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  for (const title of CASES) {
    test(`matches buildHandle for ${JSON.stringify(title)}`, () => {
      assert.equal(productHandle(title), buildHandleBody(title));
    });
  }
  test("empty-ish input yields an empty handle, not a stray hyphen", () => {
    for (const v of ["", null, undefined, "   ", "!!!", "---"]) assert.equal(productHandle(v), "");
  });
});

describe("outfitSlot", () => {
  test("maps the live catalogue's real categoryKeys", () => {
    assert.equal(outfitSlot({ categoryKey: "sneakers" }), "shoe");
    assert.equal(outfitSlot({ categoryKey: "slides" }), "shoe");
    assert.equal(outfitSlot({ categoryKey: "t-shirts" }), "top");
    assert.equal(outfitSlot({ categoryKey: "tracksuits" }), "top");
    assert.equal(outfitSlot({ categoryKey: "caps-beanies" }), "cap");
    assert.equal(outfitSlot({ categoryKey: "perfumes" }), "fragrance");
  });
  test("falls back to category for the records carrying no categoryKey", () => {
    assert.equal(outfitSlot({ category: "Footwear" }), "shoe");
    assert.equal(outfitSlot({ category: "Perfume" }), "fragrance");
  });
  test("does NOT treat all Clothing as a top — pants are clothing and are not a top", () => {
    assert.equal(outfitSlot({ categoryKey: "pants", category: "Clothing" }), null);
    assert.equal(outfitSlot({ categoryKey: "shorts", category: "Clothing" }), null);
    assert.equal(outfitSlot({ categoryKey: "dresses", category: "Clothing" }), null);
  });
  test("returns null for anything unmapped, without throwing", () => {
    assert.equal(outfitSlot({ categoryKey: "bags" }), null);
    assert.equal(outfitSlot({}), null);
    assert.equal(outfitSlot(null), null);
  });
  test("categoryKey wins over a contradicting category", () => {
    // A perfume miscategorised as Footwear must follow its key, which is the
    // field the taxonomy work actually maintains.
    assert.equal(outfitSlot({ categoryKey: "perfumes", category: "Footwear" }), "fragrance");
  });
});

describe("buildCandidates — REFUSAL 1: not on the storefront", () => {
  test("accepts a confirmed live+on product", () => {
    assert.equal(buildCandidates(world()).length, 1);
  });
  test("refuses state that is not live", () => {
    for (const state of ["awaiting", "blocked", "draft", "nominated", undefined, null]) {
      assert.equal(buildCandidates(world({ state })).length, 0, `state=${state}`);
    }
  });
  test("refuses liveState that is not on", () => {
    for (const liveState of ["off", undefined, null, "ON", true]) {
      assert.equal(buildCandidates(world({ liveState })).length, 0, `liveState=${liveState}`);
    }
  });
  test("IGNORES desiredState — an intent is not a confirmation", () => {
    // A product being switched on is not yet on. Linking to it is linking to a
    // 404 until the reconciler agrees.
    const w = world({ liveState: "off" });
    w.liveNodes.p1.desiredState = "on";
    assert.equal(buildCandidates(w).length, 0);
  });
});

describe("buildCandidates — REFUSAL 2: out of stock", () => {
  test("refuses zero stock", () => {
    assert.equal(buildCandidates(world({ stock: { pine: { M: { qty: 0 } } } })).length, 0);
  });
  test("refuses a missing stock tree entirely", () => {
    assert.equal(buildCandidates(world({ stock: undefined })).length, 0);
    assert.equal(buildCandidates(world({ stock: {} })).length, 0);
  });
  test("refuses stock that is only in transit", () => {
    assert.equal(buildCandidates(world({ stock: { in_transit: { M: { qty: 10 } } } })).length, 0);
  });
  test("a negative cell does not cancel a real one elsewhere", () => {
    // Clamping is per-cell, so this is genuinely 1 available, not 0 — the test
    // pins the clamp, which is the behaviour the inventory push has. Both
    // sizes must be on the record, or the size filter (correctly) drops the L.
    assert.equal(buildCandidates(world({
      product: { sizes: ["M", "L"] },
      stock: { pine: { M: { qty: -9 } }, hub2: { L: { qty: 1 } } },
    })).length, 1);
  });

  test("stock on a size the record no longer lists does not rescue a product", () => {
    // The same tree, but the record only sells M — which has nothing. Shopify
    // would show this sold out, so it must not be posted.
    assert.equal(buildCandidates(world({
      product: { sizes: ["M"] },
      stock: { pine: { M: { qty: 0 } }, hub2: { L: { qty: 40 } } },
    })).length, 0);
  });
  test("accepts a single unit", () => {
    assert.equal(buildCandidates(world({ stock: { pine: { M: { qty: 1 } } } })).length, 1);
  });
});

describe("buildCandidates — the other exclusions", () => {
  test("refuses a product with no photograph anywhere", () => {
    assert.equal(buildCandidates(world({ product: { photoUrl: null } })).length, 0);
  });
  test("prefers the PUBLISHING photo over the record's hero", () => {
    const c = buildCandidates(world({ photos: ["https://x/pub.jpg"] }))[0];
    assert.equal(c.photoUrl, "https://x/pub.jpg");
  });
  test("falls back to the record's hero when the publishing set is empty or junk", () => {
    assert.equal(buildCandidates(world({ photos: [] }))[0].photoUrl, "https://x/p1.jpg");
    assert.equal(buildCandidates(world({ photos: ["", "   ", null] }))[0].photoUrl, "https://x/p1.jpg");
  });
  test("refuses a product with no cleanName — the internal name is never used", () => {
    for (const cleanName of ["", "   ", null, undefined]) {
      assert.equal(buildCandidates(world({ cleanName })).length, 0, `cleanName=${cleanName}`);
    }
  });
  test("refuses a product with no /products record", () => {
    const w = world();
    w.products = {};
    assert.equal(buildCandidates(w).length, 0);
  });
  test("applies the repost cooldown, at its exact boundary", () => {
    const justInside = NOW - (REPOST_COOLDOWN_DAYS * DAY - 1);
    const justOutside = NOW - REPOST_COOLDOWN_DAYS * DAY;
    assert.equal(buildCandidates(world({ postedAt: justInside })).length, 0);
    assert.equal(buildCandidates(world({ postedAt: justOutside })).length, 1);
  });
  test("a nonsense postedAt does not exclude anything", () => {
    for (const postedAt of ["yesterday", NaN, 0]) {
      assert.equal(buildCandidates(world({ postedAt })).length, 1, `postedAt=${postedAt}`);
    }
  });
});

describe("buildCandidates — ranking", () => {
  function many(specs) {
    const liveNodes = {}, products = {}, stockByPid = {}, salesByPid = {};
    for (const s of specs) {
      liveNodes[s.pid] = { state: "live", liveState: "on", cleanName: s.pid, liveAt: s.liveAt ?? NOW - 200 * DAY };
      products[s.pid] = { id: s.pid, photoUrl: "https://x/p.jpg", category: s.category || "Clothing", categoryKey: s.key || "t-shirts", sizes: ["M"] };
      stockByPid[s.pid] = { pine: { M: { qty: 5 } } };
      salesByPid[s.pid] = s.units ?? 0;
    }
    return buildCandidates({ liveNodes, products, stockByPid, salesByPid, nowMs: NOW });
  }

  test("a best-seller outranks a non-seller of the same age", () => {
    const [first] = many([{ pid: "pA", units: 0 }, { pid: "pB", units: 40 }]);
    assert.equal(first.pid, "pB");
  });

  test("a brand-new product with no sales still scores above an old non-seller", () => {
    const rows = many([{ pid: "pOld", units: 0, liveAt: NOW - 300 * DAY }, { pid: "pNew", units: 0, liveAt: NOW }]);
    assert.equal(rows[0].pid, "pNew");
    assert.ok(rows[0].score > rows[1].score);
  });

  test("newness decays and hits exactly zero past the window", () => {
    const rows = many([
      { pid: "a", liveAt: NOW - 5 * DAY },    // inside the full-strength window
      { pid: "b", liveAt: NOW - 35 * DAY },   // decaying
      { pid: "c", liveAt: NOW - 90 * DAY },   // past zero
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.pid, r]));
    assert.equal(by.a.newNorm, 1);
    assert.ok(by.b.newNorm > 0 && by.b.newNorm < 1);
    assert.equal(by.c.newNorm, 0);
  });

  test("a product with no liveAt scores zero for newness rather than infinitely new", () => {
    const liveNodes = { p1: { state: "live", liveState: "on", cleanName: "n" } };
    const [c] = buildCandidates({
      liveNodes,
      products: { p1: { id: "p1", photoUrl: "https://x/p.jpg", sizes: ["M"] } },
      stockByPid: { p1: { pine: { M: { qty: 1 } } } },
      nowMs: NOW,
    });
    assert.equal(c.newNorm, 0);
  });

  test("sales normalise against the candidate set, not an absolute", () => {
    // Two products, 2 and 1 units. The leader must be at full strength even
    // though 2 units is a quiet week — the question is "of what I could post".
    const rows = many([{ pid: "a", units: 2 }, { pid: "b", units: 1 }]);
    assert.equal(rows.find((r) => r.pid === "a").salesNorm, 1);
    assert.equal(rows.find((r) => r.pid === "b").salesNorm, 0.5);
  });

  test("no sales data at all does not divide by zero", () => {
    const rows = many([{ pid: "a" }, { pid: "b" }]);
    for (const r of rows) assert.equal(r.salesNorm, 0);
    assert.ok(Number.isFinite(rows[0].score));
  });

  test("ties break on pid, so a run is reproducible", () => {
    const a = many([{ pid: "pz", units: 5 }, { pid: "pa", units: 5 }]).map((r) => r.pid);
    const b = many([{ pid: "pa", units: 5 }, { pid: "pz", units: 5 }]).map((r) => r.pid);
    assert.deepEqual(a, b);
    assert.deepEqual(a, ["pa", "pz"]);
  });
});

describe("pickForKind", () => {
  function pool(n, over = (i) => ({})) {
    const liveNodes = {}, products = {}, stockByPid = {}, salesByPid = {};
    for (let i = 0; i < n; i++) {
      const pid = `p${i}`;
      const o = over(i);
      liveNodes[pid] = { state: "live", liveState: "on", cleanName: `Name ${i}`, liveAt: o.liveAt ?? NOW - 5 * DAY };
      products[pid] = { id: pid, photoUrl: "https://x/p.jpg", category: o.category || "Clothing", categoryKey: o.key || "t-shirts", sizes: ["M"] };
      stockByPid[pid] = { pine: { M: { qty: 3 } } };
      salesByPid[pid] = o.units ?? (n - i);
    }
    return buildCandidates({ liveNodes, products, stockByPid, salesByPid, nowMs: NOW });
  }

  test("refuses an unknown kind by name rather than returning nothing quietly", () => {
    const r = pickForKind("reel", pool(5));
    assert.equal(r.picks.length, 0);
    assert.match(r.reason, /unknown post type/);
  });

  test("single takes exactly one, the top-ranked", () => {
    const r = pickForKind("single", pool(5));
    assert.equal(r.picks.length, 1);
    assert.equal(r.picks[0].pid, "p0");
  });

  test("respects `used` so one run does not reuse a product", () => {
    const r = pickForKind("single", pool(5), { used: new Set(["p0", "p1"]) });
    assert.equal(r.picks[0].pid, "p2");
  });

  test("reports, rather than downgrades, when a kind cannot be filled", () => {
    const r = pickForKind("flatlay", pool(2));
    assert.equal(r.picks.length, 0);
    assert.match(r.reason, /needs 3/);
  });

  test("flatlay spreads across categories where it can", () => {
    const keys = ["sneakers", "t-shirts", "caps-beanies", "bags", "perfumes"];
    const r = pickForKind("flatlay", pool(10, (i) => ({ key: keys[i % keys.length] })));
    const chosen = new Set(r.picks.map((p) => p.categoryKey));
    assert.equal(r.picks.length, 5);
    assert.equal(chosen.size, 5);
  });

  test("flatlay still produces a post from a single-category catalogue", () => {
    const r = pickForKind("flatlay", pool(6, () => ({ key: "sneakers" })));
    assert.equal(r.picks.length, 5);
  });

  describe("new_arrivals", () => {
    test("sorts by liveAt, not by sales", () => {
      const r = pickForKind("new_arrivals", pool(5, (i) => ({
        liveAt: NOW - i * DAY,
        units: i,          // sales run the OTHER way
      })));
      assert.equal(r.picks[0].pid, "p0");
      assert.ok(r.picks[0].liveAt > r.picks[1].liveAt);
    });

    test("refuses to build a new-arrivals post out of a stale catalogue", () => {
      // Everything past the newness window. A "new arrivals" post assembled
      // from the newest of a stale catalogue is a lie.
      const r = pickForKind("new_arrivals", pool(6, () => ({ liveAt: NOW - 300 * DAY })));
      assert.equal(r.picks.length, 0);
      assert.match(r.reason, /went live recently/);
    });

    test("a well-selling old product cannot sneak in", () => {
      const r = pickForKind("new_arrivals", pool(4, (i) => ({
        liveAt: i === 3 ? NOW - 300 * DAY : NOW - DAY,
        units: i === 3 ? 9999 : 0,
      })));
      assert.ok(!r.picks.some((p) => p.pid === "p3"));
    });
  });

  describe("outfit", () => {
    const outfitPool = (keys) => pool(keys.length, (i) => ({ key: keys[i] }));

    test("takes one product per slot, in slot order", () => {
      const r = pickForKind("outfit", outfitPool(["sneakers", "t-shirts", "caps-beanies", "perfumes"]));
      assert.deepEqual(r.picks.map((p) => p.slot), OUTFIT_SLOTS);
    });

    test("never puts two of the same slot in one outfit", () => {
      const r = pickForKind("outfit", outfitPool(["sneakers", "sneakers", "t-shirts", "caps-beanies"]));
      const slots = r.picks.map((p) => p.slot);
      assert.equal(new Set(slots).size, slots.length);
    });

    test("accepts a partial outfit rather than refusing for weeks over a missing fragrance", () => {
      const r = pickForKind("outfit", outfitPool(["sneakers", "t-shirts", "caps-beanies"]));
      assert.equal(r.picks.length, 3);
      assert.ok(!r.picks.some((p) => p.slot === "fragrance"));
    });

    test("refuses below the minimum, and NAMES what was missing", () => {
      const r = pickForKind("outfit", outfitPool(["sneakers"]));
      assert.equal(r.picks.length, 0);
      assert.match(r.reason, /nothing available for/);
      assert.match(r.reason, /top/);
      assert.match(r.reason, /fragrance/);
    });

    test("products filling no slot are simply not used", () => {
      const r = pickForKind("outfit", outfitPool(["bags", "pants", "sneakers", "t-shirts"]));
      assert.equal(r.picks.length, 2);
      assert.deepEqual(r.picks.map((p) => p.slot), ["shoe", "top"]);
    });
  });
});

// ─── DRIFT PINS ──────────────────────────────────────────────────────────────
// The browser prices its Generate buttons and schedules its slots from
// src/components/social/socialCore.js; this file decides what those buttons
// actually produce. Two copies of a vocabulary stay equal only if something
// checks.
describe("POST_KINDS matches the browser's copy", () => {
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const SRC = join(__dirname, "../../src/components/social/socialCore.js");

  test("the browser module is where this expects it", () => {
    assert.ok(readFileSync(SRC, "utf8").includes("export const POST_KINDS"));
  });

  test("same keys, same order, same product ranges, same prices", () => {
    const src = readFileSync(SRC, "utf8");
    // Parse the literal out of the ESM source rather than importing it — this
    // is a CJS node:test file and socialCore.js is browser ESM.
    const block = src.match(/export const POST_KINDS = \[([\s\S]*?)\n\];/);
    assert.ok(block, "could not find POST_KINDS in socialCore.js");
    const browser = [...block[1].matchAll(
      /key:\s*"([a-z_]+)"[\s\S]*?minProducts:\s*(\d+),\s*\n\s*maxProducts:\s*(\d+),\s*\n\s*generates:\s*(true|false),\s*\n\s*costUSD:\s*([\d.]+)/g
    )].map((m) => ({
      key: m[1], minProducts: +m[2], maxProducts: +m[3], generates: m[4] === "true", costUSD: +m[5],
    }));
    assert.equal(browser.length, POST_KINDS.length, "different number of post kinds");
    browser.forEach((b, i) => {
      const mine = POST_KINDS[i];
      assert.equal(b.key, mine.key);
      assert.equal(b.minProducts, mine.minProducts, `${b.key} minProducts`);
      assert.equal(b.maxProducts, mine.maxProducts, `${b.key} maxProducts`);
      assert.equal(b.generates, mine.generates, `${b.key} generates`);
      assert.equal(b.costUSD, mine.costUSD, `${b.key} costUSD`);
    });
    assert.deepEqual(KIND_KEYS, browser.map((b) => b.key));
  });
});

describe("the schedule slots match the browser's", () => {
  // socialScheduleSlots in functions/index.js is a deliberate twin of nextSlots
  // in socialCore.js — daily 11:00 SAST since 2026-08-24. Re-implemented here
  // from the same constants and checked against a hand-computed answer, so a
  // change to either side that is not mirrored fails.
  const SAST = 2 * 3600000, DAYMS = 86400000, HOUR = 11;
  function slots(fromMs, count) {
    const out = [];
    const startDay = Math.floor((fromMs + SAST) / DAYMS);
    for (let d = 0; d < count + 2 && out.length < count; d++) {
      const midnightUtc = (startDay + d) * DAYMS - SAST;
      const slot = midnightUtc + HOUR * 3600000;
      if (slot >= fromMs) out.push(slot);
    }
    return out;
  }
  test("Saturday noon SAST yields Sunday, Monday, Tuesday 11:00 — every day, not three a week", () => {
    // 2026-08-22 is a Saturday. 10:00 UTC = 12:00 SAST, past that day's 11:00.
    const got = slots(Date.UTC(2026, 7, 22, 10, 0), 3);
    assert.deepEqual(got, [
      Date.UTC(2026, 7, 23, 9, 0),   // Sun 11:00 SAST
      Date.UTC(2026, 7, 24, 9, 0),   // Mon
      Date.UTC(2026, 7, 25, 9, 0),   // Tue
    ]);
  });
  test("launchd ticks rather than firing on a calendar — no Weekday/Hour keys to drift", () => {
    // com.marathon.socialpublish polls every 120s and asks the publisher what
    // is DUE by scheduledAt; the cadence lives entirely in socialCore.js /
    // socialScheduleSlots, not in the plist. There is nothing here to pin.
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const plist = readFileSync(join(__dirname, "../../scripts/social/com.marathon.socialpublish.plist"), "utf8");
    assert.doesNotMatch(plist, /<key>StartCalendarInterval<\/key>/, "the plist should tick, not fire on a calendar");
    assert.match(plist, /<key>StartInterval<\/key><integer>\d+<\/integer>/, "the plist should declare a tick interval");
  });
});

describe("the autopilot's policy-driven time slots (nextHourSlot, parseHHMM)", () => {
  // Re-implemented from the same constants as functions/index.js, the same
  // way the schedule-slots block above does — a change to either side that
  // is not mirrored fails one of these.
  const SAST = 2 * 3600000, DAYMS = 86400000;
  function sastMidnightUtc(fromMs, dayOffset) {
    const startDay = Math.floor((fromMs + SAST) / DAYMS);
    return (startDay + dayOffset) * DAYMS - SAST;
  }
  function nextHourSlot(fromMs, hour, minute = 0, taken = new Set()) {
    for (let d = 0; d < 14; d++) {
      const slot = sastMidnightUtc(fromMs, d) + hour * 3600000 + minute * 60000;
      if (slot >= fromMs && !taken.has(slot)) return slot;
    }
    return null;
  }
  function parseHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return { hour: 12, minute: 0 };
    const hour = Math.min(23, Math.max(0, Number(m[1])));
    const minute = Math.min(59, Math.max(0, Number(m[2])));
    return { hour, minute };
  }

  test("a saved '09:30' lands at 09:30 SAST, today if still ahead", () => {
    // 2026-08-25 08:00 UTC = 10:00 SAST — 09:30 has already passed today.
    const { hour, minute } = parseHHMM("09:30");
    const slot = nextHourSlot(Date.UTC(2026, 7, 25, 8, 0), hour, minute);
    assert.equal(new Date(slot).toISOString(), "2026-08-26T07:30:00.000Z", "should roll to tomorrow's 09:30 SAST");
  });

  test("a saved '09:30' lands today when the time has not passed yet", () => {
    // 2026-08-25 05:00 UTC = 07:00 SAST — 09:30 is still ahead today.
    const { hour, minute } = parseHHMM("09:30");
    const slot = nextHourSlot(Date.UTC(2026, 7, 25, 5, 0), hour, minute);
    assert.equal(new Date(slot).toISOString(), "2026-08-25T07:30:00.000Z");
  });

  test("a taken slot is skipped to the next day's occurrence of the same time", () => {
    const fromMs = Date.UTC(2026, 7, 25, 5, 0);
    const first = nextHourSlot(fromMs, 9, 30);
    const second = nextHourSlot(fromMs, 9, 30, new Set([first]));
    assert.notEqual(first, second);
    assert.equal(second - first, DAYMS);
  });

  test("a malformed saved time falls back to noon rather than throwing", () => {
    assert.deepEqual(parseHHMM("nonsense"), { hour: 12, minute: 0 });
    assert.deepEqual(parseHHMM(""), { hour: 12, minute: 0 });
    assert.deepEqual(parseHHMM(null), { hour: 12, minute: 0 });
  });

  test("an out-of-range saved time is clamped, not refused", () => {
    assert.deepEqual(parseHHMM("23:75"), { hour: 23, minute: 59 });
    assert.deepEqual(parseHHMM("30:10"), { hour: 23, minute: 10 });
  });
});
