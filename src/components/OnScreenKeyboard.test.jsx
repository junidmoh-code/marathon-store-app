// Pins the on-screen keyboard's PORTABILITY CONTRACT (the file is copied
// verbatim into marathon-pos-app, so its only allowed import is "react") and
// its key behaviours: keys emit characters, shift is one-shot, backspace and
// submit fire their events, and a disabled submit key stays dead.
import { test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { create, act } from "react-test-renderer";
import OnScreenKeyboard from "./OnScreenKeyboard.jsx";

test("portability: the component file imports NOTHING but react", () => {
  const src = readFileSync(new URL("./OnScreenKeyboard.jsx", import.meta.url), "utf8");
  const specifiers = [...src.matchAll(/^\s*import\s+[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  for (const spec of specifiers) expect(spec).toBe("react");
  // No sneaky runtime coupling either (checked on CODE only — the header
  // comment is allowed to name the things it forbids).
  const code = src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  expect(code).not.toMatch(/require\s*\(/);
  expect(code).not.toMatch(/firebase|zustand|redux|react-router|localStorage/i);
});

const tap = (tree, label) => {
  const btn = tree.root
    .findAllByType("button")
    .find((b) => b.props["aria-label"] === label);
  expect(btn, `key "${label}" should exist`).toBeTruthy();
  act(() => { btn.props.onClick(); });
  return btn;
};

test("text layout: keys emit chars, shift uppercases exactly one key", () => {
  const onKey = vi.fn();
  let tree;
  act(() => { tree = create(<OnScreenKeyboard layout="text" onKey={onKey} />); });
  tap(tree, "a");
  tap(tree, "Shift");
  tap(tree, "b");           // shifted
  tap(tree, "c");           // shift must have reset
  expect(onKey.mock.calls.map((c) => c[0])).toEqual(["a", "B", "c"]);
});

test("backspace and submit fire; canSubmit=false disables submit", () => {
  const onBackspace = vi.fn(), onSubmit = vi.fn();
  let tree;
  act(() => {
    tree = create(
      <OnScreenKeyboard layout="numeric" onBackspace={onBackspace} onSubmit={onSubmit}
                        submitLabel="Go" canSubmit={false} />
    );
  });
  tap(tree, "Backspace");
  expect(onBackspace).toHaveBeenCalledTimes(1);
  const go = tree.root.findAllByType("button").find((b) => b.props["aria-label"] === "Go");
  expect(go.props.disabled).toBe(true);
  act(() => { go.props.onClick(); });
  expect(onSubmit).not.toHaveBeenCalled();

  act(() => {
    tree.update(
      <OnScreenKeyboard layout="numeric" onBackspace={onBackspace} onSubmit={onSubmit}
                        submitLabel="Go" canSubmit={true} />
    );
  });
  tap(tree, "Go");
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

test("numeric layout is a PIN pad: all ten digits, no letters", () => {
  let tree;
  act(() => { tree = create(<OnScreenKeyboard layout="numeric" onKey={() => {}} />); });
  const labels = tree.root.findAllByType("button").map((b) => b.props["aria-label"]);
  for (const d of "0123456789") expect(labels).toContain(d);
  expect(labels).not.toContain("q");
});
