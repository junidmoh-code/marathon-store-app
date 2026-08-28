// ─── THE ALBUM ───────────────────────────────────────────────────────────────
// Every picture the generator has ever made, in one place, for ever.
//
// ── WHY IT IS NOT JUST THE QUEUE WITH A FILTER ───────────────────────────────
// /social_posts is a queue: things enter it, get approved or discarded, get
// posted, and stop being interesting. A picture does not stop being
// interesting. Each one cost real money to generate and is reusable in an ad,
// an email, a print, a catalogue page — long after the post it was made for is
// irrelevant. So the pictures live in their OWN node, /social_library, which
// the generator appends to and nothing deletes from. Discarding a post leaves
// its picture right here.
//
// ── FITS ─────────────────────────────────────────────────────────────────────
// The generator already records which products are in each frame, so a picture
// holding more than one product is a FIT and can be priced as one. Tapping it
// lists the garments with today's prices and adds them up.
//
// The total is resolved LIVE from /products, never stored. An album that
// cached a price would keep showing August's number in December, next to a
// photograph, which is the most convincing way to be wrong. Where an item can
// no longer be resolved it is named as missing and left OUT of the total — a
// sum that quietly drops a line is worse than one that admits it is partial.
import React, { useEffect, useMemo, useState } from "react";
import { FONT, GRAY, GREEN, AMBER, BLUE_L, GLASS, tabOn, tabOff, bGray } from "../stock/ui";
import RowBoundary from "./RowBoundary";
import { loadAlbum } from "./socialStore";
import { albumList, isFit, resolveFit, formatRand } from "./socialAlbum";

const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "fits", label: "Full fits" },
  { key: "reels", label: "Reels" },
];

