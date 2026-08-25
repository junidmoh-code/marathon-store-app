// ─── ONE ROW, ONE BLAST RADIUS ───────────────────────────────────────────────
// A React error boundary sized to a SINGLE record.
//
// Without it, one malformed post out of thirty-six unmounts the entire React
// tree: the queue, the library, the generator, the header — everything the
// Social card is — and Junid gets the screen error boundary with a sentence he
// cannot act on. That is what happened. The record that broke it was
// indistinguishable from the thirty-five that did not, because none of them
// were on screen.
//
// With it, the broken record renders as ITSELF: one red row that names the id,
// says what threw, and offers the one action that clears it. The other
// thirty-five render normally, and the thing that needs fixing is the thing
// that is pointing at itself.
//
// ── WHY THE AFFORDANCE IS PASSED IN ──────────────────────────────────────────
// "Delete" means discardPost on a queue row and deleteStyleRef on a library
// tile, and neither is this component's business. It takes a label and a
// function, so it never has to know which list it is inside.
import { Component } from "react";

const WRAP = {
  border: "1px solid rgba(248,113,113,.4)",
  background: "rgba(248,113,113,.07)",
  borderRadius: 10,
  padding: "12px 13px",
  margin: "8px 0",
  fontSize: 12,
  color: "#fca5a5",
  lineHeight: 1.55,
  wordBreak: "break-word",
};

export default class RowBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Named so a console filter can pull just these out of a noisy tab.
    console.error(`[social] row ${this.props.recordId || "?"} crashed:`, error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const { recordId, label = "this item", actionLabel, onAction, busy } = this.props;
    return (
      <div style={WRAP}>
        <div style={{ fontWeight: 800, marginBottom: 4 }}>
          This {label} couldn't be shown
        </div>
        <div style={{ color: "rgba(255,255,255,.62)", fontWeight: 400 }}>
          {String(this.state.error?.message || this.state.error)}
        </div>
        {recordId && (
          <div style={{ color: "rgba(255,255,255,.38)", fontSize: 10.5, marginTop: 5, fontFamily: "ui-monospace, monospace" }}>
            {recordId}
          </div>
        )}
        <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ background: "rgba(255,255,255,.08)", color: "#fff", border: "1px solid rgba(255,255,255,.2)",
                     borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
          >Try again</button>
          {onAction && actionLabel && (
            <button
              disabled={busy}
              onClick={() => onAction()}
              style={{ background: "rgba(248,113,113,.16)", color: "#fca5a5", border: "1px solid rgba(248,113,113,.5)",
                       borderRadius: 8, padding: "6px 12px", fontSize: 11.5, fontWeight: 700,
                       cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
            >{actionLabel}</button>
          )}
        </div>
      </div>
    );
  }
}
