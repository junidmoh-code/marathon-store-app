// ─── SEED STAFF ACCOUNTS ──────────────────────────────────────────────────────
// One-time script that creates Firebase Auth users and /users/{uid} records
// for every staff PIN account. Idempotent — re-running updates the PIN
// (password) and permissions record without duplicating accounts.
//
//   node scripts/seedUsers.js
//
// Auth: ADC (run `gcloud auth application-default login --project marathon-club`
// once) OR GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account JSON.
//
// PINs and the full user roster live in `scripts/seedUsers.pins.json`, which
// is .gitignored. This script is tracked (no secrets in the body). On a fresh
// clone, recreate the JSON from the trusted source (Phase 1 spec or your
// password manager) before running.

const path = require("node:path");
const { existsSync, readFileSync } = require("node:fs");

// firebase-admin is pulled from functions/node_modules so this script needs
// no separate install.
const adminPath = path.resolve(__dirname, "..", "functions", "node_modules", "firebase-admin");
const admin = require(adminPath);

const DATABASE_URL = "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app";

// Role → permissions list. Mirrors the spec exactly. super_admin is the
// hardcoded gunidmoh@gmail.com email, granted implicitly via hasPermission's
// email shortcut at runtime — no seeded record needed for that account.
const ROLE_PERMS = {
  admin:           ["store_assistant", "warehouse", "display_refills", "place_orders", "product_admin", "source"],
  store_assistant: ["store_assistant", "display_refills", "place_orders"],
  warehouse:       ["warehouse", "display_refills", "source"],
};

const PINS_FILE = path.join(__dirname, "seedUsers.pins.json");
if (!existsSync(PINS_FILE)) {
  console.error(`Missing ${PINS_FILE}. Create it with the user roster JSON.`);
  process.exit(1);
}
const roster = JSON.parse(readFileSync(PINS_FILE, "utf8"));
if (!Array.isArray(roster.users) || roster.users.length === 0) {
  console.error("seedUsers.pins.json must have a non-empty `users` array.");
  process.exit(1);
}

admin.initializeApp({ databaseURL: DATABASE_URL });
const fbAuth = admin.auth();
const db     = admin.database();

async function seedOne({ username, displayName, role, pin }) {
  if (!username || !displayName || !role || !pin) {
    throw new Error(`Missing field on user: ${JSON.stringify({ username, displayName, role })}`);
  }
  if (!ROLE_PERMS[role]) {
    throw new Error(`Unknown role '${role}' for ${username}. Valid roles: ${Object.keys(ROLE_PERMS).join(", ")}`);
  }
  const email = `${username}@marathon.internal`;
  let userRecord;
  try {
    userRecord = await fbAuth.getUserByEmail(email);
    await fbAuth.updateUser(userRecord.uid, { password: pin, displayName });
    console.log(`  updated  ${username.padEnd(16)} ${userRecord.uid}`);
  } catch (err) {
    if (err.code !== "auth/user-not-found") throw err;
    userRecord = await fbAuth.createUser({ email, password: pin, displayName });
    console.log(`  created  ${username.padEnd(16)} ${userRecord.uid}`);
  }
  await db.ref(`users/${userRecord.uid}`).set({
    username,
    displayName,
    role,
    permissions: ROLE_PERMS[role],
    createdAt: admin.database.ServerValue.TIMESTAMP,
  });
}

(async () => {
  console.log(`Seeding ${roster.users.length} staff accounts…\n`);
  let ok = 0, fail = 0;
  for (const u of roster.users) {
    try {
      await seedOne(u);
      ok++;
    } catch (err) {
      console.error(`  FAILED   ${u.username || "(no username)"}: ${err.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} succeeded, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
