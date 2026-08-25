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
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// A regex, not a parser, and two known limits follow from that. Both are in
// the FALSE-POSITIVE direction — a glance wasted, never a defect hidden:
//
//   · `if (a) { b(); } [1, 2].forEach(...)` on ONE line. A block's closing `}`
//     is indistinguishable from an object literal's without parsing, and an
//     object literal's `}` has to count (`{...}[key].map()` is a real index
//     access). Telling them apart needs a JS parser; the shape is not one
//     anybody writes, and the cost of being wrong about it is a line to look at.
//   · `proven` is judged per FILE, not per scope. One function using a name as
//     a real array marks that name proven everywhere in the file, so a
//     different function's nullable value of the same name can slip through.
//     This one CAN hide something. It is the price of not writing a parser,
//     and it is why this sweep is a net, not a proof — the tests and the
//     mutation proof are what actually hold the guards.
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

/** Index of the `[` matching the `]` that ends `text`, or -1. */
function matchingOpenBracket(text) {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === "]") depth++;
    else if (text[i] === "[") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** The expression immediately left of the dot, and whether it is guarded. */
function receiverAt(line, dotIndex) {
  const before = line.slice(0, dotIndex);
  // Chained call or a call returning something: `foo(...)`, `x.map(...)`
  if (/\)\s*$/.test(before)) return { text: before.trim().slice(-60), guarded: true };
  // A closing bracket is TWO different things and only one of them is a guard.
  // `[a, b].map(...)` is a literal and safe. `rows[i].some(...)` is an INDEX
  // access, and `rows[i]` is exactly as able to be undefined as any other
  // expression — treating it as a literal was a false negative, which is the
  // direction that matters in a sweep. They are told apart by what sits
  // immediately before the matching `[`: an identifier, a `)` or a `]` means
  // index access.
  if (/\]\s*$/.test(before)) {
    const openIdx = matchingOpenBracket(before);
    const lead = openIdx > 0 ? before.slice(0, openIdx).trimEnd() : "";
    const prev = lead.slice(-1);
    // A KEYWORD before the bracket still means a literal: `return [a].map()`,
    // `typeof [x]`, `await [p]`. Only a value — an identifier, a call result,
    // another index — makes it an index access.
    const word = (lead.match(/[A-Za-z_$][\w$]*$/) || [""])[0];
    const KEYWORD_BEFORE_LITERAL = new Set([
      "return", "typeof", "of", "in", "case", "do", "else", "yield", "await",
      "new", "delete", "void", "instanceof",
    ]);
    // `}` belongs in this class too: `{ queued: [1], sent: [2] }[status].map()`
    // is an index into an object literal, and an unmatched `status` gives
    // undefined. Leaving it out made that shape read as a plain array literal.
    if (!/[\w$)\]}]/.test(prev) || KEYWORD_BEFORE_LITERAL.has(word)) return { text: "[...]", guarded: true };
    // Label it by the thing being indexed, not by 24 characters of whatever
    // happened to precede it.
    const base = (lead.match(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/) || ["?"])[0];
    return { text: `${base}[…]`, guarded: false, root: null };
  }
  // Template / string literal receiver
  if (/["'`]\s*$/.test(before)) return { text: "<string>", guarded: true };
  const m = before.match(/([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*$/);
  if (!m) return null;
  const text = m[1];
  const root = text.split(/[?.]/)[0];
  if (SAFE_RECEIVERS.has(root)) return { text, guarded: true };
  // Optional chaining is a guard ONLY on the hop that reaches the method.
  // `post?.media?.map(...)` is safe. `post?.media.map(...)` is NOT — the `?.`
  // there protects against a null `post`, and says nothing about `media`,
  // which is precisely the field that comes back null. METHOD_RE matches the
  // `.map(` inside `?.map(`, so the optional call leaves `before` ending in a
  // bare `?`; anything else, including a `?.` earlier in the path, is not a
  // guard on this call.
  return { text, guarded: before.trimEnd().endsWith("?"), root };
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
