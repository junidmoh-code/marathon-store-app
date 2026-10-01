// ─── Resolving firebase-admin from a script, portably ────────────────────────
// firebase-admin is a functions/ dependency, so a script in scripts/ has to
// reach into functions/node_modules for it.
//
// These scripts used to hardcode ONE developer's absolute path as the
// createRequire base, which cannot work on anyone else's machine (CodeRabbit,
// PR #547). The obvious repo-relative fix — `new URL("../functions/package.json",
// import.meta.url)` — is right on a normal clone but fails inside a git
// WORKTREE, where functions/node_modules is typically never installed (this
// repo runs 100+ worktrees against one install).
//
// So: try the repo-relative path first, then the MAIN checkout's install,
// found via git's common dir. Fail with an instruction rather than a stack.
import { createRequire } from "module";
import { execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

export function adminRequire(importMetaUrl) {
  // fileURLToPath / pathToFileURL rather than .pathname: a URL pathname
  // percent-encodes, so a checkout under a path with a space would hand git a
  // cwd containing "%20" and fail before the fallback could be tried.
  // (CodeRabbit, PR #547.)
  const here = fileURLToPath(new URL(".", importMetaUrl));
  const bases = [new URL("../functions/package.json", importMetaUrl)];

  try {
    // In a worktree this is the MAIN checkout's .git; in a normal clone it is
    // this clone's own .git. Either way its parent is the checkout holding the
    // one npm install.
    const gitDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      cwd: here, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    bases.push(pathToFileURL(`${gitDir.replace(/\/\.git\/?$/, "")}/functions/package.json`));
  } catch { /* not a git checkout — the repo-relative base is all there is */ }

  for (const base of bases) {
    try {
      const req = createRequire(base);
      req.resolve("firebase-admin");
      return req;
    } catch { /* try the next base */ }
  }
  throw new Error(
    "firebase-admin not found. Run `npm install --prefix functions` in the repository root.",
  );
}
