# Merge target picker — from live barcode scanner to the photo-capture label reader

## Where the picker lives
`src/components/stock/MergeProducts.jsx`, SCREEN 1 ("WHICH PRODUCT IS IT REALLY?").
It is opened from `src/components/stock/HubCleanup.jsx:1485` — the Leftovers card
and the duplicate-collision banner both set `merge` state and render
`<MergeProducts …/>`. SCREEN 2 (the side-by-side confirm) and the commit
(`mergeProducts` callable) live in the same file and are NOT touched.

## What the old scan action did
`📷 Scan the real shoe` opened `CameraScanner.jsx` — a **live** html5-qrcode
video stream (`instance.start(...)`, `fps: 10`, wide qrbox) that waits for a 1D
barcode/QR to decode itself. The decoded string went to `onScanLookup`
(`lookupBarcode` in `hubCleanupStore.js`) → `/barcodes/{code}` → productId.
It reads **shop barcode stickers only**. A tongue label has no barcode, so on
sneakers this action never resolves and the operator falls back to typing a
name — which is exactly what creates the duplicates the merge exists to clean up.

## What is reused (unchanged)
* `TongueLabelReader` (`src/components/stock/TongueLabelReader.jsx`) — the ONE
  label capture: `LabelCamera` three-frame burst, ≤1024px client-side downscale,
  QR/DataMatrix first, the `readStyleCodeLabel` callable (server-side image-hash
  cache — a retake re-bills nothing), the tap-to-choose note, typed entry as the
  last-resort escape hatch. Its props are already the public contract
  (`busy`, `big`, `onCode`, `onTokens`) and the merge picker consumes them as a
  fourth consumer. **No edit to the file** — register, count and assistant
  behave byte-for-byte as before.
* The count flow's candidate pooling primitives, imported as-is:
  `labelTokenSet` + `mergeTokenCandidates` (`hubCleanupCore.js`),
  `lookupStyleClaim` / `resolveAnyCodes` / `matchLabelAlias` /
  `fetchProductFollowingMerge` (`hubCleanupStore.js`). Same functions the
  merged-token picker (#371) uses; no new resolution logic is written.

## What changes
Only how the merge TARGET is found. No merge logic, no confirm screen, no write.
The live barcode scanner is KEPT as a clearly-secondary action (shop barcode
stickers on boxes still scan), below the label reader.
