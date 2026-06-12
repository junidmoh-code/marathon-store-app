# Layby — Cross-App Integration Checklist

Tracks every remaining piece to close the layby loop end-to-end. The
**warehouse side** (this app) is done — PR #58 (`feat/layby-warehouse-hub`):
the "Layby" tab (Pull Requests / Receiving / Exceptions), the exceptions banner,
the camera QR scanner, and the discreet TV strip. It reads/writes the shared
paths **defensively**, so until the items below land the warehouse queues simply
render empty (no crash).

The authoritative field-level spec is the **LAYBY CROSS-APP CONTRACT** in
`SCHEMA.md` (`/laybys/{laybyId}`, `/laybyPulls/{pullId}`). Everything here must
match it verbatim — do not invent parallel fields/paths.

> **Ownership recap.** POS app (marathon-pos-app) writes **creation + pull
> requests**; this app (warehouse) writes **receiving / sent / reject**. Identity
> is the **invoice number** (`invoiceNo`); the stable key is `laybyId`. Money is
> **cents**. Locations are canonical `/locations` ids — POS translates its
> informal `pine|pe|trophy` vocab to `marathon-pe`/`marathon-pine`/`trophy`
> **before writing**.

---

## Sequencing (do these in order)

1. ✅ **Warehouse PR #58** — merge first. UI is empty-tolerant, so it is safe to
   ship ahead of data and rules.
2. ⬜ **POS writers PR** (marathon-pos-app) — emit `/laybys` + `/laybyPulls` per
   the contract.
