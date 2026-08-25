// ─── SOCIAL — THE GENERATE TAB ───────────────────────────────────────────────
// Pick the post types, tap once, and the Cloud Function produces them. Nothing
// it makes is posted: every generated item lands in the Queue tab as a draft,
// which is where this screen sends you when it finishes.
//
// ── THE BUTTON SAYS WHAT IT COSTS ────────────────────────────────────────────
// Every kind carries a real per-post figure, taken from POST_KINDS in
// socialCore.js, which is pinned equal to the function's own copy. A generated
// scene runs on Nano Banana Pro at ~$0.134; "new arrivals" generates nothing at
// all and costs only the caption, which rounds to a twentieth of a cent. The
// running total updates as kinds are ticked, because a tap that spends money
// should never be a surprise.
//
// ── THE PHOTO POLICY IS A SWITCH, AND ITS DEFAULT IS THE BACKDROP ────────────
// Junid's painted backdrop is the default look for ordinary posts. Clean white
// is for advertising and has to be chosen. The switch reads that way round on
// purpose: the safe, normal answer is what you get by not touching anything.
//
// Nothing here regenerates an existing photograph. Every generation writes a
// new Storage object; no product record, publishing set or photo proposal is
// touched.
import React, { useMemo, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../firebase";
import { FONT, GRAY, GREEN, RED, AMBER, BLUE_L, GLASS, tabOn, tabOff, bBlue, bGray } from "../stock/ui";
import { POST_KINDS, PLATFORMS, FORMATS } from "./socialCore";

// The Generate tab's own labels for FORMATS ["feed","story","reel"] — kept
// here rather than in socialCore.js because the wording ("Reel — video, made
// from a still") is a UI decision, not shared vocabulary.
const FORMAT_INFO = {
  feed:  { label: "Feed post", hint: "The square-ish 4:5 card, in the main grid." },
  story: { label: "Story", hint: "Vertical, one item, gone in 24 hours — no caption, everything is on the artwork." },
  reel:  { label: "Reel", hint: "Vertical video. Made from a still here; the video is encoded when it's actually sent." },
};

const generateCall = httpsCallable(functions, "generateSocialPosts");

// A run makes at most four posts — the function's own ceiling, restated so the
// UI cannot offer a tap the function will refuse.
const MAX_KINDS = 4;

// ── IN-FLIGHT GENERATION, HELD OUTSIDE THE COMPONENT ─────────────────────────
// The same lesson AiStudioCard learned the hard way: a ref guards a double TAP
// but not a double MOUNT, and this card lives inside a tab that unmounts when
// Junid switches to the Queue to watch for the result. A module-level flag
// survives that, so a 90-second run cannot be started twice and billed twice.
let runInFlight = false;

const SECTION = {
  fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
  color: GRAY, fontWeight: 700, margin: "16px 0 7px",
};

export default function GenerateCard({ products = [], onNotice, notice, onGenerated }) {
  const [picked, setPicked] = useState(["single"]);
  const [style, setStyle] = useState("house");
  const [format, setFormat] = useState("feed");
  const [platforms, setPlatformSel] = useState({ instagram: true, facebook: true, tiktok: false });
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);

  // "New arrivals" is a carousel of existing photographs — the one kind that
  // is not one composed image, so it cannot be a story (one item, no
  // carousel on the API) or a reel (one video). Offered only for feed.
  const kindChoices = format === "feed" ? POST_KINDS : POST_KINDS.filter((k) => k.key !== "new_arrivals");

  const setFormatChecked = (next) => {
    setFormat(next);
    if (next !== "feed") setPicked((cur) => cur.filter((k) => k !== "new_arrivals"));
  };

  const cost = useMemo(
    () => picked.reduce((s, k) => s + (POST_KINDS.find((p) => p.key === k)?.costUSD || 0), 0),
    [picked]
  );

  const toggleKind = (key) => {
    setPicked((cur) => {
      if (cur.includes(key)) return cur.filter((k) => k !== key);
      if (cur.length >= MAX_KINDS) return cur;
      return [...cur, key];
    });
  };

  const run = async () => {
    if (runInFlight || !picked.length) return;
    runInFlight = true;
    setBusy(true);
    setReport(null);
    try {
      const res = await generateCall({ kinds: picked, style, platforms, format });
      const d = res.data || {};
      setReport(d);
      const made = (d.created || []).length;
      if (made) {
        onNotice({ kind: "ok", text: `Made ${made} post${made === 1 ? "" : "s"} — they're waiting for you in the queue.` });
      } else {
        onNotice({ kind: "err", text: "Nothing could be made — see the reasons below." });
      }
    } catch (err) {
      onNotice({ kind: "err", text: `Generation failed: ${err?.message || err}` });
    } finally {
      runInFlight = false;
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: "12px 14px 0" }}>
      <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.6 }}>
        Everything made here lands in the queue as a draft. Nothing is posted until you approve it.
      </div>

      <div style={SECTION}>Format</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {FORMATS.map((f) => (
          <button key={f} disabled={busy} onClick={() => setFormatChecked(f)}
                  style={{ ...(format === f ? tabOn : tabOff), padding: "7px 13px", fontSize: "0.76rem" }}>
            {FORMAT_INFO[f].label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: GRAY, marginTop: 6, lineHeight: 1.5 }}>
        {FORMAT_INFO[format].hint}
      </div>

      <div style={SECTION}>What to make</div>
      <div style={{ display: "grid", gap: 8 }}>
        {kindChoices.map((k) => {
          const on = picked.includes(k.key);
          return (
            <div key={k.key} onClick={() => !busy && toggleKind(k.key)}
                 style={{ ...GLASS, padding: "11px 13px", cursor: busy ? "default" : "pointer",
                          borderColor: on ? "rgba(74,127,255,.55)" : undefined,
                          background: on ? "rgba(74,127,255,.08)" : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: on ? BLUE_L : "#fff" }}>{k.label}</span>
                <span style={{ fontSize: 11, color: k.generates ? AMBER : GREEN, fontWeight: 700, whiteSpace: "nowrap" }}>
                  {k.generates ? `~$${k.costUSD.toFixed(3)}` : "no image cost"}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3 }}>{k.hint}</div>
            </div>
          );
        })}
      </div>
      {picked.length >= MAX_KINDS && (
        <div style={{ fontSize: 11, color: GRAY, marginTop: 6 }}>Four post types is the most one run makes.</div>
      )}

      <div style={SECTION}>Look</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button disabled={busy} onClick={() => setStyle("house")}
                style={{ ...(style === "house" ? tabOn : tabOff), padding: "7px 13px", fontSize: "0.76rem" }}>
          Our backdrop
        </button>
        <button disabled={busy} onClick={() => setStyle("white")}
                style={{ ...(style === "white" ? tabOn : tabOff), padding: "7px 13px", fontSize: "0.76rem" }}>
          Clean white — advertising
        </button>
      </div>
      <div style={{ fontSize: 11.5, color: GRAY, marginTop: 6, lineHeight: 1.5 }}>
        {style === "house"
          ? "Shot in your painted backdrop, matched from the photos in the Style library and the AI Studio Style Kit."
          : "Plain white studio. This is the advertising look — for an ordinary post, use the backdrop."}
      </div>

      <div style={SECTION}>Propose for</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {PLATFORMS.map((p) => {
          const on = platforms[p.key] === true;
          return (
            <button key={p.key} disabled={busy}
                    onClick={() => setPlatformSel((c) => ({ ...c, [p.key]: !on }))}
                    style={{ ...(on ? tabOn : tabOff), padding: "7px 13px", fontSize: "0.76rem" }}>
              {p.label}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 11.5, color: GRAY, marginTop: 6 }}>
        A starting position only — you change it per post in the queue.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "20px 0 6px" }}>
        <button disabled={busy || !picked.length} onClick={run}
                style={{ ...bBlue, padding: "12px 20px", fontSize: "0.9rem", opacity: busy || !picked.length ? 0.5 : 1 }}>
          {busy ? "Making them…" : `Generate ${picked.length} post${picked.length === 1 ? "" : "s"}`}
        </button>
        <span style={{ fontSize: 12, color: cost > 0 ? AMBER : GREEN, fontWeight: 700 }}>
          about ${cost.toFixed(3)}
        </span>
      </div>
      {busy && (
        <div style={{ fontSize: 11.5, color: GRAY, lineHeight: 1.5 }}>
          A generated scene takes about a minute each. Leave this open — switching tabs is safe,
          the run keeps going.
        </div>
      )}

      {notice && (
        <div style={{ fontSize: 12, fontWeight: 700, padding: "10px 2px", color: notice.kind === "err" ? RED : GREEN }}>
          {notice.text}
        </div>
      )}

      {report && (
        <div style={{ ...GLASS, padding: 13, marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>What happened</div>
          {(report.created || []).map((c) => (
            <div key={c.postId} style={{ fontSize: 11.5, color: GREEN, marginBottom: 3 }}>
              ✓ {c.kind} — {c.products} product{c.products === 1 ? "" : "s"}, ${Number(c.costUSD).toFixed(3)}
              {c.captionSource === "fallback" ? " · plain caption (the caption model was unavailable)" : ""}
              {c.captionSource === "not-needed" ? " · plain caption (a story has nowhere to show one)" : ""}
            </div>
          ))}
          {(report.skipped || []).map((s, i) => (
            <div key={i} style={{ fontSize: 11.5, color: AMBER, marginBottom: 3, lineHeight: 1.5 }}>
              — {s.kind} not made: {s.reason}
            </div>
          ))}
          <div style={{ fontSize: 11, color: GRAY, marginTop: 9, lineHeight: 1.6 }}>
            {report.candidates} product{report.candidates === 1 ? "" : "s"} were eligible (live on the
            storefront, in stock, not posted recently).
            {" "}Sales signal: {report.signal?.source === "unavailable"
              ? "unavailable — ranked on how recently things went live"
              : `${report.signal?.source}${report.signal?.coverage != null ? `, ${(report.signal.coverage * 100).toFixed(0)}% of till sales carry a product id` : ""}`}.
            {" "}Style references sent: {report.styleRefs?.sent ?? 0} of {report.styleRefs?.inLibrary ?? 0} in the library.
          </div>
          {(report.created || []).length > 0 && (
            <button onClick={onGenerated} style={{ ...bGray, marginTop: 11, padding: "8px 14px", fontSize: "0.78rem" }}>
              Go to the queue
            </button>
          )}
        </div>
      )}
    </div>
  );
}
