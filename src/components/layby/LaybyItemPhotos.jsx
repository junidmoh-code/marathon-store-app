// ─── The parcel's products, by photo, on the hub's layby request card ────────
// One row per line: a LARGE photo (not an icon) and the SIZE printed big beside
// it, so warehouse staff can spot the parcel by eye instead of reading every
// parcel number. Tap the photo → the full-size photo, full screen (the app's
// own GalleryLightbox, handed in as onOpenPhoto).
//
// Data: laybyItems.js — one single-key read of the sale's lineItems, then the
// photo leaves of each product (or the live product the caller already has).
// Both cached per sale / product. Anything missing degrades quietly to the
// product icon / "Size —": the card's Sent / Reject never wait on a photo.
import { useEffect, useState } from "react";
import { PrimaryPhoto } from "../shared/PrimaryPhoto.jsx";
import { primaryPhotoUrl } from "../../utils/primaryPhoto";
import { fetchLaybyItems, fetchProductPhoto } from "./laybyItems";

const MUTED = "rgba(255,255,255,.45)";
export const LAYBY_PHOTO_PX = 112;

function ShoeGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,.35)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 16h20v2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 16l1-6 5 2 3-4 4 3 7 2v3"/>
    </svg>
  );
}

function ItemRow({ item, liveProduct, onOpenPhoto }) {
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (liveProduct || !item.productId) return undefined;
    let alive = true;
    fetchProductPhoto(item.productId).then((p) => { if (alive) setFetched(p); }).catch(() => {});
    return () => { alive = false; };
  }, [item.productId, liveProduct]);
  const product = liveProduct || fetched;
  const full = primaryPhotoUrl(product);
  const open = full && onOpenPhoto ? () => onOpenPhoto([full]) : null;

  return (
    <div data-testid="layby-item" style={{ display:"flex", alignItems:"center", gap:12, minWidth:0 }}>
      <button type="button" onClick={open || undefined} disabled={!open} aria-label={open ? `Show ${item.name || "product"} photo full screen` : "No photo"}
              style={{ width:LAYBY_PHOTO_PX, height:LAYBY_PHOTO_PX, flexShrink:0, padding:0, border:"1px solid rgba(255,255,255,.12)", borderRadius:12, overflow:"hidden",
                       background:"rgba(255,255,255,.92)", cursor: open ? "zoom-in" : "default", display:"flex", alignItems:"center", justifyContent:"center" }}>
        {product ? (
          <PrimaryPhoto product={product} productId={item.productId} size="thumb" alt={item.name || ""}
                        style={{ width:"100%", height:"100%", objectFit:"contain" }} fallback={<ShoeGlyph/>}/>
        ) : <ShoeGlyph/>}
      </button>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:11, fontWeight:700, color:MUTED, letterSpacing:".12em", textTransform:"uppercase" }}>Size</div>
        <div data-testid="layby-item-size" style={{ fontSize:30, fontWeight:900, color:"#fff", lineHeight:1.05 }}>{item.size || "—"}</div>
        <div style={{ fontSize:12.5, color:"rgba(255,255,255,.7)", marginTop:3, overflow:"hidden", textOverflow:"ellipsis", display:"-webkit-box", WebkitLineClamp:2, WebkitBoxOrient:"vertical", wordBreak:"break-word" }}>
          {item.name || "—"}{item.qty > 1 ? ` ×${item.qty}` : ""}
        </div>
      </div>
    </div>
  );
}

export default function LaybyItemPhotos({ saleId, productsById, onOpenPhoto }) {
  const [items, setItems] = useState(null); // null = loading
  useEffect(() => {
    let alive = true;
    setItems(null);
    fetchLaybyItems(saleId).then((it) => { if (alive) setItems(it); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [saleId]);

  if (items && items.length === 0) return null; // nothing knowable — the card stands as it was
  return (
    <div data-testid="layby-items" style={{ marginTop:12, display:"flex", flexDirection:"column", gap:10 }}>
      {items == null ? (
        <div style={{ width:LAYBY_PHOTO_PX, height:LAYBY_PHOTO_PX, borderRadius:12, background:"rgba(255,255,255,.06)" }}/>
      ) : items.map((it) => (
        <ItemRow key={it.lineId} item={it} liveProduct={(it.productId && productsById?.[it.productId]) || null} onOpenPhoto={onOpenPhoto}/>
      ))}
    </div>
  );
}
