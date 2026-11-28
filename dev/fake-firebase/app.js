// DEV ONLY — the sky app harness's stand-in for firebase/app (dev/vite.harness.config.mjs).
export function initializeApp(config) { return { options: config, name: "[harness]" }; }
export function getApp() { return { name: "[harness]" }; }
