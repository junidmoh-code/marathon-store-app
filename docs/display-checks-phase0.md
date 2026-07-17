# Display Checks — Phase 0 Recon

Repo `marathon-store-app`, Firebase `marathon-club` (europe-west1). Read-only investigation
against the approved design (`docs/display-checks-design.md`). No behaviour changed. Every
RTDB read was `--shallow` or `--limit-to-last 1` per the cost constraint (RTDB is ~91% of
the bill).

Each of the five design assumptions is marked **ANSWERED** or **UNKNOWN**. A consolidated
**Blocks** list (PR 0 / PR 1 / PR 2) closes the doc.

---

## 1. Sales shape — ANSWERED (from a live sample, not a repo reader)

**Caveat up front:** the design says "derive the shape from the readers in this repo
(`useSales.js` and any other consumer)." There is **no `useSales.js`**, and **no reader of
`/pos/sales` exists in this repo** — the only reference is a comment
(`src/utils/clothingSold.js:9`). Shape below is derived from a **live sample**
(`firebase database:get /pos/sales --limit-to-last 1`), not from repo code. Treat field
presence as "observed on one record," not "contractually guaranteed by a reader."

- **Path / scoping:** `/pos/sales/{pushId}` — **flat**, keyed by push-id (the `saleId`).
  NOT store-scoped. Confirmed via `--shallow`.
- **Sale record fields:** `cashierName, cashierUid, change, createdAt` (epoch ms),
  `lineItems{L1,L2,…}`, `payments`, `priceMode`, `receiptNumber`, `saleId`,
  `status:"completed"`, `storeId:"pe"`, `subtotal`, `tendered`, `tillId`, `total`,
  `type:"sale"`, `updatedAt`.
- **Line item (`lineItems.{Ln}`):** `category:"Clothing"`, `isShoebox`, `lineDiscount`,
  `lineId`, `lineTotal`, `name`, `orderId`, `priceMode`, `productId`, `qty`, `refundedQty`,
  `size` (RAW, e.g. `"L"`), `soldWhileUncounted`, `sourceHub`, `sourceType`, `unitPrice`.
  - `productId` ✅ · `size` ✅ · `qty` ✅ · **`colour` ✗ absent**.
  - **Clothing identifier:** `lineItems.*.category === "Clothing"` (title-case). The
    repo's own classifier instead reads `products/{id}.productType === "clothing"`
    (lowercase) via `inferProductType()` — `src/utils/insights.js`, used at
    `src/utils/clothingSold.js:126-129`.
- **Store-id mismatch:** the sale's `storeId` is the **short** id `"pe"`. The store-app /
  ledger everywhere uses the **long** shop id `"marathon-pe"` (`src/utils/stores.js:50`,
  `SHOP_IDS = ["marathon-pe","trophy","marathon-pine"]`). POS `"pe"/"pine"` ≠
  `"marathon-pe"/"marathon-pine"`. A trigger on `/pos/sales` needs a mapping that does not
  yet exist in this repo.
- **Repo-native alternative:** the store-app already derives clothing sales from
  **`/stock_movements` `sold` movements** — shop-keyed (`from:"marathon-pe"`),
  return-netted, clothing-classified. See the header block `src/utils/clothingSold.js:6-17`
  and `nettedSoldRows()` at `clothingSold.js:175-212`. This is the repo-native sale source
  and avoids both the short-id mapping and re-deriving "is this clothing." **See Blocks PR 2 #1.**

## 2. Store inventory shape — ANSWERED ✅ (the important one)

- **Yes — one `get()` reads a single `{store, productId, size}` cell.** No bigger node needed.
- **Exact path:** `` `stock/${loc}/${productId}/${stockSizeKey(size)}` `` — the single
  construction point is `stockCellPath()` at `src/utils/sizeKey.js:53-55`. Size key via
  `stockSizeKey()` (`sizeKey.js:44-47`): `"M"→"M"`, `"5.5"→"5_5"`, `null/""→"_"`.
- **Cell value:** `{ qty:<number>, updatedAt, updatedBy, lastType, mv, v }`. `qty` is the
  quantity. (Sample: `stock/marathon-pe/{pid}/{L,M,S,XL,…}` each `{qty:…}`.)
- **`loc` values** include the three shops: `marathon-pe`, `trophy`, `marathon-pine`
  (also `hub1/hub2/hub3, central, studio, base`). Confirmed via `--shallow` of `/stock`.
- **Colour:** **NOT part of the key**, and colour is **not a structured product field** —
  it is embedded in the product NAME (sample product: `"Lacoste bag black with yellow"`,
  no `color` field). Every `.color` hit in `src/` is a CSS style prop, not product data.
  → The design's `{productId, colour, size, store}` collapses to **`{productId, size, store}`**:
  colour is already implied by `productId` (each colourway is its own product). **No
  prerequisite inventory PR is needed** — the single-get already exists. The data model
  should drop the `colour` dimension (or keep it as a denormalised display string only).

## 3. Staff auth and roles — ANSWERED (with two gaps)

