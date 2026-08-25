// ─── SOCIAL — THE POLICY TAB ──────────────────────────────────────────────────
// How many reels, photos and stories go out a day, and at what time — the
// knobs behind socialDailyAutopilot (functions/index.js), which reads exactly
// this record every morning at 06:00 SAST to build the day's batch. Nothing on
// this screen posts anything itself; it only decides what the unattended run
// will make tomorrow.
//
// ── ONE RECORD, ONE READER ───────────────────────────────────────────────────
// /social_policy is written here and read only by socialDailyAutopilot. A
// missing record is not a broken feature — the function has its own built-in
// defaults, the same ones this screen pre-fills with before anything has ever
// been saved, so the daily rhythm was never depending on this screen existing.
//
// ── TIMES, NOT JUST COUNTS ───────────────────────────────────────────────────
// The count of reels/photos/stories a day is simply how many time slots each
// section has — there is no separate number to keep in sync. Add a time, the
// count goes up; remove one, it goes down.
import React, { useEffect, useMemo, useState } from "react";
import { GRAY, GREEN, RED, BLUE_L, GLASS, bBlue, bGray, bRed, input as inputStyle } from "../stock/ui";
import { loadSocialPolicy, saveSocialPolicy, DEFAULT_POLICY_TIMES } from "./socialStore";
import { asList } from "../../utils/rtdbList";

// A safety ceiling, not a design opinion. socialDailyAutopilot generates
// sequentially and each Gemini call can take up to three minutes — the UI
// cannot let someone fat-finger a number that would blow the function's own
// 30-minute timeout or turn "a few dollars a day" into a real bill by
// accident. Matches MAX_ITEMS_PER_FORMAT / MAX_ITEMS_PER_DAY in
// functions/index.js — kept equal by eye, not by test: the function clamps
// to its own limit regardless, so a drift here is a UI that lets you type a
// number one save then silently trims, not a way to exceed it for real.
const MAX_PER_FORMAT = 6;
const MAX_TOTAL_PER_DAY = 8;

// `singular` is spelled out rather than derived (e.g. stripping a trailing
// "s") because "Stories" does not end in a plain "s" — a regex strip turned
// it into "Storie" on every row of the timeline below.
const SECTIONS = [
  { key: "reels", label: "Reels", singular: "Reel", hint: "A vertical video, made from a still and encoded when it actually sends." },
  { key: "photos", label: "Photos", singular: "Photo", hint: "The ordinary feed post — the square-ish 4:5 card." },
  { key: "stories", label: "Stories", singular: "Story", hint: "Vertical, one item, gone in 24 hours." },
];

const SECTION_TITLE = {
  fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase",
  color: GRAY, fontWeight: 700, margin: "18px 0 7px",
};

/** "08:00" -> "8:00 AM". Falls back to the raw string rather than throwing on
 * anything that isn't a clean HH:mm — a malformed value should be visible and
 * fixable, not hidden behind a crash. */
