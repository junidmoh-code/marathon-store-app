// ─── A CARD'S PHOTO: PLACEHOLDER AT ONCE, THEN THE FULL PHOTO ────────────────
//
// The phone/iPad order grid's photo (AssistantPhone → ProductStage tile).
// Never an empty box, and the end state is always the FULL photo (Junid's
// standing rule) — the placeholder is only a stand-in while it loads:
//
//   1. placeholder, on the first render when the device has one:
//        • the tiny blurred picture tilePhotoCache made from this photo before
//          (drawn as an SVG with the photo's own pixel size → same box), or
//        • the offline mirror's 300px thumbnail if this device holds it
//          (blurred; a pure cache read, never a download), or
//        • a soft glass block while nothing is known yet;
//   2. the full photo from memory / Cache Storage (zero network after the
//      first view, offline too) or the network (then kept), decoded off the
//      main thread (img.decode) and faded in over the placeholder;
//   3. when the page may not read the photo (bucket CORS — preview channels)
//      or the cache is off (mirror off): a plain <img src> exactly as before.
//
// decoding="async", fetchpriority="high" on the first rows, eager loading —
// the grid only mounts photos near the screen (AssistantPhone's window).

import { useEffect, useRef, useState } from "react";
import { tilePhotoSrc } from "../assistant/HiResPhoto.jsx";
import { useMirroredPhotoSrc } from "../../offline/useMirroredPhotoSrc";
import { getTile, loadTileIndex, memoTileUrl, onTileIndex, releaseTile, retainTile, tileCacheEnabled, tileIndexNow, tinyFor, tinySvg } from "../../offline/tilePhotoCache";

function decoded(url) {
  if (typeof Image === "undefined") return Promise.resolve();
  const im = new Image();
  im.decoding = "async";
  im.src = url;
  return (im.decode ? im.decode() : Promise.resolve()).catch(() => {});
}

export default function TilePhoto({ p, alt = "", priority = false, fallback = null }) {
  const src = tilePhotoSrc(p);
  const id = p?.id;
  const key = `${id}|${src}`;
  const enabled = tileCacheEnabled();
  // Re-render once the index (and with it the placeholders) has loaded.
  const [, setIdxTick] = useState(0);
  useEffect(() => {
    if (!enabled || tileIndexNow()) return undefined;
    const off = onTileIndex(() => setIdxTick((n) => n + 1));
    loadTileIndex();
    return off;
  }, [enabled]);

  const mem = enabled && src ? memoTileUrl(id, src) : null;
  // { key, url, ready, mode: "cache" | "direct" | "thumb" | "none" }
  const [st, setSt] = useState(() => ({ key, url: mem, ready: !!mem, mode: mem ? "cache" : enabled ? "cache" : "direct" }));
  const cur = st.key === key ? st : { key, url: mem, ready: !!mem, mode: mem ? "cache" : enabled ? "cache" : "direct" };
  if (st.key !== key) setSt(cur);

  // The object URL this card shows is HELD while shown (retainTile), so the
  // in-memory list can never revoke it from under a mounted <img>.
  const held = useRef(null);
  // `owned`: getTile already took this card's ref on the URL.
  const hold = (url, owned = false) => {
    if (held.current && held.current.url === url) { if (owned) releaseTile(id, url); return; }
    if (held.current) releaseTile(held.current.id, held.current.url);
    held.current = url ? { id, url } : null;
    if (url && !owned) retainTile(id, url);
  };
  useEffect(() => () => hold(null), []);   // eslint-disable-line react-hooks/exhaustive-deps
  // Hold what is shown; let go only when the card stops showing a cached photo
  // (a URL taken in the getTile callback stays held through its decode).
  useEffect(() => { if (cur.mode !== "cache") hold(null); else if (cur.url) hold(cur.url); });

  useEffect(() => {
    if (!src || cur.ready || cur.mode !== "cache") return undefined;
    let gone = false;
    getTile(id, src, { priority: priority ? "high" : "auto" }).then(async (url) => {
      if (gone) { if (url) releaseTile(id, url); return; }
      if (!url) { setSt({ key, url: null, ready: false, mode: "direct" }); return; }
      hold(url, true);          // the ref getTile took: held through the decode
      await decoded(url);
      if (!gone) setSt({ key, url, ready: true, mode: "cache" });
    });
    return () => { gone = true; };
  }, [key, cur.mode, cur.ready]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Placeholder sources (no network): the tiny, else a held mirror thumbnail.
  const thumb = useMirroredPhotoSrc(id, src);
  const tiny = enabled && src ? tinyFor(id, src) : null;
  const heldThumb = thumb && thumb !== src ? thumb : null;
  const ph = tiny ? tinySvg(tiny) : heldThumb;

  if (!src) return fallback;
  if (cur.mode === "none") return fallback;
  if (cur.mode === "thumb") {
    return heldThumb ? <img className="tile__full" src={heldThumb} alt={alt} draggable={false} decoding="async" /> : fallback;
  }
  const fullSrc = cur.mode === "direct" ? src : cur.url;
  return (
    <span className="tile" data-tile={cur.ready ? "full" : ph ? "placeholder" : "waiting"}>
      {!cur.ready && (ph
        ? <img className={`tile__ph${tiny ? "" : " tile__ph--blur"}`} data-ph="" src={ph} alt="" aria-hidden="true" draggable={false} decoding="async" />
        : <span className="tile__shim" aria-hidden="true" />)}
      {fullSrc && (
        <img className="tile__full" src={fullSrc} alt={alt} draggable={false} decoding="async" loading="eager"
             fetchpriority={priority ? "high" : undefined}
             style={{ opacity: cur.ready ? 1 : 0 }}
             onLoad={cur.mode === "direct" ? () => setSt({ key, url: null, ready: true, mode: "direct" }) : undefined}
             onError={() => setSt({ key, url: null, ready: false, mode: heldThumb ? "thumb" : "none" })} />
      )}
    </span>
  );
}
