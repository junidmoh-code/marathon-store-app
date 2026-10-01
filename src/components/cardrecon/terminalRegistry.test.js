// The registry predicate exists TWICE — here on the client (terminalRegistry.js)
// and on the server (functions/lib/card-terminals.cjs) — because the client
// cannot require a .cjs module out of the functions bundle and the functions
// bundle does not ship src/. Two copies of a rule drift, and the drift shows up
// as a retired machine still being offered on a manager's handset, or a live one
// disappearing from it.
//
// So the two are FUZZED AGAINST EACH OTHER over the shapes a registry row
// actually takes — including the ones a hand-edited row takes when somebody
// writes `retired: true` instead of a stamp.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { captureCards, isRetiredTerminal, captureMode, takesPhoto } from "./terminalRegistry";

const require = createRequire(import.meta.url);
const server = require("../../../functions/lib/card-terminals.cjs");

const ROW = { mid: "000000004977890", storeId: "pe", tillId: "till-2", label: "Marathon Till 2" };

describe("the client and server halves of the registry agree", () => {
  it("answers identically for every shape a row takes", () => {
    const stamps = [undefined, null, 0, -1, 1789689600000, "2026-09-18", NaN, Infinity, {}, [], true, false, "0"];
    const extras = [{}, { retired: true }, { retired: false }, { retiredReason: "swapped" }, { activeFrom: 1 }];
    const disagreed = [];
    for (const retiredAt of stamps) {
      for (const extra of extras) {
        const row = { ...ROW, ...extra, ...(retiredAt === undefined ? {} : { retiredAt }) };
        const mine = isRetiredTerminal(row);
        const theirs = server.isRetiredTerminal(row);
        if (mine !== theirs) disagreed.push(`${JSON.stringify(row)}: client ${mine}, server ${theirs}`);
      }
    }
    expect(disagreed, disagreed.join("\n")).toEqual([]);
    // …and the fuzz must be capable of both answers, or it is agreeing on
    // nothing. (Object.freeze on a Set is not immutability; a fuzz that only
    // ever produces `false` is not a fuzz.)
    expect(isRetiredTerminal({ ...ROW, retiredAt: 1789689600000 })).toBe(true);
    expect(isRetiredTerminal(ROW)).toBe(false);
  });

  it("agree on the capture mode for every shape the field takes", () => {
    const values = [undefined, null, "", "email", "photo", "both", "EMAIL", "fax", 1, true, {}, []];
    for (const capture of values) {
      const row = { ...ROW, ...(capture === undefined ? {} : { capture }) };
      expect(captureMode(row), JSON.stringify(capture)).toBe(server.captureMode(row));
      expect(takesPhoto(row), JSON.stringify(capture)).toBe(server.takesPhoto(row));
    }
    expect(new Set(values.map((capture) => captureMode({ capture })))).toEqual(new Set(["email", "photo", "both"]));
    expect(takesPhoto({ capture: "email" })).toBe(false);
    expect(takesPhoto({})).toBe(true);
  });

  it("a row with no stamp is live, and a row with a junk stamp is live", () => {
    // The dangerous default is the other way round: treating an unparseable
    // stamp as "retired" silently removes a trading till's card.
    expect(isRetiredTerminal({ ...ROW, retiredAt: "yesterday" })).toBe(false);
    expect(isRetiredTerminal({ ...ROW, retired: true })).toBe(false);
  });
});

describe("the cards the capture screen draws", () => {
  const ESTATE = {
    "67325636": { storeId: "pe", tillId: "till-1", label: "Marathon Till 1" },
    "0000HP1X": { storeId: "pe", tillId: "till-2", label: "Marathon Till 2" },
    "67365901": { storeId: "pe", tillId: "till-3", label: "Marathon Till 3" },
    "67377843": { storeId: "trophy", tillId: "till-1", label: "Trophy Till 1" },
    "0000Z4M6": { storeId: "trophy", tillId: "till-2", label: "Trophy Till 2" },
    "67364485": { storeId: "pine", tillId: "till-1", label: "Pine Till 1" },
  };

  it("draws one card per registered machine, in label order", () => {
    expect(captureCards(ESTATE).map((c) => c.label)).toEqual([
      "Marathon Till 1", "Marathon Till 2", "Marathon Till 3",
      "Pine Till 1", "Trophy Till 1", "Trophy Till 2",
    ]);
    // The TID comes with it — it is what the capture is sent against.
    expect(captureCards(ESTATE)[0].tid).toBe("67325636");
  });

  it("draws no card for a retired machine, and every other card is untouched", () => {
    const withRetired = { ...ESTATE, "0000HP1X": { ...ESTATE["0000HP1X"], retiredAt: 1789689600000 } };
    const cards = captureCards(withRetired);
    expect(cards.map((c) => c.tid)).not.toContain("0000HP1X");
    expect(cards).toHaveLength(5);
  });

  it("still draws a machine mapped without a label — it is capturable by TID", () => {
    const cards = captureCards({ ...ESTATE, ABCD1234: { storeId: "pine", tillId: "till-1" } });
    expect(cards.map((c) => c.label || c.tid)).toContain("ABCD1234");
  });

  it("the MAP KEY is the tid, even if the row carries one of its own", () => {
    // The card submits this value as `pickedTid`, and the callable refuses a
    // photo whose printed TID is not the till that was picked. A row whose
    // `tid` field shadowed the key would therefore make that card refuse every
    // photograph taken at it, with a message about the wrong till. The seed
    // writer preserves unknown fields on an existing row, so a stray `tid` is
    // not hypothetical.
    const cards = captureCards({ "0000HP1X": { ...ESTATE["0000HP1X"], tid: "WRONGTID" } });
    expect(cards[0].tid).toBe("0000HP1X");
  });

  it("survives the shapes RTDB actually hands back", () => {
    expect(captureCards(null)).toEqual([]);
    expect(captureCards({})).toEqual([]);
    // A node whose children were deleted comes back with nulls in it.
    expect(captureCards({ ...ESTATE, DEAD0001: null })).toHaveLength(6);
    expect(captureCards({ DEAD0001: "not an object" })).toEqual([]);
  });
});
