# Product cut-outs

Gives each product a background-removed PNG so the app can stand it on a glass
podium. Runs on the Mac mini, nightly at 02:00, with rembg on the CPU (model
`isnet-general-use`).

For every product with a `photoUrl` and no valid cut-out it downloads the
full-res photo from `photoUrl`, removes the background, trims to the object
plus 6% transparent padding (of the longer side), caps the longest side at
1600 px, and uploads
`products/{id}/cutout-<sha1(photoUrl)[:10]>.png` (image/png,
`public, max-age=31536000, immutable`, with a download token).

## What it writes

Two fields per product, as one multi-path update, nothing else:

| path | value |
|---|---|
| `/products/{id}/photoCutoutUrl` | public download URL of the PNG |
| `/products/{id}/photoCutoutFor` | the `photoUrl` it was cut from |

A cut-out is valid only while `photoCutoutFor == photoUrl`. When the photo
changes the app should ignore the old cut-out, and the next run makes a new one
(new hash, new object). It never sets a product and never touches `photoUrl`.

It never reads `/products` whole: a `shallow=true` key list, then per-product
leaf reads of `photoUrl`, `photoUpdatedAt`, `photoCutoutFor` and, only when that
matches, `photoCutoutUrl`.

Local state lives in `~/.marathon-cutouts/state.sqlite`: done ids, and failures
per (id, photoUrl). After 3 failures on a photo it gives up until the photo
changes. `~/.marathon-cutouts/cutouts.lock` stops two runs overlapping. The log
is `logs/cutouts.log` (rotating), one line per product: time, id, outcome, ms.

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
2. Delete the two fields from every product: `photoCutoutUrl` and
   `photoCutoutFor` only, never the product and never `photoUrl`.
3. Delete the Storage objects `products/*/cutout-*.png`. Never delete
   `products/*/photo.jpg` or any other photo.
4. `rm -rf ~/.marathon-cutouts` (state, lock, venv). Leave it in place if a
   later run should resume where this one stopped.
