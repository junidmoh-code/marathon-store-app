// ─── OFFLINE MIRROR — the status dot ─────────────────────────────────────────
//
// One dot, matching the POS's ConnectionDot. It answers, at a glance, the only
// question a person in a shop asks about this: "is what I am looking at
// current?"
//
//   green   connected, every leg healthy, nothing waiting
//   amber   connected, but something is behind — a leg is re-downloading, a
//           change feed page failed, or there are unsent writes
//   grey    the database is not answering. The app still works; what is on
//           screen is this device's copy as of the time shown.
//
// Tapping it shows what each leg holds and when it last synced, which is the
// difference between "I think it's stale" and knowing.
//
// It reads `.info/connected` through the mirror's own tracker — never
// navigator.onLine, which answers "some network exists" rather than "our
// database answers".

import { useEffect, useState } from "react";
import { getOfflineMirrorRuntime } from "./mirrorRuntime";
import { offlineMirrorEnabled, subscribeMirrorSwitch } from "./killSwitch";
import { MIRROR_LEGS } from "./nodes";
import { getLegHealth, vouchingRecord } from "./health";
import { heldPhotoCount } from "./photoCache";
import { pendingCount } from "./pendingWrites";
import { downloadLine } from "./MirrorDownloadGate";

const COLOURS = { ok: "#22c55e", behind: "#f59e0b", offline: "#9ca3af" };

export function mirrorStatus({ connected, legs, pending, download }) {
  // A device whose copy is still coming down is not "behind" in the sense the
  // amber dot usually means — it is working, on live reads, exactly as it
  // always did. It gets the same amber, because the honest answer to "is what
  // I am looking at current" is yes-and-this-device-is-busy, and the panel
  // says which.
  if (download?.downloading) return "behind";
  if (!connected) return "offline";
  if (pending > 0) return "behind";
  if (legs.some((l) => !l.ok)) return "behind";
  return "ok";
}

export function MirrorDot({ style }) {
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);
  // ── IT HAS TO BE ABLE TO APPEAR LATER ────────────────────────────────────
  //
  // This used to read the switch once, on mount, with an empty dependency
  // list. On a device that had never heard the switch — every genuinely new
  // one — that read was false at first paint, so the dot never mounted and
  // the download promised by the gate had no visible evidence anywhere until
  // the next reload. It now watches the switch like everything else does.
  // (Fable-vs-spec review, PR #624.)
  const [on, setOn] = useState(() => offlineMirrorEnabled());
  useEffect(() => subscribeMirrorSwitch(() => setOn(offlineMirrorEnabled())), []);

  useEffect(() => {
    if (!on) return undefined;
    let cancelled = false;
    let timer = null;
    let fastTimer = null;
    let unsub = null;

    const refresh = async (rt) => {
      const legs = [];
      for (const leg of MIRROR_LEGS) {
        const health = await getLegHealth(rt.db, leg.name).catch(() => null);
        const vouched = vouchingRecord(health);
        legs.push({
          name: leg.name,
          ok: health?.ok === true,
          reason: health?.reason ?? null,
          rows: vouched?.rows ?? null,
          at: vouched?.at ?? null,
        });
      }
      const photos = await heldPhotoCount(rt.db).catch(() => null);
      const download = await (rt.downloadProgress?.() ?? null);
      if (cancelled) return;
      setState({
        connected: rt.connection.isConnected(),
        legs, photos, pending: pendingCount(),
        download,
      });
    };

    (async () => {
      const rt = await getOfflineMirrorRuntime();
      if (!rt || cancelled) return;
      unsub = rt.connection.subscribe(() => refresh(rt));
      await refresh(rt);
      // Faster while the copy is coming down — a bar that moves once every
      // twenty seconds reads as a bar that has stopped.
      timer = setInterval(() => refresh(rt), 20_000);
      const fast = setInterval(() => {
        // `cancelled` as well as the download's own end: this interval is
        // assigned AFTER an await, so an unmount that lands in between would
        // leave the cleanup below with nothing to clear.
        if (cancelled || !rt.state?.downloading) clearInterval(fast);
        else refresh(rt);
      }, 3_000);
      fastTimer = fast;
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (fastTimer) clearInterval(fastTimer);
      if (unsub) unsub();
    };
  }, [on]);

  if (!state) return null;
  const status = mirrorStatus(state);
  const behind = state.legs.filter((l) => !l.ok);

  return (
    <span style={{ position: "relative", display: "inline-flex", ...style }}>
      <button
        type="button"
        aria-label={`Offline copy: ${status}`}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: 10, height: 10, borderRadius: 999, border: 0, padding: 0, cursor: "pointer",
          background: COLOURS[status],
        }}
      />
      {open && (
        <div style={panel}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>
            {state.download?.downloading
              ? "Setting this device up"
              : (<>
                {status === "ok" && "Up to date"}
                {status === "behind" && "Catching up"}
                {status === "offline" && "Not connected — showing this device's copy"}
              </>)}
          </div>
          {state.download?.downloading && (
            <div style={line}>{downloadLine(state.download)}</div>
          )}
          {state.pending > 0 && <div style={line}>{state.pending} write(s) still going up</div>}
          {behind.length > 0 && behind.map((l) => (
            <div key={l.name} style={line}>{l.name}: {l.reason ?? "behind"}</div>
          ))}
          <div style={line}>
            {state.legs.reduce((n, l) => n + (l.rows ?? 0), 0).toLocaleString()} records held
          </div>
          {state.photos !== null && <div style={line}>{state.photos.toLocaleString()} pictures held</div>}
        </div>
      )}
    </span>
  );
}

const panel = {
  position: "absolute", top: 18, right: 0, zIndex: 50, minWidth: 220,
  background: "#18181b", color: "#f4f4f5", borderRadius: 10, padding: "10px 12px",
  font: "12.5px/1.5 -apple-system,system-ui,sans-serif", boxShadow: "0 8px 24px rgba(0,0,0,.35)",
};
const line = { color: "#a1a1aa" };
