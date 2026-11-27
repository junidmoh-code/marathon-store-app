// Shared test harness for the resume proofs (src/resume/*.test.jsx): counts
// every listener the production hooks open, by path, and prices it with the
// sizes measured 27 Nov 2026 (docs/resume-reload-investigation.md). Opening a
// listener is the download, so opens × bytes is the egress.
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

export const MEASURED = {
  "refill_engine/open": 390_292,
  "config/refillEngine": 6_911,
  network: 4,
  "stock_exceptions/latest": 571_648,
  "stock_exceptions/strandedTransit": 2_287,
  "refill_engine/shadow": 4,
  "refill_engine/retryState": 386_199,
  stock_targets: 3_023_488,
  laybyPulls: 287_615,
  "aiAssistant/nameProposals": 873_650,
  "aiAssistant/photoProposals": 592_901,
  specials: 4,
  broadcasts: 4,
};

export const bytesOf = (paths) => paths.reduce((n, p) => n + (MEASURED[p] ?? 0), 0);

export function mountProbe(useIt) {
  function Probe() { useIt(); return null; }
  let tree;
  act(() => { tree = TestRenderer.create(<Probe />); });
  return { unmount: () => act(() => { tree.unmount(); }) };
}
