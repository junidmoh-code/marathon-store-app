// firebase-admin RTDB handle for the shipping scripts, resolved from
// functions/node_modules like every other script in scripts/. Created on first
// use only, so importing a module that CAN reach the database never connects.
import { createRequire } from "node:module";

let db = null;
export function adminDb() {
  if (db) return db;
  const require = createRequire(new URL("../../functions/package.json", import.meta.url));
  const admin = require("firebase-admin");
  if (!admin.apps.length) {
    admin.initializeApp({ databaseURL: "https://marathon-club-default-rtdb.europe-west1.firebasedatabase.app" });
  }
  db = admin.database();
  return db;
}
