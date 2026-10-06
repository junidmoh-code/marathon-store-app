#!/usr/bin/env node
// Copies the shared body of src/utils/networkRegistry.js into the functions
// copy and (when the sibling worktree is present) the POS copy. The store-app
// file is the one to edit; run this after. `--check` writes nothing and exits
// 1 if a copy has drifted.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BEGIN = "// ── BEGIN SHARED BODY";
const END = "// ── END SHARED BODY";

export function sharedBody(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b < 0 || e < 0) throw new Error("shared body markers not found");
  return text.slice(b, text.indexOf("\n", e) + 1);
}

function replaceBody(text, body) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf("\n", text.indexOf(END)) + 1;
  return text.slice(0, b) + body + text.slice(e);
}

const source = readFileSync(join(root, "src/utils/networkRegistry.js"), "utf8");
const body = sharedBody(source);
const posArg = process.argv.find((a) => a.startsWith("--pos="));
const targets = [
  join(root, "functions/lib/network-registry.cjs"),
  posArg ? join(posArg.slice(6), "src/shared/networkRegistry.js") : null,
].filter(Boolean);

let drift = false;
for (const t of targets) {
  if (!existsSync(t)) { console.error(`missing: ${t}`); drift = true; continue; }
  const cur = readFileSync(t, "utf8");
  if (sharedBody(cur) === body) continue;
  drift = true;
  if (!process.argv.includes("--check")) {
    writeFileSync(t, replaceBody(cur, body));
    console.log(`updated ${t}`);
  } else console.error(`drifted: ${t}`);
}
if (process.argv.includes("--check") && drift) process.exit(1);
