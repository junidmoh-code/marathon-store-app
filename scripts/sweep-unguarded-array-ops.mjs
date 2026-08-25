#!/usr/bin/env node
// ─── SWEEP — UNGUARDED ARRAY OPS ON SNAPSHOT-DERIVED VALUES ──────────────────
// The Social card blanked out to the screen error boundary because ONE line
// called `.some` on a value that was null. Finding the rest of that class by
// reading is not a plan: App.jsx alone is over 18,000 lines. So this walks the
// source and flags every array method invoked directly on an expression that
// is NOT provably a list.
//
// WHAT COUNTS AS GUARDED
//   · the receiver is wrapped:  asList(x).map      (x || []).map
//   · it is a literal or a call that returns one:  [1,2].map   x.filter(...).map
//   · it is a chained array method:  x.map(...).filter(...)
//   · a preceding Array.isArray(x) in the same function body
// Everything else is reported. This is deliberately noisy in the other
// direction — it is a sweep, not a type checker, and a false positive costs a
// glance while a false negative costs the whole screen.
//
// Usage:  node scripts/sweep-unguarded-array-ops.mjs [paths...]
// Exit 1 if anything is reported, so CI or a pre-merge check can use it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// Array-ONLY methods. `includes`, `join`, `slice`, `indexOf` and `concat` are
// deliberately excluded: they exist on String too, so every `text.slice(0, n)`
// in the file would be reported and the real findings would drown. The
// excluded five throw on null exactly as the others do, but a null STRING is a
// different bug from a null LIST and this sweep is about lists.
const ARRAY_METHODS = [
  "some", "every", "map", "filter", "forEach", "reduce", "flatMap", "find",
  "findIndex", "sort", "reverse",
];
const METHOD_RE = new RegExp(`\\.(${ARRAY_METHODS.join("|")})\\s*\\(`, "g");

// Receivers that are never a snapshot value: module constants, React/JS
// builtins, and anything already known to be a list by construction.
const SAFE_RECEIVERS = new Set([
  "Object", "Array", "JSON", "Math", "String", "Number", "React", "console",
  "keys", "entries", "values", "children", "Children", "process", "window",
  "document", "localStorage", "navigator", "performance", "Promise",
]);

function collectFiles(target) {
  const st = statSync(target);
  if (st.isFile()) return [target];
  const out = [];
  for (const name of readdirSync(target)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(target, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...collectFiles(p));
    else if ([".js", ".jsx"].includes(extname(p)) && !/\.test\.[jt]sx?$/.test(p)) out.push(p);
  }
  return out;
}

/** The expression immediately left of the dot, and whether it is guarded. */
function receiverAt(line, dotIndex) {
  const before = line.slice(0, dotIndex);
  // Chained call or a call returning something: `foo(...)`, `x.map(...)`
  if (/\)\s*$/.test(before)) return { text: before.trim().slice(-60), guarded: true };
  // Array literal
  if (/\]\s*$/.test(before)) return { text: "[...]", guarded: true };
  // Template / string literal receiver
  if (/["'`]\s*$/.test(before)) return { text: "<string>", guarded: true };
  const m = before.match(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*$/);
  if (!m) return null;
  const text = m[1];
  const root = text.split(/[?.]/)[0];
  if (SAFE_RECEIVERS.has(root)) return { text, guarded: true };
  // Optional chaining still throws for `.some` on null? No — `x?.some()` is
  // safe, but `x.some()` where x is null is not. Treat `?.` as guarded ONLY
  // when the optional mark is on the final hop.
  const optionalOnLastHop = /\?\.[A-Za-z_$][\w$]*$/.test(before.trim()) || before.trim().endsWith("?");
  return { text, guarded: optionalOnLastHop, root };
}

function isWrapped(line, dotIndex, receiverText) {
  const before = line.slice(0, dotIndex);
  // `(x || [])` / `(x ?? [])` / `asList(x)` / `Array.isArray(x) ? x : []`
  return /\|\|\s*\[\s*\]\s*\)\s*$/.test(before)
      || /\?\?\s*\[\s*\]\s*\)\s*$/.test(before)
      || /asList\([^()]*\)\s*$/.test(before)
      || receiverText === "[...]";
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["src/components/social", "src/utils/rtdbList.js"];

