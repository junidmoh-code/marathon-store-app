// Proves productTypeRule.mjs on the RTDB emulator against the LIVE rules
// document (unsigned JWTs in ?auth= — never a Bearer header on an assertion,
// which is the emulator's admin bypass).
//   node scripts/product-type/prove-product-type-rule.mjs <live-rules.json>
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchProductTypeRule, OWNER_EMAIL } from "./productTypeRule.mjs";

const NS = "marathon-club-default-rtdb";
const PORT = Number(process.env.RULES_TEST_PORT || 9593);
const HOST = `http://127.0.0.1:${PORT}`;
const JAR = process.env.RTDB_EMULATOR_JAR || join(process.env.HOME, ".cache/firebase/emulators/firebase-database-emulator-v4.11.2.jar");
const JAVA = process.env.JAVA_BIN || "/opt/homebrew/opt/openjdk/bin/java";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const who = (uid, email, provider = "password") => `${b64({ alg: "none" })}.${b64({ iss: `https://securetoken.google.com/${NS}`, aud: NS, sub: uid, user_id: uid, uid, email, auth_time: 1, iat: 1, exp: 9999999999, firebase: { sign_in_provider: provider, identities: {} } })}.`;
const STAFF = who("mike", "mike@marathon.internal");
const OWNER = who("owner", OWNER_EMAIL, "google.com");
const H = { Authorization: "Bearer owner" };
const url = (p, a) => `${HOST}/${p}.json?ns=${NS}${a ? `&auth=${a}` : ""}`;
const put = (p, v) => fetch(url(p), { method: "PUT", headers: H, body: JSON.stringify(v) });
const as = async (a, m, p, v) => { const r = await fetch(url(p, a), { method: m, body: JSON.stringify(v) }); return r.status; };
let pass = 0; const fails = [];
const ok = async (l, s) => { const st = await s; if (st === 200) { pass++; console.log(`  ✓ ${l}`); } else { fails.push(l); console.log(`  ✗ ${l} (${st})`); } };
const no = async (l, s) => { const st = await s; if (st === 401 || st === 403) { pass++; console.log(`  ✓ ${l}`); } else { fails.push(l); console.log(`  ✗ ${l} (${st})`); } };

const live = JSON.parse(readFileSync(process.argv[2], "utf8"));
const doc = patchProductTypeRule(live);
const emu = spawn(JAVA, ["-jar", JAR, "--port", String(PORT), "--host", "127.0.0.1"], { stdio: "ignore" });
process.on("exit", () => { try { emu.kill("SIGKILL"); } catch {} });
for (let i = 0; ; i++) { try { if ((await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { headers: H })).ok) break; } catch {} if (i > 150) process.exit(2); await new Promise((r) => setTimeout(r, 200)); }
const load = async (d) => { const r = await fetch(`${HOST}/.settings/rules.json?ns=${NS}`, { method: "PUT", headers: H, body: JSON.stringify(d) }); if (!r.ok) { console.error(await r.text()); process.exit(2); } };
const seed = () => put("products/p1", { id: "p1", name: "Nike Air Force 1 White", productType: "sneaker", hubs: ["hub1"] });

await load(live); await seed();
console.log("── TODAY (live rules): any signed-in staff account can retype a product ──");
await ok("TODAY: staff flips an existing product to Clothing", as(STAFF, "PATCH", "products/p1", { productType: "clothing" }));
await load(doc); await seed();
console.log("\n── with the rule ──");
await no("staff flips an existing product's Type", as(STAFF, "PATCH", "products/p1", { productType: "clothing" }));
await no("…or writes the leaf directly", as(STAFF, "PUT", "products/p1/productType", "clothing"));
await no("staff DELETES an existing product's Type (the leaf)", as(STAFF, "DELETE", "products/p1/productType"));
await no("staff nulls the Type inside a patch", as(STAFF, "PATCH", "products/p1", { productType: null }));
await put("products/legacy", { id: "legacy", name: "Untyped legacy shoe" });
await no("staff TYPES an untyped legacy product Clothing", as(STAFF, "PATCH", "products/legacy", { productType: "clothing" }));
await ok("staff edits an untyped legacy product's other fields", as(STAFF, "PATCH", "products/legacy", { name: "Legacy shoe" }));
await ok("staff creates a NEW product with a Type", as(STAFF, "PUT", "products/p2", { id: "p2", name: "New", productType: "clothing" }));
await ok("staff edits other fields (sizes, hubs, name)", as(STAFF, "PATCH", "products/p1", { sizes: ["6", "7"], hubs: ["hub1", "hub2"], name: "AF1 White" }));
await ok("staff re-writes the Type to the SAME value", as(STAFF, "PATCH", "products/p1", { productType: "sneaker" }));
await ok("a whole-product write that keeps the Type", as(STAFF, "PUT", "products/p1", { id: "p1", name: "AF1", productType: "sneaker" }));
await ok("Junid's own account may change the Type", as(OWNER, "PATCH", "products/p1", { productType: "clothing" }));
await ok("…and delete it", as(OWNER, "DELETE", "products/p1/productType"));
console.log(`\n${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
