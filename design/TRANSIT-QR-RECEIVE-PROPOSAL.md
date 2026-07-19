# PROPOSAL — Transit state + QR scan-to-receive for Central→shop/hub transfers

Status: **DESIGN ONLY — nothing built.** Investigated 2026-07-19.
Scope: bulk stock transfers leaving Central. Customer-order dispatch, CR fulfilment,
clothing refills, and all same-building moves stay exactly as they are (instant).

---

## 0. The headline finding

The two-step transit design **already exists in this repo, dormant**. It was specified,
scaffolded, and then deliberately dropped for one-step instant moves
(`design/INVENTORY-DESIGN.md:23-32` — "transit visibility is intentionally traded away
per Junid's explicit call"). What remains live today:

| Dormant piece | Where | State |
|---|---|---|
| `in_transit` virtual location | `src/components/stock/locations.js:16,27,50-54` | Registered, excluded from pickers |
| `transfer_in` movement type | `applyMovement.js` `VALID_TYPES` + `cellDeltas`; rules `lastType` enum | Validated everywhere, produced nowhere |
| `/transfers/{id}` document | Rules `database.rules.json:360-367` (status `dispatched\|received\|discrepancy`); push-key minted at `Transfer.jsx:340` but no record ever written | Rules fully model it; zero writes |
| `useTransfers(status)` hook | `src/components/stock/useStock.js:81-82` | Zero consumers |
| Original two-step spec | `design/INVENTORY-DESIGN.md:196-226`, `design/SCHEMA-additions.md:80-88` | Complete, incl. discrepancy handling |

So the feature is: **turn the dormant design back on for one class of lane only**, plus
two genuinely new pieces (QR package labels, scan-to-receive UI).

---

## 1. How transfers work today (what changes, what doesn't)

Every stock move goes through **one writer**: `applyMovement()`
(`src/components/stock/applyMovement.js:66-165`). A `transfer_out` writes source
decrement + destination increment + ledger row in **one atomic multi-path update**.
There is no transfer document — a transfer is just paired cell writes plus
`stock_movements` ledger rows sharing a `link.transferId`.

`applyMovement` itself needs **no changes**. The change is at the call sites: for
transit lanes, the single `transfer_out from→to` becomes two legs:

- **Dispatch leg (Central, at Send):** `transfer_out  from: central → to: in_transit`
  — stock leaves Central immediately, pools in the `in_transit` location.
- **Receive leg (destination, at scan):** `transfer_in  from: in_transit → to: dest`
  — stock lands only when scanned (or manually force-received).

Plus, at dispatch, we finally **write the `/transfers/{transferId}` document** the rules
already model (see §4 for shape).

### Call sites that move stock out of Central (candidates for transit)

| Flow | File | Lane | Transit? |
|---|---|---|---|
| Manual Transfer screen | `Transfer.jsx:331-408` | Central → anywhere | **Yes when dest is cross-building** |
| Hub 2 auto-refill queue | `Hub2RefillQueue.jsx:64-92` | Central → hub2 | **Yes — but gated on engine guard (§6)** |
| Initial Distribution Wizard | `NoTargetQueue.jsx:172-215` | Central → 5 dests | **Yes (same gate)** |
| Network Transfer (stranded clothing) | `NetworkTransfer.jsx:85-108` | Central/Hub2 → stores | **Yes (same gate)** |
| Move Excess | `MoveExcess.jsx:85-109` | stores → Central/Hub2 | **No in V1** — reverse direction; Central can receive uncounted-style for now |
| Order dispatch (`disp_`) | `App.jsx:6694-6757` | hub → shop, customer orders | **Never** — has its own lifecycle (Sent/hold/return reversal) |
| CR fulfil / clothing refills / uncounted send | `App.jsx:966-1078` | hub → store | **Never** — untouched |

### Scope gate: same-building stays instant

There is **no building/topology metadata anywhere** — `locations.js` deliberately
exposes no routing logic. The gate needs a new, tiny constant:

```js
// transitLanes.js — single source of truth for which moves go in-transit.
// A transfer goes two-step ONLY if from-building !== to-building.
const BUILDING = {
  central: "central-building",
  hub1: "???", hub2: "???", hub3: "???", hubC: "???",
  "marathon-pe": "pe-shop", trophy: "trophy-shop", "marathon-pine": "pine-shop",
};
```

**OPEN QUESTION for Junid:** fill in the real building map. Which hubs share a roof
with Central? (The hub2 dispatch-hold feature implies hub2→shop parcels travel
~6 min, but Central→hub2 adjacency is not recorded anywhere.) Everything with the
same building value keeps today's instant one-step move — the gate is a pure
`if` at the call site, so instant lanes are untouched code paths.

---

## 2. Data model

### `/transfers/{transferId}` (revived, extended with packages)

```
transfers/{tId}: {
  status: "dispatched" | "partially_received" | "received",   // rules currently allow
                                                              // dispatched|received|discrepancy —
                                                              // enum needs +partially_received
  from: "central", to: "marathon-pe",
  createdAt, createdBy, receivedAt?,
  reason: "manual" | "hub2_auto_refill" | "initial_distribution" | "network_rebalance",
  lines: { "<pid>|<sizeKey>": qty, ... },          // full manifest
  packages: {
    "1": { status: "packed" | "received", receivedAt?, receivedBy?,
           lines: { "<pid>|<sizeKey>": qty, ... } },   // per-package manifest
    "2": { ... },
  },
  packageCount: N,
}
```

- Per-package `status` carries partial state; top-level `status` flips to
  `partially_received` on first scan, `received` when every package is in.
- `stock_movements` ledger rows link both legs via `link.transferId` — audit trail
  unchanged in shape, doubled in rows for transit lanes.
- Idempotent movement ids: dispatch `tr_{tId}_{pid}_{size}` (exists today),
  receive `rcv_{tId}_p{pkg}_{pid}_{size}` — re-scan of a received package no-ops.

### Rules changes (small, but LIVE-RULES-DRIFT applies)

1. `/transfers` status enum: add `partially_received`; validate `packages` children.
2. `transfer_in` is **already permitted** for `stockRole ∈ warehouse|store|admin`
   (`database.rules.json:350`) — shop receivers already pass.
3. **Diff deployed rules before touching anything** (2026-07-10 audit: live ≠ local file).

---

## 3. QR label + D520 printing

### Where the D520 actually lives

"D520" appears **nowhere in marathon-store-app** — it's in **marathon-pos-app**:
`src/print/laybyLabel.js` + `printerPrefs.js`. The pipeline is delightfully simple
and fully portable:

- `qrcode` npm lib → QR data-URL (medium error correction)
- plain HTML label, `@page { size: 102mm 152mm; margin: 0 }` (4×6" media)
- hidden iframe + `window.print()` — the OS print dialog does the driver work;
  `printerPrefs.js` stores the printer name per terminal and the UI reminds the
  operator "confirm Destination = D520".

**No Bluetooth protocol, no ESC/POS.** Any desktop with the D520 driver installed can
print. Port this pattern into the store app (add `qrcode` dep — store app currently
has only the *decoder*, `html5-qrcode`).

Constraint worth stating: Central's current dispatch label prints on the Phomemo M110
over BLE from Android. The D520 path is **OS-print-dialog from a desktop** — the
transfer-send flow must run on (or hand off to) a machine with the D520 driver.

### Label content (per package)

Big destination name · "Package {i} of {N}" · contents summary (text, from the
package manifest) · transfer short-id + date · the QR.

### QR payload — mirrors the layby contract (`layby/contract.js:127-139`)

```json
{ "v": 1, "k": "transfer", "tId": "<transferId>", "pkg": 1, "of": 3 }
```

IDs only — contents live in `/transfers/{tId}`, printed as text on the label. Scan
resolves `tId` → transfer doc; validates `status` is receivable, `to` matches the
scanning device's location, `packages[pkg].status !== "received"`.

### Packing flow at Central (Send screen addition)

1. Confirm cart → choose package count N (default 1).
2. N = 1: whole manifest is package 1, zero extra taps.
3. N > 1: quick bucket assignment — every line starts in package 1, tap a line to
   cycle its package number (or a per-line stepper). Must fully assign before print.
4. Print → one HTML document with N page-break sections → **one** print dialog.

**Partial receive falls out naturally**: per-package manifests + pooled `in_transit`
cells mean scanning 2 of 3 packages lands exactly those 2 manifests
(`transfer_in in_transit→dest` per line) and package 3's stock stays in
`in_transit` until scanned or resolved. This is why manifests are per-package —
without them, partial receive is impossible to do honestly.

---

## 4. Scan-to-receive UI

- **Hubs:** new tab in `WarehouseView` (tab array `App.jsx:7113-7158` + the
  tab-clamp effect at `:6287-6299`). Destination identity =
  `localStorage["warehouseHub"]`.
- **Shops:** same card in the store-assistant surface (identity =
  `localStorage["storeAssistantShop"]`). Note the existing warning that a device
  left on the wrong shop mis-routes — scan validation (`to` must equal device
  location) actually *catches* wrong-device scans, a nice side benefit.
- **Scanner:** reuse `layby/QrScanner.jsx` (html5-qrcode camera modal) — it already
  implements scan→callback→self-stop with camera-permission fallback. Hardware
  keyboard-wedge scanners can be added later via `barcodeListener.js` (already
  ported from POS) since the QR payload is plain JSON text.
- **Write path:** loop `applyMovement({type:"transfer_in", from: IN_TRANSIT,
  to: dest, ...})` per manifest line (idempotent ids, retry-safe — same pattern as
  today's send loop), then mark package received, then flip transfer status.
  Authorized by the receiver's `stockRole` (#209 gate) — rules already allow it.
- **Fallbacks (day one, not later):**
  - *Manual receive* button per in-transit transfer (label damaged / camera dead) —
    admin or warehouse-role confirm.
  - *Discrepancy path* per original spec (`INVENTORY-DESIGN.md:196-226`): receive
    with adjustment, signed ledger row, `status:"discrepancy"`.
  - *Stale-in-transit surfacing*: Health card listing transfers `dispatched` older
    than X hours (the original design's `stale_in_transit` exception). Without this
    we recreate the zombie-refills class of bug in a new node.

---

## 5. Refill-engine interaction — the one real hazard

While goods sit in `in_transit`, the destination's counted stock is LOW. The refill
engine computes needs from destination stock vs targets → it will open a **duplicate
refill request** for stock that's already on a van. The pooled `in_transit` location
can't answer "inbound to whom?" — only open `/transfers` docs can (they carry `to`).

**Required guard before any engine-served lane (central→hub2) goes transit:** the
engine's deficit math subtracts inbound qty from open/partially-received transfers
targeting that destination. This touches frozen-engine territory (POST-PRODUCTION
GOVERNANCE) — it's a small, evidence-clear change, but it must be classified and
reviewed as an engine PR, and it gates Phase 1's rollout order (below).

Server side is clean otherwise: **no Cloud Function reads `/stock` cells** (reorder
fn reads embedded `products/{id}.stock`), so nothing server-side breaks when
destination stock lands late.

---

## 6. Phasing (matches Junid's suggested order)

**Phase T1 — transit state, manual receive (no QR yet).**
Building map constant + lane gate; two-leg writes on manual `Transfer.jsx` ONLY
(narrowest lane first); write `/transfers` docs; rules update (+`partially_received`);
"In transit" visibility (revive `useTransfers`); manual receive + discrepancy +
stale-transit Health card. *Shippable alone: transfers stop teleporting, receive is a
button press.*

**Phase T2 — QR package labels at Central.**
Add `qrcode` dep; port POS `laybyLabel.js` pipeline; package count + bucket
assignment UI; N-page print document; per-package manifests in the transfer doc.

**Phase T3 — scan-to-receive tab.**
QrScanner reuse; validation (dest match, status, dedupe); per-package landing;
partial-receive status flow; wrong-device scan rejection message.

**Phase T4 — widen lanes.**
Engine inbound-guard PR (governance-classified) → then flip `Hub2RefillQueue`,
`NoTargetQueue` wizard, `NetworkTransfer` onto transit. Optionally Move Excess
(reverse direction) later.

---

## 7. Open questions for Junid

1. **Building map** — which hubs share Central's building? (Determines every lane.)
2. **Who packs** — is the package-count + line-bucketing step acceptable friction at
   Central for multi-package sends? (N=1 default is zero-friction.)
3. **Is there a D520 at Central today**, on a desktop with its driver? (POS's D520
   sits at a POS workstation per its comments.)
4. **Stale threshold** — how long before an unscanned transfer is flagged? (Suggest
   4h same-day lanes.)
5. Current branch `feat/ai-refill-targets` predates recent merges — build should
   branch off fresh `origin/main`.
