// Re-export shim. THE classifier lives in src/components/stock/provenanceClass.js
// because two very different callers need the identical rules: applyMovement
// (which classifies the movement it is writing, to maintain the index forward) and
// the backfill (which classifies 56k historical records). A second copy here would
// be the drift this project has been bitten by before, so there is no second copy.
export * from "../../src/components/stock/provenanceClass.js";
