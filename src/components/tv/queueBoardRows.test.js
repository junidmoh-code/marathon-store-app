import { describe, it, expect } from "vitest";
import { buildBoard, buildColumn, agoText, clockText, dateText, VISIBLE_ROWS } from "./queueBoardRows";

// 2026-10-13 14:00 SAST = 12:00Z
const NOW = Date.parse("2026-10-13T12:00:00Z");
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();

describe("queue board rows", () => {
  it("puts each order in the column for its status, and nowhere else", () => {
    const board = buildBoard([
      { id: "001", status: "incoming", createdAt: iso(5) },
      { id: "002", status: "ready", createdAt: iso(30), readyAt: iso(3) },
      { id: "003", status: "out_of_stock", createdAt: iso(40), outOfStockAt: iso(6) },
      { id: "004", status: "coming_tomorrow", createdAt: iso(50), comingTomorrowAt: iso(7) },
      { id: "005", status: "collected", createdAt: iso(60) },
    ], NOW);
    expect(board.incoming.rows.map((r) => r.number)).toEqual(["001"]);
    expect(board.ready.rows.map((r) => r.number)).toEqual(["002"]);
    expect(board.oos.rows.map((r) => r.number)).toEqual(["003"]);
    expect(board.tomorrow.rows.map((r) => r.number)).toEqual(["004"]);
  });

  it("shows the newest five but counts every order in the column", () => {
    const orders = Array.from({ length: 12 }, (_, i) => ({
      id: String(100 + i).padStart(3, "0"), status: "incoming", createdAt: iso(i * 2),
    }));
    const col = buildColumn(orders, "incoming", NOW);
    expect(col.total).toBe(12);
    expect(col.rows).toHaveLength(VISIBLE_ROWS);
    expect(col.rows.map((r) => r.number)).toEqual(["100", "101", "102", "103", "104"]);
  });

  it("orders Ready by when it became ready, not when it was placed", () => {
    const col = buildColumn([
      { id: "010", status: "ready", createdAt: iso(1), readyAt: iso(7) },
      { id: "020", status: "ready", createdAt: iso(90), readyAt: iso(2) },
    ], "ready", NOW);
    expect(col.rows.map((r) => r.number)).toEqual(["020", "010"]);
    expect(col.rows.map((r) => r.meta)).toEqual(["2m ago", "7m ago"]);
  });

  it("ages against the status stamp, falling back to updatedAt", () => {
    const col = buildColumn([{ id: "030", status: "out_of_stock", createdAt: iso(500), updatedAt: iso(125) }], "oos", NOW);
    expect(col.rows[0].meta).toBe("2h ago");
  });

  it("Incoming shows the SAST time placed; Tomorrow never prints a clock time", () => {
    const board = buildBoard([
      { id: "040", status: "incoming", createdAt: "2026-10-13T10:43:00Z" },
      { id: "050", status: "coming_tomorrow", createdAt: iso(10), comingTomorrowAt: iso(1) },
    ], NOW);
    expect(board.incoming.rows[0].meta).toBe("12:43");
    expect(board.tomorrow.rows[0].meta).toBe("Tomorrow");
  });

  it("a stamp slightly in the future reads as just now", () => {
    expect(agoText(NOW + 30000, NOW)).toBe("just now");
    expect(agoText(undefined, NOW)).toBe("");
  });

  it("formats the header clock and date in SAST", () => {
    expect(clockText(NOW)).toBe("14:00");
    expect(dateText(NOW)).toBe("TUESDAY 13 OCT 2026");
  });

  it("tolerates holes and junk in the list", () => {
    const board = buildBoard([null, undefined, { status: "incoming" }], NOW);
    expect(board.incoming.total).toBe(1);
  });
});
