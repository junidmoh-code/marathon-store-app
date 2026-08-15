# The count flow's auto-pick — investigation before the port

**Date:** 2026-08-15 · **Branch:** `fix/count-use-admin-picker` · **Base:** `main` @ `14cb33d`

This is COMMIT 1 of the port: findings only, no behaviour changed. The port itself
lands in the next commit.

---

## a) The admin scan/picker

**File:** `src/components/admin/StyleCodeGate.jsx` — "Add Sneaker", step 1 of intake.

### What it renders

Two candidate surfaces, both photo-first:

| Surface | Lines | What it is |
|---|---|---|
| `SimilarCards` | `StyleCodeGate.jsx:91–121` | The pre-duplicate list. One card per candidate: **84×84 photo**, product name, the registered code (`+ " (pending)"` when unconfirmed), and `s.reasons.join(" · ")` — the human-readable *why*, which names **which token found the row**. Card CTA is `ADD STOCK →`. |
| `step === "existing"` cards | `StyleCodeGate.jsx:694–732` | The claimed-code picker: 84×84 photo, name, code + category, `SELECTED`/`TAP`. No default, no first-match fallback. |

`SimilarCards` is rendered in three places — the pre-form `similar` step
(`:628`), inside the `found` step (`:849`), and inside the `unknown` step
(`:933`).

### How it gathers candidates

This is the part that matters, and it is **token-set based, not
picked-token based**:

1. `buildLinkSuggestions({ kind: "code", normalised, allCodes: labelAllCodes,
   tokens, modelName, includeExact: true })` — `StyleCodeGate.jsx:326–336`
   (capture-only road) and `:368–376` (enforced road).

   Inside `buildLinkSuggestions` (`src/utils/linkSuggestions.js:479–510`)
   **every** further code-shaped token on the label ranks the catalogue exactly
   as the primary does, into one merged list, and each pooled row's reason is
   suffixed `(via the label's other token XXXX)`.

2. `addServerOwners(list)` — `StyleCodeGate.jsx:264–282` — ONE
   `labelAlias{action:"resolveAnyCode"}` round trip carrying
   `[normalised, ...labelAllCodes]`. Alias-only owners never stamp a product
   row, so the in-memory ranking cannot see them; these are `unshift`ed to the
   front of the same single list.

The consequence: **admin also auto-picks a token** (`autoPick` /`preferred`,
`StyleCodeGate.jsx:229–240`) — but the auto-pick only decides which code goes in
the *text field*. It never decides which candidates are *shown*. The candidate
list is always built from the whole token set. That separation is exactly what
the count flow lacks.

### The "it's not this colour" action

Two, both subordinate links, both always present:

* `"None of these — it's a new shoe, open the form"` — `:630`
* `"None of these — it's a new colourway of this code"` — `:763` (only when a
  claim exists), which opens the form with a `sibling` marker so the save
  registers a sibling owner instead of losing the create-once claim race.

---

## b) The count flow, and where it auto-picks

**Files:** `src/components/stock/TongueLabelReader.jsx` (capture, shared by
register/count/assistant) and `src/components/stock/HubCleanup.jsx` (the count
pass itself).

### Where the single token is chosen

`hubCleanupCore.js:139–172` — `chooseFromLabelRead(data)`:

```
:154-156   autoPick  (a LAYOUT RULE a human taught)   → { kind: "chosen", auto: true }
:157-159   preferred (tier 2's own read of the label) → { kind: "chosen", auto: true }
:160       otherwise                                  → { kind: "options" }  (chips)
```

`TongueLabelReader.jsx:206–246` then calls `onCode(formattedChosen, { allCodes,
… })` with **one** display code. The other tokens ride along in `meta.allCodes`.
The reader does announce the pick with override chips (`:232–245`), so the pick
is visible — but it is still one code going forward.

### Where the other tokens' products become invisible

**`src/components/stock/HubCleanup.jsx:350–613` — `handleStyleNumber`.**

The whole resolution chain runs against `normalised` — the ONE auto-picked
token — and short-circuits on the first hit:

