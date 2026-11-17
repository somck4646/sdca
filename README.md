# sdca

Your MTPI / RSPS / SDCA dashboard as a website: `index.html`. It is served by GitHub Pages at https://YOURNAME.github.io/sdca/.

Your capital, holdings and buy log are saved only in the browser you use. They are never uploaded here. To move them to another device, use Export and Import on the SDCA and Holdings pages.

The daily job reads the 9 checkonchain charts used by the SDCA Bottom Score every morning on GitHub's servers, so your own computer doesn't need to be on, and publishes the result as `sdca_data.json` on GitHub Pages.

- Job: `.github/workflows/sdca.yml` runs at 23:22, 23:47, 00:17 and 02:07 UTC. Checkonchain publishes at about 23:13 UTC. A run does nothing if the latest close is already saved.
- Script: `scripts/update.mjs` works out each indicator's score the same way as the dashboard: 1 − oscillator/100, or 1 − percentile rank for Power Law and ISM. It checks that all 9 readings are present, from the same day and between 0 and 1, and that checkonchain's BTC price is within 3% of Binance or Coinbase. It adds a checksum. If any check fails, nothing is saved and the run fails, which makes GitHub email you.
- History: `history.jsonl` keeps one line per close.
- Manual run: go to the Actions tab, open **SDCA daily data**, click **Run workflow**, and set force = true to re-read.
