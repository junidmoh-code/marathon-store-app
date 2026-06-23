// Small error boundary so a data edge-case in a Stock tab surfaces a readable error
// instead of blanking the whole app. Used to wrap the TEMPORARY Counted Stock tool.
import React from "react";

export default class StockErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error("Stock tool crashed:", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 14, borderRadius: 10, background: "rgba(248,113,113,.12)", border: "1px solid rgba(248,113,113,.5)", color: "#FCA5A5", fontSize: 12.5, lineHeight: 1.5 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>This tool hit an error (the rest of the app is fine).</div>
          <div style={{ fontFamily: "monospace", wordBreak: "break-word", color: "#fff" }}>{String(this.state.error?.message || this.state.error)}</div>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 10, padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(248,113,113,.5)", background: "transparent", color: "#FCA5A5", cursor: "pointer" }}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}
