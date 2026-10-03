// ─── LABEL PRINTER STATUS (quiet indicator) ──────────────────────────────────
// One line in the print screens saying which printer and which route the next
// label takes — "USB → XP-350B …" or "System print → default printer" — or that
// nothing is reachable. Mounting it starts the USB watch (getDevices on load,
// silent re-discovery on plug/unplug). On a failure the per-attempt lines (device
// · interface/endpoint · exact exception) open underneath and can be copied, so
// the next failure diagnoses itself. The "Choose USB printer" button is the one
// manual escape hatch, offered only when no USB device is permitted at all.

import React, { useEffect, useState, useSyncExternalStore } from "react";
import { getPrinterStatus, subscribePrinterStatus, printerStatusText, startUsbPrinterWatch, findUsbPrinter } from "./printers";
import { FONT } from "./ui";

const DOT = { usb: "#4ADE80", os: "#7FA6FF", none: "#F87171", checking: "#F5A623", idle: "rgba(233,238,255,.35)" };

export default function PrinterStatus({ style }) {
  const s = useSyncExternalStore(subscribePrinterStatus, getPrinterStatus, getPrinterStatus);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { startUsbPrinterWatch(); }, []);

  const head = s.state === "usb" ? `USB → ${s.name}`
    : s.state === "os" ? "System print → default printer"
    : s.state === "checking" ? "Looking for the label printer…"
    : s.state === "none" ? "No label printer reachable"
    : "Label printer";
  const sub = s.detail || "";
  const lines = s.lines || [];
  const noneAllowed = s.state === "os" && !!s.noPrinter && typeof navigator !== "undefined" && !!navigator.usb;
  const printedNote = s.printed ? ` · last label: ${s.printed === "usb" ? "USB" : "system print"}` : "";

  const copy = async () => {
    const text = printerStatusText(s);
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked — the text is on screen to photograph */ }
  };

  return (
    <div style={{ fontFamily: FONT, fontSize: 11.5, color: "rgba(233,238,255,.7)", ...style }}>
      <div onClick={() => lines.length && setOpen(o => !o)}
        style={{ display: "flex", alignItems: "flex-start", gap: 7, cursor: lines.length ? "pointer" : "default" }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: DOT[s.state] || DOT.idle, marginTop: 4, flexShrink: 0 }} />
        <span style={{ minWidth: 0, wordBreak: "break-word" }}>
          <span style={{ fontWeight: 700, color: "#E9EEFF" }}>{head}</span>
          {(sub || printedNote) && <span style={{ color: "rgba(233,238,255,.5)" }}> — {sub}{printedNote}</span>}
          {lines.length > 0 && <span style={{ color: "rgba(233,238,255,.4)" }}> {open ? "▾" : "▸"} {lines.length} USB attempt{lines.length === 1 ? "" : "s"}</span>}
        </span>
      </div>
      {open && lines.length > 0 && (
        <div style={{ marginTop: 6, padding: "7px 9px", borderRadius: 8, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)" }}>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 10.5, color: "#fff", fontFamily: "monospace" }}>{lines.join("\n")}</pre>
          <button onClick={copy} style={{ marginTop: 6, background: "none", border: "1px solid rgba(255,255,255,.2)", color: "rgba(233,238,255,.8)", borderRadius: 7, padding: "3px 8px", fontSize: 10.5, cursor: "pointer", fontFamily: FONT }}>
            {copied ? "Copied" : "Copy details"}
          </button>
        </div>
      )}
      {noneAllowed && (
        <button onClick={() => findUsbPrinter({ allowPicker: true, forcePicker: true })}
          style={{ marginTop: 6, background: "none", border: "1px solid rgba(74,127,255,.4)", color: "#9DBCFF", borderRadius: 7, padding: "3px 8px", fontSize: 10.5, cursor: "pointer", fontFamily: FONT }}>
          Choose USB printer…
        </button>
      )}
      {noneAllowed && (
        <button onClick={() => findUsbPrinter({ allowPicker: true, forcePicker: true, showAll: true })}
          style={{ marginTop: 6, marginLeft: 6, background: "none", border: "none", color: "rgba(233,238,255,.45)", padding: "3px 4px", fontSize: 10.5, cursor: "pointer", fontFamily: FONT, textDecoration: "underline" }}>
          Not listed? Show every USB device
        </button>
      )}
    </div>
  );
}
