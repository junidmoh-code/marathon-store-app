# Layby RTDB Rules — Deploy Runbook

Runbook for the `database.rules.json` change that opens `/laybys` + `/laybyPulls`.
**Deploy is a separate gated step in a quiet window — same procedure as the RTDB
hardening swap (PR #57). This PR does NOT deploy.** Until it deploys, POS layby
finalize stays rules-denied (the current blocker) and the warehouse queues read
empty.

Field-level contract: see the **LAYBY CROSS-APP CONTRACT** in `SCHEMA.md`.
Remaining cross-app work: see `LAYBY-INTEGRATION-CHECKLIST.md`.

---

## What changes

1. **Adds per-path rules for `/laybys` and `/laybyPulls`.** Both are currently
   denied by default (no rule → deny), which is exactly why POS layby finalize is
   rejected. Purely **additive** — no existing path is touched.
2. **Refreshes `rules-rollback.json`** to the **current hardened ruleset
   (pre-layby)** so it is the correct one-command rollback for *this* change.
   > ⚠️ Before this PR, `rules-rollback.json` still held the **pre-#57 permissive
   > root cascade** (`.read/.write: auth !== null`). Deploying that today would
   > **undo the entire hardening**. It must not be used as the rollback for this
   > change — hence the refresh.

## Access model (and why)

The main app requires a **real, non-anonymous** user for every surface except the
`#tv` kiosk (which signs in anonymously). So:

| Path          | `.read`                                   | `.write`                                   |
|---------------|-------------------------------------------|--------------------------------------------|
| `/laybys`     | non-anonymous                             | non-anonymous (+ `.validate`)              |
| `/laybyPulls` | **`auth != null`** (anonymous allowed)    | non-anonymous (+ `.validate`)              |

- **Writes** — both POS and warehouse operate as non-anonymous users, so writes
  are gated on `auth.token.firebase.sign_in_provider != 'anonymous'`, consistent
  with the hardening.
- **`/laybyPulls` anonymous read — the one anon-surface widening vs PR #57.** The
  hub TV layby strip runs under the anonymous `#tv` session, so it needs anon read
  of `/laybyPulls`. This grants anonymous clients read of pull records (incl.
  `customerName`/`customerPhone`) — **the same exposure `/orders` already grants
  the TV.** `/laybys` stays non-anon (only the warehouse reads it).
  - **Decision point:** if anon-readable pull PII is not acceptable, the
    alternative is a minimal public projection (e.g. `/laybyPullsPublic/{id}` =
    `{invoiceNo, storageHub}` only) that the TV reads instead. Flag before deploy
    if you want that — it's a small POS-writer + store-app change, not in scope
    here.

## Ownership split — rules vs. convention

**Enforced by the rules:**
- Non-anonymous auth for all writes.
- `status` ∈ the lifecycle enum — `/laybys`: `created · labelPrinted ·
  inTransitToStorage · storedAtHub · pullRequested · sentToStore · collected ·
  expired · rejected`; `/laybyPulls`: `pending · sentToStore · rejected`.
- `invoiceNo` / `laybyId` / `saleId` are **immutable once set** (can be written on
  create, never changed).
- Node-key consistency (`laybyId === $laybyId`, `pullId === $pullId`).
- `balanceRemaining` / `itemCount` numeric; `invoiceNo`/`laybyId` non-empty;
  required fields present.

**NOT enforced by the rules (convention + the SCHEMA contract instead):**
- *Which actor* may write *which field* — i.e. "POS writes creation/pulls,
  warehouse writes receiving/sent/reject." There is **no shared role claim** that
  distinguishes the two apps today: POS users carry `/users/{uid}/posAccess`,
  store-app warehouse users carry `/users/{uid}/role`, and the super-admin has no
  `/users` record at all. A strict per-actor predicate would risk denying
  legitimate writes (esp. super-admin). The rules therefore enforce **shape +
  transition integrity**; the actor split is held by the apps + the contract.
- **Future tightening:** once both apps mint a shared claim (a custom token claim,
  or a common `stockRole`), add per-field `.write` predicates keyed on it.
  Tracked in `LAYBY-INTEGRATION-CHECKLIST.md`.

---

## Deploy (quiet window, after close)

Pre-reqs: this PR merged to `main`, CodeRabbit green, clean `origin/main`.

```sh
firebase deploy --only database
```

Then run the smoke test below. (Same command/posture as the #57 hardening swap.)

## Rollback (one command path)

`rules-rollback.json` is the hardened ruleset **without** layby — i.e. the exact
pre-change live state. To revert:

```sh
cp rules-rollback.json database.rules.json
firebase deploy --only database
git checkout database.rules.json   # restore the working copy afterward
```

(Or point `firebase.json` → `database.rules` at `rules-rollback.json` for the
revert deploy, then put it back. The `cp` path is simplest.)

## Smoke test — run immediately after deploy

**Layby (new paths):**
- [ ] POS finalize a layby → `/laybys/{laybyId}` write **succeeds** (was denied).
- [ ] POS create a pull → `/laybyPulls/{pullId}` write succeeds; layby
      `status: "pullRequested"`.
- [ ] Warehouse (real user) **scan-receive** → `status: "storedAtHub"`,
      `receivedAt`/`receivedBy` written.
- [ ] Warehouse **Sent** → pull `sentToStore` + layby `sentToStore`.
- [ ] Warehouse **Reject** with reason → pull `rejected` + `rejectionReason`,
      layby `rejected`.
- [ ] `.validate` rejects a bad `status` (e.g. write `status: "foo"` → denied).
- [ ] Changing `invoiceNo` on an existing layby → denied.
- [ ] Anonymous `#tv` session: `/laybyPulls` **read succeeds** (strip shows);
      `/laybys` read **denied**; any layby/pull **write denied**.

**Regression (confirm hardening intact):**
- [ ] `/orders` anon read works (TV) and the collected-write path still works.
- [ ] `/products`, `/insights_log`, `/pos`, `/customers` reads/writes for real
      users unchanged.
- [ ] Anonymous writes still denied on all non-`orders` paths.

If any regression appears → run the **Rollback** above.
