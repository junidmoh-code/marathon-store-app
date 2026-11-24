# Website unavailable lines audit (24 Nov 2026)

- `REPORT.md` — the findings, for Junid.
- `unavailable-lines.csv` — one row per website order line and product that was ever rejected, not found, damaged or unavailable since #1768.
- `jamie-offers.csv` — one row per line Jamie offered alternatives for.
- `stats.json` — every number the report quotes.

Rebuild (read only; nothing is written to the database or to Shopify):

```
node scripts/audit/web-unavailable/collect.mjs <cacheDir>          # ~50 MB of RTDB reads, once
node scripts/audit/web-unavailable/analyse.mjs <cacheDir> <outDir>
node scripts/audit/web-unavailable/shopify-orders.mjs <cacheDir> <outDir>
node scripts/audit/web-unavailable/jamie-offers.mjs <cacheDir>     # reads ~/marathon-dm-agent/data/agent.db read-only
node scripts/audit/web-unavailable/analyse.mjs <cacheDir> <outDir> # again, now joined
```
