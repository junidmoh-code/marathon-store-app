// ── THE SCHEDULE THE PLIST DECLARES *IS* THE SCHEDULE THE APP PROMISES ───────
// The launchd agent's own header says "KEEP IN SYNC with SLOT_DAYS +
// SLOT_HOUR_SAST", and SOCIAL-SETUP.md §5 told the reader that "a test pins the
// plist and the code to the same days and hour, so they cannot drift apart
// silently."
//
// That test did not exist. Both files asserted a guarantee nothing enforced,
// which is worse than no guarantee: a reader who trusts it stops checking.
// This is that test.
//
// ── WHY DRIFT HERE IS INVISIBLE ──────────────────────────────────────────────
// The two halves fail in opposite directions and neither one raises an error.
// The generator writes scheduledAt from SLOT_DAYS/SLOT_HOUR_SAST and the queue
// shows Junid those slots; launchd fires on what the PLIST says. Move one and
// approved posts simply sit "due" until the next agent fire — late, never lost,
// and completely silent. Nothing throws, no log line is written, and the queue
// looks right the whole time.
//
// ── WHY THE INTERPRETER IS PINNED TOO ────────────────────────────────────────
// The plist named /usr/local/bin/node until PR #421. That is the Intel-era
// Homebrew path and it does not exist on this Apple-silicon Mac mini. launchd
// resolves ProgramArguments[0] ITSELF and never consults PATH — not the login
// shell's, and not the PATH set inside the plist — so every fire would have
// died before node started while `launchctl print` went on reporting the job
// loaded. Exactly the silent failure above, from a different cause.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { SLOT_DAYS, SLOT_HOUR_SAST, STORY_HOUR_SAST, STORY_MINUTE_SAST } from "../../src/components/social/socialCore.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PLIST_RAW = read("./com.marathon.socialpublish.plist");
const INSTALLER_RAW = read("./install-on-mac-mini.sh");

// The plist opens with a long <!-- --> header that discusses the very things
// asserted below — it names the Intel-era node path it no longer uses, and it
// quotes the reconciler's checkout path. A bare `toContain` on the raw file is
// therefore satisfied by the PROSE, so someone could repoint the real
// WorkingDirectory and leave the comment, and the test would stay green.
const PLIST = PLIST_RAW.replace(/<!--[\s\S]*?-->/g, "");

// ── ASSERT AGAINST CODE, NOT PROSE ───────────────────────────────────────────
// Both of these files are heavily commented, and the comments discuss the very
// things being asserted — the installer's header explains what RunAtLoad true
// would do, and the plist's header names the Intel-era node path it no longer
// uses. Matching the raw text therefore passes on the EXPLANATION of a guard
// that has been deleted.
//
// That is not hypothetical: an earlier version of this file asserted
// /RunAtLoad.*false/ against the raw installer, and removing the actual guard
// left all eleven tests green. A test that survives the deletion of the thing
// it tests is worse than no test. So the shell is stripped to its code lines
// before anything is asserted about it.
//
// Only whole-line comments are stripped. A '#' inside a string or a path is
// left alone, because guessing at shell quoting would trade this false pass for
// a false failure.
const INSTALLER = INSTALLER_RAW.split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

// A deliberately small plist reader rather than a dependency. It reads the ONE
// shape this file uses — <key>K</key><integer>N</integer> inside <dict>s in an
// <array> — and would rather find nothing than guess, so a reformat that breaks
// it fails the test instead of quietly matching zero entries (every assertion
// below checks the count first).
function calendarEntries(xml) {
  const block = xml.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return [];
  return [...block[1].matchAll(/<dict>([\s\S]*?)<\/dict>/g)].map(([, d]) => {
    const num = (k) => {
      const m = d.match(new RegExp(`<key>${k}</key>\\s*<integer>(-?\\d+)</integer>`));
      return m ? Number(m[1]) : undefined;
    };
    return { Weekday: num("Weekday"), Hour: num("Hour"), Minute: num("Minute") };
  });
}

