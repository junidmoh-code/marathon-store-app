import { createContext } from "react";

// Frozen so a consumer can never mutate the shared array in place.
export const EMPTY_LOG = Object.freeze([]);

// Default value for consumers rendered outside the provider (tests, and any
// future screen that forgets to mount it): an empty log and no-op retain/release
// so nothing throws and nothing subscribes.
export const InsightsLogContext = createContext({
  log: EMPTY_LOG,
  retain: () => {},
  release: () => {},
});
