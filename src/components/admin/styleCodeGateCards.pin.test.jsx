// ─── ADMIN'S CARDS DID NOT MOVE (2026-08-15) ────────────────────────────────
// The count flow now renders the intake gate's "is it one of these?" list
// instead of a second implementation of it, which meant lifting SimilarCards
// out of StyleCodeGate.jsx into shared/CandidateCards.jsx. This is a PORT: the
// gate's own output must be identical to what it produced before the move.
//
// The proof is not a snapshot file — it is the ORIGINAL component, copied
// verbatim from StyleCodeGate.jsx as it stood at 14cb33d, rendered beside the
// shared one with the same props. Byte-for-byte on the serialised tree.
// Mutating either the shared component's markup or its admin-facing defaults
// (84px photo, "ADD STOCK →", 6 rows, 1px border) fails this immediately.
import { describe, it, expect, vi } from "vitest";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { formatStyleCodeForDisplay } from "../../utils/styleCode";
import CandidateCards from "../shared/CandidateCards.jsx";

// ── VERBATIM, from StyleCodeGate.jsx before the lift ────────────────────────
const BLUE = "#4A7FFF";
const meta = { fontSize: 12, color: "rgba(233,238,255,.45)", lineHeight: 1.5 };
function SimilarCardsOriginal({ suggestions, onAddStock }) {
  return (
    <>
      {suggestions.slice(0, 6).map((s) => (
        <div key={s.product.id}
          onClick={() => onAddStock(s.product.id)}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAddStock(s.product.id); } }}
          style={{ display: "flex", gap: 14, alignItems: "center", background: "rgba(255,255,255,.03)",
                   border: "1px solid rgba(120,150,255,.16)", borderRadius: 14, padding: 12, cursor: "pointer" }}>
          <div style={{ width: 84, height: 84, flexShrink: 0, borderRadius: 12, overflow: "hidden",
                        background: "rgba(255,255,255,.05)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {s.product.photoUrl
              ? <img src={s.product.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : <span style={{ ...meta, fontSize: 9 }}>NO IMAGE</span>}
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15.5, fontWeight: 750, color: "#fff", lineHeight: 1.25 }}>{s.product.name || "Unnamed product"}</div>
            {s.code && (
              <div style={{ ...meta, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                {formatStyleCodeForDisplay(s.code)}{s.field === "pending" ? " (pending)" : ""}
              </div>
            )}
            <div style={{ ...meta, marginTop: 4, color: "#AFC6FF" }}>{s.reasons.join(" · ")}</div>
          </div>
          <span style={{ ...meta, color: BLUE, fontWeight: 800, flexShrink: 0 }}>ADD STOCK →</span>
        </div>
      ))}
    </>
  );
}

// Every branch the card has: a photo and no photo, a code and no code,
// confirmed and pending, one reason and several, a nameless row, and a
// seventh row that must be cut by the limit.
const SUGGESTIONS = [
  { product: { id: "a", name: "Lacoste Gripshot Mid White", photoUrl: "https://x/a.jpg" },
    code: "742CFA00052G4", field: "confirmed", reasons: ["same code family"] },
  { product: { id: "b", name: "Lacoste Gripshot Green", photoUrl: null },
    code: "742CFA00072G4", field: "pending", reasons: ["one character away", "shares the printed colour code"] },
  { product: { id: "c", name: "", photoUrl: "https://x/c.jpg" }, code: null, field: null, reasons: ["no code or name overlap"] },
  { product: { id: "d", name: "Timberland 6-Inch", photoUrl: "https://x/d.jpg" },
    code: "A8425", field: "confirmed", reasons: ["carries A8425 (via the label's other token A6CWNEN3)"] },
  { product: { id: "e", name: "E" }, code: "E1", field: "confirmed", reasons: ["r"] },
  { product: { id: "f", name: "F" }, code: "F1", field: "confirmed", reasons: ["r"] },
  { product: { id: "g", name: "SEVENTH — must be cut by the limit" }, code: "G1", field: "confirmed", reasons: ["r"] },
];

const render = (el) => {
  let tr;
  act(() => { tr = TestRenderer.create(el); });
  return tr;
};

