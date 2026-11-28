// DEV ONLY — the sky APP harness (dev/sky-app.html): the real App, offline.
// Same config as the app, plus one alias: every firebase SDK module resolves
// to the stand-ins in dev/fake-firebase/, which answer reads from a synthetic
// tree and record writes without sending them. Nothing in the build uses this
// file (vite build reads vite.config.js); only the admin e2e checks start it.
//   npx vite --config dev/vite.harness.config.mjs --port 5209
//   → http://localhost:5209/dev/sky-app.html
import { fileURLToPath } from "node:url";
import base from "../vite.config.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export default {
  ...base,
  resolve: {
    ...(base.resolve || {}),
    alias: [
      { find: /^firebase\/app$/, replacement: here("./fake-firebase/app.js") },
      { find: /^firebase\/auth$/, replacement: here("./fake-firebase/auth.js") },
      { find: /^firebase\/database$/, replacement: here("./fake-firebase/database.js") },
      { find: /^firebase\/functions$/, replacement: here("./fake-firebase/functions.js") },
      { find: /^firebase\/storage$/, replacement: here("./fake-firebase/storage.js") },
      { find: /^firebase\/messaging$/, replacement: here("./fake-firebase/messaging.js") },
    ],
  },
  optimizeDeps: { ...(base.optimizeDeps || {}), exclude: ["firebase"] },
};
