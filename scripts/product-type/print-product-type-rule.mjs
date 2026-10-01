// Prints the OPTIONAL rule that makes a product's Type server-only
// (productTypeRule.mjs), as a whole document to paste. Nothing is written.
//   node scripts/product-type/print-product-type-rule.mjs <live-rules.json> <out.json> [--with-device-enrolment]
// --with-device-enrolment applies the device-code patch too, so ONE paste
// carries both (the two compose: that one wraps .read/.write, this adds a
// .validate). Prove first: prove-product-type-rule.mjs and
// ../device-enrolment/prove-device-enrolment-rules.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { patchProductTypeRule, PRODUCT_VALIDATE } from "./productTypeRule.mjs";
import { patchDeviceEnrolmentRules } from "../device-enrolment/deviceEnrolmentRules.mjs";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) { console.error("usage: print-product-type-rule.mjs <live-rules.json> <out.json> [--with-device-enrolment]"); process.exit(2); }
let doc = JSON.parse(readFileSync(inFile, "utf8"));
if (process.argv.includes("--with-device-enrolment")) doc = patchDeviceEnrolmentRules(doc).doc;
doc = patchProductTypeRule(doc);
writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n");
console.log(`written to ${outFile}`);
console.log(`adds under "products" → "$pid":\n  ".validate": "${PRODUCT_VALIDATE}"`);
