// Styled clothing-size render: a big CAPITAL letter with a small raised number
// (e.g. M with a small 32). For plain-text contexts (receipts, printed labels,
// template strings) use formatSize() instead, which returns "M-32".
//
// DISPLAY ONLY — pass the RAW stored size ("M"); the raw value still keys stock/
// barcodes/orders. Footwear numbers and unknowns render unchanged.
import { formatSize } from "../utils/sizeLabel";

export function SizeTag({ size, style }) {
  if (size == null || size === "") return null;
  const label = String(formatSize(size));
  const m = label.match(/^(\d*[A-Za-z]+)-(\d+)$/); // "M-32" / "4XL-42" (clothing) → letter + number
  if (!m) return <span style={style}>{label}</span>; // footwear / unchanged
  return (
    <span style={style}>
      {m[1]}
      <span style={{ fontSize: "0.6em", fontWeight: 700, verticalAlign: "top", marginLeft: 1, letterSpacing: 0 }}>{m[2]}</span>
    </span>
  );
}
