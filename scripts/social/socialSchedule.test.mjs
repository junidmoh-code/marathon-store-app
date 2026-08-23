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
import { SLOT_DAYS, SLOT_HOUR_SAST } from "../../src/components/social/socialCore.js";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PLIST = read("./com.marathon.socialpublish.plist");
const INSTALLER_RAW = read("./install-on-mac-mini.sh");

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

  it("declares exactly one calendar entry per slot day", () => {
    // Guards the parser as much as the plist: a zero here would make every
    // assertion below vacuously true.
    expect(entries.length).toBe(SLOT_DAYS.length);
  });

  it("fires on exactly SLOT_DAYS — no extra day, no missing day", () => {
    const weekdays = entries.map((e) => e.Weekday).sort((a, b) => a - b);
    expect(weekdays).toEqual([...SLOT_DAYS].sort((a, b) => a - b));
  });

  it("fires at SLOT_HOUR_SAST on the hour, every day it fires", () => {
    for (const e of entries) {
      expect(e.Hour, `Weekday ${e.Weekday}`).toBe(SLOT_HOUR_SAST);
      // Minute must be EXPLICIT. launchd treats an omitted field as a wildcard,
      // so a dict with Hour but no Minute fires all sixty minutes of that hour
      // — sixty publish attempts, not one.
      expect(e.Minute, `Weekday ${e.Weekday} has no explicit Minute`).toBe(0);
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
    expect(PLIST).toContain("/Users/marathonclub/marathon-store-app");
    expect(INSTALLER).toMatch(/s#\/Users\/marathonclub\/marathon-store-app#\$CLONE#g/);
  });
});
