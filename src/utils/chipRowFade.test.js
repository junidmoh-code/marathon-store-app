import { describe, it, expect } from "vitest";
import { fadeFor } from "./chipRowFade.js";
const row = (scrollWidth, clientWidth, scrollLeft) => ({ scrollWidth, clientWidth, scrollLeft });
describe("chip row fade side", () => {
  it("a row that fits never fades", () => { expect(fadeFor(row(300, 300, 0))).toBe(""); expect(fadeFor(row(301, 300, 0))).toBe(""); });
  it("at rest with more to the right: right only", () => expect(fadeFor(row(600, 300, 0))).toBe("r"));
  it("in the middle: both", () => expect(fadeFor(row(600, 300, 150))).toBe("lr"));
  it("at the end: left only", () => expect(fadeFor(row(600, 300, 300))).toBe("l"));
});
