# The local stylist (Mac mini)

Chooses every full outfit (the lookbook on Mon/Wed/Fri and the reels'
outfit post) with free, local models. No paid API styles anything; image
generation is unchanged.

| piece | what it does |
|---|---|
| `run.mjs` | the daily run: catalogue → variety ledger → Fashion-CLIP shortlist → Gemma 4 pick → validator → `social_stylist/picks/{saDate}/{kind}` |
| `embed.py` | Fashion-CLIP (`patrickjohncyh/fashion-clip`, open weights) reads each product photo: colour, style, statement, embedding; cached in `~/.marathon-stylist/fclip.sqlite` |
| `ollama.mjs` | Gemma 4 over Ollama on `127.0.0.1:11434` |
| `rulebook.md` | the stylist's own rules, sent after `functions/lib/fit-rulebook.md` |
| `../functions/lib/local-stylist.cjs` | the pure rules shared with the Cloud Functions and the tests: ledger, pool, palette, shortlist, validator, hand-off |
| `review-email.mjs` | uploads a review folder and emails Junid the sheet with direct links; checks SMTP acceptance and Sent Mail |
| `run-daily.sh`, `launchd/` | `com.marathon.ollama` (model server, KeepAlive) and `com.marathon.stylist` (05:10, retry 05:40 SAST) |
| `install-on-mac-mini.sh` | the one-time, idempotent setup |

## On the mini

- Checkout: `~/marathon-social` (deploy = `git fetch && git reset --hard origin/main`).
- State: `~/.marathon-stylist/` (ledger.json, fclip.sqlite, venv, logs/stylist-YYYY-MM-DD.log).
- Model: `gemma4:12b-it-qat` (7.2 GB on disk; unloads 3 minutes after the run).
- Try it: `GOOGLE_APPLICATION_CREDENTIALS=~/.config/marathon/shopify-reconciler-sa.json /opt/homebrew/bin/node --dns-result-order=ipv4first stylist/run.mjs --dry`
- Seven in a row, offline: `… stylist/run.mjs --review 7 --out ~/Desktop/stylist-review`

## When there is no pick

The Mac mini off, Ollama down, or no answer that passes the validator: no pick
is written. The lookbook day then posts the current style and the outfit post
is skipped, exactly as a skipped fit did before. No paid model stands in.
