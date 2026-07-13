// ─── PICK LIST GENERATOR — generic printable warehouse job sheets ─────────────
// (owner spec 2026-07-14) Produces print-optimized HTML and opens it in a new
// window with the print dialog ready — every tablet/desktop turns that into a
// PDF natively ("Save as PDF" / share sheet). Deliberately dependency-free:
// no PDF library, photos load straight from the product URLs, page breaks and
// repeating headers are plain print CSS.
//
// GENERIC by design — Move Excess is the first consumer; the same call shape
// serves refill pick lists, supplier reorder sheets, count sheets, and
// transfer manifests:
//
//   openPickList({
//     title: "Move Excess Pick List",
//     route: "Marathon PE → Hub 2",
//     generatedBy: "warehouse",
//     groups: [{ name, photoUrl, lines: [{ label: "M", qty: 3 }], note? }],
//   })
//
// PRINTING NEVER MOVES STOCK. A pick list is a work assignment on paper; all
// inventory writes stay in the app's existing confirmation workflows.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Pure HTML builder — unit-testable without a DOM.
export function buildPickListHtml({ title, route, generatedBy, groups = [], now = new Date() }) {
  const totalProducts = groups.length;
  const totalUnits = groups.reduce((t, g) => t + g.lines.reduce((u, l) => u + (Number(l.qty) || 0), 0), 0);
  const dateStr = now.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // Alphabetical by name = brand → product → colour under the house naming
  // convention ("Nike Tech Fleece Black") — staff walk the shelves in order.
  const sorted = [...groups].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

  const rows = sorted.map((g, i) => `
    <tr class="item">
      <td class="photo">${g.photoUrl
        ? `<img src="${esc(g.photoUrl)}" alt="" />`
        : `<div class="nophoto">no photo</div>`}</td>
      <td class="detail">
        <div class="name">${esc(g.name)}</div>
        ${g.note ? `<div class="note">${esc(g.note)}</div>` : ""}
        <div class="sizes">${g.lines.map((l) => `<span class="size">${esc(l.label)} ×${esc(l.qty)}</span>`).join(" ")}</div>
      </td>
      <td class="qty">${g.lines.reduce((t, l) => t + (Number(l.qty) || 0), 0)}</td>
      <td class="check"><span>☐ Picked</span><span>☐ Verified</span><span>☐ Loaded</span></td>
    </tr>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — ${esc(route)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; margin: 0; }
  header { border-bottom: 3px solid #111; padding-bottom: 8px; margin-bottom: 10px; }
  header h1 { font-size: 19px; margin: 0 0 2px; }
  header .route { font-size: 15px; font-weight: 700; }
  header .meta { display: flex; gap: 18px; flex-wrap: wrap; color: #444; font-size: 11px; margin-top: 5px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
             border-bottom: 2px solid #111; padding: 4px 6px; }
  tr.item { page-break-inside: avoid; border-bottom: 1px solid #bbb; }
  tr.item td { padding: 7px 6px; vertical-align: top; }
  td.photo { width: 74px; }
  td.photo img { width: 68px; height: 68px; object-fit: cover; border-radius: 6px; border: 1px solid #ccc; }
  .nophoto { width: 68px; height: 68px; border: 1px dashed #999; border-radius: 6px; color: #999;
             font-size: 9px; display: flex; align-items: center; justify-content: center; }
  .name { font-weight: 700; font-size: 13px; }
  .note { color: #555; font-size: 11px; }
  .sizes { margin-top: 4px; }
  .size { display: inline-block; border: 1.5px solid #111; border-radius: 5px; padding: 2px 8px;
          margin: 2px 4px 0 0; font-weight: 700; font-size: 12.5px; }
  td.qty { width: 46px; font-size: 16px; font-weight: 800; text-align: center; }
  td.check { width: 92px; font-size: 10.5px; }
  td.check span { display: block; margin-bottom: 3px; white-space: nowrap; }
  footer { margin-top: 22px; page-break-inside: avoid; border-top: 2px solid #111; padding-top: 12px; font-size: 11.5px; }
  footer .line { display: flex; gap: 26px; margin-bottom: 14px; }
  footer .field { flex: 1; border-bottom: 1px solid #555; padding: 14px 2px 3px; color: #444; }
  footer .notes { border: 1px solid #999; border-radius: 6px; min-height: 64px; padding: 6px; color: #666; }
  @media screen { body { max-width: 780px; margin: 16px auto; padding: 0 12px; } }
</style></head><body>
<header>
  <h1>${esc(title)}</h1>
  <div class="route">${esc(route)}</div>
  <div class="meta">
    <span>Generated: <b>${esc(dateStr)} ${esc(timeStr)}</b></span>
    <span>Total products: <b>${totalProducts}</b></span>
    <span>Total units: <b>${totalUnits}</b></span>
    <span>Generated by: <b>${esc(generatedBy || "—")}</b></span>
  </div>
</header>
<table>
  <thead><tr><th>Photo</th><th>Product · sizes to transfer</th><th>Qty</th><th>Checklist</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
<footer>
  <div class="line"><div class="field">Completed by</div><div class="field">Signature</div></div>
  <div class="line"><div class="field">Date</div><div class="field">Time</div></div>
  <div>Notes</div><div class="notes"></div>
  <div style="margin-top:10px;color:#777;font-size:10px">
    This sheet assigns physical work only — no stock has moved. After picking,
    confirm the transfers in the Move Excess screen; live validation applies there.
  </div>
</footer>
<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},350)})</script>
</body></html>`;
}

// Open the sheet in a new tab and trigger the print dialog (user saves as PDF
// or prints). Must be called from a user gesture (button tap) so popup
// blockers allow it.
export function openPickList(spec) {
  const w = window.open("", "_blank");
  if (!w) return false;   // popup blocked — caller shows a hint
  w.document.open();
  w.document.write(buildPickListHtml(spec));
  w.document.close();
  return true;
}
