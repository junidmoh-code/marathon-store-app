# New Arrivals — upload to everywhere, one tap

```
upload ─▶ New ─▶ (Mac mini: quality gate → generate on plate → check → namer) ─▶ Ready | Rejected
Ready ─[Junid: Approve]─▶ approved ─▶ chaining (photo → name → Excellent → publish intent) ─▶ reconciler ─▶ done
done ─▶ next 10:00 / 15:00 window: 14 WhatsApp groups (WhatsApp Desktop) ─▶ one carousel to marathon-social
```

## Data — `/new_arrivals`

| Path | What |
|---|---|
| `items/{pid}` | the item (truth) |
| `by_status/{status}/{pid}` | `enqueuedAt` — the index every reader uses; never a whole-node scan |

The statuses are `new`, `generating`, `ready`, `rejected`, `approved`, `chaining` and `done`. Each move is a transaction on the item that checks the status it moves from, followed by an index update. A reader that finds a stale index entry repairs it (`indexRepair`).

Item fields, by writer:

- **Enqueue**: `pid`, `status`, `enqueuedAt`, `statusAt`, `name`, `categoryKey`, `originalUrl`, `attempts`, `attemptsSinceRetry`.
- **Agents**: `generatedUrl`, `generatedPath`, `plateId`, `checker`, `suggestedName`, `rejection {code, reason, at}`, `lastAttempt`.
- **Approve**: `approvedAt`, `approvedBy`.
- **Chain**: `chain {photo, name, condition, publish, shopify}.at`.
- **Done tab**: `destinations {shopify, groups, social}`, `soldOutBeforePosting`.

Rejection codes:

| `code` | Meaning | What happens next |
|---|---|---|
| `source` | "retake photo" | Waits for a new upload, or for the product photo to be replaced. |
| `checker` / `generation` | the product or background changed | A fresh attempt runs automatically, up to 3 runs; then it stays. |
| `name` | "duplicate name — needs a distinct name" | |
| `chain` | a publisher step refused | The refusal is shown in plain words. |

**Retry** starts a completely fresh generation from the original, with a new attempt budget.

## Who writes

- **`newArrivalsEnqueue`** (`onValueCreated products/{pid}`) enqueues only records carrying the upload form's own `createdBy.at` from the last 15 minutes. No merges and no price records.
- **The card** reads and writes only through the callables `newArrivalsList`, `newArrivalsApprove` and `newArrivalsRetry`. These are gated to the super-admin or `permFlags/shopify_publish`.
- **The Mac mini agents** use the Admin SDK: `marathon-group-poster` for generation, checking and posting, and `scripts/newArrivals/chainCore.mjs` for the post-approval chain.

**No database rule is needed or changed.** The client never touches `/new_arrivals`.

## Deploy (by name, never a bare `--only functions`)

```
firebase deploy --only functions:newArrivalsEnqueue,functions:newArrivalsList,functions:newArrivalsApprove,functions:newArrivalsRetry --project=marathon-club
```

The card itself ships with hosting. Run the drift check in `DEPLOY.md` first.
