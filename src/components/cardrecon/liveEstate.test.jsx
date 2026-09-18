// ─── THE SCREEN DRAWS A CARD FOR EVERY MACHINE IN THE ESTATE ─────────────────
// On 2026-09-18 the estate went from four terminals to six, and a report came
// back that the two Trophy cards were missing from a manager's phone. They were
// not: this test renders THE REAL SCREEN against the registry exactly as it
// stands live, and gets six cards. That result is what turned the investigation
// away from the code and towards the handset.
//
// It is kept because the claim it pins — every registered, unretired machine
// gets a card — is one this estate keeps testing: the registry grew twice in
// three weeks, and the two reported missing are the LAST TWO in label order,
// which is exactly where a list that silently truncates loses rows.
//
// The fixture is the live registry, warts and all: two rows carrying
// `activeFrom`, two carrying `tillChangedAt`, and two carrying neither. A row
// shape that stops rendering fails here.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// /config/cardTerminals as at 2026-09-18 12:07 UTC, read from the live database.
const LIVE_ESTATE = {
  "67325636": { activeFrom: 1789733243057, label: "Marathon Till 1", mid: "100000002453164", storeId: "pe", tillId: "till-1" },
  "67364485": { label: "Pine Till 1", mid: "100000001178101", storeId: "pine", tillId: "till-1" },
  "67365901": { label: "Marathon Till 3", mid: "100000001178101", storeId: "pe", tillChangedAt: 1789733243057, tillId: "till-3" },
  "67377843": { label: "Trophy Till 1", mid: "100000002816030", storeId: "trophy", tillId: "till-1" },
  "0000HP1X": { label: "Marathon Till 2", mid: "000000004977890", storeId: "pe", tillChangedAt: 1789733243057, tillId: "till-2" },
  "0000Z4M6": { activeFrom: 1789733243057, label: "Trophy Till 2", mid: "000000004977890", storeId: "trophy", tillId: "till-2" },
};

vi.mock("../../firebase", () => ({ database: {}, functions: {}, storage: {}, auth: {} }));
vi.mock("firebase/database", () => ({
  ref: (_db, path) => ({ path }),
  onValue: (refOrQuery, cb) => {
    const path = String(refOrQuery?.path ?? "");
    cb({ val: () => (path.includes("cardTerminals") ? LIVE_ESTATE : {}) });
    return () => {};
  },
  query: (r) => r, orderByChild: () => {}, limitToLast: () => {},
}));
vi.mock("firebase/functions", () => ({ httpsCallable: () => async () => ({ data: { ok: true } }) }));
vi.mock("../../utils/serverTime", () => ({
  serverNowMs: () => Date.parse("2026-09-18T16:40:00Z"),
  saDateStringAt: () => "2026-09-18",
}));
vi.mock("../shopify/imageDecode", () => ({
  decodeImageFile: vi.fn(), isAcceptedImageFile: () => true, describePickedFile: () => "",
}));

const CardReconScreen = (await import("./CardReconScreen")).default;

const renderCards = () => {
  let tree;
  act(() => { tree = TestRenderer.create(<CardReconScreen onExit={() => {}} />); });
  return tree.root
    .findAll((n) => n.type === "span" && typeof n.props.children === "string")
    .map((n) => n.props.children)
    .filter((s) => /Till/.test(s));
};

describe("the capture screen against the live estate", () => {
  it("draws one card per registered machine — all six, Trophy included", () => {
    expect(renderCards()).toEqual([
      "Marathon Till 1", "Marathon Till 2", "Marathon Till 3",
      "Pine Till 1", "Trophy Till 1", "Trophy Till 2",
    ]);
  });

  it("neither stamp hides a card — activeFrom and tillChangedAt are not filters", () => {
    // The capture screen has ONE reason to withhold a card, and it is
    // retirement. `activeFrom` bounds a report in the other app; `tillChangedAt`
    // only decides whether a captured batch carries a warning. Either being read
    // here as "not here" would take a trading till off a manager's phone.
    const stamped = renderCards().filter((l) => /Marathon Till [123]|Trophy Till 2/.test(l));
    expect(stamped).toHaveLength(4);
  });

  it("the registry stamps NEVER leave the screen — the callable is sent a TID and a photo", () => {
    // Asked directly after the 18 Sep capture failure: does a till carrying
    // `tillChangedAt` (0000HP1X) send something different from one that does
    // not (67377843)? It cannot. The payload is built from two values — the map
    // KEY and the decoded photo — and no registry field of any kind is in it.
    // A stamp added to a row therefore cannot change what is sent, for any
    // till, ever.
    const src = readFileSync(resolve(here, "CardReconScreen.jsx"), "utf8");
    const call = src.slice(src.indexOf("cardBatchCaptureFn({"), src.indexOf("summaryOnly: true"));
    expect(call).toMatch(/action: "extract", pickedTid: tid, photos: \[\{ base64 \}\]/);
    for (const field of ["tillChangedAt", "activeFrom", "retiredAt", "mid", "storeId", "tillId", "label"]) {
      expect(src.includes(`${field}:`), `${field} must not be part of what the screen sends`).toBe(false);
    }
    // And `t` reaches the callable only through its tid.
    expect(src).toMatch(/onChange=\{onPick\(t\.tid\)\}/);
  });

  it("a RETIRED machine is the only one that loses its card", () => {
    const retired = { ...LIVE_ESTATE, "67377843": { ...LIVE_ESTATE["67377843"], retiredAt: 1789733243057 } };
    // Proven through the same module the screen uses, rather than by
    // re-mocking the whole subscription for one row.
    const { captureCards } = require("./terminalRegistry");
    expect(captureCards(retired).map((c) => c.label)).not.toContain("Trophy Till 1");
    expect(captureCards(retired)).toHaveLength(5);
  });
});
