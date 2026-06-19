import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  test: {
    // The Cloud Functions suite (functions/) uses node:test and runs via
    // `node --test` from functions/ — exclude it from vitest, which can't run it.
    exclude: [...configDefaults.exclude, "functions/**"],
  },
});