describe("the launchd schedule matches the slots the app promises", () => {
  const entries = calendarEntries(PLIST);
  const postEntries  = entries.filter((e) => e.Hour === SLOT_HOUR_SAST);
  const storyEntries = entries.filter((e) => e.Hour === STORY_HOUR_SAST);

  it("declares a feed-post entry on every slot day", () => {
    expect(postEntries.length).toBe(SLOT_DAYS.length);
  });

  it("declares a story entry on every slot day", () => {
    expect(storyEntries.length).toBe(SLOT_DAYS.length);
  });

  it("has no calendar entry that is neither the post nor the story hour", () => {
    // Guards against a stray leftover from an older cadence surviving an edit.
    expect(entries.length).toBe(postEntries.length + storyEntries.length);
  });

  it("fires on exactly SLOT_DAYS — no extra day, no missing day", () => {
    for (const [label, set] of [["post", postEntries], ["story", storyEntries]]) {
      const weekdays = set.map((e) => e.Weekday).sort((a, b) => a - b);
      expect(weekdays, label).toEqual([...SLOT_DAYS].sort((a, b) => a - b));
    }
  });

  it("puts the post and the story at DIFFERENT times, so they never fire together", () => {
    // Owner spec: keep them apart. Same hour would spend two placements on one
    // moment, which is the whole reason there are two of them.
    expect(STORY_HOUR_SAST).not.toBe(SLOT_HOUR_SAST);
  });

  it("fires at the declared hour and minute, every day it fires", () => {
    for (const e of postEntries) {
      expect(e.Hour, `post Weekday ${e.Weekday}`).toBe(SLOT_HOUR_SAST);
      // Minute must be EXPLICIT. launchd treats an omitted field as a wildcard,
      // so a dict with Hour but no Minute fires all sixty minutes of that hour.
      expect(e.Minute, `post Weekday ${e.Weekday} has no explicit Minute`).toBe(0);
    }
    for (const e of storyEntries) {
      expect(e.Hour, `story Weekday ${e.Weekday}`).toBe(STORY_HOUR_SAST);
      expect(e.Minute, `story Weekday ${e.Weekday}`).toBe(STORY_MINUTE_SAST);
    }
  });
});

describe("loading the agent cannot publish", () => {
  it("RunAtLoad is false", () => {
    // Whitespace-tolerant: the plist is hand-formatted, and a reflow must not
    // silently turn this into "key not found".
    expect(PLIST).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(PLIST).not.toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it("the installer refuses to install a plist that would fire on load", () => {
    // The guard is a grep for the literal plist line. Asserted precisely
    // (not /RunAtLoad.*false/) so that deleting it fails this test — the
    // installer says "REFUSING to install" in four other places, so a loose
    // match for that phrase proves nothing about THIS guard.
    expect(INSTALLER).toMatch(/grep -qE\s+"<key>RunAtLoad<\/key>\[\[:space:\]\]\*<false\/>"/);

    // And the failure branch must EXIT. This check once only printed a red
    // line and then bootstrapped the agent anyway, which is precisely the
    // outcome it exists to prevent.
    const guard = INSTALLER.slice(INSTALLER.indexOf("RunAtLoad"));
    const branch = guard.slice(0, guard.indexOf("\nfi"));
    expect(branch, "the RunAtLoad guard must exit, not merely warn").toMatch(/exit 2/);
  });
});

describe("the interpreter launchd will actually spawn", () => {
  const program = PLIST.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/)?.[1];

  it("is an absolute path", () => {
    // launchd does not search PATH. A bare "node" here never starts.
    expect(program).toBeTruthy();
    expect(program.startsWith("/")).toBe(true);
  });

  it("is not the Intel-era path that does not exist on this machine", () => {
    expect(program).not.toBe("/usr/local/bin/node");
  });

  it("is the same interpreter the Shopify reconciler's agent names", () => {
    // The two jobs run on one machine; if one of them works, both should.
    expect(program).toBe("/opt/homebrew/bin/node");
  });

  it("the installer resolves node on the machine rather than trusting this constant", () => {
    // The pin above is a default, not the guarantee. The guarantee is that the
    // installer overwrites it with a binary it has proved is executable — which
    // is what keeps this file from having to be right about a machine it has
    // never seen.
    expect(INSTALLER).toMatch(/command -v node/);
    expect(INSTALLER).toMatch(/<string>\/opt\/homebrew\/bin\/node<\/string>/);
    expect(INSTALLER).toMatch(/<string>\/usr\/local\/bin\/node<\/string>/);
  });
});

describe("the two Mac mini jobs can never share a directory", () => {
  it("the installer clones somewhere other than the reconciler's checkout", () => {
    // The reconciler runs from ~/marathon-store-app against the LIVE shop every
    // two minutes. A git operation in that directory mid-run swaps code out
    // from under a process pushing products to Shopify.
    expect(INSTALLER).toMatch(/CLONE="\$HOME\/marathon-social"/);
    expect(INSTALLER).toMatch(/RECONCILER="\$HOME\/marathon-store-app"/);
    expect(INSTALLER).toMatch(/if \[ "\$CLONE" = "\$RECONCILER" \]/);
  });

  it("the committed plist's paths are rewritten rather than used as-is", () => {
    // The committed file points at the RECONCILER's path, on purpose — it is
    // the documented default. What makes that safe is the rewrite, so the
    // rewrite is what gets pinned.
    // Asserted in TAGGED form. The bare path also appears in the plist's header
    // comment, so `toContain` on the raw file would pass even if the real
    // WorkingDirectory were repointed — and the installer's sed would then be
    // rewriting a string that no longer exists, which is exactly the silent
    // drift this block is named for.
    expect(PLIST).toMatch(/<string>\/Users\/marathonclub\/marathon-store-app<\/string>/);
    expect(PLIST).toMatch(/<key>WorkingDirectory<\/key>\s*<string>\/Users\/marathonclub\/marathon-store-app<\/string>/);
    expect(INSTALLER).toMatch(/s#\/Users\/marathonclub\/marathon-store-app#\$CLONE#g/);
  });
});
