# WebUSB label-printing path — as-built map (before any change)

Written while diagnosing: **XP-350B on an iMac (Chrome/macOS) fails with**
`Couldn't connect to the printer: No bulk OUT endpoint found on the selected USB device — is this the label printer?`

This document describes the code **as it stands before commit 2**. No behaviour is
changed by the commit that adds it.

## Files

| File | Role |
| --- | --- |
| `src/components/stock/printers/xprinter.js` | The whole WebUSB driver: TSPL label bytes, device discovery, open/claim, `transferOut`. The only `navigator.usb` code in the repo. |
| `src/components/stock/printers/index.js` | Transport facade. `connectTransport("xprinter")` → `connectXprinter()`; `printLabels({transport:"xprinter"})` → `printXprinter()`. Re-exports `getXprinterDiag`. |
| `src/components/stock/BarcodeCatalog.jsx` | The screen the reported error comes from (`doPrint`, line ~172). Connects first (inside the click gesture), then reserves codes, then prints. Has a persistent `diagText` box. |
| `src/components/stock/printers/phomemo.js` | Separate Bluetooth transport. **Untouched** by this work. |
| `src/components/stock/BarcodePrint.jsx`, `src/components/LabelPrintView.jsx`, `src/components/stock/printDispatch.js` | Other print entry points. All go through the same facade; only BarcodeCatalog and BarcodePrint expose a transport picker, so the Xprinter is only reachable from those two on macOS (`defaultTransportId()` returns `phomemo` off Windows). |

Not shared with `marathon-pos-app`: that repo's print stack is `src/print/*`
(`printService.js`, `laybyLabel.js`) and contains no `navigator.usb`,
`claimInterface` or `transferOut` at all. Changing this file cannot diverge a
second copy.

## Current connect sequence

`connectXprinter()` → `getConnection()` → `openDevice(device)`:

1. `wireDisconnect()` — one `navigator.usb` `disconnect` listener that clears the cache.
2. If a cached device is still `opened` and has a cached endpoint → reuse it, return.
3. Else if there is a cached device → `openDevice(cached)` (reopen, no chooser).
4. Else `navigator.usb.getDevices()` → pick the first device that has *any* alternate with `interfaceClass === 0x07`, else `known[0]` → `openDevice(pick)`.
5. Else `navigator.usb.requestDevice({ filters: [] })` (chooser lists every USB device) → `openDevice(chosen)`.

`openDevice(device)`:

1. `if (!device.opened) await device.open()`
2. `if (device.configuration === null) await device.selectConfiguration(1)`
3. Loop `device.configuration.interfaces`; for each, look **only at `cfgIface.alternate`** (the currently-active alternate) for an endpoint with `direction === "out" && type === "bulk"`. Record `interfaceNumber` / `endpointNumber`; `break` early if that alternate's `interfaceClass === 0x07`.
4. Capture `lastXprinterDiag` (VID/PID hex, names, per-interface endpoint map) and `console.log` it.
5. If no interface matched → **throw** `"No bulk OUT endpoint found on the selected USB device — is this the label printer?"` ← the reported failure.
6. `await device.claimInterface(iface)` — one attempt; on throw, rewrite the message with the macOS "remove it from Printers & Scanners" hint.
7. Cache `{device, iface, endpointOut}` and return.

`printXprinter(items, conn)` → per item `sendChunked(device, endpointOut, tsplBytes)`
→ `device.transferOut(endpoint, chunk)` in 8192-byte chunks, throwing
`USB transfer ${res.status}` when status isn't `"ok"`. The device is deliberately
left open and claimed for the next batch; only a USB disconnect clears the cache.

## Assumptions the current path makes

| Thing | Assumption | Sound? |
| --- | --- | --- |
| Configuration number | Hardcoded `selectConfiguration(1)`. | Usually right, but nothing guarantees `configurationValue === 1`; the first available value should be used. |
| Which configurations are searched | Only the **active** one (`device.configuration.interfaces`). | Other configurations in `device.configurations` are never examined. |
| Interface number | Not hardcoded — discovered. But the loop keeps overwriting `iface`, so with several non-printer-class matches it ends on the **last** one, not the first. | Weak. |
| Alternate setting | Only `cfgIface.alternate` — the **currently active** alternate — is inspected. Alternates other than the active one are invisible. `selectAlternateInterface` is **never called**. | **Wrong for any device whose bulk OUT lives on a non-active alternate.** |
| Endpoint number | Discovered (`out.endpointNumber`) and used for every `transferOut`. Not hardcoded. | Sound. |
| Active configuration on macOS | Assumes `device.configuration` is either `null` (→ select 1) or already correct. | macOS commonly reports **no active configuration**; the `=== null` check covers that but the hardcoded `1` may not. |
| Claim contention | One `claimInterface` attempt, no retry. | macOS can briefly hold the interface after a replug/driver teardown; a single attempt loses that race. |
| Transfer result | `res.status !== "ok"` throws, but the message is bare (`USB transfer stall`) and no byte count is reported on success. | Thin for remote diagnosis. |
| Chooser filter | `filters: []` — lists all USB devices. | Intentional (the 0x07 filter was hiding the printer). |

## Why the reported error can happen even with the right printer selected

Step 5 fires whenever step 3 finds nothing. Three of the assumptions above can
each produce that on macOS with a genuine XP-350B attached:

* `device.configuration` is non-`null` but not the configuration holding the
  printer interface → the other configurations are never searched.
* the bulk OUT endpoint sits on alternate setting 1 (or higher) while alternate 0
  is the active one → the endpoint exists but is never seen.
* `selectConfiguration(1)` throws or selects a configuration whose
  `configurationValue` isn't 1 → `device.configuration.interfaces` isn't the set
  we want.

The error text also carries **none** of the evidence needed to tell those apart
from a photo of the screen — the full interface/endpoint map only goes to
`console.log` and to RTDB, neither of which is reachable on the remote machine.