// PASS 1 — the array constants any file may import. A receiver like
// PLATFORM_KEYS is a module-level array literal in socialCore.js; without this
// pass every render loop over a constant is reported and the real findings
// drown in them.
const EXPORTED_ARRAYS = new Set();
for (const file of collectFiles("src")) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)) EXPORTED_ARRAYS.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.(?:map|filter|split|from)\(/g)) EXPORTED_ARRAYS.add(m[1]);
}

const findings = [];
for (const t of targets) {
  for (const file of collectFiles(t)) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    // Names proven to be arrays somewhere in the file by an isArray check or a
    // literal initialiser — a coarse but useful whole-file signal.
    const proven = new Set();
    for (const m of src.matchAll(/Array\.isArray\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) proven.add(m[1]);
    // `const x = [`, `export const x = [` — including the multi-line literals
    // the module constants use — plus anything assigned from an array-producing
    // expression or defaulted to a literal.
    for (const m of src.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g)) proven.add(m[1]);
    for (const m of src.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.(?:map|filter|flatMap|slice|sort|concat|split|from|entries|keys|values)\(/g)) proven.add(m[1]);
    for (const m of src.matchAll(/(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\?\s*[^;\n]*:\s*\[\s*\]/g)) proven.add(m[1]);
    for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\[[^\]]*\]\s*$/gm)) proven.add(m[1]);
    for (const m of src.matchAll(/(?:export\s+)?function\s+[\w$]*\([^)]*\b([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]/g)) proven.add(m[1]);
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]\s*[,)}]/g)) proven.add(m[1]);
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*asList\(/g)) proven.add(m[1]);
    // `const [picked, setPicked] = useState([])` — the destructuring bracket
    // has to be allowed for, or every list held in component state is reported.
    for (const m of src.matchAll(/(?:const|let|var)\s+[[{]?\s*([A-Za-z_$][\w$]*)[^=\n]*=\s*useState\(\s*\[/g)) proven.add(m[1]);
    // The updater argument of a setState on such a list: setPicked((cur) => ...)
    for (const m of src.matchAll(/set[A-Z][\w$]*\(\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/g)) proven.add(m[1]);

    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      METHOD_RE.lastIndex = 0;
      let m;
      while ((m = METHOD_RE.exec(line))) {
        const r = receiverAt(line, m.index);
        if (!r || r.guarded) continue;
        if (isWrapped(line, m.index, r.text)) continue;
        if (r.root && (proven.has(r.root) || EXPORTED_ARRAYS.has(r.root))) continue;
        // An isArray check on the FULL receiver path on this line, not just its
        // root: `Array.isArray(post.media) ? post.media.filter(...) : []`.
        if (line.includes(`Array.isArray(${r.text})`)) continue;
        // `x && x.map(...)` and `x ? x.map(...) : null` — the truthiness test
        // immediately to the left IS the guard.
        if (r.root && new RegExp(`\\b${r.root}\\s*(?:&&|\\?)\\s*$`).test(line.slice(0, m.index - r.text.length))) continue;
        // A regex match result: `const m = s.match(re)` then `m.map(...)`,
        // already gated by an `if (m)` the line-based scan cannot see.
        if (r.root && new RegExp(`\\b${r.root}\\s*=\\s*[^;\\n]*\\.match\\(`).test(src)) continue;
        // useMemo/useState results that build a list — the hook body is the
        // proof, and it lives on other lines.
        if (r.root && new RegExp(`\\b${r.root}\\s*=\\s*useMemo\\(`).test(src)) continue;
        findings.push({ file, line: i + 1, method: m[1], receiver: r.text, text: line.trim().slice(0, 120) });
      }
    });
  }
}

if (!findings.length) {
  console.log("clean — no unguarded array operation on an unproven receiver");
  process.exit(0);
}
for (const f of findings) {
  console.log(`${f.file}:${f.line}  ${f.receiver}.${f.method}()\n    ${f.text}`);
}
console.log(`\n${findings.length} to look at`);
process.exit(1);
