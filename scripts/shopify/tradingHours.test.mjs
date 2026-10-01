// The reconciler's trading-hours schedule (tradingHours.mjs), and the runner
// actually obeying it.
import { describe, test, expect } from "vitest";
import { tickDecision } from "./tradingHours.mjs";

// SAST = UTC+2.
const at = (sastHHMM, date = "2026-09-23") => Date.parse(`${date}T${sastHHMM}:00+02:00`);

describe("the reconciler works 07:00–19:00 SAST", () => {
  test("every tick in trading hours runs, 07:00 and 19:00 included", () => {
    for (const t of ["07:00", "09:14", "12:00", "18:58", "19:00"]) {
      expect(tickDecision({ now: at(t) })).toMatchObject({ run: true, why: "trading-hours" });
    }
  });

  test("outside them it does not — evening and small hours", () => {
    for (const t of ["19:04", "21:00", "23:58", "00:00", "03:30", "06:28"]) {
      expect(tickDecision({ now: at(t) }).run).toBe(false);
    }
  });

  test("ONE catch-up run from 06:30, then nothing until 07:00", () => {
    const first = tickDecision({ now: at("06:30"), state: {} });
    expect(first).toMatchObject({ run: true, why: "catch-up", catchUpDate: "2026-09-23" });
    const state = { catchUpDate: first.catchUpDate };
    expect(tickDecision({ now: at("06:32"), state }).run).toBe(false);
    expect(tickDecision({ now: at("06:58"), state }).run).toBe(false);
    // …and it is a NEW catch-up the next morning.
    expect(tickDecision({ now: at("06:30", "2026-09-24"), state }).run).toBe(true);
  });

  test("a mini that was off at 06:30 still catches up before opening", () => {
    expect(tickDecision({ now: at("06:52"), state: { catchUpDate: "2026-09-22" } })).toMatchObject({ run: true, why: "catch-up" });
  });

  test("the idle log is one line an hour, not one every two minutes", () => {
    const a = tickDecision({ now: at("22:00"), state: {} });
    expect(a.logIdle).toBe(true);
    const state = { lastIdleLog: a.idleKey };
    expect(tickDecision({ now: at("22:02"), state }).logIdle).toBe(false);
    expect(tickDecision({ now: at("22:58"), state }).logIdle).toBe(false);
    expect(tickDecision({ now: at("23:00"), state }).logIdle).toBe(true);
  });

  test("SHOPIFY_RECONCILE_ALWAYS=1 runs at any hour", () => {
    expect(tickDecision({ now: at("02:00"), env: { SHOPIFY_RECONCILE_ALWAYS: "1" } })).toMatchObject({ run: true, why: "forced" });
  });
});

async function runRunnerAt(sastHHMM) {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, cpSync, readFileSync, existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  // A throwaway repo shape: scripts/shopify/{runner, schedule} and a
  // reconcile.mjs that leaves a mark if it is ever spawned.
  const root = mkdtempSync(join(tmpdir(), "reconcile-tick-"));
  mkdirSync(join(root, "scripts/shopify"), { recursive: true });
  cpSync(join(here, "reconcile-runner.mjs"), join(root, "scripts/shopify/reconcile-runner.mjs"));
  cpSync(join(here, "tradingHours.mjs"), join(root, "scripts/shopify/tradingHours.mjs"));
  writeFileSync(join(root, "scripts/shopify/reconcile.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "SPAWNED"))}, "1"); console.log("nothing to do.");`);
  const pin = join(root, "clock.mjs");
  writeFileSync(pin, `const T=${at(sastHHMM)}; Date.now=()=>T;`);
  const r = spawnSync(process.execPath, ["--import", pin, join(root, "scripts/shopify/reconcile-runner.mjs")], {
    encoding: "utf8", env: { ...process.env, SHOPIFY_RECONCILE_ALWAYS: "" },
  });
  return {
    status: r.status,
    spawned: existsSync(join(root, "SPAWNED")),
    lockLeft: existsSync(join(root, "logs/shopify-reconcile.lock")),
    log: readFileSync(join(root, "logs/shopify-reconcile.log"), "utf8"),
    state: JSON.parse(readFileSync(join(root, "logs/shopify-reconcile.state.json"), "utf8")),
  };
}

// ── The runner itself ────────────────────────────────────────────────────────
// Runs the REAL reconcile-runner.mjs as launchd would, with the clock pinned.
describe("reconcile-runner.mjs obeys the schedule", () => {
  test("at 23:00: exits at once — no lock, no reconcile (so no database read), one idle line", async () => {
    const r = await runRunnerAt("23:00");
    expect(r.status).toBe(0);
    expect(r.spawned).toBe(false);
    expect(r.lockLeft).toBe(false);
    expect(r.log).toMatch(/idle — outside trading hours/);
  });

  test("at 10:00: runs the reconcile exactly as before", async () => {
    const r = await runRunnerAt("10:00");
    expect(r.status).toBe(0);
    expect(r.spawned).toBe(true);
    expect(r.lockLeft).toBe(false);
    expect(r.log).toMatch(/tick — no unapplied intent/);
  });

  test("at 06:30: the catch-up runs and says so", async () => {
    const r = await runRunnerAt("06:30");
    expect(r.spawned).toBe(true);
    expect(r.log).toMatch(/06:30 catch-up/);
    // …and the run's own bookkeeping did not erase the marker that makes it
    // ONE catch-up — else every tick until 07:00 would be another.
    expect(r.state).toMatchObject({ catchUpDate: "2026-09-23", consecutiveFailures: 0 });
  });
});
