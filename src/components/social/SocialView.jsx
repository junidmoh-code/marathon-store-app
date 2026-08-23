// ─── SOCIAL — THE FULL-PAGE TAB ──────────────────────────────────────────────
// One place where every piece of generated content waits for Junid. A home-row
// entry opens THIS page; three tabs sit under one sticky header:
//
//   Queue          the approval queue (Part 1) — the point of the whole thing
//   Style library  photos and videos he likes, feeding the generator (Part 2)
//   Generate       pick a post type, produce the post (Part 3)
//
// Chrome is copied from ShopifyPublishView, not invented: the same top bar,
// the same sticky filter row, the same stock/ui.js tokens, the same
// separator-list rows. NO MODALS — an expanded row edits in place, exactly as
// the publishing product page does.
//
// ── WHAT THIS SCREEN CAN AND CANNOT DO ───────────────────────────────────────
// It can approve, edit the caption, change platforms, reschedule and discard.
// It CANNOT post. The browser never talks to Instagram, Facebook or TikTok —
// it cannot hold the tokens, exactly as it cannot hold the Shopify client
// secret. Approving writes `status: "approved"` and stops; the Mac mini
// publisher (scripts/social/publish.mjs, launchd, alongside the Shopify
// reconciler) is what sends, and it re-checks approval itself at the moment of
// sending.
//
// ── LOAD DISCIPLINE ──────────────────────────────────────────────────────────
// Posts are read one bounded indexed query per status; the style library pages
// newest-first and lazily; every thumbnail is loading="lazy" and a video
// reference shows its captured poster frame, never a <video src>. See
// socialStore.js for the read contract this screen is built to.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FONT, GRAY, GREEN, RED, AMBER, BLUE_L, GLASS, tabOn, tabOff, input as inputStyle, bBlue, bGray, bGreen, bRed } from "../stock/ui";
import {
  PLATFORMS, PLATFORM_KEYS, QUEUE_FILTERS, CAPTION_MAX,
  postKind, platform, enabledPlatforms, postBlocker, postReadiness, describePost, resultLine,
  formatSlot, toLocalInput, fromLocalInput, captionFor, needsVerification,
} from "./socialCore";
import {
  loadPostsByStatus, loadDraftCount, approvePost, unapprovePost, discardPost, retryPost,
  editCaption, reschedulePost, setPlatforms, resolveSending,
} from "./socialStore";
import StyleLibraryCard from "./StyleLibraryCard";
import GenerateCard from "./GenerateCard";

const TABS = [
  { key: "queue", label: "Queue" },
  { key: "library", label: "Style library" },
  { key: "generate", label: "Generate" },
];

const STATUS_BADGE = {
  draft: { label: "waiting for you", color: AMBER, border: "rgba(251,191,36,.55)" },
  approved: { label: "approved", color: GREEN, border: "rgba(74,222,128,.7)" },
  posting: { label: "posting…", color: BLUE_L, border: "rgba(74,127,255,.5)" },
  posted: { label: "posted", color: GREEN, border: "rgba(74,222,128,.8)" },
  failed: { label: "failed", color: RED, border: "rgba(248,113,113,.6)" },
  discarded: { label: "discarded", color: GRAY, border: "rgba(255,255,255,.18)" },
};

function StatusChip({ status }) {
  const b = STATUS_BADGE[status] || STATUS_BADGE.draft;
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, color: b.color, border: `1px solid ${b.border}`,
                   borderRadius: 8, padding: "3px 7px", whiteSpace: "nowrap", flexShrink: 0 }}>
      {b.label.toUpperCase()}
    </span>
  );
}

// A post's cover. Videos show their poster frame if the generator or the
// uploader captured one; if not, a plain marker — NEVER a <video src>, which
// would have the row fetch a media body to render a 56px square.
function Cover({ media }) {
  const first = (media || [])[0];
  const src = first && (first.thumbUrl || (first.type === "image" ? first.url : null));
  const box = {
    width: 56, height: 70, borderRadius: 8, flexShrink: 0,
    background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.1)",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 9, color: GRAY, overflow: "hidden",
  };
  if (!src) return <div style={box}>{first?.type === "video" ? "VIDEO" : "—"}</div>;
  return (
    <div style={box}>
      <img src={src} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </div>
  );
}

