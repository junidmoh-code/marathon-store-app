import { Component } from "react";

// Global crash guard. Without this, a render error in ANY view unmounts the whole
// React tree and leaves a blank white screen with no clue what happened (that's the
// symptom the Returns view showed). This catches the error, keeps the shell alive,
// and shows the message + Go back / Reload so a failure is visible + recoverable
// instead of silent. `resetKey` (the active role) remounts it on navigation so
// switching away from a broken screen clears the error.
//
// ── WHY IT NOW SHOWS A STACK, AND A COPY BUTTON ──────────────────────────────
// The Social outage was reported as one sentence read off a phone screen:
// "null is not an object (evaluating 's.some')". `s` is a minified local. That
// message alone names no file, no component and no screen, and finding the line
// meant downloading the deployed bundle and pattern-matching against it.
//
// So the panel now carries the three things that turn a report into a location:
// the hash route (WHICH screen), React's component stack (WHICH component in
// it) and the message. Copy puts all three on the clipboard as plain text, so
// what arrives in a message is the whole thing rather than the part that fitted
// in someone's memory. Details stay COLLAPSED — the person looking at this
// wants "go back", and the stack is for whoever they send it to.
//
// Preserving function names in the production build (vite.config.js,
// esbuild.keepNames) is the other half: without it the stack is a column of
// single letters and this panel is prettier but no more useful.
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, stack: null, copied: false, open: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("View crashed:", error, info);
    this.setState({ stack: (info && info.componentStack) || null });
  }

  route() {
    try { return window.location.hash || "(no hash route)"; } catch { return "(unknown route)"; }
  }

  report() {
    const err = this.state.error;
    return [
      `route: ${this.route()}`,
      `message: ${String(err?.message || err)}`,
      `build: ${typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "unknown"}`,
      "",
      "component stack:",
      this.state.stack || "(not captured)",
      "",
      "error stack:",
      String(err?.stack || "(none)"),
    ].join("\n");
  }

  copy = () => {
    const text = this.report();
    const done = () => { this.setState({ copied: true }); setTimeout(() => this.setState({ copied: false }), 2500); };
    try {
      // The clipboard API needs a secure context and can reject; the textarea
      // fallback works everywhere, including the older iPads on the floor.
      if (navigator?.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done, () => this.copyFallback(text, done)); return; }
      this.copyFallback(text, done);
    } catch { this.copyFallback(text, done); }
  };

  copyFallback(text, done) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    } catch { /* nothing more to try; the details block is on screen to read */ }
  }

  render() {
    if (!this.state.error) return this.props.children;
    const btn = { borderRadius: 10, padding: "11px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" };
    return (
      <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center" }}>
        <div style={{ maxWidth: 420, width: "100%" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>This screen hit an error</div>
          <div style={{ fontSize: 12.5, color: "rgba(255,255,255,.6)", lineHeight: 1.5, marginBottom: 6, wordBreak: "break-word" }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.35)", fontFamily: MONO, marginBottom: 16, wordBreak: "break-all" }}>
            {this.route()}
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              onClick={() => { this.setState({ error: null, stack: null, open: false }); try { window.location.hash = ""; } catch { /* ignore */ } }}
              style={{ ...btn, background: "#4A7FFF", color: "#fff", border: "none" }}
            >Go back</button>
            <button
              onClick={() => window.location.reload()}
              style={{ ...btn, background: "rgba(255,255,255,.08)", color: "#fff", border: "1px solid rgba(255,255,255,.2)" }}
            >Reload</button>
            <button
              onClick={this.copy}
              style={{ ...btn, background: "rgba(255,255,255,.08)", color: "#fff", border: "1px solid rgba(255,255,255,.2)" }}
            >{this.state.copied ? "Copied ✓" : "Copy details"}</button>
          </div>

          <div
            onClick={() => this.setState((s) => ({ open: !s.open }))}
            style={{ marginTop: 18, fontSize: 11.5, color: "rgba(255,255,255,.45)", cursor: "pointer" }}
          >{this.state.open ? "Hide details" : "Show details"}</div>

          {this.state.open && (
            <pre style={{
              textAlign: "left", marginTop: 10, padding: 12, maxHeight: "38vh", overflow: "auto",
              background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.12)",
              borderRadius: 12, fontFamily: MONO, fontSize: 10.5, lineHeight: 1.5,
              color: "rgba(255,255,255,.72)", whiteSpace: "pre-wrap", wordBreak: "break-word",
            }}>{this.report()}</pre>
          )}
        </div>
      </div>
    );
  }
}