- **User record** `/users/{uid}`: `{ username, displayName, role, permissions[], createdAt,
  [destShop], [storeIds[]], [stockRole], [posAccess] }`.
- **Role values:** `"admin"`, `"store_assistant"`, `"warehouse"`. **There is no `"manager"`
  role.** (Seed source of truth: `ROLE_PERMS` in `scripts/seedUsers.cjs:35-39`.)
- **Store fields (two different vocabularies):**
  - `destShop` = physical shop `"marathon-pe" | "trophy" | "marathon-pine"` — the
    shop-level scope. Documented `src/utils/stores.js:44-50`; `SHOP_IDS` `stores.js:50`.
    **Not set on every user** (e.g. Xoli, Keith, Yusuf, Paul have none).
  - `storeIds` = routing universe `"central" | "pine"` — order-routing granularity, a
    *different* vocabulary (`stores.js:15,60-68`). Not shop-level.
- **Role gating in existing code:** `hasPermission(p) = isSuperAdmin || permissions.includes(p)`
  at `src/components/AuthGate.jsx:146`. `isSuperAdmin = user.email === ADMIN_EMAIL`
  (`"gunidmoh@gmail.com"`) at `AuthGate.jsx:141`; `ADMIN_EMAIL` is exported from
  `src/components/PermissionsContext.jsx:11`. Role tiles are gated
  `hasPermission(ROLE_TO_PERMISSION[...])` in `RoleSelector` (`src/App.jsx`); the `guard()`
  helper wraps each role view in the AppInner dispatch.
- **⚠ No "manager" tier exists.** Design §7 assumes Clothing-staff / Manager / Super-admin.
  → **RESOLVED for the scaffold (owner decision):** a dedicated **`display_manager`**
  permission, **store-scoped**. Implemented as the single gate `canManageDisplayChecks(user,
  storeId)` in `src/config/displayChecks.js`. Inert today (nobody holds it → super-admin-only);
  seed it later to switch it on with no code change. See "Gate shape" below.
- **PIN transform — byte-identical TODAY (two mirrored copies, not one shared module):**
  - `toAuthPassword(pin) => \`pin-${pin}\`` (4-digit guard) at `src/utils/auth-utils.js:6-13`;
    `usernameToEmail(u) => \`${u.toLowerCase().trim()}@marathon.internal\`` at `auth-utils.js:15-17`.
  - **login** (`Login.jsx:34-36`) imports the ES-module copy `src/utils/auth-utils.js`.
  - **seeding** (`scripts/seedUsers.cjs:22`) imports the CJS copy `functions/lib/auth-utils.cjs`.
  - These are **two separate files** kept in sync only by a header comment, not a shared
    import or a test. Their function bodies are identical right now (verified byte-for-byte),
    so seeded PINs match login **today** — but they *can* drift. **Correction to an earlier
    draft that called this "cannot drift": it can.** Before the PIN-verify PR, add a parity
    test (or collapse to one shared module) so a future edit to one copy can't silently break
    login for newly-seeded PINs.
  - A future server-side PIN-verify callable would `require("../lib/auth-utils.cjs")` — the
    SAME copy seeding uses, so callable↔seed can't drift; callable↔login parity still rides on
    the two copies staying identical (hence the parity test above).

### Existing staff vs the design roster

| Design (store) | In `/users`? | username | role | destShop |
|---|---|---|---|---|
| Lihle (pe) | **MISSING** | — | — | — |
| Zinhle (pe) | ✅ | `zinhle` | store_assistant | marathon-pe |
| Ayanda (pe) | ✅ | `ayanda` | store_assistant | marathon-pe |
| Sphe (pe) | **MISSING** | — | — | — |
| Amanda (trophy) | ✅ | `amanda` | **admin** | trophy |
| Sphe (trophy) | **MISSING** | — | — | — |
| Zama (pine) | ✅ | `zama` | store_assistant | marathon-pine |
| Xoli (pine) | ✅ | `xoli` | store_assistant | **(no destShop; storeIds=pine)** |
| Asanda (pine) | ✅ | `asanda` | store_assistant | marathon-pine |

- **Missing → need seeding (PR 0):** Lihle (pe), Sphe (pe), Sphe (trophy).
- **⚠ Do NOT conflate `Elihle` (username `elihle`, no destShop, storeIds=central) with
  Lihle.** Different name, different person — confirm before seeding.