// ── ONE QUEUE ROW ────────────────────────────────────────────────────────────
// Collapsed: cover, kind, platforms, schedule, status. Expanded: the caption in
// an editable box, the platform switches, the date, the per-platform result
// lines, and the decisions. Editing happens IN THE ROW — no modal, matching the
// Shopify product page's treatment.
function PostRow({ post, onChanged, onNotice }) {
  const [open, setOpen] = useState(false);
  const [draftCaption, setDraftCaption] = useState(null);
  const [schedDraft, setSchedDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const kind = postKind(post.kind);
  // What stops this from being SENT (the status line), and separately what stops
  // it from being APPROVED. Not the same question: a draft is by definition not
  // approved, so gating Approve on postBlocker greyed the button forever and gave
  // "Not approved yet" as the reason it could not be approved.
  const blocker = postBlocker(post);
  const notReady = postReadiness(post);
  const caption = draftCaption !== null ? draftCaption : (post.caption || "");
  const captionDirty = draftCaption !== null && draftCaption.trim() !== (post.caption || "").trim();

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      const res = await fn();
      if (res && res.ok === false) onNotice({ kind: "err", text: res.message });
      else {
        if (okMsg) onNotice({ kind: "ok", text: okMsg });
        await onChanged();
      }
    } finally { setBusy(false); }
  };

  return (
    <div style={{ borderBottom: "1px solid rgba(255,255,255,.06)", padding: "12px 2px" }}>
      <div onClick={() => setOpen((o) => !o)}
           style={{ display: "flex", gap: 11, alignItems: "flex-start", cursor: "pointer" }}>
        <Cover media={post.media} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{kind ? kind.label : post.kind}</span>
            <StatusChip status={post.status} />
          </div>
          <div style={{ fontSize: 11.5, color: GRAY, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {(post.caption || "").replace(/\s+/g, " ").slice(0, 90) || "no caption"}
          </div>
          <div style={{ fontSize: 10.5, color: GRAY, marginTop: 4 }}>
            {enabledPlatforms(post).map((k) => platform(k).label).join(" · ") || "no platform"}
            {" · "}
            {formatSlot(post.scheduledAt)}
          </div>
        </div>
        <span style={{ fontSize: 12, color: GRAY, flexShrink: 0 }}>{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div style={{ paddingLeft: 67, paddingTop: 10 }}>
          {/* ── The media strip. Read-only here: a generated frame is discarded
              by discarding the post, not by quietly editing its contents. ── */}
          {(post.media || []).length > 1 && (
            <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
              {post.media.map((m, i) => (
                <Cover key={i} media={[m]} />
              ))}
            </div>
          )}

          <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700, marginBottom: 5 }}>
            Caption
          </div>
          <textarea
            value={caption}
            maxLength={CAPTION_MAX}
            onChange={(e) => setDraftCaption(e.target.value)}
            rows={5}
            style={{ ...inputStyle, width: "100%", boxSizing: "border-box", resize: "vertical", lineHeight: 1.45, fontSize: "0.85rem" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 5, gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10.5, color: GRAY }}>{caption.length}/{CAPTION_MAX}</span>
            {captionDirty && (
              <div style={{ display: "flex", gap: 6 }}>
                <button disabled={busy} onClick={() => setDraftCaption(null)} style={{ ...bGray, padding: "6px 11px", fontSize: "0.75rem" }}>Cancel</button>
                <button disabled={busy}
                        onClick={() => run(() => editCaption(post.id, draftCaption).then((r) => { if (r.ok) setDraftCaption(null); return r; }), "Caption saved.")}
                        style={{ ...bBlue, padding: "6px 11px", fontSize: "0.75rem" }}>Save caption</button>
              </div>
            )}
          </div>

          {post.link && (
            <div style={{ fontSize: 11, color: BLUE_L, marginTop: 8, wordBreak: "break-all" }}>{post.link}</div>
          )}

          {/* ── Platforms ── */}
          <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700, margin: "14px 0 6px" }}>
            Going to
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PLATFORMS.map((p) => {
              const on = post.platforms?.[p.key] === true;
              return (
                <button key={p.key} disabled={busy}
                        onClick={() => run(() => setPlatforms(post.id, { ...post.platforms, [p.key]: !on }))}
                        style={{ ...(on ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.74rem" }}>
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* ── Schedule ── */}
          <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700, margin: "14px 0 6px" }}>
            Scheduled for
          </div>
          {/* ── WRITES ON COMMIT, NOT ON KEYSTROKE ────────────────────────
              A datetime-local fires change on every edited segment, so writing
              from onChange sent a database write per keystroke — and, worse,
              wrote whatever half-typed date existed in between. Typing the year
              passes through "0002", which parses to 1902 and is refused, so the
              reviewer got an error toast while still typing a perfectly valid
              date. The draft is local until blur or Enter. ── */}
          <input
            type="datetime-local"
            value={schedDraft !== null ? schedDraft : toLocalInput(post.scheduledAt)}
            disabled={busy}
            onChange={(e) => setSchedDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            onBlur={() => {
              if (schedDraft === null) return;
              const ms = fromLocalInput(schedDraft);
              setSchedDraft(null);
              if (ms === null) { onNotice({ kind: "err", text: "That is not a valid date and time." }); return; }
              if (ms === Number(post.scheduledAt)) return;   // nothing changed
              run(() => reschedulePost(post.id, ms), "Rescheduled.");
            }}
            style={{ ...inputStyle, fontSize: "0.82rem", colorScheme: "dark" }}
          />
          <div style={{ fontSize: 10.5, color: GRAY, marginTop: 4 }}>
            South African time. An approved post with no date goes out on the next run.
          </div>

          {/* ── What each platform did ── */}
          {post.results && Object.keys(post.results).length > 0 && (
            <>
              <div style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: GRAY, fontWeight: 700, margin: "14px 0 6px" }}>
                Send results
              </div>
              {PLATFORM_KEYS.filter((k) => post.results[k]).map((k) => {
                const state = post.results[k].state;
                const unconfirmed = needsVerification(post, k);
                return (
                  <div key={k} style={{ marginBottom: unconfirmed ? 9 : 3 }}>
                    <div style={{ fontSize: 11.5, color: state === "ok" ? GREEN : state === "skipped" ? GRAY : RED }}>
                      <strong>{platform(k).label}</strong> — {resultLine(post, k)}
                      {post.results[k].permalink && (
                        <> · <a href={post.results[k].permalink} target="_blank" rel="noopener noreferrer"
                               style={{ color: BLUE_L }}>open</a></>
                      )}
                    </div>
                    {/* ── THE ANSWER ONLY A PERSON HAS ────────────────────
                        We asked the platform to publish and never heard back.
                        The publisher will not guess — guessing wrong posts
                        twice — so it holds the item and asks here. Without
                        this control the held state was a dead end. ── */}
                    {unconfirmed && (
                      <div style={{ marginTop: 5, paddingLeft: 2 }}>
                        <div style={{ fontSize: 11, color: AMBER, marginBottom: 5, lineHeight: 1.45 }}>
                          Open {platform(k).label} and look. Is this post there?
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button disabled={busy}
                                  onClick={() => run(() => resolveSending(post.id, k, true), "Marked as posted — it will not be sent again.")}
                                  style={{ ...bGreen, padding: "6px 11px", fontSize: "0.75rem" }}>
                            Yes, it posted
                          </button>
                          <button disabled={busy}
                                  onClick={() => run(() => resolveSending(post.id, k, false), "Marked as not posted — it can be tried again.")}
                                  style={{ ...bGray, padding: "6px 11px", fontSize: "0.75rem" }}>
                            No, it didn't
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )}

          {/* ── Decisions ── */}
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 16 }}>
            {post.status === "draft" && (
              <button disabled={busy || !!notReady}
                      onClick={() => run(() => approvePost(post.id), "Approved — it goes out on its scheduled run.")}
                      style={{ ...bGreen, opacity: blocker ? 0.45 : 1, cursor: blocker ? "not-allowed" : "pointer" }}>
                Approve
              </button>
            )}
            {post.status === "approved" && (
              <button disabled={busy} onClick={() => run(() => unapprovePost(post.id), "Back in the queue — it will not be posted.")}
                      style={bGray}>
                Un-approve
              </button>
            )}
            {post.status === "failed" && (
              <button disabled={busy} onClick={() => run(() => retryPost(post.id, post), "Back in the queue. Anything already posted stays posted.")}
                      style={bBlue}>
                Put back in the queue
              </button>
            )}
            {post.status !== "discarded" && post.status !== "posted" && (
              <button disabled={busy} onClick={() => run(() => discardPost(post.id), "Discarded.")} style={bRed}>
                Throw away
              </button>
            )}
          </div>
          {notReady && post.status === "draft" && (
            <div style={{ fontSize: 11.5, color: AMBER, marginTop: 8 }}>Can't approve yet — {notReady}</div>
          )}

          {/* ── EXACTLY WHAT WILL BE SENT ───────────────────────────────────
              The queue stores one caption; each platform receives it shaped to
              its own fields (TikTok splits a 150-char title off the front).
              Showing it here means the difference is never a surprise after
              the fact. ── */}
          {enabledPlatforms(post).includes("tiktok") && (
            <div style={{ marginTop: 12, fontSize: 11, color: GRAY, lineHeight: 1.5 }}>
              <strong style={{ color: "#dfe7ff" }}>TikTok title:</strong> {captionFor(post, "tiktok").title || "—"}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: GRAY, marginTop: 10 }}>
            {describePost(post)} · created {formatSlot(post.createdAt)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── THE QUEUE ────────────────────────────────────────────────────────────────
function Queue({ notice, onNotice }) {
  const [filter, setFilter] = useState("draft");
  const [posts, setPosts] = useState(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(null);
  // ONE count is fetched: how many are waiting for Junid. Every other chip
  // shows a number only while it is selected, from the posts the page has
  // already loaded — see loadDraftCount in the store for why counting all five
  // meant downloading a thousand post bodies to render five small numbers.
  const [draftCount, setDraftCount] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { posts: p, truncated: t } = await loadPostsByStatus(filter);
      setPosts(p);
      setTruncated(t);
    } catch (err) {
      setPosts([]);
      setError(String(err?.message || err));
    }
  }, [filter]);

  const loadCounts = useCallback(async () => {
    try { setDraftCount((await loadDraftCount()).count); } catch { setDraftCount(null); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  const onChanged = useCallback(async () => { await load(); await loadCounts(); }, [load, loadCounts]);

  // The number on a chip: the fetched draft count, or — for whichever filter is
  // selected — the length of what is already on screen. Never a fetch.
  const countFor = (key) => {
    if (key === "draft") return draftCount;
    return key === filter && posts ? posts.length : null;
  };

  return (
    <div style={{ padding: "6px 14px 0" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        {QUEUE_FILTERS.map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)}
                  style={{ ...(filter === key ? tabOn : tabOff), padding: "6px 12px", fontSize: "0.74rem" }}>
            {label}{countFor(key) ? ` ${countFor(key)}` : ""}
          </button>
        ))}
      </div>

      {notice && (
        <div style={{ fontSize: 12, fontWeight: 700, padding: "8px 2px", color: notice.kind === "err" ? RED : GREEN }}>
          {notice.text}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: RED, fontWeight: 700, padding: "12px 2px", lineHeight: 1.5 }}>
          Couldn't load the queue: {error}
          <div style={{ color: GRAY, fontWeight: 400, marginTop: 6 }}>
            If this says permission denied, the /social_posts console rule has not been
            pasted yet — run <code>node scripts/social/print-social-rules.mjs</code>.
          </div>
        </div>
      )}
      {!error && posts === null && <div style={{ fontSize: 12, color: GRAY, padding: "12px 2px" }}>Loading…</div>}
      {!error && posts && posts.length === 0 && (
        <div style={{ fontSize: 12.5, color: GRAY, padding: "18px 2px", lineHeight: 1.6 }}>
          Nothing here.{filter === "draft" ? " Generate some posts and they'll queue up for you." : ""}
        </div>
      )}
      {posts && posts.map((p) => (
        <PostRow key={p.id} post={p} onChanged={onChanged} onNotice={onNotice} />
      ))}
      {truncated && (
        <div style={{ fontSize: 11, color: AMBER, padding: "12px 2px" }}>
          Showing the most recent {posts.length} — there are more in this state.
        </div>
      )}
    </div>
  );
}

export default function SocialView({ products = [], onExit }) {
  const [tab, setTab] = useState("queue");
  const [notice, setNotice] = useState(null);
  const onNotice = useCallback((n) => {
    setNotice(n);
    if (n && n.kind === "ok") setTimeout(() => setNotice((cur) => (cur === n ? null : cur)), 4000);
  }, []);

  return (
    <div style={{ minHeight: "100vh", background: "#000", color: "#fff", fontFamily: FONT, maxWidth: 880, margin: "0 auto", overflowX: "hidden", paddingBottom: 40 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "50px 14px 12px" }}>
        <div onClick={onExit}
             style={{ background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 10, padding: "8px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <span style={{ fontSize: 12, color: "rgba(255,255,255,.7)" }}>← Switch View</span>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.4)", letterSpacing: "0.5px" }}>Viewing as:</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#4A7FFF", letterSpacing: "0.5px" }}>SOCIAL</div>
        </div>
        <div style={{ width: 92 }} />
      </div>

      <div style={{ position: "sticky", top: 0, zIndex: 20, background: "#000", padding: "10px 14px 12px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {TABS.map(({ key, label }) => (
            <button key={key} onClick={() => setTab(key)}
                    style={{ ...(tab === key ? tabOn : tabOff), padding: "7px 14px", fontSize: "0.78rem" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "queue" && <Queue notice={notice} onNotice={onNotice} />}
      {tab === "library" && <StyleLibraryCard onNotice={onNotice} notice={notice} />}
      {tab === "generate" && <GenerateCard products={products} onNotice={onNotice} notice={notice} onGenerated={() => setTab("queue")} />}
    </div>
  );
}
