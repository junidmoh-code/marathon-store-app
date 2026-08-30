// ─── THE CARD RECON SCREENS' SHARED SKIN ─────────────────────────────────────
// One palette and one time format for the capture screen and the emailed-slip
// panel beside it. They are the same screen to the person holding the phone,
// and two copies of a colour drift the moment one of them is touched.
//
// SAST, always: every time on this feature is a shop's local time, and a batch
// window read in the wrong zone is a variance nobody can explain.

export const FONT = "'Inter','SF Pro Display',-apple-system,BlinkMacSystemFont,sans-serif";

export function fmtTime(ms) {
  if (!Number.isInteger(ms)) return "—";
  return new Date(ms).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

export const S = {
  page: { minHeight: "100vh", background: "#05070D", color: "#E9EEFF", fontFamily: FONT, padding: "18px 14px 40px", maxWidth: 560, margin: "0 auto" },
  h1: { fontSize: 20, fontWeight: 800, margin: "6px 0 2px" },
  sub: { fontSize: 13, color: "rgba(233,238,255,.55)", lineHeight: 1.5 },
  card: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.09)", borderRadius: 14, padding: 14, marginTop: 14 },
  btn: { width: "100%", minHeight: 54, borderRadius: 13, fontSize: 16, fontWeight: 800, fontFamily: FONT, cursor: "pointer", border: "2px solid rgba(74,127,255,.55)", background: "rgba(74,127,255,.18)", color: "#D7E3FF" },
  btnGhost: { width: "100%", minHeight: 46, borderRadius: 13, fontSize: 14, fontWeight: 700, fontFamily: FONT, cursor: "pointer", border: "1px solid rgba(255,255,255,.16)", background: "rgba(255,255,255,.04)", color: "rgba(233,238,255,.75)" },
  warn: { background: "rgba(251,191,36,.08)", border: "1px solid rgba(251,191,36,.3)", borderRadius: 11, padding: "10px 12px", fontSize: 13, color: "#FDE9B0", marginTop: 10, lineHeight: 1.5 },
  err: { background: "rgba(255,107,107,.08)", border: "1px solid rgba(255,107,107,.35)", borderRadius: 11, padding: "10px 12px", fontSize: 13.5, color: "#FFB3B3", marginTop: 10, lineHeight: 1.5 },
  row: { display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: "1px solid rgba(255,255,255,.06)", fontSize: 14 },
  k: { color: "rgba(233,238,255,.55)" },
  v: { fontWeight: 700, fontVariantNumeric: "tabular-nums", textAlign: "right" },
};
