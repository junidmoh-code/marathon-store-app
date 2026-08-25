// ─── THE SHAPES RTDB ACTUALLY RETURNS ────────────────────────────────────────
// asList exists because a field the code calls an array comes back four ways.
// Each of these tests is one of the four, and each of them threw before the
// helper existed. See utils/rtdbList.js for the reasoning.
import { test, expect } from "vitest";
import { asList, hasItems, storedList, storedMap } from "./rtdbList";

test("a real array passes through", () => {
  const a = [{ id: 1 }, { id: 2 }];
  expect(asList(a)).toEqual(a);
});

test("ABSENT — the key was never written — is an empty array, not a throw", () => {
  const record = { id: "r1", note: "no tags were ever typed" };
  expect(asList(record.tags)).toEqual([]);
  // The operation that took the card down.
  expect(() => asList(record.tags).some(Boolean)).not.toThrow();
});

test("null — the key was deleted, or the last child removed — is an empty array", () => {
  expect(asList(null)).toEqual([]);
  expect(() => asList(null).map((x) => x)).not.toThrow();
});

test("an object-keyed map becomes a list, ordered by NUMBER not by string", () => {
  // RTDB returns this instead of an array whenever the keys are sparse. The
  // keys sort as STRINGS in the raw object — "10" before "2" — so ordering by
  // key text silently reverses a post's media, which is the order the pictures
  // appear in on Instagram.
  const map = { 10: "eleventh", 2: "third", 0: "first" };
  expect(asList(map)).toEqual(["first", "third", "eleventh"]);
});

test("a non-numeric object map keeps every value", () => {
  expect(asList({ a: 1, b: 2 })).toEqual([1, 2]);
});

test("holes inside a real array are dropped rather than handed on as null", () => {
  // eslint-disable-next-line no-sparse-arrays
  expect(asList([1, , 3])).toEqual([1, 3]);
  expect(asList([1, null, 3])).toEqual([1, 3]);
});

test("a scalar where a list belongs is empty, not a one-item list", () => {
  expect(asList("hello")).toEqual([]);
  expect(asList(7)).toEqual([]);
  expect(asList(true)).toEqual([]);
});

test("hasItems answers the question without anyone writing .length", () => {
  expect(hasItems(null)).toBe(false);
  expect(hasItems([])).toBe(false);
  expect(hasItems({ 0: "x" })).toBe(true);
});

test("storedList turns empty into an EXPLICIT null, and keeps a real list", () => {
  expect(storedList([])).toBe(null);
  expect(storedList(null)).toBe(null);
  expect(storedList(["a"])).toEqual(["a"]);
  // An object map must never be stored back as an object map.
  expect(storedList({ 0: "a", 1: "b" })).toEqual(["a", "b"]);
});

test("storedMap keeps a populated map and refuses to hand {} to update()", () => {
  // update({results: {}}) DELETES the whole subtree — losing an "ok" record,
  // which on a post means re-sending to a live public account.
  expect(storedMap({})).toBe(null);
  expect(storedMap(null)).toBe(null);
  expect(storedMap({ instagram: { state: "ok" } })).toEqual({ instagram: { state: "ok" } });
});
