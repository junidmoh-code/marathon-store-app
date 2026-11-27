// Layout-shift harness: the REAL Missing Products screen, every firebase entry
// point swapped for a fake over a saved snapshot. Local only; never deployed.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createReadStream } from "fs";
import { fileURLToPath } from "url";
import path from "path";
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "../../../src");
export default defineConfig({
  root: here,
  plugins: [react(), {
    name: "fakes",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source === "firebase/database") return path.join(here, "fakeDb.js");
      if (/^firebase\/(app|auth|functions|storage|messaging|analytics)$/.test(source)) return path.join(here, "fakeFirebase.js");
      if (!importer || !source.startsWith(".")) return null;
      const abs = path.resolve(path.dirname(importer), source);
      if (abs === path.join(SRC, "firebase") || abs === path.join(SRC, "firebase.js")) return path.join(here, "fakeFirebase.js");
      if (abs === path.join(SRC, "components", "PermissionsContext") || abs === path.join(SRC, "components", "PermissionsContext.jsx")) return path.join(here, "fakePermissions.jsx");
      return null;
    },
    configureServer(server) {
      server.middlewares.use("/__snap", (_req, res) => { res.setHeader("content-type", "application/json"); createReadStream(process.env.CLS_SNAPSHOT).pipe(res); });
    },
  }],
  server: { port: 5199, strictPort: true, fs: { allow: [path.resolve(here, "../../..")] } },
  logLevel: "warn",
});