| Line | Branch | Effect |
|---|---|---|
| **`:373`** | `const claim = await lookupStyleClaim(normalised)` | Only the picked token's claim is fetched. |
| **`:374`** | `resolveStyleNumber(display, { products, claim })` | Only the picked token's owners are gathered (`styleCodeOwners` + `claimOwnerIds`). |
| **`:375–394`** | `kind === "claim"` | → `setPanel(countPanelFor(p))`. **Returns.** |
| **`:395–398`** | `kind === "product"` | → `setPanel(countPanelFor(out.product))`. **Returns.** |
| **`:399–408`** | `kind === "choose"` | Picker opens with `claimants: out.products` — the owners of **one** token only. |

`meta.allCodes` is not consulted until **`:451`**, and only *after* every branch
above produced nothing:

```js
// :451
const alternates = (meta && Array.isArray(meta.allCodes) ? meta.allCodes : [])
  .map(normaliseStyleCode).filter((c) => c && c !== normalised);
```

**That ordering is the defect.** A Timberland label printing `A6CWNEN3` and
`A8425`: if `A6CWNEN3` is the auto-picked token and any product carries or
claims it, the flow lands on that product's count panel at `:392`/`:397` and
everything owned by `A8425` is never gathered, never ranked, never shown.

The `resolveAnyCodes` any-token step at `:451–526` — which is exactly the merged
gather the flow needs — only ever runs on the *failure* path.

### What the count flow already does right (must not be lost)

* `LinkPanel` (`HubCleanup.jsx:1315–1458`) already pools every token
  (`allCodes: panel.allCodes`, `:1345`), shows 72px photos + name + code +
  reasons, pads to ≥10 rows (`fillToMin`), offers uncapped free search, and
  ends with *"It's genuinely not in the catalogue — note as never registered"*.
* `ChoosePanel` (`:1480–1637`) shows 120px photos, optional shoe-photo colour
  ordering, remembered colourway answers, `"None of these — it's a new
  colourway"`, and a merge route for unexplained collisions.
* Picking anywhere files through the existing alias doors — `recordLabelCodes`
  for a printed code (`:803`), `addLabelAlias` for a token reading (`:818`).

---

## c) Can the admin component be reused?

**Yes — by lifting the renderer into a shared module. It cannot be imported
as-is, because it is not exported.**

* `SimilarCards` (`StyleCodeGate.jsx:91–121`) is a **pure presentational
  function** — props `{ suggestions, onAddStock }`, no hooks, no state, no
  Firebase, no admin-specific imports. Its only couplings are two module-local
  style objects (`meta`, `BLUE`) and `formatStyleCodeForDisplay`.
* It is declared inside `StyleCodeGate.jsx` and never exported, so the count
  flow cannot import it today.

**Plan:** move it verbatim to `src/components/shared/CandidateCards.jsx`,
re-import it into `StyleCodeGate.jsx`, and import it into `HubCleanup.jsx`.
Two additive props with admin's current values as defaults — `photoSize = 84`
and `cta = "ADD STOCK →"` — let the count render the same cards larger with its
own verb. Admin's rendered output stays byte-for-byte identical (pinned by
test).

**The logic is the other half of the reuse.** Admin's real trick is not the
card, it is `buildLinkSuggestions({ allCodes })` + `resolveAnyCode` over the
whole token set *before* deciding what to show. `buildLinkSuggestions` is
already shared (`src/utils/linkSuggestions.js`) and already pools tokens —
the count already calls it, but only in `LinkPanel`, i.e. only after the
resolution chain has failed. The port moves the merged gather **in front of**
the resolution chain.

**Nothing genuinely cannot be shared.** No stop-and-report condition is met:

* Admin's behaviour does not have to change for the component to move.
* No count-flow capability is removed — every fallback listed in (b) is kept,
  and the "new colourway" note keeps its own button alongside the new
  show-everything escape.

### One cost, flagged deliberately

`labelAlias{action:"resolveAnyCode"}` reads `/label_aliases` whole-node
(`functions/labelAlias/labelAlias.js:150`). Today the count calls it only when
the picked token resolves to nothing. After the port it is called once per
**multi-token** scan (single-token labels are untouched — zero new calls). The
mitigation is a session-scoped memo keyed by the sorted token set, invalidated
whenever an alias is filed. Net effect on the failure path is neutral: the call
that used to happen at `:455` is the same call, moved earlier and reused.
