// ── LET A NODE SCRIPT IMPORT THE APP'S OWN MODULES ───────────────────────────
// src/ is written for Vite, which resolves extensionless specifiers
// ("../../utils/sizeKey"). Node does not, so any script that tries to drive the
// REAL app code — rather than re-implement it and hope the two agree — dies on
// the first import with ERR_MODULE_NOT_FOUND.
//
// scripts/verify-louboutin-sourcing.mjs (shipped with #568) is exactly that
// script and exactly that failure: it claims to run "the sheet's own code path,
// not a re-implementation of it", and on 2026-09-06 it could not start at all.
// A verification script that cannot run is worse than none, because the claim
// in its header outlives the last time anyone tried it.
//
// This is a Node module-resolution hook: when a specifier fails to resolve and
// has no extension, try ".js" and then "/index.js". Nothing else changes — a
// specifier that resolves normally is untouched, so this cannot mask a real
// missing module.
//
//   node --import ./scripts/lib/appModuleLoader.mjs your-script.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," + encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      try { return await next(specifier, context); } catch (err) {
        if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
        if (!specifier.startsWith(".") && !specifier.startsWith("/")) throw err;
        if (/\\.[a-zA-Z0-9]+$/.test(specifier)) throw err;
        for (const suffix of [".js", ".jsx", "/index.js"]) {
          try { return await next(specifier + suffix, context); } catch { /* try the next */ }
        }
        throw err;
      }
    }
  `),
  pathToFileURL("./"),
);