function formatTime12h(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${period}`;
}

function nextSuggestedTime(times) {
  if (!times.length) return "09:00";
  const last = times[times.length - 1];
  const m = /^(\d{1,2}):(\d{2})$/.exec(last);
  if (!m) return "09:00";
  const h = (Number(m[1]) + 2) % 24;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

export default function PolicyCard({ onNotice, notice }) {
  const [loaded, setLoaded] = useState(false);
  const [reels, setReels] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [stories, setStories] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const setters = { reels: setReels, photos: setPhotos, stories: setStories };
  const values = { reels, photos, stories };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await loadSocialPolicy();
        if (cancelled) return;
        // Nothing has EVER been saved: pre-fill with what the function
        // already runs by default, so the screen never opens looking empty
        // and wrong. This is NOT "all three lists are empty" — a deliberate
        // save of "0 reels, 0 photos, 0 stories" (everything off) is a real
        // saved policy and must come back exactly as saved, not bounce back
        // to the non-zero defaults the moment the tab is reopened.
        const start = p.saved ? p : DEFAULT_POLICY_TIMES;
        setReels(start.reels);
        setPhotos(start.photos);
        setStories(start.stories);
      } catch (err) {
        if (!cancelled) setError(String(err?.message || err));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const total = reels.length + photos.length + stories.length;
  const overTotal = total > MAX_TOTAL_PER_DAY;

  // The timeline: every slot, from every section, in the order they'll
  // actually fire — this answers "what's posting when" without anyone having
  // to add up three separate lists by eye.
  const timeline = useMemo(() => {
    const rows = [];
    for (const s of SECTIONS) {
      for (const t of values[s.key]) rows.push({ time: t, label: s.singular });
    }
    return rows.sort((a, b) => a.time.localeCompare(b.time));
  }, [reels, photos, stories]);

  const addTime = (key) => {
    setters[key]((cur) => (cur.length >= MAX_PER_FORMAT ? cur : [...cur, nextSuggestedTime(cur)]));
  };
  const removeTime = (key, i) => {
    setters[key]((cur) => asList(cur).filter((_, idx) => idx !== i));
  };
  const changeTime = (key, i, val) => {
    setters[key]((cur) => asList(cur).map((t, idx) => (idx === i ? val : t)));
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await saveSocialPolicy({ reels, photos, stories });
      if (res.ok) onNotice({ kind: "ok", text: "Saved — tomorrow's 06:00 SAST run uses this." });
      else onNotice({ kind: "err", text: res.message });
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div style={{ padding: "12px 14px", fontSize: 12.5, color: RED, lineHeight: 1.6 }}>
        Couldn't load the policy: {error}
      </div>
    );
  }
  if (!loaded) {
    return <div style={{ padding: "12px 14px", fontSize: 12, color: GRAY }}>Loading…</div>;
  }

  return (
    <div style={{ padding: "12px 14px 40px" }}>
      <div style={{ fontSize: 12.5, color: GRAY, lineHeight: 1.6 }}>
        This is what runs on its own, every morning at 06:00 SAST — no approval needed, the same
        automated run this queue already fills up from. Change what it makes and when here.
      </div>

      {/* ── Today's timeline ── */}
      <div style={SECTION_TITLE}>Today's timeline</div>
      {timeline.length === 0 ? (
        <div style={{ fontSize: 12.5, color: GRAY, padding: "6px 2px" }}>Nothing scheduled — add a time below.</div>
      ) : (
        <div style={{ ...GLASS, padding: "10px 13px", display: "flex", flexDirection: "column", gap: 6 }}>
          {timeline.map((row, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
              <span style={{ color: BLUE_L, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{formatTime12h(row.time)}</span>
              <span style={{ color: "#dfe7ff" }}>{row.label}</span>
            </div>
          ))}
        </div>
      )}

      {SECTIONS.map((s) => {
        const list = asList(values[s.key]);
        return (
          <React.Fragment key={s.key}>
            <div style={SECTION_TITLE}>{s.label} — {list.length} a day</div>
            <div style={{ fontSize: 11.5, color: GRAY, marginBottom: 8 }}>{s.hint}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {list.map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 7, alignItems: "center" }}>
                  <input
                    type="time"
                    value={t}
                    disabled={busy}
                    onChange={(e) => changeTime(s.key, i, e.target.value)}
                    style={{ ...inputStyle, colorScheme: "dark", flex: "0 0 140px" }}
                  />
                  <button disabled={busy} onClick={() => removeTime(s.key, i)}
                          style={{ ...bRed, padding: "8px 12px", fontSize: "0.78rem" }}>
                    Remove
                  </button>
                </div>
              ))}
              {list.length === 0 && (
                <div style={{ fontSize: 11.5, color: GRAY }}>None today — no {s.label.toLowerCase()} will be made.</div>
              )}
            </div>
            <button disabled={busy || list.length >= MAX_PER_FORMAT} onClick={() => addTime(s.key)}
                    style={{ ...bGray, marginTop: 8, padding: "7px 13px", fontSize: "0.76rem",
                             opacity: list.length >= MAX_PER_FORMAT ? 0.45 : 1 }}>
              + Add a time
            </button>
            {list.length >= MAX_PER_FORMAT && (
              <div style={{ fontSize: 10.5, color: GRAY, marginTop: 5 }}>{MAX_PER_FORMAT} a day is the most one format runs.</div>
            )}
          </React.Fragment>
        );
      })}

      <div style={{ marginTop: 22, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button disabled={busy || overTotal} onClick={save}
                style={{ ...bBlue, padding: "12px 20px", fontSize: "0.9rem", opacity: busy || overTotal ? 0.5 : 1 }}>
          {busy ? "Saving…" : "Save"}
        </button>
        <span style={{ fontSize: 12, color: overTotal ? RED : GREEN, fontWeight: 700 }}>
          {total} post{total === 1 ? "" : "s"} a day
        </span>
      </div>
      {overTotal && (
        <div style={{ fontSize: 11.5, color: RED, marginTop: 8, lineHeight: 1.5 }}>
          {MAX_TOTAL_PER_DAY} a day is the most one unattended run makes — remove a time above to save.
        </div>
      )}

      {notice && (
        <div style={{ fontSize: 12, fontWeight: 700, padding: "12px 2px 0", color: notice.kind === "err" ? RED : GREEN }}>
          {notice.text}
        </div>
      )}
    </div>
  );
}