- **Two-Sphe collision:** neither `sphe`, `sphe.pe`, nor `sphe.trophy` exists yet, so there
  is **no live conflict to map** — but the one-uid-vs-two decision must be made *before*
  seeding (append-only attribution can't be unpicked later). **See Blocks PR 0.**
- **Xoli** has no `destShop`; if Pine goes live she'd need one set.

### ⚠ System accounts hold role `admin` (noted, not acted on)

Several `/users` records with `role: "admin"` are **system / shared accounts, not people** —
e.g. `Tv` (`68EzXKAClo`, display device) and `2POS` (`yXTAJTbTew`). Others (`Yusuf`, `Zee`,
`Mike`, `Amanda`) are real admins. This is exactly why the manager gate was NOT keyed on
`role === "admin"` — it would have handed Analytics/Settings to the TV/POS accounts. The
dedicated `display_manager` permission avoids that entirely. Flagged for the owner; no
action taken. Worth a broader look on its own (are shared device accounts holding admin the
right posture?), independent of Display Checks.

## 4. Product images — ANSWERED (full-size only)

- **Field:** `photoUrl` — a full-resolution Firebase Storage URL
  (`…/products/{id}/photo.jpg`). Also `photo` (often `""`) and `gallery[]` (extra angles).
- **No thumbnail derivative** exists — no `thumb*` / resize / `@2x` field anywhere. The
  `Thumb` components just render `photoUrl` at a small CSS size (`src/components/stock/
  MovementHistory.jsx:17-18`, `Adjust.jsx:15`, `SetQuantity.jsx:32`, `Transfer.jsx:65`).
- → The design's denormalised `imageUrl` *thumbnail* (§4.1) has **no source**. A 60-card
  grid loads 60 full-size images. Producing thumbnails is separate work (Storage resize
  extension or a build step). **See Blocks PR 2 #4.** (Not a PR-1 problem — the shell has
  no images.)

## 5. Barcodes — ANSWERED (present, heavily populated)

- **Fields:** product-level `barcode` (e.g. `"00020845"`) **and** a per-size map
  `barcodes/{sizeKey}` (`{S,M,L,XL,XXL,XXXL,4XL}`) on `/products/{id}`. Reverse index
  `/barcodes/{code} → {productId, size}` (`src/components/stock/barcodeStore.js:5-6`).
- **Population:** **16,205** reverse-index codes for **3,085** products (~5.3 codes/product
  ≈ per-size coverage). Effectively fully populated for sized clothing.
- `barcode → productId` is a direct `/barcodes/{code}` read, or (per design §5) a map
  lookup in the static catalog. **No index prerequisite.**

---

## Gate shape (as built in PR 1)

`src/config/displayChecks.js` is the single policy surface. `canManageDisplayChecks(user,
storeId)`:

- **super-admin** (`user.email === gunidmoh@gmail.com`) → true, every store.
- otherwise → `user.permissions.includes("display_manager") && user.destShop === storeId`.

This reads **only existing fields** (`permissions` array + `destShop`) — it invents no new
user-model surface in PR 1. Inert today (nobody holds `display_manager`), so Analytics +
Settings are super-admin-only until seeded. Base access uses a parallel `display_checks`
permission via `canUseDisplayChecks`.

**Shape needed to switch it on later (Junid, in PR 0 seeding — NOT PR 1):**
add `"display_manager"` (and, for base staff access, `"display_checks"`) to
`/users/{uid}.permissions`, and ensure `/users/{uid}.destShop` is the shop being managed.
**Limitation:** `destShop` is single-store, so this expresses a per-store manager (which is
what the independent PE/Trophy rosters need). If one person must ever manage TWO stores,
switch the scope read to a `displayManagerStores: string[]` field instead — flagged, not
decided.

---

## Blocks PR 0 (seeding — Junid runs `seedUsers.cjs`)
1. **Resolve the two Sphes** — one uid (`sphe`, both stores) vs two (`sphe.pe`,
   `sphe.trophy`). Neither exists yet; decide before seeding.
2. **Seed Lihle (pe)** — missing. Do **not** assume `Elihle` is Lihle.
3. **Seed the gate permissions** — `display_manager` (managers) and `display_checks`
   (clothing staff), plus `destShop` per person. Until then the module is super-admin-only.
4. (Pine is dark in Phase 1; Xoli lacks `destShop` — set it if/when Pine flips on.)

## Blocks PR 1 (this scaffold) — CLEARED
- The "manager" gate had no repo equivalent. **Resolved:** dedicated store-scoped
  `display_manager` permission, single `canManageDisplayChecks()` gate. Nothing else blocks
  PR 1.

## Blocks PR 2 (the trigger) and beyond — flagged, NOT reconciled or built
1. **Sale source decision — `/pos/sales` vs `/stock_movements`.** No repo reader for
   `/pos/sales`; its `storeId` is short (`"pe"`) needing an unbuilt map; the repo already
   derives shop-keyed, return-netted, clothing-classified sales from `/stock_movements`.
   Recommend the trigger fire on a `/stock_movements` `sold` movement (reuse existing
   keying + classification) — or add an explicit short→long store map if staying on
   `/pos/sales`. (A Cloud Function onCreate trigger is server-side, not a client listener,
   so it does not violate the "no listener on /pos/sales" rule — but confirm intent.)
2. **Drop the `colour` dimension** from the data model — not a structured field (§2).
3. **Store-id vocabulary map** — `"pe"/"trophy"/"pine"` ↔ `"marathon-pe"/"trophy"/
   "marathon-pine"` — only needed if the trigger stays on `/pos/sales`.
4. **Thumbnail source** — none exists (§4). Either generate thumbnails first or accept
   full-size in the denormalised `imageUrl`.
