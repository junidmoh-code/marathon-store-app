import { formatSize } from "../../utils/sizeLabel";

// ─── THE ALTERNATIVES STRIP ──────────────────────────────────────────────────
// Owner spec 2026-09-06. Under the refusal — which is unchanged, word for word
// — a horizontally scrollable row of up to eight shoes that CAN be sold right
// now. Photo, name, the sizes actually available, the price, and one short line
// saying why it matched.
//
// SHOWS NOTHING WHEN THERE IS NOTHING. No empty section, no "no matches" row,
// no skeleton. The sheet falls back to exactly what it said before this
// existed, which is the correct answer when the catalogue genuinely has no
// substitute: an assistant reading out a suggestion that cannot be sold is
// worse than the bare refusal, because it spends the customer's patience twice.
//
// Every row here has ALREADY passed the availability join (alternativesCore);
// this component renders and never re-decides. The sizes printed are the ones
// the resolver said were sellable at the hub that would supply them, at the
// moment the chip was tapped.
//
// TAPPING ONE SELECTS THAT SHOE — it never returns to the catalogue. The
// customer's original size comes with them when the shoe has it; when it does
// not, the shoe opens on its own size grid with nothing chosen, because
// pre-choosing a size nobody asked for is how a wrong pair gets ordered.
export function AlternativesStrip({ rows, requestedSize, onPick, compact = false }) {
  if (!rows?.length) return null;
  const money = (n) => "R" + Number(n).toLocaleString("en-ZA", { maximumFractionDigits: 0 });
  const cardW = compact ? 132 : 148;
  return (
    <div style={{ marginBottom: compact ? 8 : "0.9rem" }}>
      <div style={{ color: "rgba(233,238,255,.5)", fontSize: compact ? 10.5 : 11, fontWeight: 800,
                    letterSpacing: ".07em", textTransform: "uppercase", marginBottom: 7 }}>
        Available now instead
      </div>
      {/* One row, scrolled sideways. A wrapped grid would push the size picker
          and the Add button off a phone screen, and the picker is what the
          assistant came here for. */}
      <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4,
                    WebkitOverflowScrolling: "touch", scrollbarWidth: "thin" }}>
        {rows.map((r) => (
          <button key={r.product.id} onClick={() => onPick(r)}
            title={`${r.product.name} — ${r.why}`}
            style={{ flex: `0 0 ${cardW}px`, width: cardW, textAlign: "left", padding: 0,
                     // NEUTRAL, not blue. Blue is "chosen" on the size chips a
                     // few pixels below, and eight blue-bordered cards next to
                     // that grid read as pre-selected.
                     border: "1px solid rgba(255,255,255,.14)", borderRadius: 12,
                     background: "rgba(255,255,255,.04)", color: "inherit", cursor: "pointer",
                     fontFamily: "inherit", overflow: "hidden" }}>
            <div style={{ position: "relative", width: "100%", aspectRatio: "3 / 4", background: "rgba(0,0,0,.25)" }}>
              <img src={r.product.photoUrl} alt="" loading="lazy"
                   style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
              {/* The size the customer actually asked for, called out on the
                  photo — it is the only fact that decides whether this row is
                  the answer or merely a near miss. */}
              {r.hasRequestedSize && (
                <span style={{ position: "absolute", top: 6, left: 6, padding: "2px 7px", borderRadius: 999,
                               background: "rgba(16,185,129,.92)", color: "#04150E", fontSize: 10, fontWeight: 900,
                               letterSpacing: ".03em" }}>
                  Size {formatSize(requestedSize)}
                </span>
              )}
            </div>
            <div style={{ padding: "7px 8px 9px" }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, lineHeight: 1.25, color: "#E9EEFF",
                            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {r.product.name}
              </div>
              <div style={{ marginTop: 4, fontSize: 12, fontWeight: 800, color: "#7AA2FF" }}>
                {money(r.product.retailPrice)}
              </div>
              {/* The sizes are the point of the card. Printed in full rather
                  than counted: "4 sizes" makes the assistant tap to find out
                  whether any of them is the one in front of them. */}
              <div style={{ marginTop: 4, fontSize: 10.5, fontWeight: 700, color: "rgba(233,238,255,.62)", lineHeight: 1.3 }}>
                {r.sizes.map((sz) => (sz === "Free Size" ? "OS" : formatSize(sz))).join(" · ")}
              </div>
              <div style={{ marginTop: 5, fontSize: 10, fontWeight: 600, color: "rgba(157,188,255,.72)", lineHeight: 1.3 }}>
                {r.why}{r.hubLabel ? ` · ${r.hubLabel}` : ""}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export default AlternativesStrip;
