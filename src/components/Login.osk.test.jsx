// Pins the login on-screen-keyboard contract: the keyboard appears ONLY on
// touch-only hardware (coarse pointer, no fine pointer), never on desktop;
// its keys fill whichever field is focused; and a full username+PIN entered
// through it signs in with the same synthetic credentials as typed input.
// Firebase is fully mocked — no test touches live data.
import { test, expect, vi, afterEach } from "vitest";
import { create, act } from "react-test-renderer";

vi.mock("../firebase", () => ({ auth: { __mockAuth: true } }));
vi.mock("firebase/auth", () => ({ signInWithEmailAndPassword: vi.fn(() => Promise.resolve()) }));

import { signInWithEmailAndPassword } from "firebase/auth";
import Login from "./Login.jsx";

const ORIGINAL_WINDOW = globalThis.window;
afterEach(() => {
  globalThis.window = ORIGINAL_WINDOW;
  vi.clearAllMocks();
});

// matchMedia stub: touchOnly=true reports coarse pointers and no fine pointer.
const stubWindow = (touchOnly) => {
  globalThis.window = {
    matchMedia: (q) => ({
      matches: q.includes("coarse") ? touchOnly : !touchOnly,
    }),
  };
};

const render = () => {
  let tree;
  act(() => {
    tree = create(<Login />, { createNodeMock: () => ({ focus: () => {} }) });
  });
  return tree;
};

const oskKeys = (tree) =>
  tree.root.findAllByType("button").filter((b) => b.props["aria-label"]);
const tap = (tree, label) => {
  const btn = oskKeys(tree).find((b) => b.props["aria-label"] === label);
  expect(btn, `key "${label}" should exist`).toBeTruthy();
  act(() => { btn.props.onClick(); });
};
const inputs = (tree) => tree.root.findAllByType("input");

test("desktop (fine pointer): no on-screen keyboard renders", () => {
  stubWindow(false);
  const tree = render();
  expect(oskKeys(tree).length).toBe(0);
});

test("touch-only device: keyboard renders and a full sign-in works through it", async () => {
  stubWindow(true);
  const tree = render();
  expect(oskKeys(tree).length).toBeGreaterThan(30); // full QWERTY present

  // Native keyboards are suppressed while ours is active.
  for (const inp of inputs(tree)) expect(inp.props.inputMode).toBe("none");

  // Type the username on the QWERTY layout.
  tap(tree, "j"); tap(tree, "u");
  expect(inputs(tree)[0].props.value).toBe("ju");

  // "Next" advances to the PIN field → layout flips to the PIN pad.
  tap(tree, "Next");
  const labels = oskKeys(tree).map((b) => b.props["aria-label"]);
  expect(labels).toContain("7");
  expect(labels).not.toContain("q");

  // Type the 4-digit PIN, then submit from the keyboard.
  tap(tree, "1"); tap(tree, "2"); tap(tree, "3"); tap(tree, "4");
  expect(inputs(tree)[1].props.value).toBe("1234");
  await act(async () => {
    oskKeys(tree).find((b) => b.props["aria-label"] === "Sign in").props.onClick();
  });
  expect(signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
  const [, email, password] = signInWithEmailAndPassword.mock.calls[0];
  expect(email).toBe("ju@marathon.internal");
  expect(password).toBe("pin-1234");
});

test("touch-only: backspace edits the focused field", () => {
  stubWindow(true);
  const tree = render();
  tap(tree, "a"); tap(tree, "b");
  tap(tree, "Backspace");
  expect(inputs(tree)[0].props.value).toBe("a");
});