3. ⬜ **Rules PR + quiet-window deploy** — add `/laybys` + `/laybyPulls` to
   `database.rules.json`. **Separate, gated rules PR**, deployed in a quiet
   window — same procedure as the RTDB hardening swap (PR #57). Until this lands,
   authed reads of the new paths return permission-denied → warehouse shows empty.
4. ⬜ **End-to-end test** — full lifecycle on a non-live target / quiet window.

Steps 2 and 3 are independent and can land in either order, but **both** are
required before step 4 produces live data.

---

## 1. POS writers (marathon-pos-app)

All ids canonical; all money cents; `invoiceNo` is the displayed identity,
`laybyId` is the stable node key. QR label payload: `{ "v":1, "laybyId":"…",
"invoiceNo":"L-00045" }`.

### `/laybys/{laybyId}` — creation + lifecycle (POS-owned transitions)
- ⬜ **On layby creation** write the node with: `laybyId`, `invoiceNo`, `saleId`,
  `customerName`, `customerPhone`, `itemCount`, `balanceRemaining` (cents),
  `dueDate` (`YYYY-MM-DD`), `createdAt`, `createdBy`, `originStore` (canonical),
  `storageHub` (canonical; **default `hub1`**), and `status: "created"`.
- ⬜ **On label print** → `status: "labelPrinted"`; print the QR with the
  `{v:1, laybyId, invoiceNo}` payload.
- ⬜ **On dispatch to storage** → `status: "inTransitToStorage"` **and set
  `scanDeadline`** (epoch ms or ISO). This is what arms the warehouse Receiving
  queue + the exceptions timer.
- ⬜ **On collection** → `status: "collected"`.
- ⬜ **Expiry** → `status: "expired"` when past `dueDate` (auto-sweep or on
  next interaction — POS decides the trigger).
- ⬜ **Do NOT write** `storedAtHub` / `receivedAt` / `receivedBy` /
  `sentToStore` / `sentToStoreAt` / `rejected*` — those are warehouse-owned.

### `/laybyPulls/{pullId}` — pull requests (POS-owned creation)
- ⬜ **On a store requesting collection** write the pull node with: `pullId`,
  `laybyId`, `invoiceNo`, `saleId`, `customerName`, `customerPhone`, `itemCount`,
  `balanceRemaining` (cents), `dueDate`, `requestingStore` (canonical),
  `storageHub` (mirror of the layby's), `requestedAt`, and `status: "pending"`.
- ⬜ Simultaneously set the layby `/laybys/{laybyId}/status: "pullRequested"`.

### POS consumes warehouse outcomes
- ⬜ **Reject** — when `/laybyPulls/{pullId}/status === "rejected"`, surface
  `rejectionReason` to the store (the layby is also flipped to `rejected`).
- ⬜ **Sent** — when `status === "sentToStore"` (layby → `sentToStore`,
  `sentToStoreAt` set), tell the store the parcel is on its way / arrived so they
  can complete collection.

### Translation
- ⬜ Map POS informal store ids → canonical (`pe → marathon-pe`,
  `pine → marathon-pine`, `trophy → trophy`) **at the write boundary**, so every
  `originStore`/`requestingStore` in RTDB is already canonical.

---

## 2. `database.rules.json` entries — **separate gated rules PR**

> **Prepared** — see `LAYBY-RULES-DEPLOY.md` for the deploy runbook (access model,
> ownership-split rationale + limitation, the `/laybyPulls` anon-read flag,
> refreshed `rules-rollback.json`, and the post-deploy smoke test).

> **This is a separate, gated rules PR + quiet-window deploy — the same procedure
> as the RTDB hardening swap (PR #57).** It is **not** part of the warehouse
> feature PR (#58 does not touch `database.rules.json`). The store-app feature
> code must merge and be live first so that the moment the rules open the paths,
> the readers already exist.

- ⬜ Add explicit per-path rules for **`/laybys`** and **`/laybyPulls`** (the
  current hardened ruleset denies undeclared paths, so reads/writes fail until
  these exist).
- ⬜ **Read:** authed staff of both apps may read both paths.
- ⬜ **Write (field-level ownership):** enforce the contract split as far as the
  rules language allows —
  - POS may create `/laybys/{laybyId}` and `/laybyPulls/{pullId}` and write the
    POS-owned fields + POS-owned status transitions.
  - Warehouse may write only the warehouse-owned fields (`status` →
    `storedAtHub`/`sentToStore`/`rejected`, `receivedAt`, `receivedBy`,
    `sentToStoreAt`, `rejectedAt`, `rejectedBy`, `rejectionReason`).
  - At minimum, gate on auth and validate `status` against the allowed enum;
    tighten to per-field ownership if feasible.
- ⬜ **Anonymous auth:** the warehouse runs under anonymous auth — make sure the
  read rules permit it (mirrors the existing orders-read allowance from the
  hardening PR). Confirm the writer paths require a real (non-anon) identity if
  that is the intended posture.
- ⬜ **Keep `rules-rollback.json` current** — capture the pre-change ruleset so
  the rollback path stays one command away.

### Rules deploy window (mirror the hardening swap)
- ⬜ Merge the rules PR to `main` only after CodeRabbit passes.
- ⬜ Deploy in a **quiet window** (low POS/warehouse traffic):
  `firebase deploy --only database` from a clean `origin/main`.
- ⬜ **Smoke test immediately** after deploy (see §3) — confirm reads/writes work
  for both apps and that no previously-allowed path regressed.
- ⬜ **Rollback ready:** `firebase deploy --only database` against
  `rules-rollback.json` if anything misbehaves.

---

## 3. End-to-end test (full lifecycle)

Run after both the POS writers and the rules are live (quiet window / non-live
target). Use one customer + one parcel and walk every state, confirming the RTDB
node + both apps' UIs at each step.

- ⬜ **create** — POS takes a layby → `/laybys/{laybyId}` exists,
  `status: "created"`, `invoiceNo` set, money in cents, `originStore`/`storageHub`
  canonical.
- ⬜ **label** — POS prints label → `status: "labelPrinted"`; scan the printed QR
  and confirm it decodes `{v:1, laybyId, invoiceNo}`.
- ⬜ **dispatch** — → `status: "inTransitToStorage"`, `scanDeadline` set; parcel
  now appears in the warehouse **Receiving** queue at its `storageHub`.
- ⬜ **scan-in** — warehouse **Scan layby** (and manual-entry fallback) →
  `status: "storedAtHub"`, `receivedAt`/`receivedBy` stamped; leaves Receiving.
- ⬜ **pull** — POS requests collection → `/laybyPulls/{pullId}` (`pending`),
  layby `status: "pullRequested"`; appears in warehouse **Pull Requests** with the
  invoice number huge + on the **TV strip**.
- ⬜ **sent** — warehouse **Sent** → pull `status: "sentToStore"`, layby
  `status: "sentToStore"` + `sentToStoreAt`; drops off the Pull Requests queue +
  TV strip; POS sees it.
- ⬜ **collected** — POS completes collection → layby `status: "collected"`.

### Off-ramp paths
- ⬜ **Exception** — dispatch a parcel and let it pass `scanDeadline` without
  scanning → it surfaces in **Exceptions** + the loud banner (age, origin store,
  creator). Confirm same-day visibility.
- ⬜ **Reject (expired)** — request a pull for a past-`dueDate` layby → warehouse
  card shows `EXPIRED`; **Reject** with a reason → pull `status: "rejected"`,
  layby `status: "rejected"`, and the POS/store sees `rejectionReason`.

### Regression
- ⬜ Re-run the existing RTDB rules smoke test (orders read/write, products, etc.)
  to confirm the new rules didn't narrow anything previously allowed.

---

## Notes
- The stock-transfer rework is a **separate PR train** — keep it out of this loop.
- `hubC` never stores laybys (customer-clothing trial only) — the warehouse Layby
  tab and banner are intentionally absent there.
