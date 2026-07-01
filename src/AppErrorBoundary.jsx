import { Component } from "react";

// Global crash guard. Without this, a render error in ANY view unmounts the whole
// React tree and leaves a blank white screen with no clue what happened (that's the
// symptom the Returns view showed). This catches the error, keeps the shell alive,
// and shows the message + Go back / Reload so a failure is visible + recoverable
// instead of silent. `resetKey` (the active role) remounts it on navigation so
// switching away from a broken screen clears the error.
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("View crashed:", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ maxWidth: 360 }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>This screen hit an error</div>
          <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.6)", lineHeight: 1.5, marginBottom: 18, wordBreak: "break-word" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button
              onClick={() => { this.setState({ error: null }); try { window.location.hash = ""; } catch { /* ignore */ } }}
              style={{ background: "#4A7FFF", color: "#fff", border: "none", borderRadius: 10, padding: "11px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >Go back</button>
            <button
              onClick={() => window.location.reload()}
              style={{ background: "rgba(255,255,255,.08)", color: "#fff", border: "1px solid rgba(255,255,255,.2)", borderRadius: 10, padding: "11px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
            >Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