export default function AlbumCard({ products = [], onNotice }) {
  const [raw, setRaw] = useState(null);
  const [busy, setBusy] = useState(true);
  const [filter, setFilter] = useState("all");
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await loadAlbum();
      if (!alive) return;
      if (!res.ok && onNotice) onNotice({ tone: "bad", text: res.message || "Could not read the album." });
      setRaw(res.raw || {});
      setBusy(false);
    })();
    return () => { alive = false; };
  }, [onNotice]);

  // One lookup for the whole grid rather than a scan per tile.
  const lookup = useMemo(() => {
    const byId = new Map();
    for (const p of products) {
      if (p && p.id) byId.set(p.id, { name: p.name, price: Number(p.retailPrice), available: true });
    }
    return (pid) => byId.get(pid) || null;
  }, [products]);

  const all = useMemo(() => albumList(raw), [raw]);
  const shown = useMemo(() => {
    if (filter === "fits") return all.filter(isFit);
    if (filter === "reels") return all.filter((e) => e.format === "reel" || e.videoPath);
    return all;
  }, [all, filter]);

  const open = useMemo(() => all.find((e) => e.id === openId) || null, [all, openId]);
  const fit = useMemo(() => (open ? resolveFit(open, lookup) : null), [open, lookup]);

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      onNotice?.({ tone: "good", text: `${what} copied.` });
    } catch {
      onNotice?.({ tone: "bad", text: "Could not copy — long-press the image instead." });
    }
  };

  return (
    <RowBoundary>
      <div style={{ font: FONT, color: "#fff" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          {FILTERS.map((f) => (
            <button key={f.key} onClick={() => setFilter(f.key)}
                    style={{ ...(filter === f.key ? tabOn : tabOff), padding: "6px 12px", fontSize: ".76rem" }}>
              {f.label}
            </button>
          ))}
          <span style={{ color: GRAY, fontSize: ".74rem", marginLeft: "auto" }}>
            {busy ? "reading the album…" : `${shown.length} of ${all.length} picture${all.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {!busy && !all.length && (
          <p style={{ color: GRAY, fontSize: ".8rem", lineHeight: 1.55 }}>
            The album is empty. Every picture the generator makes from now on lands here
            automatically; anything made before that is added by running{" "}
            <code style={{ color: BLUE_L }}>scripts/social/backfill-social-library.mjs --commit</code>.
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(132px, 1fr))", gap: 8 }}>
          {shown.map((e) => {
            const n = e.products.length;
            return (
              <button key={e.id} onClick={() => setOpenId(e.id === openId ? null : e.id)}
                      title={`${e.kind} · ${n} product${n === 1 ? "" : "s"}`}
                      style={{
                        padding: 0, border: e.id === openId ? `1px solid ${BLUE_L}` : "1px solid rgba(255,255,255,.12)",
                        borderRadius: 10, overflow: "hidden", background: GLASS, cursor: "pointer", position: "relative",
                      }}>
                <img src={e.url} alt="" loading="lazy"
                     style={{ width: "100%", aspectRatio: "1/1", objectFit: "cover", display: "block" }} />
                {n > 1 && (
                  <span style={{
                    position: "absolute", left: 6, top: 6, background: "rgba(0,0,0,.66)", color: "#fff",
                    borderRadius: 6, padding: "2px 6px", fontSize: ".64rem", letterSpacing: ".04em",
                  }}>FIT · {n}</span>
                )}
                {(e.format === "reel" || e.videoPath) && (
                  <span style={{
                    position: "absolute", right: 6, top: 6, background: "rgba(0,0,0,.66)", color: AMBER,
                    borderRadius: 6, padding: "2px 6px", fontSize: ".64rem",
                  }}>reel</span>
                )}
              </button>
            );
          })}
        </div>

        {open && fit && (
          <div style={{ marginTop: 14, background: GLASS, border: "1px solid rgba(255,255,255,.12)", borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <img src={open.url} alt="" style={{ width: 200, maxWidth: "42vw", borderRadius: 8, display: "block" }} />
              <div style={{ flex: "1 1 240px", minWidth: 220 }}>
                <div style={{ color: GRAY, fontSize: ".72rem", letterSpacing: ".06em", textTransform: "uppercase" }}>
                  {open.kind}{open.format ? ` · ${open.format}` : ""}
                  {open.createdAt ? ` · ${new Date(open.createdAt).toLocaleDateString("en-ZA")}` : ""}
                </div>

                <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
                  {fit.items.map((i) => (
                    <li key={i.pid} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "4px 0", fontSize: ".8rem" }}>
                      <span style={{ color: GRAY, minWidth: 62, fontSize: ".7rem", textTransform: "uppercase" }}>
                        {i.slot || "item"}
                      </span>
                      <span style={{ flex: 1, color: i.missing ? AMBER : "#fff" }}>
                        {i.missing ? "no longer in the catalogue" : (i.name || i.pid)}
                      </span>
                      <span style={{ color: i.price === null ? AMBER : GREEN }}>
                        {i.price === null ? "no price" : formatRand(i.price)}
                      </span>
                    </li>
                  ))}
                </ul>

                {fit.items.length > 1 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,.12)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: ".92rem" }}>
                      <strong>{fit.complete ? "Full fit" : "Part of the fit"}</strong>
                      <strong style={{ color: fit.complete ? GREEN : AMBER }}>{formatRand(fit.total)}</strong>
                    </div>
                    {!fit.complete && (
                      <p style={{ color: AMBER, fontSize: ".72rem", margin: "6px 0 0", lineHeight: 1.5 }}>
                        {fit.missingCount ? `${fit.missingCount} item${fit.missingCount === 1 ? "" : "s"} no longer in the catalogue. ` : ""}
                        This total covers {fit.pricedCount} of {fit.items.length} items, so it is not the price of the whole look.
                      </p>
                    )}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
                  <button style={{ ...bGray, fontSize: ".76rem" }} onClick={() => copy(open.url, "Image link")}>
                    Copy image link
                  </button>
                  <a href={open.url} target="_blank" rel="noreferrer"
                     style={{ ...bGray, fontSize: ".76rem", textDecoration: "none", display: "inline-block" }}>
                    Open full size
                  </a>
                  <button style={{ ...bGray, fontSize: ".76rem" }} onClick={() => setOpenId(null)}>Close</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </RowBoundary>
  );
}