describe("the intake gate's cards survived the lift into shared/", () => {
  it("renders BYTE-FOR-BYTE what SimilarCards rendered before the move", () => {
    const before = render(<SimilarCardsOriginal suggestions={SUGGESTIONS} onAddStock={() => {}} />);
    const after = render(<CandidateCards suggestions={SUGGESTIONS} onPick={() => {}} />);
    expect(JSON.stringify(after.toJSON())).toBe(JSON.stringify(before.toJSON()));
  });

  it("still caps at six rows — the seventh never renders", () => {
    const tr = render(<CandidateCards suggestions={SUGGESTIONS} onPick={() => {}} />);
    expect(JSON.stringify(tr.toJSON())).not.toContain("SEVENTH");
    expect(tr.toJSON()).toHaveLength(6);
  });

  it("a tap still hands back the product — the gate turns it into onAddStock(id)", () => {
    const onPick = vi.fn();
    const tr = render(<CandidateCards suggestions={SUGGESTIONS} onPick={onPick} />);
    act(() => { tr.root.findAll((n) => n.props?.role === "button")[3].props.onClick(); });
    expect(onPick).toHaveBeenCalledWith(SUGGESTIONS[3].product);
  });

  it("keyboard activation survived — Enter and Space both pick", () => {
    const onPick = vi.fn();
    const tr = render(<CandidateCards suggestions={SUGGESTIONS} onPick={onPick} />);
    const row = tr.root.findAll((n) => n.props?.role === "button")[0];
    act(() => { row.props.onKeyDown({ key: "Enter", preventDefault: () => {} }); });
    act(() => { row.props.onKeyDown({ key: " ", preventDefault: () => {} }); });
    act(() => { row.props.onKeyDown({ key: "Tab", preventDefault: () => {} }); });
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("the count's overrides are ADDITIVE — they change nothing until passed", () => {
    const plain = render(<CandidateCards suggestions={SUGGESTIONS} onPick={() => {}} />);
    const explicitDefaults = render(
      <CandidateCards suggestions={SUGGESTIONS} onPick={() => {}}
                      limit={6} photoSize={84} cta="ADD STOCK →" highlightId={null} disabled={false} />);
    expect(JSON.stringify(explicitDefaults.toJSON())).toBe(JSON.stringify(plain.toJSON()));
  });
});

describe("what the count flow asks the shared card for", () => {
  it("a bigger photo, its own verb, no row limit, and the colour leader outlined", () => {
    const tr = render(
      <CandidateCards suggestions={SUGGESTIONS} onPick={() => {}}
                      limit={SUGGESTIONS.length} photoSize={120} cta="TAP" highlightId="b" />);
    const json = JSON.stringify(tr.toJSON());
    expect(tr.toJSON()).toHaveLength(7);              // the limit really lifted
    expect(json).toContain('"width":120,"height":120');
    expect(json).toContain('"TAP"');
    expect(json).not.toContain("ADD STOCK");
    // The outlined row, and ONLY that row.
    expect((json.match(/2px solid #4A7FFF/g) || []).length).toBe(1);
  });

  it("busy disables every row — a tap mid-write cannot start a second one", () => {
    const onPick = vi.fn();
    const tr = render(<CandidateCards suggestions={SUGGESTIONS} onPick={onPick} disabled />);
    const row = tr.root.findAll((n) => n.props?.role === "button")[0];
    expect(row.props.onClick).toBeUndefined();
    expect(row.props["aria-disabled"]).toBe(true);
    expect(row.props.style.cursor).toBe("not-allowed");
  });

  it("the matched-token line is just a reason — the card needs no new slot for it", () => {
    const tr = render(<CandidateCards suggestions={[
      { product: { id: "a", name: "Timberland", photoUrl: "https://x/a.jpg" }, code: "A8425", field: "confirmed",
        reasons: ["matched A8425 · A6CWNEN3", "closest colour match — check it, don't trust it"] },
    ]} onPick={() => {}} cta="TAP" />);
    expect(JSON.stringify(tr.toJSON())).toContain("matched A8425 · A6CWNEN3 · closest colour match");
  });
});
