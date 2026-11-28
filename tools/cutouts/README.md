# Product cut-outs

**PAUSED 3 Nov (Junid: use the original photo).** The app does not show
cut-outs (`SHOW_CUTOUTS = false` in src/components/sky/Sky.jsx) and the nightly
job is unloaded on the mini. To resume: set it true, and run
`install-on-mac-mini.sh` to load the job again.

Gives each FOOTWEAR product (category `Footwear`: sneakers, boots, slides,
soccer boots) a PNG of the shoe alone, so the app can stand it on a glass
podium. Runs on the Mac mini, nightly at 02:00, on the CPU. Free, local
models only; never an AI-generated shoe.

Every other product (clothing, perfume, accessories, bags) has its cut-out
fields cleared and shows its original photo.

## How a shoe is cut (shoe.py)

1. **CLIPSeg** (`CIDAS/clipseg-rd64-refined`), prompted "a sneaker" / "a shoe"
   against "a white display stand" / "a shoe box" / "a shelf" / "a hand",
   finds the shoe (or a pair: a second region at least 45% the size of the
   first) and masks out everything else.
2. **rembg** (`isnet-general-use`) cleans the edge on that crop; its alpha is
   hard-clipped to the CLIPSeg mask and detached fragments are dropped.

## The quality gate (Junid, 3 Nov)

Run on every mask before anything is uploaded. Rejected if any of:

| rule | rejects when |
|---|---|
| `components` | more than 2 pieces above 3% of the mask area (2 = a pair) |
| `solidity` | largest piece's area / its convex hull area under 0.80 |
| `area` | largest piece under 6% of the photo (spec said 10%; see below) |
| `aspect` | mask bounding box w/h outside 0.9 to 3.2 |
| `box-remnant` | over 15% of the mask's bottom 20% rows are dark pixels CLIPSeg was not sure were shoe (under 92% of the shoe's peak score, 2.5% margin), AND those rows span under 45% of the mask's width — a stem hanging under the shoe (riser label, box), not a sole |
| `hole` | an enclosed hole above 4% of the mask area |
| `clip` | CLIP zero-shot: P("a clean product photo of a single shoe on a plain background") minus P("a damaged image with fragments and cut-off pieces") under 0.15 (the CLIP inside CLIPSeg; no second model) |

Before the gate, `no-shoe` (CLIPSeg found nothing) and `low-confidence`
(peak under 0.60) are rejections too.

A rejected cut is retried once with a tighter CLIPSeg threshold (0.65) and the
mask eroded 10 px. The retry may trim fragments, not the shoe: one that keeps
under 80% of the first attempt's shoe is `retry-shrunk` (a normal retry keeps
85-95%; the AJ1 Cream Brown Red retry kept 73%, minus its sole). If the retry
fails, the product is written `rejected` with
no URL and the card shows the original photo. There is no whole-object
fallback. Every rejection is logged in `logs/cutouts.log` as
`REJECT <pid> attempt=<n> rule=<rule> {metrics}` and `REJECTED <pid> rule=<rule>`.

**Area: 6%, not the spec's 10%.** These are shop photos of a shoe on a riser
in front of the wall; a perfectly cut sneaker covers 6-10% of the photo
(median 9.8% on a 160-product calibration). At 10% the rule rejected ~58% of
good footwear; the cuts under 6% were the broken ones. `--area 0.10` restores
the spec number.

**Box-remnant needs the width test.** Black shoes on the black mesh wall have
dark soles CLIPSeg is unsure of, so the dark-pixel test alone rejected clean
black shoes (19 of the first 126 judged). Real remnants hang under the sole:
the SB Dunk's riser label spans 22% of the mask's width, a black block 37%;
clean black shoes' soles 64-100%.

`--loose` sets solidity and aspect one step looser (0.75; 0.8 to 3.6). Only
use it if more than 25% of footwear is rejected.

## What it writes

Three fields per product, as one multi-path update, nothing else:

| path | value |
|---|---|
| `/products/{id}/photoCutoutUrl` | public download URL of the PNG (absent when rejected) |
| `/products/{id}/photoCutoutFor` | the `photoUrl` it was judged on |
| `/products/{id}/photoCutoutQuality` | `shoe` or `rejected` |

The PNG is trimmed to the shoe plus 6% transparent padding, capped at 1600 px,
at `products/{id}/cutout-<sha1(photoUrl)[:10]>.png` (`public, max-age=31536000,
immutable`, download token). Non-footwear products get all three fields
deleted. It never sets a product and never touches `photoUrl`.

The app (`cutoutSrc` in `src/components/sky/Sky.jsx`) shows a cut-out only
when the category is `Footwear`, the quality is `shoe` and `photoCutoutFor`
equals the current `photoUrl`.

A judgement is current only while `photoCutoutFor == photoUrl` and the local
state records the current `GATE_VERSION` for that photo. Bumping
`GATE_VERSION` re-audits every cut-out: a cut that still passes on its first
attempt keeps its existing URL; a failing one is retried, then cleared.

It never reads `/products` whole: a `shallow=true` key list, then per-product
leaf reads (`category`, then `photoUrl`, `photoUpdatedAt`, `photoCutoutFor`,
and the URL/quality only when that matches).

Local state lives in `~/.marathon-cutouts/state.sqlite`: judgements per
(id, photoUrl, gate version) and failures. After 3 errors on a photo it gives
up until the photo changes. `~/.marathon-cutouts/cutouts.lock` stops two runs
overlapping. Every judged product also leaves previews and one JSON line in
`~/.marathon-cutouts/audit/` (input for `make_audit_sheet.py`).

## Running it

On the mini (after `git pull` in `~/marathon-store-app`):

```sh
bash ~/marathon-store-app/tools/cutouts/install-on-mac-mini.sh             # install / update
bash ~/marathon-store-app/tools/cutouts/install-on-mac-mini.sh --run-now   # + one pass now
bash ~/marathon-store-app/tools/cutouts/install-on-mac-mini.sh --run-now --limit 20

PY=~/.marathon-cutouts/venv/bin/python
export GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json
$PY ~/marathon-store-app/tools/cutouts/cutout.py --dry-run --limit 20   # reads only
$PY ~/marathon-store-app/tools/cutouts/cutout.py --run-now --ids -Nabc,-Ndef
$PY ~/marathon-store-app/tools/cutouts/cutout.py --status
```

Options: `--interval S` (pause between products, default 1.5), `--model`,
`--max-side N` (0 = full size).

Tests (no network; the rembg test downloads the model on first use):

```sh
cd tools/cutouts && python -m pytest -q
```

## Undo

1. Stop the job:
   `launchctl bootout gui/$(id -u)/com.marathon.cutouts; rm ~/Library/LaunchAgents/com.marathon.cutouts.plist`
2. Delete the three fields from every product: `photoCutoutUrl`,
   `photoCutoutFor` and `photoCutoutQuality` only, never the product and
   never `photoUrl`.
3. Delete the Storage objects `products/*/cutout-*.png`. Never delete
   `products/*/photo.jpg` or any other photo.
4. `rm -rf ~/.marathon-cutouts` (state, lock, venv). Leave it in place if a
   later run should resume where this one stopped.
